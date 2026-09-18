import {
  isRewriteRequest,
  type EngineResult,
  type RewriteRequest,
  type WorkerEngine,
  type WorkerResponse,
} from "../types.ts";
import { WorkerClient, type WorkerPort } from "./worker-client.ts";

interface Run {
  request: RewriteRequest;
  abort: AbortController;
  onEvent(message: WorkerResponse): void;
}

interface Dependencies {
  createWorker(engine: WorkerEngine): WorkerPort;
}

function createWorker(engine: WorkerEngine): WorkerPort {
  if (engine === "harper") return new Worker(new URL("../grammar.worker.ts", import.meta.url), { type: "module" });
  if (engine === "dictionary") return new Worker(new URL("../dictionary.worker.ts", import.meta.url), { type: "module" });
  return new Worker(new URL("../rewrite.worker.ts", import.meta.url), { type: "module" });
}

export class EditorEngine {
  private readonly dependencies: Dependencies;
  private readonly quick: WorkerClient;
  private words: WorkerClient | null = null;
  private model: WorkerClient | null = null;
  private active: Run | null = null;

  constructor(dependencies: Partial<Dependencies> = {}) {
    this.dependencies = { createWorker, ...dependencies };
    this.quick = new WorkerClient("harper", () => this.dependencies.createWorker("harper"));
  }

  async run(request: RewriteRequest, onEvent: Run["onEvent"]): Promise<EngineResult> {
    if (!isRewriteRequest(request)) throw new Error("Invalid editing request.");
    if (this.active) throw new Error("Another edit is already running.");
    const run: Run = { request, onEvent, abort: new AbortController() };
    this.active = run;
    try {
      // Every column names its own engine; nothing here ever picks one on the reader's behalf.
      if (!request.engine) throw new Error("Choose an engine for the comparison.");
      if (request.engine === "harper") return await this.quick.run(request, onEvent);
      if (request.engine === "dictionary") return await this.runDictionary(run);
      return await this.runModel(run, request.engine);
    } finally {
      if (this.active === run) this.active = null;
    }
  }

  approveDownload(id: number, key: string): boolean {
    const run = this.active;
    if (!run || run.request.id !== id) return false;
    return this.model?.approve(id, key) ?? false;
  }

  cancel(): void {
    const run = this.active;
    this.active = null;
    run?.abort.abort(new DOMException("The edit was stopped.", "AbortError"));
    if (this.quick.busy) this.quick.cancel();
    if (this.words?.busy) this.words.cancel();
    if (this.model?.busy) this.model.cancel();
  }

  dispose(): void {
    this.cancel();
    this.quick.dispose();
    this.words?.dispose();
    this.words = null;
    this.model?.dispose();
    this.model = null;
  }

  private runDictionary(run: Run): Promise<EngineResult> {
    run.abort.signal.throwIfAborted();
    this.words ??= new WorkerClient("dictionary", () => this.dependencies.createWorker("dictionary"));
    return this.words.run(run.request, run.onEvent);
  }

  private runModel(run: Run, engine: "qwen" | "coedit"): Promise<EngineResult> {
    run.abort.signal.throwIfAborted();
    if (this.model?.engine !== engine) {
      this.model?.dispose();
      this.model = new WorkerClient(engine, () => this.dependencies.createWorker(engine));
    }
    return this.model.run(run.request, run.onEvent);
  }
}
