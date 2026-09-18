import { chromium } from "@playwright/test";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { parseArgs } from "node:util";
import { createHash } from "node:crypto";
import { summarize } from "../benchmarks/score.mjs";

const { values } = parseArgs({
  options: {
    url: { type: "string", default: "http://127.0.0.1:5187/" },
    engine: { type: "string", default: "harper" },
    output: { type: "string" },
    profile: { type: "string" },
    "worker-path": { type: "string" },
    backend: { type: "string", default: "auto" },
    comparison: { type: "boolean", default: false },
    limit: { type: "string", default: "120" },
    "allow-downloads": { type: "boolean", default: false },
  },
});
if (!["harper", "qwen", "coedit"].includes(values.engine)) throw new Error("Unsupported engine.");
if (!["auto", "wasm"].includes(values.backend)) throw new Error("--backend must be auto or wasm.");
if (!values.output || !values.profile) throw new Error("--output and --profile are required.");
if (values.engine !== "harper" && !values["allow-downloads"]) {
  throw new Error("Model evaluation requires explicit --allow-downloads consent.");
}
const corpus = JSON.parse(await readFile(new URL("../benchmarks/grammar-corpus.json", import.meta.url), "utf8"));
const allCases = Array.isArray(corpus) ? corpus : corpus.cases;
if (!Array.isArray(allCases)) throw new Error("The benchmark corpus must contain cases.");
const limit = Number(values.limit);
if (!Number.isSafeInteger(limit) || limit < 1) throw new Error("--limit must be a positive integer.");
const cases = allCases.slice(0, limit);
// Reject malformed annotations before authorizing a model download.
summarize(cases, []);
const context = await chromium.launchPersistentContext(resolve(values.profile), {
  channel: "chrome",
  headless: true,
});
const page = await context.newPage();
const workerPath = values["worker-path"] ?? (values.engine === "harper" ? "/src/grammar.worker.ts" : "/src/rewrite.worker.ts");
const workerUrl = new URL(workerPath, values.url);
if (values.backend === "wasm") {
  await page.route((url) => url.href === workerUrl.href, async (route) => {
    const response = await route.fetch();
    await route.fulfill({
      response,
      body: `Object.defineProperty(navigator, "gpu", {value: undefined});\n${await response.text()}`,
    });
  });
}
const downloads = [];
const networkTasks = [];
page.on("requestfinished", (request) => {
  if (!/^https:/.test(request.url())) return;
  networkTasks.push((async () => {
    const sizes = await request.sizes();
    downloads.push({ url: request.url(), bytes: sizes.responseBodySize });
  })().catch((error) => { downloads.push({ url: request.url(), error: String(error) }); }));
});
const results = [];
const report = {
  recordedAt: new Date().toISOString(),
  url: values.url,
  engine: values.engine,
  requestedBackend: values.backend,
  comparison: values.comparison,
  workerPath,
  corpusSha256: createHash("sha256").update(JSON.stringify(cases)).digest("hex"),
  browser: context.browser()?.version(),
  note: "Reference matching is not a semantic quality judgment. Review outputs and errors.",
  corpus: cases,
  results,
  downloads,
};
const output = resolve(values.output);
await mkdir(dirname(output), { recursive: true });
try {
  await page.goto(values.url);
  report.capabilities = await page.evaluate(async () => ({
    userAgent: navigator.userAgent,
    webgpu: !!(await navigator.gpu?.requestAdapter()),
    nativeProofreader: "Proofreader" in self,
    nativeRewriter: "Rewriter" in self,
  }));
  await page.evaluate((path) => {
    window.benchmarkWorker = new Worker(path, { type: "module" });
  }, workerPath);
  for (const [index, item] of cases.entries()) {
    const result = await page.evaluate(async ({ item, index, engine, allowDownloads, comparison }) => {
      const started = performance.now();
      const events = [];
      return new Promise((resolveResult) => {
        const worker = window.benchmarkWorker;
        const id = index + 1;
        const timer = setTimeout(() => finish({ error: "Benchmark case timed out." }), 180_000);
        const finish = (message) => {
          clearTimeout(timer);
          worker.removeEventListener("message", handle);
          worker.removeEventListener("error", onError);
          const rejected = typeof message.error === "string" &&
            /^The (?:model|proofreader) could not produce a usable edit\./.test(message.error);
          resolveResult({
            id: item.id, engine, text: message.text ?? null,
            warnings: message.warnings ?? [], error: rejected ? null : message.error ?? null,
            rejectionReason: rejected ? message.error : undefined,
            outcome: rejected ? "rejected" : message.error ? "error" : "produced",
            backend: message.backend ?? null, elapsedMs: performance.now() - started, events,
            findings: message.findings,
          });
        };
        const onError = (event) => finish({ error: event.message || "Worker crashed." });
        const handle = ({ data }) => {
          if (data.id !== id) return;
          if (data.type !== "progress") events.push(data);
          if (data.type === "download-required") {
            if (!allowDownloads) finish({ error: "Download not approved for this benchmark." });
            else worker.postMessage({ type: "allow-download", id, key: data.download.key });
          }
          if (data.type === "result") finish(data);
          if (data.type === "error") finish({ error: data.message });
        };
        worker.addEventListener("message", handle);
        worker.addEventListener("error", onError);
        worker.postMessage({
          type: "rewrite", id, action: "grammar", text: item.input, attempt: 0,
          engine, comparison, grammarDepth: engine === "harper" ? "quick" : "deep",
        });
      });
    }, { item, index, engine: values.engine, allowDownloads: values["allow-downloads"], comparison: values.comparison });
    results.push(result);
    await writeFile(output, `${JSON.stringify(report, null, 2)}\n`);
    if (result.outcome === "error") {
      throw new Error(result.error);
    }
    if ((index + 1) % 10 === 0 || index === cases.length - 1) {
      console.log(`${values.engine}: ${index + 1}/${cases.length}, ${results.filter((row) => row.outcome !== "produced").length} rejected or failed`);
    }
  }
  await Promise.all(networkTasks);
  await writeFile(output, `${JSON.stringify(report, null, 2)}\n`);
} finally {
  await context.close();
}
