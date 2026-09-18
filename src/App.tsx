import { For, Show, createMemo, createSignal, onCleanup, onMount } from "solid-js";
import { COEDIT_MODEL, COEDIT_VARIANT } from "./lib/coedit-model";
import { diffWords } from "./lib/diff";
import { EditorEngine } from "./lib/editor-engine";
import { QWEN_MODEL, QWEN_VARIANTS, inspectModelCache, modelDownloadOffer, type ModelSpec, type ModelVariant } from "./lib/model";
import {
  EDIT_ACTIONS, ENGINE_LABELS, isRewriteAction,
  type DownloadOffer, type EngineResult, type InferenceBackend, type RewriteAction, type WorkerEngine, type WorkerResponse,
} from "./types";

type Pane = WorkerEngine | "qwen-rewrite";
type RewriteMode = Exclude<RewriteAction, "grammar">;
interface Result extends EngineResult {
  source: string;
  action: RewriteAction;
  elapsedMs: number;
}
interface Activity {
  id: number;
  message: string;
  progress: number | null;
  download: DownloadOffer | null;
}
const ACTION_LABELS: Record<RewriteAction, string> = {
  grammar: "Spelling & grammar", concise: "Concise", longer: "Longer",
  casual: "Casual", professional: "Professional", confident: "Confident",
  enthusiastic: "Enthusiastic", lighthearted: "Light-hearted",
};
const BACKEND_LABELS: Record<InferenceBackend, string> = {
  webgpu: "WebGPU",
  wasm: "WebAssembly",
  browser: "Browser AI",
  javascript: "JavaScript",
};
/** A word list cannot judge grammar, so labelling its output "grammar" would overstate it. */
function resultScope(result: Result): string {
  return result.engine === "dictionary" ? "Spelling only" : ACTION_LABELS[result.action];
}

/** Weight is only half the price. The other half is how long you wait, so every run is timed. */
function formatElapsed(milliseconds: number): string {
  if (milliseconds < 1000) return `${Math.max(1, Math.round(milliseconds))} ms`;
  return `${(milliseconds / 1000).toFixed(milliseconds < 10_000 ? 1 : 0)} s`;
}
const STARTER_TEXT = `Hi team, I recieved the notes from yesterdays meeting. We was suppose to review the invitation, but there are alot of details we still need to check. The adress is wrong, and two of the posters is missing. Please send the corrected version to Maya by Thursday so she can print 25 copies.

Could we move tomorrows practice session to 3:30? Several volunteers cant arrive earlier, and we havent finished setting up the room yet. I would of tested the microphones today, but the speakers hasn't arrived. Please keep the two activities seperate and let me know if the new time work for everyone.`;

/**
 * One passage cannot show where a word list stops and a language model starts. Each sample isolates a
 * single axis, so the engine that wins — and the one that quietly damages the text — is unambiguous.
 */
interface Sample {
  id: string;
  label: string;
  /** What this passage is designed to reveal about the five engines. */
  hint: string;
  text: string;
}
const SAMPLES: readonly Sample[] = [
  {
    id: "draft",
    label: "Everyday draft",
    hint: "A realistic message with spelling, apostrophe, agreement, and word-form errors mixed together — plus a name, a date, a time, and a quantity that must survive.",
    text: STARTER_TEXT,
  },
  {
    id: "spelling",
    label: "Misspellings only",
    hint: "Thirteen misspellings, each with exactly one plausible correction, and not a single grammar error. This is the 540 KB word list's best case — watch whether a gigabyte of weights does any better.",
    text: `We recieved the shipment yesterday, and the delay occured because the labels were seperate from the packing list. It is neccesary to mesure the shelves again before tommorow, and the calender in the shared enviroment is still wrong. Maya will definately reccomend that we acheive a cleaner handoff, so please do not print anything untill the goverment form is signed.`,
  },
  {
    id: "grammar",
    label: "Grammar, not spelling",
    hint: "Every word is spelled correctly, so the dictionary should return this untouched. Everything wrong here is agreement, tense, or word form.",
    text: `The list of volunteers were printed this morning, but neither of the coordinators have signed it. We was going to review the schedule together, and the posters is still sitting in the van. If the microphones arrives before noon, Maya and me will set them up. I would of asked earlier, but the speakers hasn't been unpacked.`,
  },
  {
    id: "meaning",
    label: "Meaning, not rules",
    hint: "Every word here is a real, correctly spelled English word in the wrong place. Only context can tell which is which, so this is where rules run out and a model has to earn its download.",
    text: `Their going to announce the results tomorrow, and I think its going to effect the whole team. Please right back to me if the new schedule is worse then the old one. We should of asked whether the venue accepts more then forty people, because your the one who has to sign the contract.`,
  },
  {
    id: "traps",
    label: "Leave this alone",
    hint: "Nothing here is wrong. It is made of names, identifiers, paths, versions, times, and a negation, so every change an engine makes is damage — watch which ones stay out of the way and which one slips.",
    text: `Ship the fix to production after the retryLimit change lands in config/app.json. The notes from Bo and Maya cover the ChatGPT export, the figma.com mockups, and the checklist in /usr/local/share/docs. The build is v2.10.3, it needs 25 GB of disk, and it must not run before 3:30 PM on Thursday. Do not merge this until the speakers have arrived.`,
  },
];
const PANES: readonly Pane[] = ["dictionary", "harper", "coedit", "qwen", "qwen-rewrite"];
/** These run entirely from bundled assets, so they start immediately and in parallel. */
const LOCAL_PANES: readonly Pane[] = ["dictionary", "harper"];
const PANE_TITLES: Record<Pane, string> = {
  dictionary: "Dictionary",
  harper: "Harper",
  coedit: "CoEdIT Base",
  qwen: "Qwen 3 grammar",
  "qwen-rewrite": "Qwen 3 rewrites",
};
interface PaneCopy {
  summary: string;
  detail: string;
  /** Shown as the column's headline cost, in tabular figures. */
  weight: string;
  /** What the visitor must agree to before this column can run. */
  gate: string;
  /** Drives the comparison bar. Zero means the column adds nothing to download. */
  bytes: number;
}

/** The spread runs from a word list to a gigabyte of weights, so the bar is logarithmic;
 *  a linear bar would render every engine except CoEdIT as an invisible sliver. */
const WEIGHT_FLOOR = 100_000;
const WEIGHT_CEILING = 1_100_000_000;
function weightShare(bytes: number): number {
  if (bytes <= 0) return 0;
  const span = Math.log10(WEIGHT_CEILING) - Math.log10(WEIGHT_FLOOR);
  const ratio = (Math.log10(bytes) - Math.log10(WEIGHT_FLOOR)) / span;
  return Math.max(4, Math.min(100, Math.round(ratio * 100)));
}
/** The cost line is the comparison: the same job, priced from a quarter-megabyte to a gigabyte. */
const PANE_COPY: Record<Pane, PaneCopy> = {
  dictionary: {
    summary: "A Hunspell word list. Finds misspellings, not grammar.",
    detail: "Ordinary words are looked up in an English word list; identifier-like tokens, links, and capitalised words away from a sentence start are reported rather than replaced. It applies its top guess and reports the rest. Having no sense of context, it can still pick the wrong real word.",
    weight: "540 KB", gate: "Bundled with the page", bytes: 540_000,
  },
  harper: {
    summary: "Rule-based checks. No neural model download.",
    detail: "Applies rule hits that offer exactly one suggestion and reports the rest below. Lone tokens a rule can only reshape \u2014 identifiers, text against code punctuation, recasing an already-capitalised word \u2014 are reported instead. Rules still fire without wider context, and several can flag the same span, so findings can outnumber the problems.",
    weight: "16 MB", gate: "Bundled with the page", bytes: 16_164_077,
  },
  coedit: {
    summary: "On-device AI tuned for text editing.",
    detail: "Spelling and grammar corrections only. No Harper cleanup or automatic tone changes are requested.",
    weight: "1.09 GB", gate: "Download needs approval", bytes: 1_089_592_286,
  },
  qwen: {
    summary: "Grammar and spelling only. No tone rewrite.",
    detail: "Spelling and grammar corrections only. No Harper cleanup or automatic tone changes are requested.",
    weight: "570–920 MB", gate: "Download needs approval", bytes: 569_789_750,
  },
  "qwen-rewrite": {
    summary: "Tone or length rewrites, including grammar cleanup.",
    detail: "",
    weight: "No extra download", gate: "570\u2013920 MB if Qwen 3 grammar has not run", bytes: 0,
  },
};
const REWRITE_GROUPS: readonly { label: string; actions: readonly RewriteMode[] }[] = [
  { label: "Tone", actions: ["casual", "professional", "confident", "enthusiastic", "lighthearted"] },
  { label: "Length", actions: ["concise", "longer"] },
];
interface PaneModel {
  spec: ModelSpec;
  variants: readonly ModelVariant[];
  estimate: ModelVariant;
}
const QWEN_PANE_MODEL: PaneModel = {
  spec: QWEN_MODEL,
  variants: [QWEN_VARIANTS.q4f16, QWEN_VARIANTS.q4, QWEN_VARIANTS.q8],
  estimate: QWEN_VARIANTS.q4f16,
};
const PANE_MODELS: Partial<Record<Pane, PaneModel>> = {
  coedit: { spec: COEDIT_MODEL, variants: [COEDIT_VARIANT], estimate: COEDIT_VARIANT },
  qwen: QWEN_PANE_MODEL,
  "qwen-rewrite": QWEN_PANE_MODEL,
};

/**
 * Approval covers the exact builds that were priced — every dtype the engine may fall back to, and no
 * other revision — and is cleared when the batch ends so it can never authorise a later download.
 */
function approvedKeys(model: PaneModel): string[] {
  return model.variants.map((variant) => modelDownloadOffer(model.spec, variant).key);
}

function formatBytes(bytes: number): string {
  return bytes >= 1_000_000_000
    ? `${(bytes / 1_000_000_000).toFixed(2)} GB`
    : `${Math.ceil(bytes / 1_000_000)} MB`;
}

/** Weights already in the Cache API download nothing, so they need no approval. */
async function missingDownloads(panes: readonly Pane[]): Promise<readonly PaneModel[]> {
  const required = new Map<string, PaneModel>();
  for (const pane of panes) {
    const model = PANE_MODELS[pane];
    if (model) required.set(model.spec.id, model);
  }
  const missing: PaneModel[] = [];
  for (const model of required.values()) {
    let cached = false;
    for (const variant of model.variants) {
      try {
        if (await inspectModelCache(globalThis.caches, model.spec, variant) === "cached") { cached = true; break; }
      } catch (error) {
        console.warn("Model cache could not be inspected.", error);
      }
    }
    if (!cached) missing.push(model);
  }
  return missing;
}

export default function App() {
  const [passage, setPassageText] = createSignal(STARTER_TEXT);
  const [results, setResults] = createSignal<Record<Pane, Result | null>>({ dictionary: null, harper: null, coedit: null, qwen: null, "qwen-rewrite": null });
  const [activities, setActivities] = createSignal<Record<Pane, Activity | null>>({ dictionary: null, harper: null, coedit: null, qwen: null, "qwen-rewrite": null });
  const [notices, setNotices] = createSignal<Record<Pane, string | null>>({ dictionary: null, harper: null, coedit: null, qwen: null, "qwen-rewrite": null });
  const [qwenRewriteAction, setQwenRewriteAction] = createSignal<RewriteMode>("professional");
  const [queued, setQueued] = createSignal<readonly Pane[]>([]);
  const [batchRunning, setBatchRunning] = createSignal(false);
  const [batchPlan, setBatchPlan] = createSignal<readonly PaneModel[] | null>(null);
  const [batchChecking, setBatchChecking] = createSignal(false);
  const [agentTool, setAgentTool] = createSignal(false);
  /** Derived, not stored: editing the passage deselects the chip without any extra bookkeeping. */
  const activeSample = createMemo(() => SAMPLES.find((sample) => sample.text === passage()));
  const editors = { harper: new EditorEngine(), dictionary: new EditorEngine(), neural: new EditorEngine() };
  const outputHeadings: Partial<Record<Pane, HTMLHeadingElement>> = {};
  const aiBusy = createMemo(() => PANES.some((pane) => !LOCAL_PANES.includes(pane) && activities()[pane]));
  const anyBusy = createMemo(() => PANES.some((pane) => Boolean(activities()[pane])));
  const anyInput = createMemo(() => Boolean(passage().trim()));
  let sequence = 0;
  let focusRequest = 0;
  let batchToken = 0;
  let approvedModels = new Set<string>();
  /** Local panes start before the download prompt, so the batch adopts jobs that are already running. */
  let pendingLocalJobs: readonly Promise<unknown>[] = [];

  function editorFor(pane: Pane) {
    if (pane === "harper") return editors.harper;
    if (pane === "dictionary") return editors.dictionary;
    return editors.neural;
  }

  function runBlocked(pane: Pane): boolean {
    if (batchChecking() || batchPlan()) return true;
    if (queued().includes(pane)) return true;
    return LOCAL_PANES.includes(pane) ? Boolean(activities()[pane]) : aiBusy();
  }

  function updateActivity(pane: Pane, id: number, patch: Partial<Activity>) {
    setActivities((current) => {
      const previous = current[pane];
      return previous?.id === id ? { ...current, [pane]: { ...previous, ...patch } } : current;
    });
  }

  function stop(pane: Pane) {
    const wasQueued = queued().includes(pane);
    if (wasQueued) setQueued((current) => current.filter((item) => item !== pane));
    if (!activities()[pane]) {
      if (wasQueued) setNotices((current) => ({ ...current, [pane]: "Removed from the run-all queue." }));
      return;
    }
    setActivities((current) => ({ ...current, [pane]: null }));
    editorFor(pane).cancel();
    setNotices((current) => ({ ...current, [pane]: "Stopped. Your input is unchanged." }));
  }

  function setPassage(text: string) {
    // Editing the passage invalidates every result, plus any preflight or approval prompt still in flight for the old text.
    stopAll();
    pendingLocalJobs = [];
    for (const pane of PANES) clearOutput(pane);
    setPassageText(text);
  }

  function clearOutput(pane: Pane) {
    setResults((current) => ({ ...current, [pane]: null }));
    setNotices((current) => ({ ...current, [pane]: null }));
  }

  function onEvent(pane: Pane, message: WorkerResponse) {
    if (activities()[pane]?.id !== message.id) return;
    switch (message.type) {
      case "download-required":
        updateActivity(pane, message.id, { download: message.download, progress: null, message: "Approval needed before downloading missing files." });
        if (approvedModels.has(message.download.key)) approve(pane);
        break;
      case "status":
        if (!activities()[pane]?.download) updateActivity(pane, message.id, { message: message.message });
        break;
      case "progress":
        updateActivity(pane, message.id, { progress: message.progress });
        break;
      case "editing-progress":
        updateActivity(pane, message.id, {
          message: `${message.completed} of ${message.total} sections processed.`, progress: null,
        });
        break;
      case "model-ready":
        updateActivity(pane, message.id, {
          message: `${ENGINE_LABELS[message.engine]} ready · ${BACKEND_LABELS[message.backend]}`,
          progress: null,
        });
        break;
      case "fallback":
        updateActivity(pane, message.id, { message: message.message, progress: null });
        break;
      case "cache-warning":
        setNotices((current) => ({ ...current, [pane]: message.message }));
        break;
    }
  }

  function approve(pane: Pane) {
    const activity = activities()[pane];
    if (!activity?.download) return;
    focusRequest = activity.id;
    if (!editorFor(pane).approveDownload(activity.id, activity.download.key)) {
      stop(pane);
      setNotices((current) => ({ ...current, [pane]: "This download request expired. Run the check again." }));
      return;
    }
    updateActivity(pane, activity.id, { download: null, message: "Loading approved files. Cached files are reused." });
  }

  async function run(pane: Pane): Promise<Result> {
    if (runBlocked(pane)) throw new Error(LOCAL_PANES.includes(pane) ? `${PANE_TITLES[pane]} is already running.` : "Another AI check is running. Finish or stop it first.");
    const source = passage();
    if (!source.trim()) throw new Error("Add text before running this engine.");
    const engine: WorkerEngine = pane === "qwen-rewrite" ? "qwen" : pane;
    const action = pane === "qwen-rewrite" ? qwenRewriteAction() : "grammar";
    const id = ++sequence;
    focusRequest = id;
    clearOutput(pane);
    setActivities((current) => ({
      ...current, [pane]: { id, message: `Preparing ${ENGINE_LABELS[engine]}…`, progress: null, download: null },
    }));
    try {
      const started = performance.now();
      const output = await editorFor(pane).run({
        type: "rewrite", id, action, text: source, attempt: 0, engine, comparison: true,
        ...(action === "grammar" ? { grammarDepth: LOCAL_PANES.includes(pane) ? "quick" : "deep" } : {}),
      }, (event) => onEvent(pane, event));
      if (activities()[pane]?.id !== id) throw new DOMException("The input changed.", "AbortError");
      const result: Result = { ...output, source, action, elapsedMs: performance.now() - started };
      setResults((current) => ({ ...current, [pane]: result }));
      queueMicrotask(() => {
        const activeElement = document.activeElement;
        const stillInPanel = document.getElementById(`${pane}-panel`)?.contains(activeElement);
        const blurredRunButton = activeElement === document.body && focusRequest === id;
        if (results()[pane] === result && (stillInPanel || blurredRunButton)) {
          outputHeadings[pane]?.focus();
        }
      });
      return result;
    } catch (error) {
      if (activities()[pane]?.id === id) {
        const message = error instanceof Error ? error.message : String(error);
        setNotices((current) => ({ ...current, [pane]: message }));
      }
      throw error;
    } finally {
      if (activities()[pane]?.id === id) setActivities((current) => ({ ...current, [pane]: null }));
    }
  }

  async function runAll() {
    if (batchRunning() || batchChecking() || anyBusy()) return;
    const panes = passage().trim() ? [...PANES] : [];
    if (!panes.length) return;
    const token = ++batchToken;
    const localJobs = panes
      .filter((pane) => LOCAL_PANES.includes(pane))
      .map((pane) => run(pane).catch(() => undefined));
    setBatchChecking(true);
    let missing: readonly PaneModel[];
    try {
      missing = await missingDownloads(panes.filter((pane) => !LOCAL_PANES.includes(pane)));
    } finally {
      setBatchChecking(false);
    }
    // The passage may have changed while the cache was being read; that edit already cancelled this run.
    if (batchToken !== token) return;
    if (missing.length) {
      pendingLocalJobs = localJobs;
      setBatchPlan(missing);
      return;
    }
    void startBatch(panes, localJobs);
  }

  function confirmBatch() {
    const plan = batchPlan();
    if (!plan) return;
    for (const model of plan) for (const key of approvedKeys(model)) approvedModels.add(key);
    setBatchPlan(null);
    const panes = passage().trim() ? [...PANES] : [];
    const localJobs = pendingLocalJobs;
    pendingLocalJobs = [];
    if (panes.length) void startBatch(panes, localJobs);
  }

  async function startBatch(panes: readonly Pane[], localJobs: readonly Promise<unknown>[] = []) {
    const token = ++batchToken;
    const aiPanes = panes.filter((pane) => !LOCAL_PANES.includes(pane));
    setBatchRunning(true);
    setQueued(aiPanes);
    const jobs: Promise<unknown>[] = [...localJobs];
    jobs.push((async () => {
      for (const pane of aiPanes) {
        if (batchToken !== token) return;
        if (!queued().includes(pane)) continue;
        setQueued((current) => current.filter((item) => item !== pane));
        await run(pane).catch(() => undefined);
      }
    })());
    await Promise.all(jobs);
    if (batchToken !== token) return;
    approvedModels.clear();
    setQueued([]);
    setBatchRunning(false);
  }

  function stopAll() {
    batchToken += 1;
    setQueued([]);
    setBatchRunning(false);
    setBatchPlan(null);
    approvedModels = new Set();
    for (const pane of PANES) stop(pane);
  }

  onMount(() => {
    const context = document.modelContext;
    if (!context?.registerTool) return;
    const lifecycle = new AbortController();
    const registration = context.registerTool({
      name: "rewrite_text_on_device",
      title: "Proofread or rewrite text on device",
      description: "Run an engine in its own input/output panel. The dictionary and Harper answer immediately with no download; the neural engines may ask the user to approve weights first. Qwen grammar uses the grammar-only column; other Qwen actions use the rewrites column. AI output is not postprocessed by Harper or applied to the input automatically.",
      inputSchema: {
        type: "object",
        properties: {
          text: { type: "string", minLength: 1 },
          engine: { type: "string", enum: ["dictionary", "harper", "coedit", "qwen"] },
          action: { type: "string", enum: [...EDIT_ACTIONS], description: "Only Qwen supports actions other than grammar." },
        },
        required: ["text", "engine"], additionalProperties: false,
      },
      annotations: { readOnlyHint: false, untrustedContentHint: true },
      async execute(input: unknown) {
        if (!input || typeof input !== "object") throw new TypeError("Input must be an object.");
        const value = input as Record<string, unknown>;
        if (typeof value.text !== "string" || !value.text.trim()) throw new TypeError("text must not be empty.");
        if (value.engine !== "dictionary" && value.engine !== "harper" &&
          value.engine !== "coedit" && value.engine !== "qwen") {
          throw new TypeError("Choose dictionary, harper, coedit, or qwen explicitly.");
        }
        const action = value.action ?? "grammar";
        if (!isRewriteAction(action) || (value.engine !== "qwen" && action !== "grammar")) {
          throw new TypeError("Only Qwen supports tone and length actions.");
        }
        const pane: Pane = value.engine === "qwen" && action !== "grammar" ? "qwen-rewrite" : value.engine;
        if (runBlocked(pane)) throw new Error(LOCAL_PANES.includes(pane) ? `${PANE_TITLES[pane]} is already running.` : "Another AI check is running. Finish or stop it first.");
        if (pane === "qwen-rewrite" && action !== "grammar") setQwenRewriteAction(action);
        setPassage(value.text);
        const result = await run(pane);
        return {
          originalText: result.source, rewrittenText: result.text, action: result.action,
          engine: result.engine, backend: result.backend, warnings: result.warnings,
          findings: result.findings, pane, state: "previewed",
        };
      },
    }, { signal: lifecycle.signal });
    void Promise.resolve(registration)
      .then(() => setAgentTool(true))
      .catch((error: unknown) => console.warn("WebMCP registration was unavailable.", error));
    onCleanup(() => { lifecycle.abort(); setAgentTool(false); });
  });

  onCleanup(() => {
    batchToken += 1;
    setQueued([]);
    setBatchRunning(false);
    setActivities({ dictionary: null, harper: null, coedit: null, qwen: null, "qwen-rewrite": null });
    editors.harper.dispose();
    editors.dictionary.dispose();
    editors.neural.dispose();
  });

  const Panel = (props: { pane: Pane }) => {
    const title = PANE_TITLES[props.pane];
    const activity = () => activities()[props.pane];
    const result = () => results()[props.pane];
    const isQueued = () => queued().includes(props.pane);
    const diff = createMemo(() => {
      const value = result();
      return value ? diffWords(value.source, value.text) : [];
    });
    return (
      <section id={`${props.pane}-panel`} class="comparison-panel" aria-labelledby={`${props.pane}-title`}>
        <header class="panel-heading">
          <h2 id={`${props.pane}-title`}>{title}</h2>
          <div class="engine-weight">
            <span class="weight-size">{PANE_COPY[props.pane].weight}</span>
            <span class="weight-gate">{PANE_COPY[props.pane].gate}</span>
            <div class="weight-bar" aria-hidden="true">
              <span style={{ width: `${weightShare(PANE_COPY[props.pane].bytes)}%` }} />
            </div>
          </div>
          <p>{PANE_COPY[props.pane].summary}</p>
          <Show when={PANE_COPY[props.pane].detail}>{(detail) => (
            <p class="engine-explanation">{detail()}</p>
          )}</Show>
          <Show when={props.pane === "qwen-rewrite"}>
            <div class="model-controls">
              <div>
                <label for="qwen-rewrite-action">Rewrite action</label>
                <select id="qwen-rewrite-action" value={qwenRewriteAction()} disabled={Boolean(activity())}
                  onChange={(event) => {
                    const action = event.currentTarget.value;
                    if (isRewriteAction(action) && action !== "grammar") {
                      setQwenRewriteAction(action);
                      clearOutput("qwen-rewrite");
                    } else setNotices((current) => ({ ...current, "qwen-rewrite": "Choose a listed rewrite action." }));
                  }}>
                  <For each={REWRITE_GROUPS}>{(group) => (
                    <optgroup label={group.label}>
                      <For each={group.actions}>{(action) => <option value={action}>{ACTION_LABELS[action]}</option>}</For>
                    </optgroup>
                  )}</For>
                </select>
              </div>
            </div>
          </Show>
        </header>

        <div class="panel-actions">
          <Show when={activity() || isQueued()} fallback={
            <button class="secondary-button" type="button" disabled={!anyInput() || runBlocked(props.pane)}
              onClick={() => void run(props.pane).catch(() => undefined)}>Run {title}</button>
          }>
            <button class="secondary-button" type="button"
              aria-label={activity() ? undefined : `Leave queue for ${title}`}
              onClick={() => stop(props.pane)}>{activity() ? `Stop ${title}` : "Leave queue"}</button>
          </Show>
        </div>

        <div class="panel-status" aria-live="polite">
          <Show when={!activity() && isQueued()}>
            <p>Queued. AI checks run one at a time.</p>
          </Show>
          <Show when={activity()}>{(current) => (
            <>
              <p>{current().message}</p>
              <Show when={current().download}>{(offer) => (
                <section class="download-prompt" aria-label={`${title} download approval`}>
                  <h3>Download {offer().label}?</h3>
                  <p>About {offer().size.replace(/^about /, "")}. Only missing files are fetched; cached files are reused.</p>
                  <p>Your input stays on this device. Nothing is uploaded to a model service.</p>
                  <div class="panel-actions">
                    <button class="primary-button" type="button" onClick={() => approve(props.pane)}>Download and run</button>
                    <button class="secondary-button" type="button" onClick={() => stop(props.pane)}>Not now</button>
                  </div>
                </section>
              )}</Show>
              <Show when={current().progress !== null && !current().download}>
                <div class="progress-wrap" role="progressbar" aria-label={`${title} file progress`}
                  aria-valuemin="0" aria-valuemax="100" aria-valuenow={Math.round(current().progress ?? 0)}>
                  <div class="progress-track"><span style={{ width: `${current().progress ?? 0}%` }} /></div>
                  <span>{Math.round(current().progress ?? 0)}%</span>
                </div>
              </Show>
            </>
          )}</Show>
          <Show when={notices()[props.pane]}>{(notice) => <p class="notice">{notice()}</p>}</Show>
        </div>

        <div class="panel-output">
        <h3 class="output-heading" ref={(element) => { outputHeadings[props.pane] = element; }} tabindex="-1">{title} output</h3>
        <Show when={result()} fallback={<p class="empty-output">Not run yet.</p>}>
          {(value) => (
            <>
              <p class="output-description">
                {ENGINE_LABELS[value().engine]} · {resultScope(value())} · {BACKEND_LABELS[value().backend]} · {formatElapsed(value().elapsedMs)}
                {value().text === value().source ? " · Returned unchanged—not a guarantee of correct grammar." : ""}
              </p>
              <div class="output-view-caption">
                <Show when={value().text !== value().source} fallback={<span>No textual changes.</span>}>
                  <span class="change-legend"><span class="removed-key">Removed</span><span class="added-key">Added</span></span>
                </Show>
              </div>
              <div class="diff-block" aria-label={`${title} output`}>
                <For each={diff()}>{(part) => part.kind === "added"
                  ? <ins>{part.value}</ins>
                  : part.kind === "removed" ? <del>{part.value}</del> : <span>{part.value}</span>}</For>
              </div>
              <Show when={value().findings}>{(findings) => (
                <details class="findings" open>
                  <summary>{findings().length} {title} {findings().length === 1 ? "finding" : "findings"} · {findings().filter((finding) => !finding.applied).length} not applied automatically</summary>
                  <p>Alternatives need a decision. The first suggestion is not always correct, and nothing here chooses for you.</p>
                  <ol>
                    <For each={findings()}>{(finding) => (
                      <li>
                        <div><strong>{finding.kind}</strong><span>{finding.applied ? "Applied" : "Review"}</span></div>
                        <p class="finding-source">{finding.problem}</p>
                        <p>{finding.suggestions.length
                          ? finding.suggestions.map((suggestion) => suggestion || "(remove)").join(" / ")
                          : "No automatic replacement offered."}</p>
                      </li>
                    )}</For>
                  </ol>
                </details>
              )}</Show>
              <Show when={value().warnings.length}>
                <details class="review-notes">
                  <summary>Automatic review notes ({value().warnings.length})</summary>
                  <p>These conservative checks can flag harmless corrections. They do not alter or hide the output above.</p>
                  <ul><For each={value().warnings}>{(warning) => <li>{warning}</li>}</For></ul>
                </details>
              </Show>
            </>
          )}
        </Show>
        </div>
      </section>
    );
  };

  return (
    <div class="app-shell">
      <header class="topbar">
        <a class="skip-link" href="#passage">Skip to the passage</a>
        <span class="wordmark">On-device spelling &amp; grammar</span>
        <span class="privacy-pill">Your text never leaves this tab</span>
      </header>
      <main class="comparison-workspace">
        <header class="comparison-heading">
          <h1>Spelling and grammar, checked entirely in your browser</h1>
          <p>Four engines proofread the same passage, and a fifth rewrites it for tone or length. Nothing is uploaded — a Hunspell word list and Harper's rule checks ship with the page and answer instantly, while CoEdIT Base and Qwen 3 are neural models that download into this tab and run on WebGPU. The same job costs half a megabyte at one end and a gigabyte at the other, so run them side by side and see what the extra weight actually buys.</p>
          <Show when={agentTool()}>
            <p class="agent-note">This page also registers a WebMCP tool, so an AI agent running inside the browser can call these engines directly and read back their findings.</p>
          </Show>
        </header>

        <section class="passage-panel" aria-labelledby="passage-title">
          <div class="passage-intro">
            <h2 id="passage-title">The passage</h2>
            <p>Every engine below reads this same text. Editing it clears the results so you are never comparing outputs from different inputs.</p>
          </div>
          <div class="sample-row">
            <p class="sample-heading" id="sample-label">Test cases</p>
            <div class="sample-chips" role="group" aria-labelledby="sample-label">
              <For each={SAMPLES}>{(sample) => (
                <button type="button" class="sample-chip" aria-pressed={activeSample()?.id === sample.id}
                  disabled={anyBusy()} onClick={() => setPassage(sample.text)}>{sample.label}</button>
              )}</For>
            </div>
            <p class="sample-hint">
              {activeSample()?.hint ?? "Your own text. Pick a test case above to load a passage built to separate the engines."}
            </p>
          </div>
          <label class="field-label" for="passage">Passage to check</label>
          <textarea id="passage" value={passage()} spellcheck={false}
            onInput={(event) => setPassage(event.currentTarget.value)}
            placeholder="Paste the passage you want to check…" />
          <div class="comparison-controls">
            <button
              class={batchRunning() ? "secondary-button" : "primary-button"}
              type="button"
              disabled={batchChecking() || Boolean(batchPlan()) || (!batchRunning() && (!anyInput() || anyBusy()))}
              onClick={() => { if (batchRunning()) stopAll(); else void runAll(); }}
            >{batchRunning() ? "Stop all" : batchChecking() ? "Checking cache…" : "Run all five"}</button>
            <button class="text-button" type="button" disabled={!passage() || anyBusy()}
              onClick={() => setPassage("")}>Clear passage</button>
            <span class="resource-note">The dictionary and Harper run right away; the AI engines run one at a time to limit memory. Finished outputs stay visible.</span>
          </div>
          <Show when={batchPlan()}>{(plan) => (
            <section class="batch-prompt" aria-label="Run all five download approval">
              <h2>Approve downloads before running all five</h2>
              <p>These weights are not cached yet. Approve once and the whole run finishes without stopping to ask again.</p>
              <ul>
                <For each={plan()}>{(model) => (
                  <li>
                    <strong>{model.spec.label}</strong>
                    <span>about {formatBytes(model.estimate.bytes)} · {model.spec.license}</span>
                  </li>
                )}</For>
                <Show when={plan().length > 1}>
                  <li class="batch-total">
                    <strong>Total</strong>
                    <span>about {formatBytes(plan().reduce((sum, model) => sum + model.estimate.bytes, 0))}</span>
                  </li>
                </Show>
              </ul>
              <p class="batch-prompt-note">The exact build depends on your GPU, so the size may vary. Your text stays in this tab; only model files are fetched.</p>
              <div class="panel-actions">
                <button class="primary-button" type="button" onClick={confirmBatch}>Download and run all five</button>
                <button class="secondary-button" type="button" onClick={() => setBatchPlan(null)}>Cancel</button>
              </div>
            </section>
          )}</Show>
        </section>
        <div class="comparison-grid"><For each={PANES}>{(pane) => <Panel pane={pane} />}</For></div>
      </main>
      <footer class="site-footer">
        <p class="footer-credit">
          Built by <a href="https://codylindley.com" target="_blank" rel="noopener noreferrer">Cody Lindley<span class="visually-hidden"> (opens in a new tab)</span></a>
          <span aria-hidden="true"> · </span>
          <a href="https://github.com/codylindley/on-device-rewrite-demo" target="_blank" rel="noopener noreferrer">Source on GitHub<span class="visually-hidden"> (opens in a new tab)</span></a>
        </p>
      </footer>
    </div>
  );
}
