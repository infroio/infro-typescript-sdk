/**
 * `@infro.io/sdk` — the first-party TypeScript client for the INFRO gateway.
 *
 * WHAT THIS EXISTS FOR, GIVEN THAT THE OPENAI SDK ALREADY WORKS
 *
 * Text is genuinely covered by any OpenAI-compatible client, and the docs say
 * so. What no OpenAI client can express is the rest of the platform: an image
 * generation whose response carries `usage.cost`, a video render that is an
 * async job with a signed webhook, a transcription, the catalog, the key's own
 * balance — and the INFRO extensions (`routing`, `fallbacks`, `logging`,
 * `metadata`) which in the OpenAI SDK are an untyped `extra_body` and a
 * `@ts-expect-error`.
 *
 * So this SDK's job is to make the multimodal surface typed and the extensions
 * first-class, while keeping `chat.completions.create` shaped exactly like the
 * OpenAI one so that moving a codebase across is a rename and not a rewrite.
 *
 * WHAT IT DELIBERATELY DOES NOT DO
 *
 * It does not model providers, because the gateway never names one. It does not
 * expose a `provider` request field, because the gateway refuses it. And it
 * does not retry a request without an idempotency key — see `client.ts` for why
 * that is the difference between a retry and a double charge.
 */

import { HttpClient, VERSION, type ClientOptions, type RequestOptions } from "./client.js";
import { InfroError } from "./errors.js";
import { streamSse } from "./streaming.js";
import type {
  ChatCompletion,
  ChatCompletionChunk,
  ChatCompletionCreateParams,
  ImageGenerateParams,
  ImageResponse,
  Job,
  KeyInfo,
  Model,
  Page,
  SpeechParams,
  Transcription,
  TranscriptionParams,
  VideoCreateParams,
} from "./types.js";

export * from "./types.js";
export { InfroError, InfroConnectionError, type InfroErrorType } from "./errors.js";
export { DEFAULT_BASE_URL, type ClientOptions, type RequestOptions } from "./client.js";
export { VERSION };

/* ------------------------------------------------------------------ *
 * Resources
 * ------------------------------------------------------------------ */

class Completions {
  constructor(private readonly http: HttpClient) {}

  /**
   * A chat completion.
   *
   * Overloaded on `stream` so the return type follows the argument: a caller
   * who passes `stream: true` gets an async iterable and a caller who does not
   * gets a completion, with no cast and no union to narrow. Getting this wrong
   * is the most common ergonomic complaint about hand-rolled clients.
   */
  create(
    params: ChatCompletionCreateParams & { stream?: false },
    options?: RequestOptions,
  ): Promise<ChatCompletion>;
  create(
    params: ChatCompletionCreateParams & { stream: true },
    options?: RequestOptions,
  ): Promise<AsyncIterable<ChatCompletionChunk>>;
  async create(
    params: ChatCompletionCreateParams,
    options: RequestOptions = {},
  ): Promise<ChatCompletion | AsyncIterable<ChatCompletionChunk>> {
    if (!params.stream) {
      return this.http.request<ChatCompletion>(
        "POST",
        "/chat/completions",
        params,
        options,
      );
    }

    // `include_usage` on by default for a stream, because `usage.cost` is the
    // one number a caller nearly always wants and it is only ever emitted when
    // asked for. Explicitly opting out still works.
    const body: ChatCompletionCreateParams = {
      ...params,
      stream_options: { include_usage: true, ...params.stream_options },
    };

    const response = await this.http.raw("POST", "/chat/completions", body, {
      ...options,
      headers: { Accept: "text/event-stream", ...options.headers },
      // A stream that fails after the first byte cannot be re-routed and must
      // not be replayed — the customer has already seen part of an answer.
      maxRetries: 0,
    });

    return streamSse<ChatCompletionChunk>(response, {
      requestId: response.headers.get("x-infro-request-id"),
    });
  }
}

class Chat {
  readonly completions: Completions;
  constructor(http: HttpClient) {
    this.completions = new Completions(http);
  }
}

class Images {
  constructor(private readonly http: HttpClient) {}

  /**
   * Generate one or more images.
   *
   * Synchronous: the response carries the images. `url` results are re-hosted
   * on INFRO's CDN behind a signed, expiring link — never the provider's own,
   * which would both name the upstream and disappear on their schedule.
   */
  generate(params: ImageGenerateParams, options?: RequestOptions): Promise<ImageResponse> {
    return this.http.request<ImageResponse>("POST", "/images/generations", params, options);
  }
}

class Videos {
  constructor(private readonly http: HttpClient) {}

  /**
   * Submit a render. Returns immediately with a queued job.
   *
   * Asynchronous because renders take minutes, not because of an
   * implementation detail: there is no synchronous form to fall back to.
   */
  create(params: VideoCreateParams, options?: RequestOptions): Promise<Job> {
    return this.http.request<Job>("POST", "/videos", params, options);
  }

  retrieve(jobId: string, options?: RequestOptions): Promise<Job> {
    return this.http.request<Job>("GET", `/videos/${encodeURIComponent(jobId)}`, undefined, options);
  }
}

class Jobs {
  constructor(private readonly http: HttpClient) {}

  retrieve(jobId: string, options?: RequestOptions): Promise<Job> {
    return this.http.request<Job>("GET", `/jobs/${encodeURIComponent(jobId)}`, undefined, options);
  }

  list(
    query: { status?: string; limit?: number; cursor?: string } = {},
    options?: RequestOptions,
  ): Promise<Page<Job>> {
    const search = new URLSearchParams();
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined) search.set(key, String(value));
    }
    const suffix = search.size > 0 ? `?${search}` : "";
    return this.http.request<Page<Job>>("GET", `/jobs${suffix}`, undefined, options);
  }

  cancel(jobId: string, options?: RequestOptions): Promise<Job> {
    return this.http.request<Job>(
      "POST",
      `/jobs/${encodeURIComponent(jobId)}/cancel`,
      undefined,
      options,
    );
  }

  /**
   * Poll until a job reaches a terminal status.
   *
   * A convenience, and a deliberately *unglamorous* one: a webhook is the
   * documented way to learn a render finished, and polling is what you do in a
   * script or a test where there is nowhere for a webhook to land. So it is
   * here, it backs off, it has a deadline, and its own doc comment says to use
   * a webhook in production.
   *
   * Throws on a failed job rather than returning it, because a caller who
   * awaited "the finished video" and got a failure object will use it as though
   * it were a video.
   */
  async waitFor(
    jobId: string,
    options: RequestOptions & {
      /** Give up after this long. Default 30 minutes — longer than any render. */
      timeoutMs?: number;
      /** First poll interval. Doubles up to 30s. */
      pollIntervalMs?: number;
      onUpdate?: (job: Job) => void;
    } = {},
  ): Promise<Job> {
    const deadline = Date.now() + (options.timeoutMs ?? 30 * 60_000);
    let interval = options.pollIntervalMs ?? 3_000;

    for (;;) {
      const job = await this.retrieve(jobId, options);
      options.onUpdate?.(job);

      if (job.status === "succeeded") return job;
      if (job.status === "failed" || job.status === "cancelled") {
        throw new InfroError({
          message: job.error?.message ?? `Job ${jobId} ended as ${job.status}.`,
          ...(job.error?.type === undefined ? {} : { type: job.error.type }),
          code: job.error?.code ?? null,
          status: 502,
          requestId: job.id,
        });
      }

      if (Date.now() >= deadline) {
        throw new InfroError({
          message: `Job ${jobId} did not finish within the wait timeout. It may still be running — retrieve it, or use a webhook.`,
          type: "timeout_error",
          status: 408,
          requestId: job.id,
        });
      }

      await new Promise((resolve) => setTimeout(resolve, interval));
      interval = Math.min(interval * 2, 30_000);
    }
  }
}

class Audio {
  constructor(private readonly http: HttpClient) {}

  /**
   * Text to speech. Returns the audio bytes.
   *
   * A `Response` rather than a parsed body, because the useful thing to do with
   * it is stream it to a file or a player and materialising a whole track in
   * memory to hand back an `ArrayBuffer` would be the wrong default for a long
   * one. `X-INFRO-Cost` carries the charge.
   */
  speech(params: SpeechParams, options?: RequestOptions): Promise<Response> {
    return this.http.raw("POST", "/audio/speech", params, {
      ...options,
      headers: { Accept: "audio/*", ...options?.headers },
    });
  }

  transcribe(params: TranscriptionParams, options?: RequestOptions): Promise<Transcription> {
    return this.http.request<Transcription>("POST", "/audio/transcriptions", params, options);
  }
}

class Models {
  constructor(private readonly http: HttpClient) {}

  list(options?: RequestOptions): Promise<Page<Model>> {
    return this.http.request<Page<Model>>("GET", "/models", undefined, options);
  }

  retrieve(id: string, options?: RequestOptions): Promise<Model> {
    return this.http.request<Model>("GET", `/models/${id}`, undefined, options);
  }
}

class Keys {
  constructor(private readonly http: HttpClient) {}

  /** What this key is, what it may spend, and what is left. */
  retrieve(options?: RequestOptions): Promise<KeyInfo> {
    return this.http.request<KeyInfo>("GET", "/key", undefined, options);
  }
}

class Requests {
  constructor(private readonly http: HttpClient) {}

  /** One request's full record — spans, attempts, cost, and content if stored. */
  retrieve(requestId: string, options?: RequestOptions): Promise<unknown> {
    return this.http.request("GET", `/requests/${encodeURIComponent(requestId)}`, undefined, options);
  }

  list(
    query: { from?: string; to?: string; limit?: number; cursor?: string } = {},
    options?: RequestOptions,
  ): Promise<Page<unknown>> {
    const search = new URLSearchParams();
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined) search.set(key, String(value));
    }
    const suffix = search.size > 0 ? `?${search}` : "";
    return this.http.request<Page<unknown>>("GET", `/requests${suffix}`, undefined, options);
  }
}

/* ------------------------------------------------------------------ *
 * The client
 * ------------------------------------------------------------------ */

export class Infro {
  readonly chat: Chat;
  readonly images: Images;
  readonly videos: Videos;
  readonly jobs: Jobs;
  readonly audio: Audio;
  readonly models: Models;
  readonly keys: Keys;
  readonly requests: Requests;

  /** The transport, exposed so an endpoint this SDK does not model is reachable. */
  readonly http: HttpClient;

  constructor(options: ClientOptions = {}) {
    this.http = new HttpClient(options);
    this.chat = new Chat(this.http);
    this.images = new Images(this.http);
    this.videos = new Videos(this.http);
    this.jobs = new Jobs(this.http);
    this.audio = new Audio(this.http);
    this.models = new Models(this.http);
    this.keys = new Keys(this.http);
    this.requests = new Requests(this.http);
  }
}

export default Infro;
