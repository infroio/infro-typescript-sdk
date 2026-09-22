/**
 * The transport every resource is built on.
 *
 * WHAT THIS FILE IS RESPONSIBLE FOR, AND WHY IT IS ONE FILE
 *
 * Authentication, retries, idempotency, timeouts and error mapping are decided
 * once, here, rather than per resource. The alternative — each resource doing
 * its own `fetch` — is how one endpoint ends up retrying a `400`, another
 * forgets the idempotency key, and a third loses the request id from the error
 * it throws.
 *
 * ZERO DEPENDENCIES, ON PURPOSE
 *
 * `fetch`, `AbortController`, `TextDecoder` and `crypto.randomUUID` are all
 * platform globals in Node 18+, Bun, Deno, Cloudflare Workers and every
 * browser. An SDK for an inference gateway is very often installed *into* an
 * edge runtime, and a dependency that assumes Node is exactly what makes that
 * fail at deploy time rather than at install time.
 *
 * RETRIES ARE NARROW AND IDEMPOTENT, WHICH IS THE WHOLE POINT
 *
 * Only the four statuses the docs name as retryable — 408, 429, 502, 503 — and
 * only with an `Idempotency-Key`, so a retry of a request the gateway already
 * accepted returns the first response instead of doing the work twice. Retrying
 * a billed POST without one is how a customer is charged twice for a render
 * they asked for once.
 *
 * `Retry-After` wins over the computed backoff when the server sends it, and
 * jitter is applied so a fleet that failed together does not retry together.
 */

import { InfroConnectionError, InfroError, errorFromResponse } from "./errors.js";

/** Published production base URL. Overridable for staging and for tests. */
export const DEFAULT_BASE_URL = "https://api.infro.io/v1";

export interface ClientOptions {
  /**
   * An `sk_infro_…` key. Falls back to `INFRO_API_KEY` in the environment.
   *
   * Read from the environment by default because a key in source is a key in
   * version control, and the one place an SDK can make that the harder path is
   * its constructor.
   */
  apiKey?: string;
  baseUrl?: string;
  /** Wall-clock budget for one attempt. Retries get their own. */
  timeoutMs?: number;
  /** Attempts *after* the first. Two by default; zero disables retrying. */
  maxRetries?: number;
  /** Extra headers on every request — a proxy token, a trace header. */
  defaultHeaders?: Record<string, string>;
  /** Swap the transport. Used by the tests, and by anyone behind a proxy. */
  fetch?: typeof fetch;
}

export interface RequestOptions {
  /** Cancels the request, including any retry still to come. */
  signal?: AbortSignal;
  timeoutMs?: number;
  maxRetries?: number;
  headers?: Record<string, string>;
  /**
   * Reuse a key to make a retry safe across process restarts.
   *
   * One is generated per call otherwise, which covers retries *within* a call.
   * Supplying your own is what makes a retry safe after your own process died
   * mid-request — the case an SDK cannot see.
   */
  idempotencyKey?: string;
}

const DEFAULT_TIMEOUT_MS = 600_000;
const DEFAULT_MAX_RETRIES = 2;
const RETRYABLE_STATUSES = new Set([408, 429, 502, 503]);

/** Package version, sent in `User-Agent` so support can identify a client. */
export const VERSION = "0.1.0";

export class HttpClient {
  readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly defaultHeaders: Record<string, string>;
  private readonly fetchImpl: typeof fetch;

  constructor(options: ClientOptions = {}) {
    const apiKey = options.apiKey ?? readEnv("INFRO_API_KEY");
    if (!apiKey) {
      throw new Error(
        "No INFRO API key. Pass `apiKey` or set INFRO_API_KEY in the environment. " +
          "Create a key at https://dash.infro.io.",
      );
    }

    this.apiKey = apiKey;
    this.baseUrl = (options.baseUrl ?? readEnv("INFRO_BASE_URL") ?? DEFAULT_BASE_URL).replace(
      /\/+$/,
      "",
    );
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
    this.defaultHeaders = options.defaultHeaders ?? {};
    this.fetchImpl = options.fetch ?? globalThis.fetch;

    if (typeof this.fetchImpl !== "function") {
      throw new Error(
        "No global `fetch`. Node 18 or newer, or pass one as `fetch` in the client options.",
      );
    }
  }

  /** A JSON request that returns a parsed body. */
  async request<T>(
    method: string,
    path: string,
    body?: unknown,
    options: RequestOptions = {},
  ): Promise<T> {
    const response = await this.raw(method, path, body, options);
    if (response.status === 204) return undefined as T;
    return (await response.json()) as T;
  }

  /**
   * A request that returns the `Response` itself.
   *
   * Streaming and binary bodies need the response rather than a parsed one, and
   * both must still get the same authentication, retries and error mapping —
   * so they come through here rather than around it.
   */
  async raw(
    method: string,
    path: string,
    body?: unknown,
    options: RequestOptions = {},
  ): Promise<Response> {
    const url = `${this.baseUrl}${path.startsWith("/") ? path : `/${path}`}`;
    const maxRetries = options.maxRetries ?? this.maxRetries;
    const timeoutMs = options.timeoutMs ?? this.timeoutMs;

    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.apiKey}`,
      Accept: "application/json",
      "User-Agent": `infro-typescript/${VERSION}`,
      ...this.defaultHeaders,
      ...options.headers,
    };

    const isWrite = method !== "GET" && method !== "HEAD";
    if (isWrite) {
      headers["Content-Type"] = "application/json";
      // Sent on every write, not only on the retry, because the gateway keys
      // on it *when it first sees the request* — adding it on the second
      // attempt would be a different request as far as the server is concerned.
      headers["Idempotency-Key"] = options.idempotencyKey ?? newIdempotencyKey();
    }

    let lastError: InfroError | InfroConnectionError | undefined;

    for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
      if (attempt > 0) {
        await sleep(backoffMs(attempt, lastError), options.signal);
      }

      const controller = new AbortController();
      const onAbort = () => controller.abort();
      options.signal?.addEventListener("abort", onAbort, { once: true });
      const timer = setTimeout(() => controller.abort(), timeoutMs);

      try {
        const response = await this.fetchImpl(url, {
          method,
          headers,
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          signal: controller.signal,
        });

        if (response.ok) return response;

        // Read the body before deciding, so the error carries the gateway's own
        // message rather than a status number.
        const parsed = await response.json().catch(() => null);
        const error = errorFromResponse(response.status, parsed, response.headers);

        if (!RETRYABLE_STATUSES.has(response.status) || attempt === maxRetries) throw error;
        lastError = error;
      } catch (caught) {
        if (caught instanceof InfroError) {
          // Re-thrown from just above, or thrown by `response.json()` on a
          // body we already decided about. Either way the decision was made
          // there: `retryable` is keyed on the status, and re-deciding it here
          // is how a `400` gets retried three times. That is not hypothetical —
          // an earlier draft of this loop did exactly that, because a `throw`
          // inside a `try` lands in its own `catch`.
          if (!caught.retryable || attempt === maxRetries) throw caught;
          lastError = caught;
          continue;
        }

        // The caller's own cancellation is not a failure to retry — it is the
        // outcome they asked for, and re-issuing the request would be the
        // opposite of what an abort means.
        if (options.signal?.aborted) throw caught;

        const connection = new InfroConnectionError(
          caught instanceof Error && caught.name === "AbortError"
            ? `Request timed out after ${timeoutMs}ms`
            : `Could not reach ${this.baseUrl}`,
          caught,
        );
        if (attempt === maxRetries) throw connection;
        lastError = connection;
      } finally {
        clearTimeout(timer);
        options.signal?.removeEventListener("abort", onAbort);
      }
    }

    /* c8 ignore next -- the loop always returns or throws. */
    throw lastError ?? new InfroConnectionError("Request failed with no outcome");
  }
}

/**
 * How long to wait before attempt `n`.
 *
 * `Retry-After` first, because the server knows when capacity frees up and a
 * computed guess that undershoots produces a second `429`. Otherwise
 * exponential with full jitter — a fleet that failed together must not retry
 * together, which is what turns a blip into a thundering herd.
 */
export function backoffMs(
  attempt: number,
  error: InfroError | InfroConnectionError | undefined,
  random: () => number = Math.random,
): number {
  if (error instanceof InfroError && error.retryAfter !== null && error.retryAfter >= 0) {
    return Math.min(error.retryAfter * 1000, 60_000);
  }
  const ceiling = Math.min(500 * 2 ** (attempt - 1), 8_000);
  return Math.round(ceiling * (0.5 + random() * 0.5));
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? new Error("aborted"));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    function onAbort() {
      clearTimeout(timer);
      reject(signal?.reason ?? new Error("aborted"));
    }
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/** A key the gateway can deduplicate on. */
function newIdempotencyKey(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  // Every supported runtime has `randomUUID`; this exists so an unusual one
  // degrades to a still-unique key rather than to no key at all, which would
  // silently make retries unsafe.
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** Read an environment variable without assuming Node. */
function readEnv(name: string): string | undefined {
  const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process
    ?.env;
  return env?.[name];
}
