/// <reference lib="webworker" />

import {
  env,
  pipeline,
  type ProgressInfo,
  type TextGenerationPipeline,
} from "@huggingface/transformers";
import { editText } from "./lib/edit";
import { getLocalProofreader } from "./lib/browser-proofreader";
import { EDIT_DECODING, getGenerationTokenBudget } from "./lib/generation";
import { makeEditMessages } from "./lib/prompts";
import { applyConservativeProofreading } from "./lib/proofread";
import { isRewriteRequest, type InferenceBackend, type WorkerRequest, type WorkerResponse } from "./types";

const MODEL_ID = "onnx-community/Qwen3-0.6B-ONNX";
const workerScope = self as unknown as DedicatedWorkerGlobalScope;

env.allowLocalModels = false;
env.allowRemoteModels = true;
env.useBrowserCache = true;
env.useWasmCache = true;

let generator: TextGenerationPipeline | null = null;
let generatorPromise: Promise<TextGenerationPipeline> | null = null;
let backend: InferenceBackend = "wasm";
let activeRequestId = 0;
let requestRunning = false;
let sawAggregateProgress = false;

interface GPUAdapterLike {
  features?: {
    has(feature: string): boolean;
  };
}

interface NavigatorWithGPU {
  gpu?: {
    requestAdapter(): Promise<GPUAdapterLike | null>;
  };
}

function post(message: WorkerResponse) {
  workerScope.postMessage(message);
}

function readableError(error: unknown): string {
  return error instanceof Error && error.message ? error.message : String(error);
}

async function getWebGPUAdapter(): Promise<GPUAdapterLike | null> {
  const gpu = (workerScope.navigator as unknown as NavigatorWithGPU).gpu;
  if (!gpu) return null;
  try {
    return await gpu.requestAdapter();
  } catch {
    return null;
  }
}

function reportProgress(info: ProgressInfo) {
  if (info.status === "progress_total") {
    sawAggregateProgress = true;
  } else if (info.status !== "progress" || sawAggregateProgress) {
    return;
  }
  post({
    type: "progress",
    id: activeRequestId,
    progress: Math.max(0, Math.min(100, info.progress)),
    loaded: info.loaded,
    total: info.total,
  });
}

async function loadGenerator(): Promise<TextGenerationPipeline> {
  post({
    type: "status",
    id: activeRequestId,
    phase: "detecting",
    message: "Checking this browser for WebGPU…",
  });

  const adapter = await getWebGPUAdapter();
  if (adapter) {
    post({
      type: "status",
      id: activeRequestId,
      phase: "loading",
      message: "Loading the local model with WebGPU…",
    });
    try {
      sawAggregateProgress = false;
      const loaded = await pipeline("text-generation", MODEL_ID, {
        device: "webgpu",
        dtype: adapter.features?.has("shader-f16") ? "q4f16" : "q4",
        progress_callback: reportProgress,
      });
      backend = "webgpu";
      post({ type: "backend", id: activeRequestId, backend });
      return loaded;
    } catch (error) {
      post({
        type: "fallback",
        id: activeRequestId,
        message: `WebGPU could not load the model (${readableError(error)}). Switching to WASM…`,
      });
    }
  } else {
    post({
      type: "fallback",
      id: activeRequestId,
      message: "WebGPU is not available here. Switching to the compatible WASM engine…",
    });
  }

  post({
    type: "status",
    id: activeRequestId,
    phase: "loading",
    message: "Loading the local model with WASM…",
  });
  sawAggregateProgress = false;
  const loaded = await pipeline("text-generation", MODEL_ID, {
    device: "wasm",
    dtype: "q8",
    progress_callback: reportProgress,
  });
  backend = "wasm";
  post({ type: "backend", id: activeRequestId, backend });
  return loaded;
}

function getGenerator(): Promise<TextGenerationPipeline> {
  if (generator) return Promise.resolve(generator);
  generatorPromise ??= loadGenerator()
    .then((loaded) => {
      generator = loaded;
      return loaded;
    })
    .catch((error: unknown) => {
      generatorPromise = null;
      throw error;
    });
  return generatorPromise;
}

async function rewrite(request: WorkerRequest) {
  activeRequestId = request.id;
  const model = await getGenerator();
  const proofreader = await getLocalProofreader();
  post({
    type: "status",
    id: request.id,
    phase: "generating",
    message: "Editing your text locally, section by section…",
  });

  const countTokens = (text: string) =>
    model.tokenizer.encode(text, { add_special_tokens: false }).length;
  const generateForAction = async (
    action: WorkerRequest["action"],
    text: string,
    retry: boolean,
    includeRequestAttempt: boolean,
  ) => {
    const promptRetry = retry || (includeRequestAttempt && request.attempt > 0);
    const creativeAction = action === "enthusiastic" || action === "lighthearted";
    const varyRetry = promptRetry && action !== "grammar";
    const sample = creativeAction || varyRetry;
    const output = await model(makeEditMessages(action, text, promptRetry), {
      ...EDIT_DECODING,
      max_new_tokens: getGenerationTokenBudget(
        countTokens(text),
        action === "longer",
      ),
      do_sample: sample,
      temperature: sample ? (creativeAction ? 0.45 : 0.35) : undefined,
      top_p: sample ? 0.9 : undefined,
    });
    const generated = output[0]?.generated_text;
    const rawText = typeof generated === "string"
      ? generated
      : generated?.at(-1)?.content;
    if (typeof rawText !== "string") return "";
    return applyConservativeProofreading(rawText, proofreader);
  };
  const result = await editText({
    action: request.action,
    text: request.text,
    countTokens,
    onProgress(completed, total) {
      post({ type: "editing-progress", id: request.id, completed, total });
    },
    async generate(text, retry) {
      return generateForAction(request.action, text, retry, true);
    },
    fallback: request.action === "grammar"
      ? undefined
      : (text) => generateForAction("grammar", text, false, false),
  });

  post({ type: "result", id: request.id, ...result, backend });
}

workerScope.addEventListener("message", (event: MessageEvent<unknown>) => {
  if (!isRewriteRequest(event.data)) {
    console.error("The editor worker received an invalid request.");
    post({ type: "error", id: 0, message: "The editor received an invalid request." });
    return;
  }
  const request = event.data;
  if (requestRunning) {
    post({ type: "error", id: request.id, message: "Another edit is already running." });
    return;
  }
  requestRunning = true;
  void rewrite(request)
    .catch((error: unknown) => {
      post({ type: "error", id: request.id, message: readableError(error) });
    })
    .finally(() => {
      requestRunning = false;
    });
});
