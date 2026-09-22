/**
 * The wire shapes, as the gateway actually serves them.
 *
 * TWO NAMING CONVENTIONS, AND THAT IS DELIBERATE
 *
 * Request and response fields are `snake_case` because that is what the API
 * uses and what every published example shows. An SDK that camel-cased them
 * would make the docs unusable — a reader copying `duration_seconds` out of a
 * curl example into typed code would get a compile error and no explanation.
 *
 * PROVIDER INVISIBILITY IS A TYPE-LEVEL PROPERTY HERE
 *
 * There is no `provider` field on any type in this file, because there is none
 * on the wire. What responses carry is `route` — `"primary"`, `"standby_a"` —
 * which answers "did my traffic move?" without answering "to whom?". A field
 * added here that the gateway does not serve would be a promise the SDK cannot
 * keep, and this one would be a promise it must not.
 */

/** Where in the model's chain a request was served. Never a vendor name. */
export type Route = "primary" | `standby_${string}`;

export interface Usage {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  /** Prompt tokens the provider served from its own cache. */
  prompt_tokens_details?: { cached_tokens: number | null };
  /** Images, seconds, characters — whatever this modality bills. */
  units?: number;
  /**
   * Estimated cost of this request in USD: what your own provider will bill
   * for it, at the rate you entered or the vendor's published rate. INFRO
   * charges nothing per request. Absent when the model is unpriced.
   */
  cost?: number;
}

/* ------------------------------------------------------------------ *
 * Chat
 * ------------------------------------------------------------------ */

export type ChatRole = "system" | "user" | "assistant" | "tool" | "developer";

/** A content part. A string is shorthand for one text part. */
export type ContentPart =
  | { type: "text"; text: string; cache_control?: { type: "ephemeral" } }
  | { type: "image_url"; image_url: { url: string; detail?: "low" | "high" | "auto" } };

export interface ChatMessage {
  role: ChatRole;
  content: string | ContentPart[] | null;
  name?: string;
  tool_call_id?: string;
  tool_calls?: unknown[];
}

/**
 * INFRO's own request extensions.
 *
 * Top-level body fields rather than headers, and ignored by any other
 * OpenAI-compatible backend — which is what keeps a codebase that uses them
 * portable. `routing.providers` is deliberately absent: the gateway refuses it
 * with `provider_selection_unsupported`, because a customer cannot name a
 * provider they are never shown.
 */
export interface InfroExtensions {
  routing?: {
    policy?: "cheapest" | "fastest" | "balanced";
    regions?: string[];
  };
  /** Other models to try when every route for the primary one fails. */
  fallbacks?: string[];
  /** Per-request opt-out of content storage. Can never opt *in*. */
  logging?: false;
  /** Opaque tags, echoed on the request record and exported as span attributes. */
  metadata?: Record<string, string>;
}

export interface ChatCompletionCreateParams extends InfroExtensions {
  model: string;
  messages: ChatMessage[];
  max_tokens?: number;
  temperature?: number;
  top_p?: number;
  stop?: string | string[];
  frequency_penalty?: number;
  presence_penalty?: number;
  tools?: unknown[];
  tool_choice?: unknown;
  response_format?: unknown;
  seed?: number;
  /** Your own opaque end-user identifier. Forwarded; it is yours, not ours. */
  user?: string;
  stream?: boolean;
  stream_options?: { include_usage?: boolean };
  /** Anything else is forwarded to the upstream unchanged. */
  [key: string]: unknown;
}

export interface ChatCompletionChoice {
  index: number;
  message: { role: "assistant"; content: string | null; tool_calls?: unknown[] };
  finish_reason: string | null;
}

export interface ChatCompletion {
  id: string;
  object: "chat.completion";
  created: number;
  /** The model that *served*, which is not always the one requested. */
  model: string;
  route: Route | null;
  choices: ChatCompletionChoice[];
  usage: Usage;
}

export interface ChatCompletionChunk {
  id: string;
  object: "chat.completion.chunk";
  created: number;
  model: string;
  route: Route | null;
  choices: {
    index: number;
    delta: { role?: string; content?: string; tool_calls?: unknown[] };
    finish_reason: string | null;
  }[];
  /** Present only on the final chunk, and only with `include_usage`. */
  usage?: Usage;
}

/* ------------------------------------------------------------------ *
 * Images
 * ------------------------------------------------------------------ */

export interface ImageGenerateParams extends InfroExtensions {
  model: string;
  prompt: string;
  n?: number;
  size?: string;
  /** `url` re-hosts to INFRO's CDN; `b64_json` returns the bytes inline. */
  response_format?: "url" | "b64_json";
  seed?: number;
  [key: string]: unknown;
}

export interface ImageResponse {
  id: string;
  created: number;
  model: string;
  route: Route | null;
  data: { url: string | null; b64_json: string | null }[];
  usage: Usage;
}

/* ------------------------------------------------------------------ *
 * Video and jobs
 * ------------------------------------------------------------------ */

export type JobStatus = "queued" | "running" | "succeeded" | "failed" | "cancelled";

export interface VideoCreateParams extends InfroExtensions {
  model: string;
  prompt: string;
  duration_seconds?: number;
  resolution?: string;
  aspect_ratio?: string;
  /** A first frame, as a URL or a data URL. */
  image?: string;
  seed?: number;
  webhook?: { url: string; events?: string[] };
  [key: string]: unknown;
}

export interface Job {
  id: string;
  object: "job";
  status: JobStatus;
  model: string;
  route: Route | null;
  created: number;
  completed_at?: number | null;
  output?: { url: string; expires_at: number } | null;
  error?: { message: string; type: string; code: string | null } | null;
  usage?: Usage;
}

/* ------------------------------------------------------------------ *
 * Audio
 * ------------------------------------------------------------------ */

export interface SpeechParams extends InfroExtensions {
  model: string;
  input: string;
  voice: string;
  format?: "mp3" | "wav" | "opus" | "flac";
  speed?: number;
  [key: string]: unknown;
}

export interface TranscriptionParams extends InfroExtensions {
  model: string;
  /** A URL or a data URL. */
  file: string;
  language?: string;
  prompt?: string;
  [key: string]: unknown;
}

export interface Transcription {
  text: string;
  language: string | null;
  usage: Usage;
}

/* ------------------------------------------------------------------ *
 * Catalog and account
 * ------------------------------------------------------------------ */

export interface Model {
  id: string;
  name: string;
  modality: "text" | "image" | "video" | "audio";
  context_length: number | null;
  /** Documented flags: `tools`, `vision`, `json`. Empty means unpublished. */
  capabilities: string[];
  pricing: Record<string, string>;
}

export interface KeyInfo {
  id: string;
  label: string;
  organization: string;
  rate_limit_rpm: number;
  spend_limit: number | null;
  usage: number;
  balance: number;
}

export interface Page<T> {
  data: T[];
  has_more?: boolean;
  next_cursor?: string | null;
}
