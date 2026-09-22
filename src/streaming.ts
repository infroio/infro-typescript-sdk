/**
 * Reading a Server-Sent Events body as an async iterable.
 *
 * WHY THIS IS HAND-WRITTEN
 *
 * `EventSource` cannot send an `Authorization` header and cannot POST, which
 * rules it out for a chat completion. Every SSE library that can is a Node
 * library. What is actually needed is line framing over a byte stream and one
 * rule about `[DONE]`, which is this file.
 *
 * THE TWO THINGS THAT GO WRONG, AND ARE HANDLED HERE
 *
 * **A frame can be split across chunks.** `data: {"id":"chatc` arriving in one
 * read and `mpl-9f3a"…}` in the next is normal, not exceptional, and a parser
 * that assumes a chunk is a frame works in development and fails under real
 * network conditions. The buffer is carried across reads.
 *
 * **A stream can end without `[DONE]`.** The gateway documents exactly this:
 * when a request fails after the first byte, it emits an error frame and closes
 * *without* `[DONE]`, so a client that missed the frame still knows it was cut
 * short. So the absence of `[DONE]` is meaningful and must not be smoothed over
 * — an in-band error is raised as an error, and a truncated stream is reported
 * as truncated rather than as a normal ending.
 */

import { InfroError } from "./errors.js";

export interface SseOptions {
  /** Surfaced on an error frame, so the failure carries the request it belongs to. */
  requestId?: string | null;
}

/**
 * Yield each parsed `data:` payload until the stream ends.
 *
 * `[DONE]` ends it cleanly. An `{"error": …}` frame throws the documented
 * error. Anything else — including the connection simply stopping — throws,
 * because a chat completion that ends early has produced a partial answer and
 * silently returning it is how truncated text reaches a user as though it were
 * complete.
 */
export async function* streamSse<T>(
  response: Response,
  options: SseOptions = {},
): AsyncGenerator<T, void, unknown> {
  if (!response.body) {
    throw new InfroError({
      message: "The gateway returned a stream with no body.",
      status: response.status,
      requestId: options.requestId ?? null,
    });
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let sawDone = false;

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });

      // Frames are separated by a blank line. Split on the separator rather
      // than on newlines, so a multi-line `data:` frame stays one frame.
      let separator = buffer.indexOf("\n\n");
      while (separator !== -1) {
        const frame = buffer.slice(0, separator);
        buffer = buffer.slice(separator + 2);
        separator = buffer.indexOf("\n\n");

        const payload = dataOf(frame);
        if (payload === null) continue;

        if (payload === "[DONE]") {
          sawDone = true;
          return;
        }

        const parsed = JSON.parse(payload) as {
          error?: { message: string; type: string; code: string | null };
        };

        if (parsed.error) {
          // The documented mid-stream failure. Nothing can be re-routed past
          // the first byte, so this is the ending — raised rather than yielded,
          // because a caller iterating chunks would otherwise have to inspect
          // every one for a field that is almost never there.
          throw new InfroError({
            message: parsed.error.message,
            type: parsed.error.type,
            code: parsed.error.code,
            status: response.status,
            requestId: options.requestId ?? null,
          });
        }

        yield parsed as T;
      }
    }

    if (!sawDone) {
      throw new InfroError({
        message:
          "The stream ended before `[DONE]`. The response is incomplete — see " +
          "https://infro.io/docs/api/streaming.",
        type: "upstream_error",
        status: response.status,
        requestId: options.requestId ?? null,
      });
    }
  } finally {
    // Releasing the lock lets the caller `break` out of the loop without
    // leaking the connection, which is the normal way somebody stops reading a
    // stream early.
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

/**
 * The `data:` payload of one frame, or null for a frame carrying none.
 *
 * Comment lines (`:` keep-alives) and `event:`/`id:` lines are skipped rather
 * than treated as an error: a proxy is entitled to inject keep-alives, and a
 * parser that threw on one would fail only under a load balancer.
 */
function dataOf(frame: string): string | null {
  const parts: string[] = [];
  for (const line of frame.split("\n")) {
    if (line.startsWith(":")) continue;
    if (!line.startsWith("data:")) continue;
    parts.push(line.slice(5).trimStart());
  }
  return parts.length === 0 ? null : parts.join("\n");
}
