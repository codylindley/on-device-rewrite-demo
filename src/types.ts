export type RewriteAction =
  | "grammar"
  | "rewrite"
  | "concise"
  | "professional"
  | "casual";

export type InferenceBackend = "webgpu" | "wasm";

export interface RewriteRequest {
  type: "rewrite";
  id: number;
  text: string;
  action: RewriteAction;
  attempt: number;
}

export type WorkerRequest = RewriteRequest;

export type WorkerResponse =
  | {
      type: "status";
      id: number;
      phase: "detecting" | "loading" | "generating";
      message: string;
    }
  | {
      type: "progress";
      id: number;
      progress: number;
      loaded?: number;
      total?: number;
    }
  | {
      type: "backend";
      id: number;
      backend: InferenceBackend;
    }
  | {
      type: "fallback";
      id: number;
      message: string;
    }
  | {
      type: "result";
      id: number;
      text: string;
      backend: InferenceBackend;
    }
  | {
      type: "error";
      id: number;
      message: string;
    };
