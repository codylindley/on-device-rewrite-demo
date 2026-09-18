import assert from "node:assert/strict";
import test from "node:test";
import { inspectModelCache, modelDownloadOffer, QWEN_MODEL, QWEN_VARIANTS } from "../src/lib/model.ts";

test("model cache state distinguishes partial, complete, unrelated and old revisions", async () => {
  const model = QWEN_MODEL;
  const variant = QWEN_VARIANTS.q4f16;
  const files = [
    ...variant.files, "config.json", "generation_config.json", "tokenizer.json", "tokenizer_config.json",
  ];
  const storage = (cached: string[]) => ({
    async has() { return true; },
    async open() { return { async keys() {
      return cached.map((file) => new Request(`https://huggingface.co/${model.id}/resolve/${model.revision}/${file}`));
    } }; },
  });
  assert.equal(await inspectModelCache(storage([]), model, variant), "empty");
  assert.equal(await inspectModelCache(storage([variant.files[0]!]), model, variant), "partial");
  assert.equal(await inspectModelCache(storage(files), model, variant), "cached");
  assert.equal(await inspectModelCache(storage(files), { ...model, revision: "new" }, variant), "empty");
  assert.equal(await inspectModelCache(storage(files), { ...model, id: "other/model" }, variant), "empty");
  await assert.rejects(inspectModelCache(undefined, model, variant), /unavailable/);
});

test("download offers disclose the selected variant, not a shared misleading estimate", () => {
  const f16 = modelDownloadOffer(QWEN_MODEL, QWEN_VARIANTS.q4f16);
  const q4 = modelDownloadOffer(QWEN_MODEL, QWEN_VARIANTS.q4);
  const q8 = modelDownloadOffer(QWEN_MODEL, QWEN_VARIANTS.q8);
  assert.match(f16.size, /570 MB/);
  assert.match(q4.size, /920 MB/);
  assert.match(q8.size, /618 MB/);
  assert.equal(new Set([f16.key, q4.key, q8.key]).size, 3);
  assert.match(f16.key, new RegExp(QWEN_MODEL.revision));
});

test("a cache missing generation_config.json is reported as incomplete", async () => {
  const model = QWEN_MODEL;
  const variant = QWEN_VARIANTS.q4f16;
  const storage = (cached: string[]) => ({
    async has() { return true; },
    async open() { return { async keys() {
      return cached.map((file) => new Request(`https://huggingface.co/${model.id}/resolve/${model.revision}/${file}`));
    } }; },
  });

  const withoutGenerationConfig = [
    ...variant.files, "config.json", "tokenizer.json", "tokenizer_config.json",
  ];
  assert.equal(await inspectModelCache(storage(withoutGenerationConfig), model, variant), "partial");
});
