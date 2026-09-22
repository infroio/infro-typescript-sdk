/**
 * The documented error taxonomy, as types a caller can branch on.
 *
 * The gateway publishes a closed set of `error.type` values and an HTTP status
 * for each. An SDK that collapsed them into one `Error` would make the single
 * most common decision — "should I retry this?" — a string comparison against
 * a message, which is the thing that breaks when a message is reworded.
 *
 * So: one class, a `type` that is the published union, and a `retryable` flag
 * derived from the status rather than from the type. The status is what the
 * docs key retry guidance on, and it is what a proxy in front of INFRO would
 * preserve if it rewrote the body.
 */

/** Every `error.type` the gateway emits. Closed set — see `docs api/errors`. */
export type InfroErrorType =
  | "authentication_error"
  | "permission_denied"
  | "invalid_request_error"
  | "not_found_error"
  | "rate_limit_exceeded"
  | "budget_exceeded"
  | "upstream_error"
  | "no_available_provider"
  | "timeout_error"
  | "internal_error";

/**
 * The four statuses the docs name as retryable, and no others.
 *
 * Deliberately not `>= 500`: a `500 internal_error` is a defect in the
 * gateway's own code and retrying it fails identically, which turns one bug
 * into a retry storm. `502` and `503` are upstream conditions that a second
 * attempt genuinely re-rolls.
 */
const RETRYABLE_STATUSES = new Set([408, 429, 502, 503]);

/**
 * The one code that overrides its own status.
 *
 * `no_provider_connected` is a 503 saying the organization has no connected
 * provider able to serve the model. Unlike every other 503, a second attempt
 * cannot change that — it stays true until somebody connects a provider in the
 * console, which the message tells them to do. Retrying spends the whole
 * backoff to arrive at advice the first response already carried, and it is
 * the error a new organization is most likely to meet.
 */
const NEVER_RETRY_CODES = new Set(["no_provider_connected"]);

export class InfroError extends Error {
  readonly type: InfroErrorType | "unknown";
  /** An upstream-supplied sub-code, when there is one. Often null. */
  readonly code: string | null;
  readonly status: number;
  /** `req_…`, from the response header. The one thing support will ask for. */
  readonly requestId: string | null;
  /** Seconds the server asked us to wait, when it said. */
  readonly retryAfter: number | null;

  constructor(input: {
    message: string;
    type?: string;
    code?: string | null;
    status: number;
    requestId?: string | null;
    retryAfter?: number | null;
  }) {
    super(input.message);
    this.name = "InfroError";
    this.type = (input.type as InfroErrorType) ?? "unknown";
    this.code = input.code ?? null;
    this.status = input.status;
    this.requestId = input.requestId ?? null;
    this.retryAfter = input.retryAfter ?? null;
  }

  /**
   * Whether trying again could plausibly succeed. Keyed on status, not type —
   * except for the codes in `NEVER_RETRY_CODES`, which describe a condition
   * only the caller can clear.
   */
  get retryable(): boolean {
    if (this.code !== null && NEVER_RETRY_CODES.has(this.code)) return false;
    return RETRYABLE_STATUSES.has(this.status);
  }

  /**
   * A message worth putting in a log line.
   *
   * The request id is included because it is the first thing support asks for
   * and the last thing anybody thinks to record.
   */
  override toString(): string {
    const parts = [`${this.name}: ${this.message}`, `status=${this.status}`, `type=${this.type}`];
    if (this.code) parts.push(`code=${this.code}`);
    if (this.requestId) parts.push(`request_id=${this.requestId}`);
    return parts.join(" ");
  }
}

/**
 * A failure that never reached the gateway: DNS, TLS, a dropped socket, an
 * abort.
 *
 * Separate from `InfroError` because the remedies differ and so does the
 * blame — there is no request id, no type, and nothing INFRO can tell you
 * about it. Retryable, because a connection that failed to open may open.
 */
export class InfroConnectionError extends Error {
  readonly retryable = true;

  constructor(
    message: string,
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = "InfroConnectionError";
  }
}

/** Build an `InfroError` from a response the gateway actually produced. */
export function errorFromResponse(
  status: number,
  body: unknown,
  headers: { get(name: string): string | null },
): InfroError {
  const envelope = (body as { error?: { message?: string; type?: string; code?: string | null } })
    ?.error;

  const retryAfterHeader = headers.get("retry-after");
  const retryAfter = retryAfterHeader === null ? null : Number.parseInt(retryAfterHeader, 10);

  return new InfroError({
    // A body that is not the documented envelope still has to produce a usable
    // message — a proxy or a load balancer in front of INFRO can return HTML.
    message: envelope?.message ?? `INFRO request failed with status ${status}`,
    ...(envelope?.type === undefined ? {} : { type: envelope.type }),
    code: envelope?.code ?? null,
    status,
    requestId: headers.get("x-infro-request-id"),
    retryAfter: Number.isFinite(retryAfter) ? retryAfter : null,
  });
}
