import type { DownloadOffer } from "../types.ts";

export const MODEL_CACHE_KEY = "transformers-cache";
export type ModelDtype = "q4f16" | "q4" | "q8" | "fp32";

export interface ModelVariant {
  dtype: ModelDtype;
  files: readonly string[];
  bytes: number;
}

export interface ModelSpec {
  id: string;
  revision: string;
  label: string;
  license: string;
  maxInputTokens: number;
}

export const QWEN_MODEL: ModelSpec = {
  id: "onnx-community/Qwen3-0.6B-ONNX",
  revision: "da1453100cf3ff33ef56d17983fc7a8648706db6",
  label: "Qwen 3",
  license: "Apache-2.0",
  maxInputTokens: 192,
};

export const QWEN_VARIANTS: Record<"q4f16" | "q4" | "q8", ModelVariant> = {
  q4f16: { dtype: "q4f16", files: ["onnx/model_q4f16.onnx"], bytes: 569789750 },
  q4: { dtype: "q4", files: ["onnx/model_q4.onnx"], bytes: 919096585 },
  q8: { dtype: "q8", files: ["onnx/model_quantized.onnx"], bytes: 617687575 },
};

export function modelDownloadOffer(model: ModelSpec, variant: ModelVariant): DownloadOffer {
  return {
    key: `${model.id}@${model.revision}:${variant.dtype}`,
    label: `${model.label} (${variant.dtype})`,
    size: `about ${Math.ceil(variant.bytes / 1_000_000)} MB of model weights, plus tokenizer and runtime files`,
    source: "huggingface",
  };
}

interface CacheStorageLike {
  has(name: string): Promise<boolean>;
  open(name: string): Promise<Pick<Cache, "keys">>;
}

export async function inspectModelCache(
  storage: CacheStorageLike | undefined,
  model: ModelSpec,
  variant: ModelVariant,
): Promise<"empty" | "partial" | "cached"> {
  if (!storage) throw new Error("Model caching is unavailable in this browser.");
  if (!await storage.has(MODEL_CACHE_KEY)) return "empty";
  const requests = await (await storage.open(MODEL_CACHE_KEY)).keys();
  const prefix = `/${model.id}/resolve/${model.revision}/`;
  const files = new Set(requests.flatMap((request) => {
    const url = new URL(request.url);
    return url.hostname === "huggingface.co" && url.pathname.startsWith(prefix)
      ? [url.pathname.slice(prefix.length)]
      : [];
  }));
  // Every file the pipeline fetches, including generation_config.json: omitting one reports a
  // complete cache and then asks for a download the batch never authorised.
  const required = [
    ...variant.files, "config.json", "generation_config.json", "tokenizer.json", "tokenizer_config.json",
  ];
  if (!required.some((file) => files.has(file))) return "empty";
  return required.every((file) => files.has(file)) ? "cached" : "partial";
}
