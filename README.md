# Local Edit

A small SolidJS + TypeScript demo of an on-device writing assistant. It runs a quantized language model in a Web Worker with Transformers.js, prefers WebGPU, falls back to WASM, and keeps the text being edited inside the browser.

**Live demo:** <https://codylindley.github.io/on-device-rewrite-demo/>

## What it includes

- Fix grammar, Rewrite, Concise, Professional, and Casual actions
- lazy model download with byte and percentage progress
- WebGPU detection with automatic WASM fallback
- inference in a module Web Worker so the composer stays responsive
- browser model caching for faster later visits
- result preview with Replace, Retry, and Cancel
- word-level insertion/deletion diff
- output safeguards that reject rewrites which lose names, numbers, links, emoji, questions, or too much source meaning
- stale-result protection and a Stop action that terminates the worker
- keyboard-friendly controls, live status, and responsive layout

## Run it locally

Requirements: Node.js 20.19 or newer and a current browser.

```bash
npm install
npm run dev
```

Open the local URL printed by Vite, normally <http://127.0.0.1:5173>. Do not open `index.html` directly with a `file://` URL; browser workers and model fetching require the local server.

The first edit downloads model files from Hugging Face. Expect roughly 550–700 MB, depending on the selected backend and quantization. The browser caches those files, so later loads should be much faster. The download can take several minutes on a slower connection.

## Build and preview the production bundle

```bash
npm run build
npm run preview
```

The production preview normally runs at <http://127.0.0.1:4173>.

Pushes to `main` are built and deployed to GitHub Pages by
`.github/workflows/deploy-pages.yml`.

## Model and runtime

- Runtime: [`@huggingface/transformers`](https://www.npmjs.com/package/@huggingface/transformers)
- Model: [`onnx-community/Qwen3-0.6B-ONNX`](https://huggingface.co/onnx-community/Qwen3-0.6B-ONNX)
- WebGPU dtype: `q4f16` when shader-f16 is available, otherwise `q4`
- WASM dtype: `q8`
- Model license: Apache-2.0

The 0.6B instruction model is the compatible local fallback used by Grammar Check SLM and supports all five editing modes with one model. The worker explicitly disables Qwen's thinking mode, uses deterministic generation for the first result and grammar retries, and adds a small amount of variation on stylistic retries.

## Privacy behavior

The draft text is posted only from the page to the same page's Web Worker. It is not sent to an application server, analytics service, or model API. Network requests are used to load the app, Transformers.js runtime assets, and model weights. You can verify this in the browser Network panel: after the model is cached, edits run locally.

## Browser notes

- Chromium browsers with WebGPU enabled provide the best experience.
- Firefox, Safari, and browsers without a usable WebGPU adapter use the WASM fallback.
- WASM is slower and may use more memory.
- Private browsing or restrictive storage settings can prevent model caching.
- Low-memory phones and older computers may not be able to load a roughly 0.6B-parameter model.

## Project shape

```text
src/App.tsx             SolidJS UI and interaction state
src/rewrite.worker.ts  Transformers.js loading and inference
src/lib/diff.ts         word-level LCS diff
src/types.ts            typed page/worker message protocol
src/styles.css          responsive visual system
```

The worker is intentionally lazy: it is created only after the first action. Stopping an edit terminates the worker and releases its active model session; already downloaded files remain in the browser cache.

## Dependency audit note

At the time of this demo, `npm audit` reports upstream advisories through the Node-only `onnxruntime-node` and `sharp` dependencies bundled by Transformers.js 4.2.0. Those packages are not imported into this browser build—the production assets use `onnxruntime-web` and WASM—and npm currently reports no available upstream fix.
