import { expect, test, type Page } from "@playwright/test";

const PANE_OF: Record<string, string> = {
  Dictionary: "dictionary", Harper: "harper", "CoEdIT Base": "coedit",
  "Qwen 3 grammar": "qwen", "Qwen 3 rewrites": "qwen-rewrite",
};

/** The inline diff is the only output view, so tests read what is actually rendered. */
function outputBlock(page: Page, title: string) {
  return page.locator(`#${PANE_OF[title]}-panel .diff-block`);
}

/** The engine's own text is the diff with the struck-out original removed. */
function readOutput(page: Page, title: string): Promise<string> {
  return outputBlock(page, title).evaluate((element) => [...element.childNodes]
    .filter((node) => node.nodeName !== "DEL")
    .map((node) => node.textContent ?? "")
    .join(""));
}

function expectOutput(page: Page, title: string) {
  return expect.poll(() => readOutput(page, title).catch(() => null));
}

const PASSAGE = "Their are alot of reasons why peeple keep writing long sentences about a report that they want to share with a freind even though it would be easier to read with a little more care and attention to each word because every reader should be able to follow the explanation without struggling to understand the central point.";

test("the shared two-paragraph default has fixable errors and preserves comparison inputs", async ({ page }) => {
  const external: string[] = [];
  await page.route("https://**", (route) => { external.push(route.request().url()); return route.abort(); });
  await page.goto("/");
  const source = await page.getByLabel("Passage to check", { exact: true }).inputValue();
  const paragraphs = source.split("\n\n");
  expect(paragraphs).toHaveLength(2);
  expect(paragraphs.every((paragraph) => paragraph.trim().length > 0)).toBe(true);

  // One passage, so there is nothing to keep in sync.
  await expect(page.locator("textarea")).toHaveCount(1);

  await page.getByRole("button", { name: "Run Harper", exact: true }).click();
  await expectOutput(page, "Harper").toMatch(/We were supposed to review/);
  const corrected = await readOutput(page, "Harper");
  expect(corrected).toContain("a lot of details");
  expect(corrected).toContain("tomorrow's practice session");
  expect(corrected).toContain("would have tested");
  expect(corrected.split("\n\n")).toHaveLength(2);
  for (const fact of ["Maya", "Thursday", "25", "3:30", "today"]) {
    expect(corrected).toContain(fact);
  }
  await expect(page.locator(".findings")).toContainText("recieved");
  await expect(page.locator(".findings")).toContainText("received");
  await expect(page.getByLabel("Passage to check", { exact: true })).toHaveValue(source);
  expect(external).toEqual([]);

  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 900 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  }
});

test("Harper exposes spelling findings hidden by overlapping readability diagnostics", async ({ page }) => {
  const external: string[] = [];
  const resources: string[] = [];
  page.on("request", (request) => resources.push(request.url()));
  await page.route("https://**", (route) => { external.push(route.request().url()); return route.abort(); });
  await page.goto("/");
  await page.getByLabel("Passage to check", { exact: true }).fill(PASSAGE);
  await page.getByRole("button", { name: "Run Harper", exact: true }).click();
  await expectOutput(page, "Harper").toMatch(/^There are a lot of reasons/);
  await expect(page.locator(".findings")).toContainText("peeple");
  await expect(page.locator(".findings")).toContainText("people");
  await expect(page.locator(".findings")).toContainText("freind");
  await expect(page.getByLabel("Passage to check", { exact: true })).toHaveValue(PASSAGE);
  expect(external).toEqual([]);
  expect(resources.filter((url) => /transformers\.web|onnxruntime|rewrite\.worker/i.test(url))).toEqual([]);
  await expect(page.getByRole("button", { name: "Deeper check", exact: true })).toHaveCount(0);
});

test("the diff is the only output view and flows to its full height", async ({ page }) => {
  await page.goto("/");
  await page.getByLabel("Passage to check", { exact: true }).fill("We was ready.");
  await page.getByRole("button", { name: "Run Harper", exact: true }).click();
  const panel = page.locator("#harper-panel");
  const review = outputBlock(page, "Harper");
  await expect(review).toBeVisible();
  await expect(review.locator("del")).toHaveText("was");
  await expect(review.locator("ins")).toHaveText("were");

  // No view switcher: comparing engines is the whole task, so the diff is always on screen.
  await expect(panel.getByRole("tab")).toHaveCount(0);
  await expect(panel.locator(".output-tabs, .output-surface")).toHaveCount(0);

  // Nothing in the output region clips or scrolls; each panel is as tall as its result.
  const clipped = await panel.evaluate((element) => [...element.querySelectorAll(".diff-block, .findings ol")]
    .filter((node) => node.scrollHeight - node.clientHeight > 1).length);
  expect(clipped).toBe(0);

  // Nothing offers to export the result: the page exists to compare, not to produce text.
  await expect(panel.getByRole("button", { name: /copy/i })).toHaveCount(0);
  await expectOutput(page, "Harper").toBe("We were ready.");
  await expect(page.getByLabel("Passage to check", { exact: true })).toHaveValue("We was ready.");
});

test("an unchanged result stays readable and says so", async ({ page }) => {
  await page.goto("/");
  await page.getByLabel("Passage to check", { exact: true }).fill("The report is ready.");
  await page.getByRole("button", { name: "Run Harper", exact: true }).click();
  const panel = page.locator("#harper-panel");
  await expect(outputBlock(page, "Harper")).toHaveText("The report is ready.");
  await expect(panel.locator(".output-view-caption")).toHaveText("No textual changes.");
  await expect(panel.locator(".diff-block ins, .diff-block del")).toHaveCount(0);
});

test("five fixed inputs remain independent without input-copy controls", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Dictionary", exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Harper", exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "CoEdIT Base", exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Qwen 3 grammar", exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Qwen 3 rewrites", exact: true })).toBeVisible();
  await expect(page.getByLabel("Model", { exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: /copy.*input|use input in all/i })).toHaveCount(0);
  // A single passage feeds every engine, so comparisons can never drift apart.
  await expect(page.locator("textarea")).toHaveCount(1);
  await page.getByLabel("Passage to check", { exact: true }).fill("Shared passage.");
  await expect(page.getByLabel("Passage to check", { exact: true })).toHaveValue("Shared passage.");
  await expect(page.locator(".input-match")).toHaveCount(0);
  await expect(page.locator("#qwen-panel").getByRole("combobox")).toHaveCount(0);
  await expect(page.getByLabel("Rewrite action", { exact: true })).toHaveValue("professional");
  await expect(page.locator("#qwen-rewrite-action option[value='grammar']")).toHaveCount(0);
});

test("CoEdIT needs consent and serializes AI jobs without blocking Harper", async ({ page }) => {
  const external: string[] = [];
  await page.route("https://**", (route) => { external.push(route.request().url()); return route.abort(); });
  await page.addInitScript(() => {
    Object.defineProperty(window, "Proofreader", { value: class {
      static availability() { throw new Error("Comparison must not inspect native AI."); }
    } });
  });
  await page.goto("/");
  await page.getByLabel("Passage to check", { exact: true }).fill("We was ready.");
  await page.getByRole("button", { name: "Run CoEdIT Base", exact: true }).click();
  await expect(page.getByRole("button", { name: "Download and run" })).toBeVisible();
  await expect(page.locator(".download-prompt")).toContainText("CoEdIT");
  await expect(page.locator(".download-prompt")).toContainText("1090 MB");
  await expect(page.getByRole("button", { name: "Run Qwen 3 grammar", exact: true })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Run Qwen 3 rewrites", exact: true })).toBeDisabled();
  await page.getByRole("button", { name: "Run Harper", exact: true }).click();
  await page.getByLabel("Passage to check", { exact: true }).focus();
  await expectOutput(page, "Harper").toBe("We were ready.");
  await expect(page.getByLabel("Passage to check", { exact: true })).toBeFocused();
  await expect(page.getByRole("button", { name: "Download and run" })).toBeVisible();
  expect(external).toEqual([]);
  await page.getByRole("button", { name: "Not now", exact: true }).click();
  await expect(page.getByLabel("Passage to check", { exact: true })).toHaveValue("We was ready.");
  await expect(page.getByRole("button", { name: "Run CoEdIT Base", exact: true })).toBeEnabled();
  await expect(page.getByRole("button", { name: "Run Qwen 3 grammar", exact: true })).toBeEnabled();
  await expect(page.getByRole("button", { name: "Run Qwen 3 rewrites", exact: true })).toBeEnabled();
});

test("the dictionary runs with no download gate and refuses to guess", async ({ page }) => {
  const external: string[] = [];
  await page.route("https://**", (route) => { external.push(route.request().url()); return route.abort(); });
  await page.goto("/");
  await page.getByLabel("Passage to check", { exact: true })
    .fill("I recieved it and we havent finished, so keep the adress seperate.");
  await page.getByRole("button", { name: "Run Dictionary", exact: true }).click();

  // The word list ships with the page, so nothing is fetched and nothing is approved.
  await expectOutput(page, "Dictionary").toBe("I received it and we haven't finished, so keep the adress separate.");
  await expect(page.locator(".download-prompt")).toHaveCount(0);
  expect(external).toEqual([]);

  // Findings are attributed to the engine that produced them, not to Harper.
  await expect(page.locator("#dictionary-panel .findings summary"))
    .toHaveText("4 Dictionary findings · 1 not applied automatically");
  await expect(page.locator("#dictionary-panel .findings")).not.toContainText("Harper");

  // `adress` is equally near `address` and `dress`, so it is reported rather than replaced.
  const findings = page.locator("#dictionary-panel .findings li");
  await expect(findings).toHaveCount(4);
  await expect(findings.filter({ hasText: "adress" })).toContainText("address");
  await expect(findings.filter({ hasText: "adress" })).not.toContainText("Applied");
});

test("Run all five asks for every missing download once, then runs unattended", async ({ page }) => {
  const external: string[] = [];
  await page.route("https://**", (route) => { external.push(route.request().url()); return route.abort(); });
  await page.addInitScript(() => {
    Object.defineProperty(window, "Worker", { value: class {
      onmessage: ((event: MessageEvent) => void) | null = null;
      private engine = "";
      private id = 0;
      postMessage(request: { type: string; id: number; engine: string; key?: string }) {
        if (request.type === "allow-download") {
          queueMicrotask(() => this.onmessage?.(new MessageEvent("message", { data: {
            type: "result", id: this.id, engine: this.engine, backend: "webgpu",
            text: "We were ready.", warnings: [],
          } })));
          return;
        }
        if (request.type !== "rewrite") return;
        this.engine = request.engine;
        this.id = request.id;
        if (request.engine === "harper" || request.engine === "dictionary") {
          queueMicrotask(() => this.onmessage?.(new MessageEvent("message", { data: {
            type: "result", id: request.id, engine: request.engine, backend: "wasm",
            text: "We were ready.", warnings: [],
          } })));
          return;
        }
        // Every neural engine demands approval before it will fetch weights.
        queueMicrotask(() => this.onmessage?.(new MessageEvent("message", { data: {
          type: "download-required", id: request.id, engine: request.engine,
          download: {
            key: request.engine === "coedit"
              ? "imrahamed/coedit-base-webgpu-onnx@bb88a28f63cf459d0ba4f00ebea36446172d0c30:fp32"
              : "onnx-community/Qwen3-0.6B-ONNX@da1453100cf3ff33ef56d17983fc7a8648706db6:q4f16",
            label: request.engine === "coedit" ? "CoEdIT Base (evaluation)" : "Qwen 3 (q4f16)",
            size: "about 570 MB", source: "huggingface",
          },
        } })));
      }
      terminate() {}
    } });
  });
  await page.goto("/");
  await page.getByLabel("Passage to check", { exact: true }).fill("We was ready.");
  await page.getByRole("button", { name: "Run all five", exact: true }).click();

  // Consent is collected up front, as one decision, for the engines that actually download.
  const prompt = page.locator(".batch-prompt");
  await expect(prompt).toBeVisible();
  await expect(prompt).toContainText("CoEdIT Base (evaluation)");
  await expect(prompt).toContainText("Qwen 3");
  await expect(prompt).toContainText("1.66 GB");
  await expect(page.getByRole("button", { name: "Run all five", exact: true })).toBeDisabled();

  // The bundled engines cost nothing to run, so they must not wait behind a neural download decision.
  await expectOutput(page, "Dictionary").toBe("We were ready.");
  await expectOutput(page, "Harper").toBe("We were ready.");

  await page.getByRole("button", { name: "Download and run all five", exact: true }).click();
  await expect(prompt).toHaveCount(0);

  // No further clicks: each per-engine gate is answered by the approval already given.
  for (const title of ["Dictionary", "Harper", "CoEdIT Base", "Qwen 3 grammar", "Qwen 3 rewrites"]) {
    await expectOutput(page, title).toBe("We were ready.");
  }
  await expect(page.locator(".download-prompt")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Run all five", exact: true })).toBeEnabled();
  expect(external).toEqual([]);
});

test("declining the neural download keeps the results that cost nothing", async ({ page }) => {
  const external: string[] = [];
  await page.route("https://**", (route) => { external.push(route.request().url()); return route.abort(); });
  await page.addInitScript(() => {
    Object.defineProperty(window, "Worker", { value: class {
      onmessage: ((event: MessageEvent) => void) | null = null;
      postMessage(request: { type: string; id: number; engine: string }) {
        if (request.type !== "rewrite") return;
        const local = request.engine === "harper" || request.engine === "dictionary";
        queueMicrotask(() => this.onmessage?.(new MessageEvent("message", { data: local
          ? { type: "result", id: request.id, engine: request.engine, backend: "wasm", text: "We were ready.", warnings: [] }
          : { type: "download-required", id: request.id, engine: request.engine, download: {
            key: "onnx-community/Qwen3-0.6B-ONNX@da1453100cf3ff33ef56d17983fc7a8648706db6:q4f16",
            label: "Qwen 3 (q4f16)", size: "about 570 MB", source: "huggingface",
          } } })));
      }
      terminate() {}
    } });
  });
  await page.goto("/");
  await page.getByLabel("Passage to check", { exact: true }).fill("We was ready.");
  await page.getByRole("button", { name: "Run all five", exact: true }).click();
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(page.locator(".batch-prompt")).toHaveCount(0);

  // Refusing a multi-gigabyte download must not cost the visitor the results that were free.
  await expectOutput(page, "Dictionary").toBe("We were ready.");
  await expectOutput(page, "Harper").toBe("We were ready.");
  expect(external).toEqual([]);
});

test("Run all five skips the approval step when the weights are already cached", async ({ page }) => {
  await page.addInitScript(() => {
    const cached = [
      ["imrahamed/coedit-base-webgpu-onnx", "bb88a28f63cf459d0ba4f00ebea36446172d0c30",
        ["onnx/encoder_model.onnx", "onnx/decoder_model_merged.onnx"]],
      ["onnx-community/Qwen3-0.6B-ONNX", "da1453100cf3ff33ef56d17983fc7a8648706db6", ["onnx/model_q4f16.onnx"]],
    ] as const;
    const keys = cached.flatMap(([id, revision, files]) =>
      [...files, "config.json", "generation_config.json", "tokenizer.json", "tokenizer_config.json"]
        .map((file) => ({ url: `https://huggingface.co/${id}/resolve/${revision}/${file}` })));
    Object.defineProperty(globalThis, "caches", { value: {
      has: () => Promise.resolve(true),
      open: () => Promise.resolve({ keys: () => Promise.resolve(keys) }),
    } });
    Object.defineProperty(window, "Worker", { value: class {
      onmessage: ((event: MessageEvent) => void) | null = null;
      postMessage(request: { type: string; id: number; engine: string }) {
        if (request.type !== "rewrite") return;
        queueMicrotask(() => this.onmessage?.(new MessageEvent("message", { data: {
          type: "result", id: request.id, engine: request.engine, backend: "webgpu",
          text: "We were ready.", warnings: [],
        } })));
      }
      terminate() {}
    } });
  });
  await page.goto("/");
  await page.getByLabel("Passage to check", { exact: true }).fill("We was ready.");
  await page.getByRole("button", { name: "Run all five", exact: true }).click();
  await expect(page.locator(".batch-prompt")).toHaveCount(0);
  for (const title of ["Dictionary", "Harper", "CoEdIT Base", "Qwen 3 grammar", "Qwen 3 rewrites"]) {
    await expectOutput(page, title).toBe("We were ready.");
  }
});

test("AI candidates remain visible without capitalization cleanup or safety replacement", async ({ page }) => {  await page.addInitScript(() => {
    Object.defineProperty(window, "Worker", { value: class {
      onmessage: ((event: MessageEvent) => void) | null = null;
      postMessage(request: { type: string; id: number; engine: string; comparison?: boolean }) {
        if (request.type !== "rewrite") return;
        if (!request.comparison) throw new Error("Comparison mode was not requested.");
        queueMicrotask(() => this.onmessage?.(new MessageEvent("message", { data: {
          type: "result", id: request.id, engine: request.engine, backend: "webgpu",
          text: "we was ready at 3.", warnings: ["The number needs review."],
        } })));
      }
      terminate() {}
    } });
  });
  await page.goto("/");
  await page.getByLabel("Passage to check", { exact: true }).fill("We were ready.");
  await page.getByRole("button", { name: "Run CoEdIT Base", exact: true }).click();
  await expectOutput(page, "CoEdIT Base").toBe("we was ready at 3.");
  await expect(outputBlock(page, "CoEdIT Base")).toBeVisible();
  await expect(page.getByLabel("Passage to check", { exact: true })).toHaveValue("We were ready.");
  await expect(page.locator(".review-notes")).toContainText("The number needs review.");
});

test("editing the passage cancels running jobs and ignores a late worker result", async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(window, "Worker", { value: class {
      onmessage: ((event: MessageEvent) => void) | null = null;
      postMessage(request: { type: string; id: number; engine: string }) {
        if (request.type !== "rewrite") return;
        document.documentElement.dataset.started = "true";
        setTimeout(() => {
          document.documentElement.dataset.finished = "true";
          this.onmessage?.(new MessageEvent("message", { data: {
            type: "result", id: request.id, engine: request.engine,
            backend: "webgpu", text: "Old output.", warnings: [],
          } }));
        }, 250);
      }
      terminate() {}
    } });
  });
  await page.goto("/");
  await page.getByLabel("Passage to check", { exact: true }).fill("Check this passage.");
  await page.getByRole("button", { name: "Run CoEdIT Base", exact: true }).click();
  await expect(page.locator("html")).toHaveAttribute("data-started", "true");
  await page.getByLabel("Passage to check", { exact: true }).fill("New input.");
  await expect(page.locator("html")).toHaveAttribute("data-finished", "true");
  // The late result belongs to text the visitor has already replaced, so it must not appear.
  await expect(outputBlock(page, "CoEdIT Base")).toHaveCount(0);
  await expect(page.getByLabel("Passage to check", { exact: true })).toHaveValue("New input.");
});

test("comparison panels work on a narrow screen and focus the completed output", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/");
  await page.getByLabel("Passage to check", { exact: true }).fill("We was ready.");
  await page.getByRole("button", { name: "Run Harper", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Harper output", exact: true })).toBeFocused();
  await expect(outputBlock(page, "Harper")).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await expect(page.getByLabel("Passage to check", { exact: true })).toBeVisible();
  await expect(page.getByLabel("Passage to check", { exact: true })).toBeVisible();
  await expect(page.getByLabel("Passage to check", { exact: true })).toBeVisible();
});

test("every output persists and Qwen grammar stays separate from tone rewrites", async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(window, "Worker", { value: class {
      onmessage: ((event: MessageEvent) => void) | null = null;
      engine = "";
      postMessage(request: { type: string; id: number; engine: string; action: string; text: string; comparison?: boolean }) {
        if (request.type !== "rewrite") return;
        if (!request.comparison) throw new Error("Comparison mode is required.");
        this.engine = request.engine;
        if (request.action !== "grammar") document.documentElement.dataset.rewriteSource = request.text;
        queueMicrotask(() => this.onmessage?.(new MessageEvent("message", { data: {
          type: "result", id: request.id, engine: request.engine,
          backend: request.engine === "harper" ? "wasm" : "webgpu",
          text: `${request.engine} ${request.action} result.`, warnings: [],
        } })));
      }
      terminate() {
        document.documentElement.dataset.released = [
          document.documentElement.dataset.released, this.engine,
        ].filter(Boolean).join(",");
      }
    } });
  });
  await page.setViewportSize({ width: 1900, height: 1000 });
  await page.goto("/");
  await page.getByLabel("Passage to check", { exact: true }).fill("We was ready.");
  await page.getByLabel("Passage to check", { exact: true }).fill("Please send the draft tomorrow.");
  for (const title of ["Harper", "CoEdIT Base", "Qwen 3 grammar", "Qwen 3 rewrites"]) {
    await page.getByRole("button", { name: `Run ${title}`, exact: true }).click();
    await expect(outputBlock(page, title)).toHaveCount(1);
  }
  await expectOutput(page, "Harper").toBe("harper grammar result.");
  await expectOutput(page, "CoEdIT Base").toBe("coedit grammar result.");
  await expectOutput(page, "Qwen 3 grammar").toBe("qwen grammar result.");
  await expectOutput(page, "Qwen 3 rewrites").toBe("qwen professional result.");
  await expect(page.locator("html")).toHaveAttribute("data-rewrite-source", "Please send the draft tomorrow.");
  await expect(page.locator("html")).toHaveAttribute("data-released", "coedit");
  const harper = page.locator("#harper-panel");
  const coedit = page.locator("#coedit-panel");
  const qwen = page.locator("#qwen-panel");
  const rewrite = page.locator("#qwen-rewrite-panel");
  // All four results stay on screen together; that simultaneity is the point of the page.
  for (const panel of [harper, coedit, qwen, rewrite]) {
    await expect(panel.locator(".diff-block")).toBeVisible();
  }
  const boxes = await Promise.all([harper.boundingBox(), coedit.boundingBox(), qwen.boundingBox(), rewrite.boundingBox()]);
  expect(boxes.every((box) => box && box.y === boxes[0]?.y)).toBe(true);
  expect(boxes[0]!.x + boxes[0]!.width).toBeLessThanOrEqual(boxes[1]!.x);
  expect(boxes[1]!.x + boxes[1]!.width).toBeLessThanOrEqual(boxes[2]!.x);
  expect(boxes[2]!.x + boxes[2]!.width).toBeLessThanOrEqual(boxes[3]!.x);
  await page.getByLabel("Rewrite action", { exact: true }).selectOption("casual");
  await expect(outputBlock(page, "Qwen 3 rewrites")).toHaveCount(0);
  await expectOutput(page, "Qwen 3 grammar").toBe("qwen grammar result.");
  await page.getByRole("button", { name: "Run Qwen 3 rewrites", exact: true }).click();
  await expectOutput(page, "Qwen 3 rewrites").toBe("qwen casual result.");
  await page.getByRole("button", { name: "Run Qwen 3 grammar", exact: true }).click();
  await expectOutput(page, "Qwen 3 grammar").toBe("qwen grammar result.");
  await expectOutput(page, "Qwen 3 rewrites").toBe("qwen casual result.");
});

test("WebMCP explicitly selects the engine and returns findings without applying output", async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(document, "modelContext", { value: {
      registerTool(tool: { execute(input: unknown): Promise<unknown> }) {
        Object.defineProperty(window, "editorTool", { value: tool });
      },
    } });
  });
  await page.goto("/");
  await expect(page.getByRole("button", { name: "Run Harper", exact: true })).toBeVisible();
  const result = await page.evaluate(async () => {
    const tool = Reflect.get(window, "editorTool") as { execute(input: unknown): Promise<unknown> };
    return tool.execute({ text: "We was ready.", engine: "harper", action: "grammar" });
  });
  expect(result).toMatchObject({ rewrittenText: "We were ready.", engine: "harper", state: "previewed" });
  expect(result).toHaveProperty("findings");
  await expect(page.getByLabel("Passage to check", { exact: true })).toHaveValue("We was ready.");
});

test("the page describes itself without product branding and announces the agent tool only when present", async ({ page }) => {
  await page.goto("/");
  await expect(page).toHaveTitle(/On-device spelling and grammar/);
  await expect(page.locator(".wordmark")).toHaveText("On-device spelling & grammar");
  await expect(page.locator("body")).not.toContainText("Local Edit");
  await expect(page.locator(".site-footer")).not.toContainText("blending");

  // The WebMCP claim must not be shown in a browser with no agent runtime.
  await expect(page.locator(".agent-note")).toHaveCount(0);

  // The skip link is the first tab stop, stays offscreen until focused, and reaches the first input.
  expect(await page.evaluate(() => document.querySelector(".skip-link")!.getBoundingClientRect().bottom <= 0)).toBe(true);
  await page.keyboard.press("Tab");
  await expect(page.getByRole("link", { name: "Skip to the passage" })).toBeFocused();
  expect(await page.evaluate(() => document.querySelector(".skip-link")!.getBoundingClientRect().top >= 0)).toBe(true);
  await page.keyboard.press("Enter");
  await expect(page.getByLabel("Passage to check", { exact: true })).toBeInViewport();
});

test("the agent tool note appears once a WebMCP runtime registers the tool", async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(document, "modelContext", { value: { registerTool: () => Promise.resolve({}) } });
  });
  await page.goto("/");
  await expect(page.locator(".agent-note")).toContainText("WebMCP");
});

test("test cases isolate the boundary each one names, and switching clears stale output", async ({ page }) => {
  const external: string[] = [];
  await page.route("https://**", (route) => { external.push(route.request().url()); return route.abort(); });
  await page.goto("/");
  const passage = page.getByLabel("Passage to check", { exact: true });

  // The spelling case is the word list's best case: every misspelling has one plausible fix.
  await page.getByRole("button", { name: "Misspellings only" }).click();
  await expect(passage).toHaveValue(/neccesary to mesure/);
  await page.getByRole("button", { name: "Run Dictionary", exact: true }).click();
  await expectOutput(page, "Dictionary").toContain("necessary to measure");
  await expect(page.locator("#dictionary-panel .diff-block ins")).not.toHaveCount(0);

  // Choosing another case invalidates the comparison, so the old result cannot linger beside it.
  await page.getByRole("button", { name: "Grammar, not spelling" }).click();
  await expect(page.locator("#dictionary-panel .diff-block")).toHaveCount(0);
  await expect(passage).toHaveValue(/neither of the coordinators have signed/);
  // The explanation tracks the selection rather than describing whichever case was chosen first.
  await expect(page.locator(".sample-hint")).toContainText("spelled correctly");

  // Every word is spelled correctly, so a speller has nothing to say — the capability boundary.
  await page.getByRole("button", { name: "Run Dictionary", exact: true }).click();
  await expect(page.locator("#dictionary-panel .output-view-caption")).toHaveText("No textual changes.");
  await expect(page.locator("#dictionary-panel .diff-block ins, #dictionary-panel .diff-block del")).toHaveCount(0);

  // Harper reads the same passage as rules rather than words, so it finds real errors there.
  await page.getByRole("button", { name: "Run Harper", exact: true }).click();
  await expectOutput(page, "Harper").toContain("We were going to review");

  // Nothing in the traps passage is wrong, so a rule engine must leave identifiers and names alone.
  await page.getByRole("button", { name: "Leave this alone" }).click();
  await page.getByRole("button", { name: "Run Harper", exact: true }).click();
  await expect(page.locator("#harper-panel .output-view-caption")).toHaveText("No textual changes.");
  await expectOutput(page, "Harper").toContain("config/app.json");

  // The chosen case is announced as pressed, and none of this cost a network request.
  await expect(page.getByRole("button", { name: "Leave this alone" })).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByRole("button", { name: "Misspellings only" })).toHaveAttribute("aria-pressed", "false");
  expect(external).toEqual([]);
});
