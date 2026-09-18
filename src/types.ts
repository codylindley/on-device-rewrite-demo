export const EDIT_ACTIONS = [
  "grammar",
  "concise",
  "longer",
  "casual",
  "professional",
  "confident",
  "enthusiastic",
  "lighthearted",
] as const;

export type RewriteAction = (typeof EDIT_ACTIONS)[number];

export function isRewriteAction(value: unknown): value is RewriteAction {
  return typeof value === "string" && EDIT_ACTIONS.some((action) => action === value);
}

export type GrammarDepth = "quick" | "deep";
export type EngineId = "harper" | "dictionary" | "coedit" | "qwen";
export type WorkerEngine = "harper" | "dictionary" | "coedit" | "qwen";
export type InferenceBackend = "webgpu" | "wasm" | "browser" | "javascript";

export const ENGINE_LABELS: Record<EngineId, string> = {
  harper: "Harper",
  dictionary: "Hunspell dictionary",
  coedit: "CoEdIT Base",
  qwen: "Qwen 3",
};

export interface RewriteRequest {
  type: "rewrite";
  id: number;
  text: string;
  action: RewriteAction;
  attempt: number;
  grammarDepth?: GrammarDepth;
  engine?: WorkerEngine;
  comparison?: boolean;
}

export interface DownloadOffer {
  key: string;
  label: string;
  size: string;
  source: "browser" | "huggingface";
}

export interface DownloadApproval {
  type: "allow-download";
  id: number;
  key: string;
}

export type WorkerRequest = RewriteRequest | DownloadApproval;

export function isDownloadApproval(value: unknown): value is DownloadApproval {
  if (!value || typeof value !== "object") return false;
  const request = value as Record<string, unknown>;
  return request.type === "allow-download" &&
    Number.isSafeInteger(request.id) && Number(request.id) > 0 &&
    typeof request.key === "string" && request.key.length > 0;
}

export function isRewriteRequest(value: unknown): value is RewriteRequest {
  if (!value || typeof value !== "object") return false;
  const request = value as Record<string, unknown>;
  return request.type === "rewrite" &&
    typeof request.id === "number" && Number.isSafeInteger(request.id) && request.id > 0 &&
    typeof request.text === "string" && Boolean(request.text.trim()) &&
    isRewriteAction(request.action) &&
    typeof request.attempt === "number" && Number.isSafeInteger(request.attempt) && request.attempt >= 0 &&
    (request.comparison === undefined || typeof request.comparison === "boolean") &&
    (request.grammarDepth === undefined ||
      (request.action === "grammar" && (request.grammarDepth === "quick" || request.grammarDepth === "deep"))) &&
    (request.engine === undefined || request.engine === "qwen" ||
      ((request.engine === "harper" || request.engine === "dictionary") &&
        request.action === "grammar" && request.grammarDepth !== "deep") ||
      (request.engine === "coedit" && request.action === "grammar" && request.grammarDepth === "deep"));
}

export interface GrammarFinding {
  kind: string;
  problem: string;
  suggestions: string[];
  applied: boolean;
}

export interface EngineResult {
  text: string;
  warnings: string[];
  engine: EngineId;
  backend: InferenceBackend;
  findings?: GrammarFinding[];
}

export type EngineEvent =
  | {
      type: "status";
      phase: "detecting" | "loading" | "downloading" | "generating";
      message: string;
    }
  | {
      type: "download-required";
      download: DownloadOffer;
    }
  | {
      type: "model-ready";
      backend: InferenceBackend;
      source: "cache" | "download" | "browser";
    }
  | {
      type: "cache-warning";
      message: string;
    }
  | {
      type: "progress";
      progress: number;
      source?: "cache" | "download";
      loaded?: number;
      total?: number;
    }
  | {
      type: "editing-progress";
      completed: number;
      total: number;
    }
  | {
      type: "backend";
      backend: InferenceBackend;
    }
  | {
      type: "fallback";
      message: string;
    }
  | {
      type: "result";
      text: string;
      backend: InferenceBackend;
      warnings: string[];
      findings?: GrammarFinding[];
    }
  | {
      type: "error";
      message: string;
    };

export type WorkerResponse = EngineEvent & { id: number; engine: EngineId };
