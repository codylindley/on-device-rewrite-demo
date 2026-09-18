declare module "nspell" {
  interface NSpell {
    correct(word: string): boolean;
    suggest(word: string): string[];
    spell(word: string): { correct: boolean; forbidden: boolean; warn: boolean };
    add(word: string, model?: string): NSpell;
    remove(word: string): NSpell;
  }
  /**
   * Pass decoded text. nspell accepts only strings and Node Buffers; a `Uint8Array`
   * satisfies its `'length' in aff` check and is misread as a list of dictionaries.
   */
  export default function nspell(aff: string, dic: string): NSpell;
}
