import {
  createBinaryModuleFromUrl,
  Dialect,
  LocalLinter,
  type Linter,
} from "harper.js";
import harperWasmUrl from "../../node_modules/harper.js/dist/harper_wasm_bg.wasm?url";

let linterPromise: Promise<Linter> | null = null;

export function getLocalProofreader(): Promise<Linter> {
  linterPromise ??= (async () => {
    const linter = new LocalLinter({
      binary: createBinaryModuleFromUrl(harperWasmUrl),
      dialect: Dialect.American,
    });
    await linter.setup();
    return linter;
  })().catch((error: unknown) => {
    linterPromise = null;
    throw error;
  });
  return linterPromise;
}
