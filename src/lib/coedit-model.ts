import type { ModelSpec, ModelVariant } from "./model.ts";

export const COEDIT_MODEL: ModelSpec = {
  id: "imrahamed/coedit-base-webgpu-onnx",
  revision: "bb88a28f63cf459d0ba4f00ebea36446172d0c30",
  label: "CoEdIT Base (evaluation)",
  license: "Apache-2.0",
  maxInputTokens: 512,
};
export const COEDIT_VARIANT: ModelVariant = {
  dtype: "fp32",
  files: ["onnx/encoder_model.onnx", "onnx/decoder_model_merged.onnx"],
  bytes: 1089592286,
};
