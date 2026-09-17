export const EDIT_ACTIONS = ["grammar", "concise", "professional"] as const;

export type RewriteAction = (typeof EDIT_ACTIONS)[number];

export function isRewriteAction(value: unknown): value is RewriteAction {
  return typeof value === "string" && EDIT_ACTIONS.some((action) => action === value);
}

export type InferenceBackend = "webgpu" | "wasm";

export interface RewriteRequest {
  type: "rewrite";
  id: number;
  text: string;
  action: RewriteAction;
  attempt: number;
}

export type WorkerRequest = RewriteRequest;

export function isRewriteRequest(value: unknown): value is RewriteRequest {
  if (!value || typeof value !== "object") return false;
  const request = value as Record<string, unknown>;
  return request.type === "rewrite" &&
    typeof request.id === "number" && Number.isSafeInteger(request.id) && request.id > 0 &&
    typeof request.text === "string" && Boolean(request.text.trim()) &&
    isRewriteAction(request.action) &&
    typeof request.attempt === "number" && Number.isSafeInteger(request.attempt) && request.attempt >= 0;
}

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
      type: "editing-progress";
      id: number;
      completed: number;
      total: number;
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
      warnings: string[];
    }
  | {
      type: "error";
      id: number;
      message: string;
    };
