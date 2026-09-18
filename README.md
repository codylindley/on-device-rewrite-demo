# On-device spelling and grammar

Four spelling and grammar engines running side by side inside a browser tab, on the same passage, plus a fifth column that rewrites for tone and length. The same job, priced across three orders of magnitude.

- **Hunspell dictionary** is a 540 KB English word list read by [`nspell`](https://github.com/wooorm/nspell) in a Web Worker. No neural model, no WebAssembly, no download — it ships with the page and answers in milliseconds.
- **Harper** is a rule-based checker compiled to WebAssembly, about 16 MB, also bundled with the page.
- **CoEdIT Base** and **Qwen3-0.6B** are neural models loaded into the page with Transformers.js and executed on WebGPU (or WASM as a fallback), each in its own Web Worker. These are the ones that cost 570 MB to 1.09 GB of download.

One passage feeds every engine, and each gets its own output column. Nothing is sent to a server, no engine's output is merged into another's, and no output is ever written back into the passage — you read the diff. The point is to see what each engine actually changes, including where they disagree.

The page also registers an optional [WebMCP](https://github.com/webmachinelearning/webmcp) tool, so an AI agent running inside the browser can call these engines directly and read back their findings.

**Published demo:** <https://codylindley.github.io/on-device-rewrite-demo/>. Local changes do not update that site until pushed and deployed.

## The comparison

- **Hunspell dictionary:** every word is looked up in an English word list. It is the cheapest tier by three orders of magnitude and the most thorough at plain misspellings, and it cannot see grammar at all — `We was suppose to` passes untouched. It applies its top guess — a missing apostrophe (`havent` → `haven't`), the same letters rearranged (`recieved` → `received`), a single nearest neighbour (`seperate` → `separate`) — and reports the rest with alternatives. Identifiers and names are left alone: interior capitals (`ChatGPT`), adjacent digits (`ChatGPT4`), bare domains (`figma.com`), paths (`/usr/locla/bin`), links, addresses, handles, tags, and any capitalised word away from a sentence start (`Lindley`, `Vitest`). Elisions that are really two words (`alot`) are reported rather than guessed at. What remains is context-blindness, and it is what the comparison exists to show: a word one slip from four real words picks one of them (`acsent` → `ascent`, not `absent`).
- **Harper:** a rule-based checker. The preview applies rule hits that offer exactly one suggestion and reports the rest; every finding and alternative is visible. Lone tokens that a rule can only reshape — interior capitals or digits (`retryLimit`), text against code punctuation (`config/app.json`), and recasing a word that is already capitalised (`Bo` → `BO`) — are reported instead of applied. Rules still fire without wider context, so a suggestion can be confidently wrong. Several rules can flag one span, so the finding count can exceed the number of distinct problems.
- **CoEdIT Base:** its own spelling-and-grammar column, without Harper cleanup.
- **Qwen 3 grammar:** always requests spelling and grammar correction only.
- **Qwen 3 rewrites:** a separate output column with tone and length actions. It never consumes the grammar column's output automatically, and neither result replaces the other.
- **AI behavior:** one generation per section, with no Harper cleanup, no provider switching, and no hidden retry or fallback. Each column runs the engine named on it or fails.
- **Test cases:** five passages, chosen with one click, each built to isolate a single capability boundary. *Everyday draft* is the default realistic message. *Misspellings only* is thirteen misspellings that each have exactly one plausible fix, and no grammar errors — the word list's best case, where 540 KB matches a gigabyte of weights. *Grammar, not spelling* is spelled perfectly throughout, so the dictionary returns it completely untouched while the rule engine and the models do not. *Meaning, not rules* is made entirely of real words in the wrong places (`their`/`they're`, `effect`/`affect`, `then`/`than`), which only context can resolve. *Leave this alone* contains no errors at all — only identifiers, paths, versions, names, times, and a negation — so every change an engine makes there is damage. Editing the text deselects the case, since it is no longer that passage.
- **Elapsed time:** every result reports how long that run took, measured in the page. A word list answering in milliseconds next to a model taking seconds is part of the price being compared.
- **One shared passage:** paste or edit the text once and every column reads it, so results can never drift apart. Editing the passage stops any running job and clears the results it would no longer match.
- **Run all five:** one optional button. Any model weights that are not yet cached are disclosed up front in a single approval, with sizes and a total, so the whole run then finishes without stopping to ask again. When the weights are already cached nothing is downloaded and no approval is shown. The dictionary and Harper start immediately on their own workers; the three AI columns queue and run back to back, because they share a single neural worker to limit memory. A queued column shows its position and can leave the queue on its own.
- **Actual output:** preservation checks produce separate review notes. They do not silently replace a candidate with the original text.
- **Read the diff:** each result is shown inline as a single flowing diff — removed text struck through, added text underlined — with no view switcher and no scroll box. This is a comparison demo, not an editor, so there is nothing to export.

The word list is vendored into `src/assets/dictionary/` from [`dictionary-en`](https://github.com/wooorm/dictionaries) (MIT AND BSD, SCOWL-derived; see the `LICENSE` beside it). It is copied rather than imported because that package reads its files with `node:fs`, so its entry point cannot run in a browser. Re-sync it with `cp node_modules/dictionary-en/index.{aff,dic} src/assets/dictionary/en.{aff,dic}`.

Harper is configured with `language: "plaintext"` and `dedup: false`. This matters: default overlap removal can let a whole-sentence readability finding suppress spelling findings inside that sentence. We choose non-overlapping automatic fixes only *after* filtering, while keeping the complete findings list visible. A word-choice rule can also fire on the same token as a misspelling and offer a single confident-looking substitution — `untill` → `distill` — so a fix from another rule may only outrank an uncertain spelling if it keeps the same letters (`alot` → `a lot`) or is a correction the speller itself proposed.

This is an evaluation interface, not a guarantee of correct grammar or preserved meaning. A model can make an incorrect edit; a heuristic can flag a harmless correction. An unchanged output is not proof that a passage is error-free.

## Run locally

Requires Node.js 20.19+ and a current browser.

```bash
npm install
npm run dev
```

Open the printed local URL, normally <http://127.0.0.1:5173>. Do not open `index.html` as a file.

```bash
npm run build
npm run preview
```

The default production preview is <http://127.0.0.1:4173>. Pushes to `main` deploy through `.github/workflows/deploy-pages.yml`.

## Models and download consent

Harper loads its bundled WASM asset but needs no neural model or GPU. Its panel can run while either AI column is waiting for download approval.

| AI model | Role | Model weights |
| --- | --- | --- |
| [CoEdIT Base](https://huggingface.co/imrahamed/coedit-base-webgpu-onnx) | Editing-specialized, approximately 250M parameters | FP32 reference: about **1.09 GB** |
| [Qwen3-0.6B](https://huggingface.co/onnx-community/Qwen3-0.6B-ONNX) | General instruction model; also supports the existing tone and length actions | WebGPU q4f16: **570 MB**; q4: **920 MB**; WASM q8: **618 MB** |

Tokenizer and runtime files are additional. The app names the selected artifact and asks before downloading missing files. Cached files are reused. Switching to different model artifacts or a different quantization requires its own approval.

AI memory usage can exceed the weight-file size. Low-memory devices may be unable to load a model; Harper does not have that neural-model requirement.

CoEdIT is available here **by explicit comparison selection**, not as an automatic production fallback. The linked FP32 export is an Apache-2.0-declared conversion of `jbochi/coedit-base`, not Grammarly's official CoEdIT Large. A smaller int8 lead had unverified provenance/license and a different decoder layout; it is not offered. Exact revisions, file sizes, and provenance are recorded in `src/lib/{model,coedit-model}.ts` and `benchmarks/model-candidates.json`.

Only one AI check runs at a time. The two Qwen panels share the same cached model but not prompts or results. Starting a different model releases the previous neural worker without deleting cached files or its finished output. All outputs remain visible for comparison. Harper has its own lightweight worker and can run independently.

## Privacy and limitations

Text is sent only to same-page workers, never to an application server, analytics service, or remote model API. Network traffic loads the app, runtime assets, and approved model files. No draft recovery or default text persistence is included.

The editor preserves paragraph separators and breaks long AI inputs into tokenizer-bounded sections. Sentence splitting does not cut through URL queries; oversized URLs are copied instead of being generated in fragments. Outputs still require review, particularly quotations, negation, names, and facts. Review notes are conservative heuristics, not a semantic verdict.

The comparison UI does not use the experimental native browser AI APIs, and no adapter for them remains in the code. Every column runs the engine named on it. Browser verification is on Chrome/macOS; Safari and Firefox behavior has not been established by these runs.

The optional WebMCP tool requires an explicit `engine` (`harper`, `coedit`, or `qwen`). Qwen with `action: "grammar"` uses the grammar panel; other Qwen actions use the rewrites panel. The response includes `pane`, findings, and review notes. It never writes output back into the passage automatically.

## Verification and local experiments

```bash
npm run unit-tests
npm run build
npm run browser-tests
```

Browser tests use an isolated installed Google Chrome and do not download AI weights. Build before running them.

The synthetic corpus in `benchmarks/grammar-corpus.json` contains 120 cases: clean text, annotated errors, and protected/adversarial examples, with development/held-out splits. The scorer treats copying erroneous input as a failure to correct it and keeps rejections, runtime failures, and produced outputs separate. Exact reference matches are not a grammar-accuracy or meaning-preservation score.

```bash
npm run benchmark:grammar -- --engine harper --comparison \
  --url http://127.0.0.1:5173/ \
  --profile /tmp/editing-engines-benchmark-profile \
  --output /tmp/harper-comparison.json
```

AI experiments also require `--allow-downloads`. Use `--engine coedit` or `--engine qwen`, keep `--comparison` for the same uncombined behavior as the UI, and run neural models sequentially. Omitting `--comparison` exercises the earlier guarded pipeline for historical comparison; do not conflate those results.

For repeatable runs without development hot reloads, serve a production build and supply its worker asset with `--worker-path /assets/<worker-file>.js`. `--backend wasm` disables WebGPU in the benchmark worker only; it does not change browser/OS settings. Score reports with:

```bash
node scripts/summarize-grammar.mjs /tmp/harper-comparison.json /tmp/scored.json
```

Every report includes the corpus snapshot. Record model revision, pipeline mode, browser, and hardware when comparing results. Inspect the actual edits and remaining errors, not just speed or guard rejection rates. Combining engines is deliberately a separate future experiment.
