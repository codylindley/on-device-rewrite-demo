const MIN_GENERATED_TOKENS = 96;
const MAX_GENERATED_TOKENS = 1024;

// These penalties include the source prompt in causal models, which must remain copyable.
export const EDIT_DECODING = {
  no_repeat_ngram_size: 0,
  repetition_penalty: 1,
  return_full_text: false,
  tokenizer_encode_kwargs: {
    add_generation_prompt: true,
    enable_thinking: false,
  },
} as const;

export function getGenerationTokenBudget(sourceTokenCount: number): number {
  return Math.min(
    MAX_GENERATED_TOKENS,
    Math.max(MIN_GENERATED_TOKENS, Math.ceil(sourceTokenCount * 1.5) + 48),
  );
}
