# @infro.io/sdk

[![npm](https://img.shields.io/npm/v/%40infro.io%2Fsdk)](https://www.npmjs.com/package/@infro.io/sdk)
[![CI](https://github.com/infroio/typescript-sdk/actions/workflows/ci.yml/badge.svg)](https://github.com/infroio/typescript-sdk/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![TypeScript](https://img.shields.io/badge/TypeScript-ready-3178c6.svg)](https://www.typescriptlang.org/)

The official TypeScript client for the [INFRO](https://infro.io) API — one
endpoint for text, image, video and audio models.

```bash
npm install @infro.io/sdk
```

```ts
import Infro from "@infro.io/sdk";

const infro = new Infro(); // reads INFRO_API_KEY

const image = await infro.images.generate({
  model: "bfl/flux-2-pro",
  prompt: "a lighthouse in fog, 35mm",
});

console.log(image.data[0].url);
console.log(`cost: $${image.usage.cost}`);
```

## Why this and not the OpenAI SDK

For text, either works — INFRO serves an OpenAI-compatible
`/v1/chat/completions` and any client that lets you override the base URL will
talk to it. What the OpenAI SDK cannot express is the rest of the platform:

- **Images, video and audio**, with `usage.cost` on every response.
- **Video as an async job**, with a signed webhook when the render lands.
- **INFRO's request extensions** — `routing`, `fallbacks`, `logging`,
  `metadata` — as typed fields rather than an untyped body plus a
  `// @ts-expect-error`.
- **The error taxonomy as a typed class**, so "should I retry this?" is
  `error.retryable` and not a substring match on a message.

## Runtime support

Zero dependencies, built on platform globals: `fetch`, `AbortController`,
`TextDecoder`, `crypto.randomUUID`. Node 18+, Bun, Deno, Cloudflare Workers,
Vercel Edge, and browsers.

The package is **ESM-only**. Node 22.12 and later can `require("@infro.io/sdk")`
through `require(esm)`; on Node 18 and 20 a CommonJS caller needs
`await import("@infro.io/sdk")`.

Edge support is not incidental — an SDK for an inference gateway is very often
installed *into* an edge runtime, and a dependency that assumes Node is what
makes that fail at deploy time rather than at install time.

## Configuration

```ts
const infro = new Infro({
  apiKey: "sk_infro_...",           // or INFRO_API_KEY in the environment
  baseUrl: "https://api.infro.io/v1",
  timeoutMs: 600_000,                // per attempt
  maxRetries: 2,                     // attempts *after* the first
  defaultHeaders: { "X-My-Trace": "…" },
});
```

The key falls back to `INFRO_API_KEY` because a key in source is a key in
version control.

## Text

Shaped exactly like the OpenAI SDK, so moving a codebase across is a rename:

```ts
const completion = await infro.chat.completions.create({
  model: "anthropic/claude-sonnet-5",
  messages: [{ role: "user", content: "Hello" }],
});

console.log(completion.choices[0].message.content);
console.log(completion.model);  // the model that *served* — matters with fallbacks
console.log(completion.route);  // "primary" | "standby_a" — a position, never a vendor
```

Streaming is an async iterable, and the return type follows the argument — no
cast, no union to narrow:

```ts
const stream = await infro.chat.completions.create({
  model: "anthropic/claude-sonnet-5",
  messages: [{ role: "user", content: "Write a haiku about fog." }],
  stream: true,
});

for await (const chunk of stream) {
  process.stdout.write(chunk.choices[0]?.delta.content ?? "");
}
```

A stream that ends *without* `[DONE]` throws rather than finishing quietly: the
gateway closes that way when a request fails after the first byte, so silence
would hand you a truncated answer that looks complete.

## Routing, fallbacks and cost control

```ts
const completion = await infro.chat.completions.create({
  model: "openai/gpt-5.6-terra",
  messages: [{ role: "user", content: "Hello" }],
  routing: { policy: "fastest", regions: ["us", "eu"] },
  fallbacks: ["deepseek/deepseek-v4-flash"],
  metadata: { user: "u_42", feature: "summariser" },
  logging: false, // this request's content is never stored
});
```

`metadata` is echoed on the request record and exported as OpenTelemetry span
attributes, so per-feature cost attribution needs no extra instrumentation.

## Video

Renders take minutes, so they are jobs. A webhook is the production path:

```ts
const job = await infro.videos.create({
  model: "kuaishou/kling-o3",
  prompt: "slow push-in on a lighthouse in fog",
  duration_seconds: 6,
  webhook: { url: "https://api.example.com/hooks/infro" },
});
```

In a script or a test, where there is nowhere for a webhook to land, poll:

```ts
const finished = await infro.jobs.waitFor(job.id, {
  onUpdate: (j) => console.log(j.status),
});
console.log(finished.output?.url);
```

`waitFor` throws on a failed render rather than returning it, because a caller
who awaited "the finished video" will use whatever comes back as one.

## Audio

```ts
const speech = await infro.audio.speech({
  model: "elevenlabs/eleven-v3",
  input: "The lighthouse keeper watched the fog roll in.",
  voice: "rachel",
});
await Bun.write("out.mp3", await speech.arrayBuffer());

const transcript = await infro.audio.transcribe({
  model: "openai/whisper-large-v3",
  file: "https://example.com/recording.mp3",
});
```

`speech` returns the `Response` rather than a buffer, so a long track can be
streamed to a file or a player instead of materialised in memory.

## Errors

```ts
import { InfroError, InfroConnectionError } from "@infro.io/sdk";

try {
  await infro.chat.completions.create({ model, messages });
} catch (error) {
  if (error instanceof InfroError) {
    error.type;       // "budget_exceeded" | "rate_limit_exceeded" | …
    error.status;     // 402
    error.requestId;  // "req_…" — the first thing support will ask for
    error.retryable;  // keyed on the status, not the type
  } else if (error instanceof InfroConnectionError) {
    // never reached the gateway — DNS, TLS, a dropped socket
  }
}
```

## Retries

Only the four statuses the docs name as retryable — `408`, `429`, `502`, `503` —
and always with an `Idempotency-Key`, so a retry of a request the gateway
already accepted returns the first response instead of doing the work twice.
`Retry-After` wins over the computed backoff; jitter stops a fleet that failed
together from retrying together.

Streams are never retried: past the first byte the caller has already seen part
of an answer.

Pass your own key to make a retry safe across a process restart — the case an
SDK cannot see:

```ts
await infro.videos.create(params, { idempotencyKey: myJobId });
```

## Cancellation

```ts
const controller = new AbortController();
setTimeout(() => controller.abort(), 5_000);

await infro.chat.completions.create(params, { signal: controller.signal });
```

An abort is the outcome you asked for, so it cancels any retry still to come
rather than re-issuing the request.

## Anything this client does not model

The gateway grows faster than a client library, so there is an escape hatch that
keeps the authentication and the retries:

```ts
const usage = await infro.http.request("GET", "/usage?from=2026-08-01");
```

## Documentation

<https://infro.io/docs> — the API reference, the error table, and the routing,
fallback and privacy semantics this client is a thin shell over.
