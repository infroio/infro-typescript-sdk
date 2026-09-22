# Changelog

All three INFRO SDKs share one version line: a customer reading a changelog
should not have to work out which of three independent version numbers applies
to them.

## 0.1.2

- Correct the runtime version reported in the SDK user agent and enforce the
  package version in tests.

## 0.1.1

- Link the package metadata to its public GitHub repository and issue tracker.
- Preserve Node 18 support by loading Web Crypto from Node's built-in module
  when it is not available globally.

## 0.1.0

First release.

- `chat.completions.create` and `.stream()` for text, plus `images.generate`,
  `videos.create`, `jobs.retrieve` / `.wait()`, `audio.speech`,
  `audio.transcribe`, `models.list`, `keys.retrieve` and `requests.retrieve` —
  each response carrying `usage.cost`.
- The documented error taxonomy as classes, so "should I retry this?" is an
  `instanceof` rather than a substring match on a message.
- Retries only on 408, 429, 502 and 503, always carrying the `Idempotency-Key`
  sent with the first attempt — except `no_provider_connected`, the one 503 a
  retry can never clear, which fails immediately so the advice in its message
  arrives without a backoff in front of it. A stream is never retried, and a
  stream that ends without `[DONE]` throws rather than returning the partial
  answer.
- `request()` as an escape hatch for endpoints this client does not yet model.
- No platform globals beyond `fetch`, `TextDecoder` and `crypto.randomUUID`, so
  it runs on Node 18+, Bun, Deno, Cloudflare Workers and the browser.

### Known limitation

The package is ESM-only. On Node 22.12+ `require("@infro.io/sdk")` works through
`require(esm)`; on Node 18 and 20 it does not, and CommonJS callers need
`await import("@infro.io/sdk")`.
