/// <reference lib="webworker" />

import { getLocalProofreader } from "./lib/browser-proofreader";
import { proofreadText } from "./lib/quick-grammar";
import { inspectProofreading } from "./lib/proofread";
import { comparisonWarnings } from "./lib/compare";
import { isRewriteRequest, type EngineEvent, type WorkerResponse } from "./types";

const scope = self as unknown as DedicatedWorkerGlobalScope;
let running = false;

scope.addEventListener("message", (event: MessageEvent<unknown>) => {
  if (!isRewriteRequest(event.data) || event.data.action !== "grammar" ||
      event.data.grammarDepth === "deep" || (event.data.engine && event.data.engine !== "harper")) {
    console.error("The grammar worker received an invalid request.");
    scope.postMessage({ type: "error", id: 0, engine: "harper", message: "Invalid quick grammar request." });
    return;
  }
  const request = event.data;
  const post = (message: EngineEvent) => {
    scope.postMessage({ ...message, id: request.id, engine: "harper" } satisfies WorkerResponse);
  };
  if (running) {
    post({ type: "error", message: "Another quick grammar check is running." });
    return;
  }
  running = true;
  void (async () => {
    post({ type: "status", phase: "loading", message: "Preparing Harper on this device…" });
    const linter = await getLocalProofreader();
    post({ type: "status", phase: "generating", message: "Checking spelling and grammar with Harper…" });
    if (request.comparison) {
      const result = await inspectProofreading(request.text, linter);
      post({
        type: "result", ...result, backend: "wasm",
        warnings: comparisonWarnings("grammar", request.text, result.text),
      });
      return;
    }
    const result = await proofreadText(request.text, linter, (completed, total) => {
      post({ type: "editing-progress", completed, total });
    });
    post({ type: "result", ...result, backend: "wasm" });
  })().catch((error: unknown) => {
    console.error("Quick grammar check failed.", error);
    post({ type: "error", message: error instanceof Error ? error.message : String(error) });
  }).finally(() => { running = false; });
});
