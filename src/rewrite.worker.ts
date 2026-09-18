/// <reference lib="webworker" />

import type { ProgressInfo, TextGenerationPipeline, Text2TextGenerationPipeline } from "@huggingface/transformers";
import { getLocalProofreader, harperAssetUrl } from "./lib/browser-proofreader";
import { COEDIT_MODEL, COEDIT_VARIANT } from "./lib/coedit-model";
import { createDownloadGate } from "./lib/download";
import { editText } from "./lib/edit";
import { compareText } from "./lib/compare";
import { EDIT_DECODING, getGenerationTokenBudget } from "./lib/generation";
import { MODEL_CACHE_KEY, modelDownloadOffer, QWEN_MODEL, QWEN_VARIANTS, type ModelSpec, type ModelVariant } from "./lib/model";
import { makeEditMessages } from "./lib/prompts";
import { applyConservativeProofreading } from "./lib/proofread";
import {
  isDownloadApproval, isRewriteRequest,
  type DownloadOffer, type EngineEvent, type InferenceBackend,
  type RewriteAction, type RewriteRequest, type WorkerResponse,
} from "./types";

const scope = self as unknown as DedicatedWorkerGlobalScope;
const originalFetch = scope.fetch.bind(scope);
let activeId = 0;
let engine: "qwen" | "coedit" = "qwen";
let running = false;
let usedNetwork = false;
let aggregateProgress = false;
let backend: InferenceBackend = "wasm";
let offer: DownloadOffer | null = null;

interface LocalModel {
  countTokens(text: string): number;
  generate(action: RewriteAction, text: string, retry: boolean, attempt: number): Promise<string>;
}

let model: LocalModel | null = null;

function post(message: EngineEvent) {
  scope.postMessage({ ...message, id: activeId, engine } satisfies WorkerResponse);
}

const gate = createDownloadGate((download) => post({ type: "download-required", download }));

function readable(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function chooseDevice(): Promise<{ device: "webgpu" | "wasm"; f16: boolean }> {
  const navigatorWithGPU = scope.navigator as WorkerNavigator & {
    gpu?: { requestAdapter(): Promise<{ features: { has(value: string): boolean } } | null> };
  };
  try {
    const adapter = await navigatorWithGPU.gpu?.requestAdapter();
    if (adapter) return { device: "webgpu", f16: adapter.features.has("shader-f16") };
  } catch (error) {
    console.warn("WebGPU detection failed; using WASM.", error);
    post({ type: "fallback", message: `WebGPU could not be inspected (${readable(error)}). Using WASM.` });
  }
  return { device: "wasm", f16: false };
}

function reportProgress(info: ProgressInfo) {
  if (info.status === "progress_total") aggregateProgress = true;
  else if (info.status !== "progress" || aggregateProgress) return;
  post({
    type: "progress", progress: Math.max(0, Math.min(100, info.progress)),
    loaded: info.loaded, total: info.total, source: usedNetwork ? "download" : "cache",
  });
}

async function loadModel(): Promise<LocalModel> {
  const specification = engine === "qwen" ? QWEN_MODEL : COEDIT_MODEL;
  usedNetwork = false;
  post({ type: "status", phase: "detecting", message: "Checking this device for an AI editing engine…" });
  const selected = await chooseDevice();
  const library = await import("@huggingface/transformers");
  const { env, pipeline } = library;
  env.allowLocalModels = false;
  env.allowRemoteModels = true;
  env.useBrowserCache = true;
  env.useWasmCache = true;
  env.cacheKey = MODEL_CACHE_KEY;
  try {
    if (!scope.caches) throw new Error("Cache Storage is unavailable.");
    await scope.caches.open(MODEL_CACHE_KEY);
  } catch (error) {
    console.warn("Model caching is unavailable.", error);
    env.useBrowserCache = false;
    env.useWasmCache = false;
    post({ type: "cache-warning", message: "This browser cannot cache engine files. Another visit may need another download." });
  }
  const approvedFetch: typeof fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : input, scope.location.href);
    if (url.href === new URL(harperAssetUrl, scope.location.href).href) {
      return originalFetch(input, init);
    }
    if (!offer) throw new Error("No model artifact set was selected.");
    await gate.wait(offer);
    if (!usedNetwork) {
      usedNetwork = true;
      post({ type: "status", phase: "downloading", message: `Downloading missing ${offer.label} files. Your text stays on this device.` });
    }
    return originalFetch(input, init);
  };
  env.fetch = approvedFetch;
  scope.fetch = approvedFetch;

  async function load(device: "webgpu" | "wasm") {
    const variant: ModelVariant = engine === "coedit"
      ? COEDIT_VARIANT
      : QWEN_VARIANTS[device === "wasm" ? "q8" : selected.f16 ? "q4f16" : "q4"];
    offer = modelDownloadOffer(specification, variant);
    aggregateProgress = false;
    post({ type: "status", phase: "loading", message: `Checking cached ${specification.label} files for ${device.toUpperCase()}…` });
    const options = {
      device, dtype: variant.dtype, revision: specification.revision,
      progress_callback: reportProgress,
    } as const;
    if (engine === "coedit") {
      const loaded = await pipeline("text2text-generation", specification.id, options);
      return coeditModel(loaded, specification);
    }
    const loaded = await pipeline("text-generation", specification.id, options);
    return qwenModel(loaded);
  }
  let loaded: LocalModel;
  backend = selected.device;
  try {
    loaded = await load(selected.device);
  } catch (error) {
    if (selected.device !== "webgpu" || /fetch|network|HTTP|download/i.test(readable(error))) throw error;
    console.warn("WebGPU could not load the selected model.", error);
    post({ type: "fallback", message: `WebGPU could not load the model (${readable(error)}). WASM may require different files and separate approval.` });
    backend = "wasm";
    loaded = await load("wasm");
  }
  post({ type: "model-ready", backend, source: usedNetwork ? "download" : "cache" });
  return loaded;
}

function qwenModel(generator: TextGenerationPipeline): LocalModel {
  const countTokens = (text: string) => generator.tokenizer.encode(text, { add_special_tokens: false }).length;
  return {
    countTokens,
    async generate(action, text, retry, attempt) {
      const promptRetry = retry || attempt > 0;
      const creative = action === "enthusiastic" || action === "lighthearted";
      const sample = creative || (promptRetry && action !== "grammar");
      const output = await generator(makeEditMessages(action, text, promptRetry), {
        ...EDIT_DECODING,
        max_new_tokens: getGenerationTokenBudget(countTokens(text), action === "longer"),
        do_sample: sample,
        temperature: sample ? (creative ? 0.45 : 0.35) : undefined,
        top_p: sample ? 0.9 : undefined,
      });
      const generated = output[0]?.generated_text;
      const textOutput = typeof generated === "string" ? generated : generated?.at(-1)?.content;
      if (typeof textOutput !== "string") throw new Error("Qwen returned no readable edited text.");
      return textOutput;
    },
  };
}

function coeditModel(generator: Text2TextGenerationPipeline, specification: ModelSpec): LocalModel {
  const countTokens = (text: string) => generator.tokenizer.encode(text, { add_special_tokens: false }).length;
  return {
    countTokens,
    async generate(action, text) {
      if (action !== "grammar") throw new Error("CoEdIT is only enabled for deeper grammar checks.");
      const instruction = `Fix grammatical errors in this sentence: ${text}`;
      if (countTokens(instruction) > specification.maxInputTokens) {
        throw new Error("This section exceeds CoEdIT's input limit; it was not truncated.");
      }
      const output = await generator(instruction, {
        max_new_tokens: getGenerationTokenBudget(countTokens(text)),
        do_sample: false,
      });
      const generated = output[0]?.generated_text;
      if (typeof generated !== "string") throw new Error("CoEdIT returned no readable corrected text.");
      return generated;
    },
  };
}

async function rewrite(request: RewriteRequest) {
  model ??= await loadModel();
  post({ type: "status", phase: "generating", message: `Editing locally with ${engine === "qwen" ? "Qwen" : "CoEdIT Base"}…` });
  const currentModel = model;
  if (request.comparison) {
    const result = await compareText({
      action: request.action, text: request.text, countTokens: currentModel.countTokens,
      generate: (text) => currentModel.generate(request.action, text, false, 0),
      onProgress: (completed, total) => post({ type: "editing-progress", completed, total }),
    });
    post({ type: "result", ...result, backend });
    return;
  }
  const proofreader = await getLocalProofreader();
  const result = await editText({
    action: request.action, text: request.text, countTokens: currentModel.countTokens,
    generate: async (text, retry) => applyConservativeProofreading(
      await currentModel.generate(request.action, text, retry, request.attempt), proofreader,
    ),
    fallback: request.action === "grammar" ? undefined : (text) => applyConservativeProofreading(text, proofreader),
    onProgress: (completed, total) => post({ type: "editing-progress", completed, total }),
  });
  post({ type: "result", ...result, backend });
}

scope.addEventListener("message", (event: MessageEvent<unknown>) => {
  if (isDownloadApproval(event.data)) {
    if (!running || event.data.id !== activeId || !gate.approve(event.data.key)) {
      console.warn("Ignoring a stale or mismatched model-download approval.");
    }
    return;
  }
  if (!isRewriteRequest(event.data) || (event.data.engine !== "qwen" && event.data.engine !== "coedit")) {
    console.error("The AI worker received an invalid request.");
    scope.postMessage({ type: "error", id: 0, engine, message: "Invalid AI editing request." });
    return;
  }
  if (running) {
    scope.postMessage({ type: "error", id: event.data.id, engine, message: "Another AI edit is running." });
    return;
  }
  if (model && event.data.engine !== engine) {
    scope.postMessage({ type: "error", id: event.data.id, engine, message: "Dispose the previous model before changing engines." });
    return;
  }
  activeId = event.data.id;
  engine = event.data.engine;
  running = true;
  void rewrite(event.data).catch((error: unknown) => {
    console.error(`${engine} editing failed.`, error);
    post({ type: "error", message: readable(error) });
  }).finally(() => { running = false; });
});
