import assert from "node:assert/strict";
import test from "node:test";
import { WorkerClient, type WorkerPort } from "../src/lib/worker-client.ts";
import type { RewriteRequest, WorkerRequest, WorkerResponse } from "../src/types.ts";

class FakeWorker implements WorkerPort {
  onmessage: WorkerPort["onmessage"] = null;
  onerror: WorkerPort["onerror"] = null;
  onmessageerror: WorkerPort["onmessageerror"] = null;
  messages: WorkerRequest[] = [];
  terminated = false;
  postMessage(message: WorkerRequest) { this.messages.push(message); }
  terminate() { this.terminated = true; }
  emit(message: WorkerResponse) { this.onmessage?.(new MessageEvent("message", { data: message })); }
}
const request: RewriteRequest = { type: "rewrite", id: 1, text: "The report is ready.", action: "grammar", attempt: 0 };

test("stale results and approvals cannot settle a current request", async () => {
  const worker = new FakeWorker();
  const client = new WorkerClient("harper", () => worker);
  const events: WorkerResponse[] = [];
  const result = client.run(request, (message) => events.push(message));
  worker.emit({ type: "result", id: 2, engine: "harper", backend: "wasm", text: "stale", warnings: [] });
  assert.equal(events.length, 0);
  assert.equal(client.approve(1, "unexpected"), false);
  worker.emit({ type: "result", id: 1, engine: "harper", backend: "wasm", text: request.text, warnings: [] });
  assert.equal((await result).text, request.text);
  assert.equal(client.ready, false);
});

test("cancellation rejects promptly and terminates only this worker", async () => {
  const worker = new FakeWorker();
  const client = new WorkerClient("qwen", () => worker);
  const result = client.run(request, () => {});
  client.cancel();
  await assert.rejects(result, { name: "AbortError" });
  assert.equal(worker.terminated, true);
  assert.equal(client.ready, false);
});

test("download approval needs the current request and artifact key", async () => {
  const worker = new FakeWorker();
  const client = new WorkerClient("qwen", () => worker);
  const result = client.run(request, () => {});
  worker.emit({
    type: "download-required", id: 1, engine: "qwen",
    download: { key: "qwen:revision:q4", label: "Qwen", size: "570 MB", source: "huggingface" },
  });
  assert.equal(client.approve(2, "qwen:revision:q4"), false);
  assert.equal(client.approve(1, "coedit:revision:q8"), false);
  assert.equal(client.approve(1, "qwen:revision:q4"), true);
  assert.equal(client.approve(1, "qwen:revision:q4"), false);
  worker.emit({ type: "error", id: 1, engine: "qwen", message: "Download failed." });
  await assert.rejects(result, /Download failed/);
});
