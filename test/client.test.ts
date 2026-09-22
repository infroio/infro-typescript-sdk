/**
 * The transport, which is where every expensive mistake in a client SDK lives.
 *
 * The three that matter, and that this suite exists to prevent:
 *
 *  - **Retrying something that should not be retried.** A `400` retried three
 *    times is three times the latency for the same failure; a billed `POST`
 *    retried without an idempotency key is a customer charged twice for one
 *    render.
 *  - **Losing the request id.** It is the first thing support asks for and the
 *    last thing anybody records, so an error that drops it turns a two-minute
 *    lookup into a conversation.
 *  - **Mis-framing a stream.** An SSE frame split across two network reads is
 *    normal, not exceptional, and a parser that assumes otherwise works
 *    perfectly in development.
 */

import { describe, expect, it, vi } from "vitest";

import { HttpClient, backoffMs } from "../src/client.js";
import { InfroConnectionError, InfroError } from "../src/errors.js";
import { Infro } from "../src/index.js";
import { streamSse } from "../src/streaming.js";

const KEY = "unit-test-key-not-a-secret";

function json(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json", "X-INFRO-Request-Id": "req_TEST01" },
    ...init,
  });
}

function errorBody(type: string, message: string, code: string | null = null) {
  return { error: { message, type, code } };
}

/** A client whose transport is a queue of canned responses. */
function client(responses: (Response | (() => Response | Promise<Response>))[]) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetchImpl = vi.fn(async (url: string | URL, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    const next = responses.shift();
    if (!next) throw new Error("no canned response left");
    return typeof next === "function" ? await next() : next;
  });

  return {
    calls,
    fetchImpl,
    http: new HttpClient({
      apiKey: KEY,
      baseUrl: "https://api.test/v1",
      fetch: fetchImpl as unknown as typeof fetch,
      // Retries are exercised explicitly per case; sleeping between them would
      // make the suite slow for no signal.
      maxRetries: 0,
    }),
  };
}

describe("constructing a client", () => {
  it("refuses to start with no key rather than failing on the first request", () => {
    // A key missing at construction is a configuration mistake; discovering it
    // as a 401 on the first customer request is the same mistake, later and
    // with a stranger involved.
    expect(() => new HttpClient({ fetch })).toThrow(/INFRO_API_KEY/);
  });

  it("strips a trailing slash from the base URL", () => {
    const http = new HttpClient({ apiKey: KEY, baseUrl: "https://api.test/v1/", fetch });
    expect(http.baseUrl).toBe("https://api.test/v1");
  });
});

describe("every request", () => {
  it("authenticates and identifies itself", async () => {
    const { http, calls } = client([json({ ok: true })]);
    await http.request("GET", "/key");

    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers.Authorization).toBe(`Bearer ${KEY}`);
    expect(headers["User-Agent"]).toMatch(/^infro-typescript\//);
  });

  it("carries an idempotency key on a write", async () => {
    // Sent on the *first* attempt, not only on the retry: the gateway keys on
    // it when it first sees the request, so adding it later would be a
    // different request as far as the server is concerned.
    const { http, calls } = client([json({ ok: true })]);
    await http.request("POST", "/images/generations", { model: "m", prompt: "p" });

    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers["Idempotency-Key"]).toBeTruthy();
  });

  it("does not put one on a read", async () => {
    const { http, calls } = client([json({ data: [] })]);
    await http.request("GET", "/models");
    expect((calls[0]!.init.headers as Record<string, string>)["Idempotency-Key"]).toBeUndefined();
  });

  it("honours a caller-supplied idempotency key", async () => {
    const { http, calls } = client([json({ ok: true })]);
    await http.request("POST", "/videos", { model: "m" }, { idempotencyKey: "mine-42" });
    expect((calls[0]!.init.headers as Record<string, string>)["Idempotency-Key"]).toBe("mine-42");
  });
});

describe("errors", () => {
  it("carries the gateway's own message, type and request id", async () => {
    const { http } = client([
      json(errorBody("budget_exceeded", "Your balance is exhausted."), { status: 402 }),
    ]);

    const error = (await http.request("POST", "/chat/completions", {}).catch((e) => e)) as InfroError;

    expect(error).toBeInstanceOf(InfroError);
    expect(error.status).toBe(402);
    expect(error.type).toBe("budget_exceeded");
    expect(error.message).toBe("Your balance is exhausted.");
    expect(error.requestId).toBe("req_TEST01");
  });

  it("keys retryability on the status, not on the type", () => {
    // A message can be reworded; a status is what the docs promise and what a
    // proxy preserves.
    expect(new InfroError({ message: "", status: 429 }).retryable).toBe(true);
    expect(new InfroError({ message: "", status: 503 }).retryable).toBe(true);
    expect(new InfroError({ message: "", status: 400 }).retryable).toBe(false);
    expect(new InfroError({ message: "", status: 402 }).retryable).toBe(false);
  });

  it("does not retry no_provider_connected, though it is a 503", () => {
    // The one code that overrides its own status. Nothing about a second
    // attempt connects a provider account, and it is the first error most new
    // organizations meet — so the whole backoff would be spent arriving at
    // advice the first response already carried.
    expect(
      new InfroError({ message: "", status: 503, code: "no_provider_connected" }).retryable,
    ).toBe(false);
    // A plain 503 with no code is still retryable.
    expect(new InfroError({ message: "", status: 503, code: null }).retryable).toBe(true);
  });

  it("does not treat a 500 as retryable", () => {
    // A defect in the gateway's own code fails identically on a retry, so
    // retrying turns one bug into a retry storm.
    expect(new InfroError({ message: "", status: 500 }).retryable).toBe(false);
  });

  it("survives a body that is not the documented envelope", async () => {
    // A load balancer in front of INFRO can return HTML. The error still has to
    // be usable.
    const { http } = client([new Response("<html>502</html>", { status: 502 })]);
    const error = (await http.request("GET", "/models").catch((e) => e)) as InfroError;

    expect(error).toBeInstanceOf(InfroError);
    expect(error.status).toBe(502);
    expect(error.message).toMatch(/502/);
  });

  it("distinguishes a connection failure from a gateway error", async () => {
    // There is no request id, no type, and nothing INFRO can say about it — so
    // it is a different class, with different remedies.
    const { http } = client([
      () => {
        throw new TypeError("fetch failed");
      },
    ]);
    const error = await http.request("GET", "/models").catch((e) => e);

    expect(error).toBeInstanceOf(InfroConnectionError);
    expect(error).not.toBeInstanceOf(InfroError);
  });

  it("names the request id in the string form", () => {
    const error = new InfroError({
      message: "Rate limit exceeded",
      type: "rate_limit_exceeded",
      status: 429,
      requestId: "req_ABC",
    });
    expect(String(error)).toContain("req_ABC");
    expect(String(error)).toContain("status=429");
  });
});

describe("retrying", () => {
  it("retries a 503 and returns the eventual success", async () => {
    const { http, fetchImpl } = client([
      json(errorBody("no_available_provider", "no route"), { status: 503 }),
      json({ ok: true }),
    ]);
    (http as unknown as { maxRetries: number }).maxRetries = 1;

    const result = await http.request<{ ok: boolean }>("GET", "/models", undefined, {
      maxRetries: 1,
    });
    expect(result.ok).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("does not retry a 400", async () => {
    const { http, fetchImpl } = client([
      json(errorBody("invalid_request_error", "bad model"), { status: 400 }),
    ]);
    await expect(http.request("POST", "/chat/completions", {}, { maxRetries: 3 })).rejects.toThrow(
      /bad model/,
    );
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("does not retry a 402, because more credit is not a matter of waiting", async () => {
    const { http, fetchImpl } = client([
      json(errorBody("budget_exceeded", "exhausted"), { status: 402 }),
    ]);
    await expect(http.request("POST", "/videos", {}, { maxRetries: 3 })).rejects.toThrow();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("reuses the same idempotency key across a retry", async () => {
    // The point of the key. A second attempt carrying a different one is a
    // second render, and a second charge.
    const { http, calls } = client([
      json(errorBody("upstream_error", "flaky"), { status: 502 }),
      json({ ok: true }),
    ]);

    await http.request("POST", "/images/generations", { model: "m" }, { maxRetries: 1 });

    const first = (calls[0]!.init.headers as Record<string, string>)["Idempotency-Key"];
    const second = (calls[1]!.init.headers as Record<string, string>)["Idempotency-Key"];
    expect(first).toBeTruthy();
    expect(second).toBe(first);
  });

  it("gives up after the configured number of attempts", async () => {
    const { http, fetchImpl } = client([
      json(errorBody("upstream_error", "a"), { status: 502 }),
      json(errorBody("upstream_error", "b"), { status: 502 }),
      json(errorBody("upstream_error", "c"), { status: 502 }),
    ]);
    await expect(http.request("GET", "/models", undefined, { maxRetries: 2 })).rejects.toThrow(/c/);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it("does not retry after the caller aborted", async () => {
    // An abort is the outcome the caller asked for. Re-issuing the request is
    // the opposite of what it means.
    const controller = new AbortController();
    const { http, fetchImpl } = client([
      () => {
        controller.abort();
        const error = new Error("aborted");
        error.name = "AbortError";
        throw error;
      },
    ]);

    await expect(
      http.request("GET", "/models", undefined, { signal: controller.signal, maxRetries: 3 }),
    ).rejects.toThrow();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});

describe("backoff", () => {
  it("obeys Retry-After when the server sends one", () => {
    // The server knows when capacity frees up; a computed guess that
    // undershoots produces a second 429.
    const error = new InfroError({ message: "", status: 429, retryAfter: 12 });
    expect(backoffMs(1, error, () => 0.5)).toBe(12_000);
  });

  it("caps an absurd Retry-After rather than sleeping for an hour", () => {
    const error = new InfroError({ message: "", status: 429, retryAfter: 86_400 });
    expect(backoffMs(1, error, () => 0.5)).toBe(60_000);
  });

  it("grows exponentially and is jittered", () => {
    // Full jitter: a fleet that failed together must not retry together.
    const low = backoffMs(3, undefined, () => 0);
    const high = backoffMs(3, undefined, () => 1);
    expect(low).toBeLessThan(high);
    expect(high).toBeLessThanOrEqual(8_000);
  });

  it("is bounded however many attempts have failed", () => {
    expect(backoffMs(20, undefined, () => 1)).toBeLessThanOrEqual(8_000);
  });
});

/* ------------------------------------------------------------------ *
 * Streaming
 * ------------------------------------------------------------------ */

/** A response body delivered in the chunks given, byte for byte. */
function sseResponse(chunks: string[], status = 200): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
  return new Response(stream, {
    status,
    headers: { "Content-Type": "text/event-stream", "X-INFRO-Request-Id": "req_STREAM" },
  });
}

const chunk = (content: string) =>
  `data: ${JSON.stringify({
    id: "c",
    object: "chat.completion.chunk",
    choices: [{ index: 0, delta: { content }, finish_reason: null }],
  })}\n\n`;

async function collect<T>(iterable: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const item of iterable) out.push(item);
  return out;
}

describe("SSE framing", () => {
  it("yields each frame and stops at [DONE]", async () => {
    const events = await collect(
      streamSse<{ choices: { delta: { content?: string } }[] }>(
        sseResponse([chunk("Hel"), chunk("lo"), "data: [DONE]\n\n"]),
      ),
    );
    expect(events.map((e) => e.choices[0]!.delta.content)).toEqual(["Hel", "lo"]);
  });

  it("reassembles a frame split across network reads", async () => {
    // The failure that only shows up under real network conditions.
    const whole = chunk("Hello");
    const split = Math.floor(whole.length / 2);
    const events = await collect(
      streamSse<{ choices: { delta: { content?: string } }[] }>(
        sseResponse([whole.slice(0, split), whole.slice(split), "data: [DONE]\n\n"]),
      ),
    );
    expect(events).toHaveLength(1);
    expect(events[0]!.choices[0]!.delta.content).toBe("Hello");
  });

  it("handles several frames arriving in one read", async () => {
    const events = await collect(
      streamSse<unknown>(sseResponse([chunk("a") + chunk("b") + "data: [DONE]\n\n"])),
    );
    expect(events).toHaveLength(2);
  });

  it("ignores keep-alive comments a proxy injects", async () => {
    const events = await collect(
      streamSse<unknown>(sseResponse([": keep-alive\n\n", chunk("a"), "data: [DONE]\n\n"])),
    );
    expect(events).toHaveLength(1);
  });

  it("raises a mid-stream error frame as an error", async () => {
    // Nothing can be re-routed past the first byte, so this is the ending. A
    // caller iterating chunks must not have to inspect every one for a field
    // that is almost never there.
    const failure =
      `data: ${JSON.stringify({
        error: { message: "upstream died", type: "upstream_error", code: null },
      })}\n\n`;

    const error = await collect(streamSse(sseResponse([chunk("a"), failure]))).catch((e) => e);
    expect(error).toBeInstanceOf(InfroError);
    expect((error as InfroError).message).toBe("upstream died");
    expect((error as InfroError).requestId).toBe(null);
  });

  it("treats a stream that ends without [DONE] as truncated", async () => {
    // The gateway documents closing without `[DONE]` on a mid-stream failure,
    // so its absence is meaningful. Returning the partial answer silently is
    // how truncated text reaches a user as though it were complete.
    const error = await collect(streamSse(sseResponse([chunk("half an answer")]))).catch((e) => e);
    expect(error).toBeInstanceOf(InfroError);
    expect((error as InfroError).message).toMatch(/incomplete/);
  });
});

/* ------------------------------------------------------------------ *
 * Resources
 * ------------------------------------------------------------------ */

function infro(responses: (Response | (() => Response | Promise<Response>))[]) {
  const { fetchImpl, calls } = client(responses);
  return {
    calls,
    fetchImpl,
    sdk: new Infro({
      apiKey: KEY,
      baseUrl: "https://api.test/v1",
      fetch: fetchImpl as unknown as typeof fetch,
      maxRetries: 0,
    }),
  };
}

describe("the resource surface", () => {
  it("posts a chat completion to the OpenAI-compatible path", async () => {
    const { sdk, calls } = infro([
      json({ id: "c", choices: [{ message: { content: "hi" } }], usage: { cost: 0.0001 } }),
    ]);

    const completion = await sdk.chat.completions.create({
      model: "anthropic/claude-sonnet-5",
      messages: [{ role: "user", content: "Hello" }],
    });

    expect(calls[0]!.url).toBe("https://api.test/v1/chat/completions");
    expect(completion.usage.cost).toBe(0.0001);
  });

  it("sends INFRO extensions as top-level body fields", async () => {
    // Top level, not headers and not a nested envelope — which is what makes a
    // codebase that uses them still work against another OpenAI-compatible
    // backend that simply ignores them.
    const { sdk, calls } = infro([json({ id: "c", choices: [], usage: { cost: 0 } })]);

    await sdk.chat.completions.create({
      model: "m",
      messages: [],
      routing: { policy: "fastest", regions: ["eu"] },
      fallbacks: ["deepseek/deepseek-v4-flash"],
      logging: false,
      metadata: { user: "u_1" },
    });

    const body = JSON.parse(calls[0]!.init.body as string);
    expect(body.routing).toEqual({ policy: "fastest", regions: ["eu"] });
    expect(body.fallbacks).toEqual(["deepseek/deepseek-v4-flash"]);
    expect(body.logging).toBe(false);
    expect(body.metadata).toEqual({ user: "u_1" });
  });

  it("asks for usage on a stream, because cost is the number people want", async () => {
    const { sdk, calls } = infro([sseResponse(["data: [DONE]\n\n"])]);
    await sdk.chat.completions.create({ model: "m", messages: [], stream: true });

    const body = JSON.parse(calls[0]!.init.body as string);
    expect(body.stream_options.include_usage).toBe(true);
  });

  it("lets a caller turn stream usage back off", async () => {
    const { sdk, calls } = infro([sseResponse(["data: [DONE]\n\n"])]);
    await sdk.chat.completions.create({
      model: "m",
      messages: [],
      stream: true,
      stream_options: { include_usage: false },
    });
    expect(JSON.parse(calls[0]!.init.body as string).stream_options.include_usage).toBe(false);
  });

  it("never retries a stream", async () => {
    // Past the first byte the customer has already seen part of an answer, and
    // replaying would show them a sentence starting twice.
    const { sdk, fetchImpl } = infro([
      json(errorBody("upstream_error", "flaky"), { status: 502 }),
    ]);
    await expect(
      sdk.chat.completions.create({ model: "m", messages: [], stream: true }, { maxRetries: 5 }),
    ).rejects.toThrow();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("generates an image and reports its cost", async () => {
    const { sdk, calls } = infro([
      json({
        id: "req_1",
        data: [{ url: "https://cdn.infro.io/x.png", b64_json: null }],
        usage: { cost: 0.04, units: 1 },
      }),
    ]);

    const image = await sdk.images.generate({ model: "bfl/flux-2-pro", prompt: "a lighthouse" });
    expect(calls[0]!.url).toBe("https://api.test/v1/images/generations");
    expect(image.data[0]!.url).toContain("cdn.infro.io");
    expect(image.usage.cost).toBe(0.04);
  });

  it("submits a video as a job", async () => {
    const { sdk, calls } = infro([json({ id: "job_1", status: "queued" })]);
    const job = await sdk.videos.create({
      model: "kuaishou/kling-o3",
      prompt: "a lighthouse",
      duration_seconds: 6,
      webhook: { url: "https://example.com/hook" },
    });

    expect(calls[0]!.url).toBe("https://api.test/v1/videos");
    expect(job.status).toBe("queued");
    expect(JSON.parse(calls[0]!.init.body as string).duration_seconds).toBe(6);
  });

  it("escapes a job id into the path", async () => {
    // A path built by concatenation is a path an id can escape.
    const { sdk, calls } = infro([json({ id: "j", status: "queued" })]);
    await sdk.jobs.retrieve("job_../../admin");
    expect(calls[0]!.url).not.toContain("/admin");
  });
});

describe("waiting for a job", () => {
  it("polls until it succeeds", async () => {
    const { sdk, fetchImpl } = infro([
      json({ id: "j", status: "running" }),
      json({ id: "j", status: "succeeded", output: { url: "https://cdn/x.mp4", expires_at: 1 } }),
    ]);

    const job = await sdk.jobs.waitFor("j", { pollIntervalMs: 1 });
    expect(job.status).toBe("succeeded");
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("throws on a failed job rather than returning it", async () => {
    // A caller who awaited "the finished video" and got a failure object will
    // use it as though it were a video.
    const { sdk } = infro([
      json({
        id: "j",
        status: "failed",
        error: { message: "the render failed", type: "upstream_error", code: null },
      }),
    ]);

    await expect(sdk.jobs.waitFor("j", { pollIntervalMs: 1 })).rejects.toThrow(/the render failed/);
  });

  it("gives up at the deadline and says the job may still be running", async () => {
    const { sdk } = infro([json({ id: "j", status: "running" })]);
    const error = (await sdk.jobs
      .waitFor("j", { pollIntervalMs: 1, timeoutMs: 0 })
      .catch((e) => e)) as InfroError;

    expect(error.type).toBe("timeout_error");
    expect(error.message).toMatch(/may still be running/);
  });
});
