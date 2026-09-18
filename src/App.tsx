import {
  For,
  Show,
  createMemo,
  createSignal,
  onCleanup,
  onMount,
} from "solid-js";
import { diffWords } from "./lib/diff";
import {
  EDIT_ACTIONS,
  isRewriteAction,
  type InferenceBackend,
  type RewriteAction,
  type WorkerRequest,
  type WorkerResponse,
} from "./types";

interface ActionOption {
  id: RewriteAction;
  label: string;
  shortLabel: string;
}

const PROOFREAD_ACTION: ActionOption = {
  id: "grammar",
  label: "Fix spelling & grammar",
  shortLabel: "Spelling & grammar",
};

const LENGTH_ACTIONS: ReadonlyArray<ActionOption> = [
  { id: "concise", label: "Concise", shortLabel: "Concise" },
  { id: "longer", label: "Longer", shortLabel: "Longer" },
];

const TONE_ACTIONS: ReadonlyArray<ActionOption> = [
  { id: "casual", label: "Casual", shortLabel: "Casual" },
  { id: "professional", label: "Professional", shortLabel: "Professional" },
  { id: "confident", label: "Confident", shortLabel: "Confident" },
  { id: "enthusiastic", label: "Enthusiastic", shortLabel: "Enthusiastic" },
  { id: "lighthearted", label: "Light-hearted", shortLabel: "Light-hearted" },
];

const ACTIONS: ReadonlyArray<ActionOption> = [
  PROOFREAD_ACTION,
  ...LENGTH_ACTIONS,
  ...TONE_ACTIONS,
];

const STARTER_TEXT =
  "Hey team, I wanted to check if we could maybe move tomorrows review a little later because I haven't finish the notes yet.";

type UiPhase =
  | "idle"
  | "detecting"
  | "loading"
  | "generating"
  | "ready"
  | "error";

interface RewriteResult {
  before: string;
  after: string;
  action: RewriteAction;
  attempt: number;
  warnings: string[];
}

interface ActiveRequest {
  id: number;
  text: string;
  action: RewriteAction;
  attempt: number;
}

interface PendingPromise {
  id: number;
  resolve(value: string): void;
  reject(reason: Error): void;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${Math.round(bytes / 1024 / 1024)} MB`;
}

interface EditingProgress {
  completed: number;
  total: number;
}

function friendlyError(message: string): string {
  if (/fetch|network|download|failed to load/i.test(message)) {
    return "The model download was interrupted. Check your connection and try again.";
  }
  if (/memory|allocation|out of bounds|runtime/i.test(message)) {
    return "This device ran out of memory while loading the model. Close other tabs and try again.";
  }
  if (/could not produce a usable edit|left unchanged|omitted too much|changed too much/i.test(message)) {
    return "The local model could not produce a safe edit. Retry, or edit the difficult section separately.";
  }
  return "The local model could not finish this edit. You can retry without losing your text.";
}

export default function App() {
  const [text, setText] = createSignal(STARTER_TEXT);
  const [phase, setPhase] = createSignal<UiPhase>("idle");
  const [statusText, setStatusText] = createSignal(
    "The model downloads on your first edit, then stays in the browser cache.",
  );
  const [progress, setProgress] = createSignal<number | null>(null);
  const [progressBytes, setProgressBytes] = createSignal<string | null>(null);
  const [editingProgress, setEditingProgress] = createSignal<EditingProgress | null>(null);
  const [backend, setBackend] = createSignal<InferenceBackend | null>(null);
  const [activeAction, setActiveAction] = createSignal<RewriteAction | null>(null);
  const [result, setResult] = createSignal<RewriteResult | null>(null);
  const [errorDetails, setErrorDetails] = createSignal<string | null>(null);
  const [busy, setBusy] = createSignal(false);

  let worker: Worker | undefined;
  let sequence = 0;
  let activeRequest: ActiveRequest | null = null;
  let pendingPromise: PendingPromise | null = null;
  let textarea: HTMLTextAreaElement | undefined;
  let resultHeading: HTMLHeadingElement | undefined;

  const wordCount = createMemo(() => {
    const trimmed = text().trim();
    return trimmed ? trimmed.split(/\s+/).length : 0;
  });

  const activeActionLabel = createMemo(
    () => ACTIONS.find((action) => action.id === activeAction())?.shortLabel ?? "Edit",
  );

  const diff = createMemo(() => {
    const candidate = result();
    return candidate ? diffWords(candidate.before, candidate.after) : [];
  });

  const hasChanges = createMemo(() => {
    const candidate = result();
    return candidate ? candidate.before !== candidate.after : false;
  });

  const engineTitle = createMemo(() => {
    switch (phase()) {
      case "detecting":
        return "Choosing the fastest engine";
      case "loading":
        return progress() === null ? "Loading the local model" : `Downloading · ${Math.round(progress() ?? 0)}%`;
      case "generating":
        return editingProgress()?.total && editingProgress()!.total > 1
          ? `${activeActionLabel()} · ${editingProgress()!.completed} of ${editingProgress()!.total}`
          : `${activeActionLabel()} in progress`;
      case "ready":
        return "Model ready on this device";
      case "error":
        return "That edit did not finish";
      default:
        return "Ready when you are";
    }
  });

  function settlePending(error?: Error, value?: string) {
    if (!pendingPromise) return;
    const pending = pendingPromise;
    pendingPromise = null;
    if (error) pending.reject(error);
    else pending.resolve(value ?? "");
  }

  function handleWorkerMessage(event: MessageEvent<WorkerResponse>) {
    const message = event.data;
    if (!activeRequest || message.id !== activeRequest.id) return;

    switch (message.type) {
      case "status":
        setPhase(message.phase);
        setStatusText(message.message);
        if (message.phase === "generating") {
          setProgress(null);
          setProgressBytes(null);
          setEditingProgress(null);
        }
        break;
      case "progress": {
        setPhase("loading");
        setProgress(message.progress);
        if (message.loaded && message.total) {
          setProgressBytes(`${formatBytes(message.loaded)} of ${formatBytes(message.total)}`);
        }
        break;
      }
      case "editing-progress":
        setPhase("generating");
        setEditingProgress({
          completed: message.completed,
          total: message.total,
        });
        setStatusText(
          message.total > 1
            ? `Editing section ${Math.min(message.completed + 1, message.total)} of ${message.total}…`
            : "Editing locally on your device…",
        );
        break;
      case "backend":
        setBackend(message.backend);
        break;
      case "fallback":
        setPhase("loading");
        setBackend("wasm");
        setProgress(null);
        setProgressBytes(null);
        setStatusText(message.message);
        break;
      case "result": {
        const request = activeRequest;
        activeRequest = null;
        setBackend(message.backend);
        setBusy(false);
        setPhase("ready");
        setProgress(null);
        setProgressBytes(null);
        setEditingProgress(null);
        setStatusText(
          message.warnings.length
            ? `Finished with ${message.warnings.length} section${message.warnings.length === 1 ? "" : "s"} left unchanged for safety.`
            : "This model is cached for faster edits during future visits.",
        );
        setResult({
          before: request.text,
          after: message.text,
          action: request.action,
          attempt: request.attempt,
          warnings: message.warnings,
        });
        settlePending(undefined, message.text);
        queueMicrotask(() => resultHeading?.focus());
        break;
      }
      case "error":
        activeRequest = null;
        setBusy(false);
        setPhase("error");
        setProgress(null);
        setProgressBytes(null);
        setEditingProgress(null);
        setErrorDetails(message.message);
        setStatusText(friendlyError(message.message));
        settlePending(new Error(message.message));
        break;
    }
  }

  function ensureWorker(): Worker {
    if (worker) return worker;

    worker = new Worker(new URL("./rewrite.worker.ts", import.meta.url), {
      type: "module",
    });
    worker.addEventListener("message", handleWorkerMessage);
    worker.addEventListener("error", (event) => {
      if (!activeRequest) return;
      const message = event.message || "The model worker stopped unexpectedly.";
      activeRequest = null;
      setBusy(false);
      setPhase("error");
      setProgress(null);
      setStatusText(friendlyError(message));
      setErrorDetails(message);
      settlePending(new Error(message));
    });
    return worker;
  }

  function startRewrite(
    action: RewriteAction,
    sourceText: string,
    attempt = 0,
  ): Promise<string> {
    const trimmed = sourceText.trim();
    if (!trimmed) return Promise.reject(new Error("Add some text before choosing an edit."));
    if (busy()) return Promise.reject(new Error("Another edit is already running."));

    const id = ++sequence;
    const request: WorkerRequest = {
      type: "rewrite",
      id,
      text: sourceText,
      action,
      attempt,
    };

    setResult(null);
    setErrorDetails(null);
    setBusy(true);
    setPhase("detecting");
    setStatusText("Preparing the on-device editor…");
    setProgress(null);
    setProgressBytes(null);
    setEditingProgress(null);
    setActiveAction(action);
    activeRequest = { id, text: sourceText, action, attempt };

    const response = new Promise<string>((resolve, reject) => {
      pendingPromise = { id, resolve, reject };
    });
    ensureWorker().postMessage(request);
    return response;
  }

  function stopWork(reason = "The edit was stopped.") {
    if (!activeRequest) return;
    const stoppedId = activeRequest.id;
    activeRequest = null;
    worker?.terminate();
    worker = undefined;
    setBusy(false);
    setPhase("idle");
    setProgress(null);
    setProgressBytes(null);
    setEditingProgress(null);
    setBackend(null);
    setActiveAction(null);
    setStatusText("Stopped. Any downloaded model files remain in the browser cache.");
    if (pendingPromise?.id === stoppedId) settlePending(new Error(reason));
  }

  function handleTextInput(value: string) {
    if (busy()) stopWork("The composer changed, so the running edit was stopped.");
    setText(value);
    setResult(null);
    setErrorDetails(null);
    if (phase() === "error") {
      setPhase("idle");
      setStatusText("Your text stays here. Choose an action whenever you are ready.");
    }
  }

  function replaceText() {
    const candidate = result();
    if (!candidate) return;
    setText(candidate.after);
    setResult(null);
    setActiveAction(null);
    setStatusText("Suggestion applied. The model remains ready for another edit.");
    queueMicrotask(() => {
      textarea?.focus();
      textarea?.setSelectionRange(candidate.after.length, candidate.after.length);
    });
  }

  function cancelResult() {
    setResult(null);
    setActiveAction(null);
    queueMicrotask(() => textarea?.focus());
  }

  function clearText() {
    if (busy()) stopWork();
    setText("");
    setResult(null);
    setActiveAction(null);
    queueMicrotask(() => textarea?.focus());
  }

  onMount(() => {
    const context = document.modelContext;
    if (!context?.registerTool) return;

    const lifecycle = new AbortController();
    const registration = context.registerTool(
      {
        name: "rewrite_text_on_device",
        title: "Improve text on device",
        description:
          "Stage an on-device grammar correction or rewrite in the visible preview. Use when the user wants to improve supplied text without uploading it to a server.",
        inputSchema: {
          type: "object",
          properties: {
            text: { type: "string", minLength: 1 },
            action: {
              type: "string",
              enum: [...EDIT_ACTIONS],
            },
          },
          required: ["text", "action"],
          additionalProperties: false,
        },
        annotations: { readOnlyHint: false, untrustedContentHint: true },
        async execute(input: unknown) {
          if (!input || typeof input !== "object") throw new TypeError("Input must be an object.");
          const candidate = input as { text?: unknown; action?: unknown };
          if (typeof candidate.text !== "string" || !candidate.text.trim()) {
            throw new TypeError("text must be a non-empty string.");
          }
          if (!isRewriteAction(candidate.action)) throw new TypeError("action is not supported.");

          setText(candidate.text);
          setResult(null);
          const rewrittenText = await startRewrite(candidate.action, candidate.text);
          return {
            action: candidate.action,
            originalText: candidate.text,
            rewrittenText,
            backend: backend(),
            state: "previewed",
          };
        },
      },
      { signal: lifecycle.signal },
    );

    void Promise.resolve(registration).catch((error: unknown) => {
      console.warn("WebMCP tool registration was unavailable.", error);
    });
    onCleanup(() => lifecycle.abort());
  });

  onCleanup(() => {
    worker?.terminate();
    settlePending(new Error("The page was closed."));
  });

  return (
    <div class="app-shell">
      <header class="topbar">
        <a class="brand" href="#composer" aria-label="Local Edit home">
          <span class="brand-mark" aria-hidden="true">L</span>
          <span>Local Edit</span>
        </a>
        <div class="privacy-pill">
          <span class="privacy-dot" aria-hidden="true" />
          Private by design
        </div>
      </header>

      <main class="workspace">
        <section class="intro" aria-labelledby="page-title">
          <p class="eyebrow">ON-DEVICE WRITING LAB / 01</p>
          <div>
            <h1 id="page-title">Say it better.<br /><span>Keep it yours.</span></h1>
            <p class="intro-copy">
              Polish your writing in your browser. Your words stay on this device.
            </p>
          </div>
        </section>

        <section
          class="editor-card"
          id="composer"
          aria-labelledby="composer-title"
          aria-busy={busy()}
        >
          <div class="card-heading">
            <div>
              <p class="section-kicker">COMPOSER</p>
              <h2 id="composer-title">What do you want to improve?</h2>
            </div>
            <span class="word-count">{wordCount()} words</span>
          </div>

          <div class="editor-layout">
            <div class="draft-column">
              <label class="sr-only" for="draft">Text to improve</label>
              <p class="input-guidance" id="draft-guidance">
                Longer passages are edited section by section. Review every suggestion before replacing your text.
              </p>
              <textarea
                ref={textarea}
                id="draft"
                value={text()}
                onInput={(event) => handleTextInput(event.currentTarget.value)}
                aria-describedby="draft-guidance draft-limit"
                placeholder="Type or paste the text you want to improve…"
              />

              <div class="editor-footer">
                <span
                  id="draft-limit"
                  aria-live="polite"
                >
                  {text().length.toLocaleString("en-US")} characters
                </span>
                <Show
                  when={busy()}
                  fallback={
                    <button class="clear-button" type="button" onClick={clearText} disabled={!text()}>
                      Clear
                    </button>
                  }
                >
                  <button class="stop-button" type="button" onClick={() => stopWork()}>
                    Stop edit
                  </button>
                </Show>
              </div>
            </div>

            <div class="action-block">
              <p class="action-label">Choose what to change</p>
              <p class="action-note">Every option also checks spelling and grammar.</p>
              <div class="action-groups">
                <fieldset class="action-group">
                  <legend>Correct</legend>
                  <button
                    class="action-button"
                    classList={{ "is-active": busy() && activeAction() === PROOFREAD_ACTION.id }}
                    type="button"
                    disabled={!text().trim() || busy()}
                    onClick={() =>
                      void startRewrite(PROOFREAD_ACTION.id, text()).catch(() => undefined)
                    }
                  >
                    {PROOFREAD_ACTION.label}
                  </button>
                </fieldset>

                <fieldset class="action-group">
                  <legend>Make it</legend>
                  <div class="action-grid">
                    <For each={LENGTH_ACTIONS}>
                      {(action) => (
                        <button
                          class="action-button"
                          classList={{ "is-active": busy() && activeAction() === action.id }}
                          type="button"
                          disabled={!text().trim() || busy()}
                          onClick={() =>
                            void startRewrite(action.id, text()).catch(() => undefined)
                          }
                        >
                          {action.label}
                        </button>
                      )}
                    </For>
                  </div>
                </fieldset>

                <fieldset class="action-group action-group-wide">
                  <legend>Make it sound</legend>
                  <div class="action-grid tone-grid">
                    <For each={TONE_ACTIONS}>
                      {(action) => (
                        <button
                          class="action-button"
                          classList={{ "is-active": busy() && activeAction() === action.id }}
                          type="button"
                          disabled={!text().trim() || busy()}
                          onClick={() =>
                            void startRewrite(action.id, text()).catch(() => undefined)
                          }
                        >
                          {action.label}
                        </button>
                      )}
                    </For>
                  </div>
                </fieldset>
              </div>
            </div>
          </div>
        </section>

        <aside class="engine-card" aria-labelledby="engine-title">
          <Show
            when={result()}
            fallback={
              <>
                <div class="engine-copy">
                  <div class="engine-title-row">
                    <div>
                      <p class="section-kicker">LOCAL ENGINE</p>
                      <h2 id="engine-title">{engineTitle()}</h2>
                    </div>
                    <Show when={backend()}>
                      {(activeBackend) => (
                        <span class="backend-badge">{activeBackend().toUpperCase()}</span>
                      )}
                    </Show>
                  </div>
                  <p>{statusText()}</p>
                  <Show when={progress() !== null}>
                    <div
                      class="progress-wrap"
                      role="progressbar"
                      aria-label="Model download progress"
                      aria-valuemin="0"
                      aria-valuemax="100"
                      aria-valuenow={Math.round(progress() ?? 0)}
                    >
                      <div class="progress-track">
                        <span style={{ width: `${progress() ?? 0}%` }} />
                      </div>
                      <div class="progress-meta">
                        <span>{Math.round(progress() ?? 0)}%</span>
                        <Show when={progressBytes()}>{(bytes) => <span>{bytes()}</span>}</Show>
                      </div>
                    </div>
                  </Show>
                  <Show when={editingProgress()?.total && editingProgress()!.total > 1}>
                    <div
                      class="progress-wrap"
                      role="progressbar"
                      aria-label="Text editing progress"
                      aria-valuemin="0"
                      aria-valuemax={editingProgress()!.total}
                      aria-valuenow={editingProgress()!.completed}
                    >
                      <div class="progress-track">
                        <span
                          style={{
                            width: `${Math.round(
                              (editingProgress()!.completed / editingProgress()!.total) * 100,
                            )}%`,
                          }}
                        />
                      </div>
                      <div class="progress-meta">
                        <span>{editingProgress()!.completed} of {editingProgress()!.total}</span>
                        <span>sections</span>
                      </div>
                    </div>
                  </Show>
                  <Show when={phase() === "error"}>
                    <div class="error-note" role="alert">
                      <span aria-hidden="true">!</span>
                      <p>{statusText()}</p>
                    </div>
                    <Show when={errorDetails()}>
                      {(details) => (
                        <details class="error-details">
                          <summary>Technical details</summary>
                          <code>{details()}</code>
                        </details>
                      )}
                    </Show>
                  </Show>
                </div>
                <dl class="engine-facts">
                  <div><dt>Model</dt><dd>Qwen 3 · 0.6B</dd></div>
                  <div><dt>Acceleration</dt><dd>WebGPU → WASM</dd></div>
                  <div><dt>Network</dt><dd>Model files only</dd></div>
                </dl>
                <div class="engine-visual" classList={{ "is-working": busy() }} aria-hidden="true">
                  <span>{busy() ? "PROCESSING" : "LOCAL"}</span>
                  <div class="orbit orbit-one" />
                  <div class="orbit orbit-two" />
                  <div class="core">{busy() ? <span class="spinner" /> : "AI"}</div>
                </div>
              </>
            }
          >
            {(candidate) => (
              <section class="result-panel" aria-labelledby="result-title">
                <div class="result-heading">
                  <div>
                    <p class="section-kicker">SUGGESTION / {activeActionLabel().toUpperCase()}</p>
                    <h2 id="result-title" ref={resultHeading} tabindex="-1">
                      {hasChanges() ? "Here’s a cleaner version" : "No changes suggested"}
                    </h2>
                  </div>
                  <span class="ready-mark" aria-hidden="true">✓</span>
                </div>

                <div class="suggestion-text" aria-label="Suggested text">
                  {candidate().after}
                </div>

                <Show when={candidate().warnings.length}>
                  <details class="result-warning">
                    <summary>
                      {candidate().warnings.length} section{candidate().warnings.length === 1 ? "" : "s"} need review
                    </summary>
                    <ul>
                      <For each={candidate().warnings}>
                        {(warning) => <li>{warning}</li>}
                      </For>
                    </ul>
                  </details>
                </Show>

                <div class="diff-heading">
                  <h3>Changes</h3>
                  <div class="diff-legend" aria-hidden="true">
                    <span class="removed-key">Removed</span>
                    <span class="added-key">Added</span>
                  </div>
                </div>
                <div class="diff-block" aria-label="Word-level changes">
                  <Show when={hasChanges()} fallback={<span class="unchanged-note">Your original already fits this edit.</span>}>
                    <For each={diff()}>
                      {(part) => (
                        <Show
                          when={part.kind !== "same"}
                          fallback={<span>{part.value}</span>}
                        >
                          <Show
                            when={part.kind === "added"}
                            fallback={<del title="Removed text">{part.value}</del>}
                          >
                            <ins title="Added text">{part.value}</ins>
                          </Show>
                        </Show>
                      )}
                    </For>
                  </Show>
                </div>

                <div class="result-actions">
                  <button class="primary-button" type="button" onClick={replaceText}>
                    Replace
                  </button>
                  <button
                    class="secondary-button"
                    type="button"
                    onClick={() =>
                      void startRewrite(
                        candidate().action,
                        candidate().before,
                        candidate().attempt + 1,
                      ).catch(() => undefined)
                    }
                  >
                    Retry
                  </button>
                  <button class="text-button" type="button" onClick={cancelResult}>
                    Cancel
                  </button>
                </div>
              </section>
            )}
          </Show>
        </aside>

        <p class="sr-only" aria-live="polite">
          {busy() ? `${activeActionLabel()} is running. ${statusText()}` : statusText()}
        </p>
      </main>

      <footer class="site-footer">
        <span>Runs with Transformers.js</span>
        <span aria-hidden="true">•</span>
        <span>No account. No server. No text upload.</span>
      </footer>
    </div>
  );
}
