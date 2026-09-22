import assert from "node:assert/strict";

import { Infro } from "../dist/index.js";

let sentHeaders;
const sdk = new Infro({
  apiKey: "unit-test-key-not-a-secret",
  baseUrl: "https://api.test/v1",
  maxRetries: 0,
  fetch: async (_url, init) => {
    sentHeaders = init?.headers;
    return new Response(
      JSON.stringify({
        id: "completion",
        choices: [{ message: { content: "ok" } }],
        usage: { cost: 0 },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  },
});

await sdk.chat.completions.create({
  model: "test/model",
  messages: [{ role: "user", content: "Hello" }],
});

assert.equal(typeof sentHeaders?.["Idempotency-Key"], "string");
assert.ok(sentHeaders["Idempotency-Key"].length >= 32);
