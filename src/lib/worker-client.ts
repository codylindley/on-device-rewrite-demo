import type { EngineResult, RewriteRequest, WorkerEngine, WorkerRequest, WorkerResponse } from "../types.ts";

export interface WorkerPort {
  postMessage(message: WorkerRequest): void;
  terminate(): void;
  onmessage: ((event: MessageEvent<WorkerResponse>) => void) | null;
  onerror: ((event: ErrorEvent) => void) | null;
  onmessageerror: ((event: MessageEvent<unknown>) => void) | null;
}

interface Pending {
  id: number;
  onEvent(message: WorkerResponse): void;
  resolve(result: EngineResult): void;
  reject(error: Error): void;
}

export class WorkerClient {
  private worker: WorkerPort | null = null;
  private pending: Pending | null = null;
  private approvalKey: string | null = null;
  ready = false;

  get busy(): boolean { return this.pending !== null; }

  constructor(
    readonly engine: WorkerEngine,
    private readonly factory: () => WorkerPort,
  ) {}

  run(request: RewriteRequest, onEvent: Pending["onEvent"]): Promise<EngineResult> {
    if (this.pending) return Promise.reject(new Error("Another edit is already running."));
    return new Promise((resolve, reject) => {
      this.pending = { id: request.id, onEvent, resolve, reject };
      try {
        if (!this.worker) {
          const worker = this.factory();
          this.worker = worker;
          // A terminated worker can still deliver a late event; only the current one may speak.
          worker.onmessage = ({ data }) => { if (this.worker === worker) this.receive(data); };
          worker.onerror = (event) => {
            if (this.worker === worker) this.fail(new Error(event.message || "The local editing worker stopped."));
          };
          worker.onmessageerror = () => {
            if (this.worker === worker) this.fail(new Error("The browser could not read the editing result."));
          };
        }
        this.worker.postMessage({ ...request, engine: this.engine });
      } catch (error) {
        this.fail(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  approve(id: number, key: string): boolean {
    if (!this.pending || this.pending.id !== id || this.approvalKey !== key || !this.worker) return false;
    try {
      this.worker.postMessage({ type: "allow-download", id, key });
      this.approvalKey = null;
      return true;
    } catch (error) {
      this.fail(error instanceof Error ? error : new Error(String(error)));
      return false;
    }
  }

  cancel(): void {
    this.fail(new DOMException("The edit was stopped.", "AbortError"));
  }

  dispose(): void {
    this.cancel();
  }

  private receive(message: WorkerResponse): void {
    const pending = this.pending;
    if (!pending || (message.id !== pending.id && !(message.id === 0 && message.type === "error"))) return;
    if (message.engine !== this.engine) {
      this.fail(new Error("The editing worker returned an unexpected engine."));
      return;
    }
    if (message.type === "download-required") this.approvalKey = message.download.key;
    if (message.type === "model-ready") this.ready = true;
    pending.onEvent(message);
    if (message.type === "result") {
      this.pending = null;
      this.approvalKey = null;
      pending.resolve({
        text: message.text, warnings: message.warnings, engine: this.engine, backend: message.backend,
        ...(message.findings ? { findings: message.findings } : {}),
      });
    } else if (message.type === "error") {
      this.fail(new Error(message.message));
    }
  }

  private fail(error: Error): void {
    const pending = this.pending;
    const worker = this.worker;
    this.pending = null;
    this.approvalKey = null;
    this.ready = false;
    this.worker = null;
    if (worker) {
      worker.onmessage = null;
      worker.onerror = null;
      worker.onmessageerror = null;
      worker.terminate();
    }
    pending?.reject(error);
  }
}
