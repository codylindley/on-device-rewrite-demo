/// <reference lib="webworker" />

import nspell from "nspell";
import affixUrl from "./assets/dictionary/en.aff?url";
import dictionaryUrl from "./assets/dictionary/en.dic?url";
import { spellcheckText, type Speller } from "./lib/dictionary-spell";
import { comparisonWarnings } from "./lib/compare";
import { isRewriteRequest, type EngineEvent, type WorkerResponse } from "./types";

const scope = self as unknown as DedicatedWorkerGlobalScope;
let running = false;
let speller: Promise<Speller> | null = null;

/** The word list is a static asset on this origin, so it needs no download approval. */
async function readAsset(url: string): Promise<string> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Could not load the word list (${response.status}).`);
  return await response.text();
}

function loadSpeller(): Promise<Speller> {
  speller ??= (async () => {
    const [affix, dictionary] = await Promise.all([readAsset(affixUrl), readAsset(dictionaryUrl)]);
    return nspell(affix, dictionary);
  })().catch((error: unknown) => { speller = null; throw error; });
  return speller;
}

scope.addEventListener("message", (event: MessageEvent<unknown>) => {
  if (!isRewriteRequest(event.data) || event.data.action !== "grammar" || event.data.engine !== "dictionary") {
    console.error("The dictionary worker received an invalid request.");
    scope.postMessage({ type: "error", id: 0, engine: "dictionary", message: "Invalid dictionary request." });
    return;
  }
  const request = event.data;
  const post = (message: EngineEvent) => {
    scope.postMessage({ ...message, id: request.id, engine: "dictionary" } satisfies WorkerResponse);
  };
  if (running) {
    post({ type: "error", message: "Another dictionary check is running." });
    return;
  }
  running = true;
  void (async () => {
    post({ type: "status", phase: "loading", message: "Loading the English word list…" });
    const loaded = await loadSpeller();
    post({ type: "model-ready", backend: "javascript", source: "cache" });
    post({ type: "status", phase: "generating", message: "Checking every word against the dictionary…" });
    const result = spellcheckText(request.text, loaded);
    post({
      type: "result", text: result.text, findings: result.findings, backend: "javascript",
      warnings: comparisonWarnings("grammar", request.text, result.text),
    });
  })().catch((error: unknown) => {
    console.error("Dictionary check failed.", error);
    post({ type: "error", message: error instanceof Error ? error.message : String(error) });
  }).finally(() => { running = false; });
});
