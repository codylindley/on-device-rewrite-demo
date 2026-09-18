import assert from "node:assert/strict";
import test from "node:test";
import { EditorEngine } from "../src/lib/editor-engine.ts";
import type { WorkerPort } from "../src/lib/worker-client.ts";
import type { RewriteRequest, WorkerEngine, WorkerRequest, WorkerResponse } from "../src/types.ts";

class TestWorker implements WorkerPort {
  onmessage: WorkerPort["onmessage"] = null;
  onerror: WorkerPort["onerror"] = null;
  onmessageerror: WorkerPort["onmessageerror"] = null;
  terminated = false;
  constructor(readonly engine: WorkerEngine) {}
  postMessage(request: WorkerRequest): void {
    if (request.type !== "rewrite") return;
    queueMicrotask(() => {
      if (this.terminated) return;
      if (this.engine !== "harper") {
        this.emit({ type: "model-ready", id: request.id, engine: this.engine, backend: "wasm", source: "cache" });
      }
      this.emit({
        type: "result", id: request.id, engine: this.engine, backend: "wasm",
        text: request.text.replace("We was", "We were"), warnings: [],
      });
    });
  }
  terminate(): void { this.terminated = true; }
  private emit(data: WorkerResponse): void { this.onmessage?.(new MessageEvent("message", { data })); }
}

const base: RewriteRequest = {
  type: "rewrite", id: 1, action: "grammar", text: "We was ready.", attempt: 0, comparison: true,
};

test("each column reaches exactly the engine it names", async () => {
  const created: WorkerEngine[] = [];
  const editor = new EditorEngine({
    createWorker(engine) { created.push(engine); return new TestWorker(engine); },
  });

  assert.equal((await editor.run({ ...base, engine: "harper" }, () => {})).engine, "harper");
  assert.equal((await editor.run({ ...base, id: 2, engine: "dictionary" }, () => {})).engine, "dictionary");
  assert.equal(
    (await editor.run({ ...base, id: 3, engine: "coedit", grammarDepth: "deep" }, () => {})).engine,
    "coedit",
  );
  assert.equal(
    (await editor.run({ ...base, id: 4, action: "confident", engine: "qwen" }, () => {})).engine,
    "qwen",
  );
  assert.deepEqual(created, ["harper", "dictionary", "coedit", "qwen"]);
  editor.dispose();
});

test("a request without an engine is refused rather than routed by guesswork", async () => {
  const created: WorkerEngine[] = [];
  const editor = new EditorEngine({
    createWorker(engine) { created.push(engine); return new TestWorker(engine); },
  });

  await assert.rejects(editor.run(base, () => {}), /Choose an engine/);
  assert.deepEqual(created, []);
  assert.equal((await editor.run({ ...base, engine: "harper" }, () => {})).engine, "harper");
  assert.deepEqual(created, ["harper"]);
  editor.dispose();
});

test("switching neural models releases the previous model but retains Harper", async () => {
  const workers: TestWorker[] = [];
  const editor = new EditorEngine({
    createWorker(engine) { const worker = new TestWorker(engine); workers.push(worker); return worker; },
  });

  await editor.run({ ...base, engine: "harper" }, () => {});
  await editor.run({ ...base, id: 2, engine: "coedit", grammarDepth: "deep" }, () => {});
  await editor.run({ ...base, id: 3, action: "confident", engine: "qwen" }, () => {});

  assert.equal(workers.find(({ engine }) => engine === "coedit")?.terminated, true);
  assert.equal(workers.find(({ engine }) => engine === "harper")?.terminated, false);
  assert.equal(workers.filter(({ engine, terminated }) => engine !== "harper" && !terminated).length, 1);
  editor.dispose();
});

test("approval is refused for another request or another build", async () => {
  const editor = new EditorEngine({ createWorker: (engine) => new TestWorker(engine) });

  assert.equal(editor.approveDownload(1, "qwen:any"), false);
  await editor.run({ ...base, action: "confident", engine: "qwen" }, () => {});
  assert.equal(editor.approveDownload(999, "qwen:any"), false);
  editor.dispose();
});

test("an invalid request and a second concurrent run are both rejected", async () => {
  const editor = new EditorEngine({ createWorker: (engine) => new TestWorker(engine) });

  await assert.rejects(editor.run({ ...base, text: "   " }, () => {}), /Invalid editing request/);
  const first = editor.run({ ...base, action: "confident", engine: "qwen" }, () => {});
  await assert.rejects(
    editor.run({ ...base, id: 2, action: "confident", engine: "qwen" }, () => {}),
    /Another edit is already running/,
  );
  await first;
  editor.dispose();
});

test("canceling settles the pending run and leaves the engine reusable", async () => {
  const editor = new EditorEngine({ createWorker: (engine) => new TestWorker(engine) });

  const pending = editor.run({ ...base, action: "confident", engine: "qwen" }, () => {});
  editor.cancel();
  await assert.rejects(pending, { name: "AbortError" });
  assert.equal((await editor.run({ ...base, id: 2, engine: "harper" }, () => {})).engine, "harper");
  editor.dispose();
});
