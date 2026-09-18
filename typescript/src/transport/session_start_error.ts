import { RealtimeError } from '../core/errors';
import { log } from '../core/logger';
/**
 * Error model for a rejected ``/realtime/session/start``.
 *
 * Kept free of the ``livekit-client`` dependency that ``livekit_transport``
 * pulls in so the backend's structured ``detail`` (``concurrent_session_limit``,
 * ``model_unavailable``, …) can be parsed and asserted in isolation.
 */

/** The server's structured reason for refusing a session start.
 *
 *  Every field beyond `code` and `message` belongs to one rejection, and the
 *  `code` says which — read the group that matches and ignore the rest. The
 *  server may add fields, so treat it as open: an unrecognized one is carried
 *  through rather than dropped. */
export type SessionStartRejection = {
  /** The server's stable rejection slug — the same value as
   *  `SessionStartError.serverCode`. Match on this to know which group of
   *  fields below is populated. */
  code?: string;
  /** Human-readable reason, written for a person to read. */
  message?: string;

  /** `concurrent_session_limit`: the workspace's cap on live sessions. */
  limit?: number;
  /** `concurrent_session_limit`: sessions already running against that cap. */
  active?: number;

  /** `free_minutes_exhausted`: minutes the free grant allowed in total. */
  granted_minutes?: number;
  /** `free_minutes_exhausted`: minutes already spent against that grant. */
  used_minutes?: number;

  /** `insufficient_credits`: prepaid balance remaining, in cents. */
  balance_cents?: number;
  /** `insufficient_credits`: where to add credit. */
  top_up_path?: string;

  /** `quota_exceeded`: which allowance was exceeded. */
  meter?: string;
  /** `quota_exceeded`: how much the plan includes. */
  included?: number;
  /** `quota_exceeded`: how much has been used. */
  used?: number;
  /** `quota_exceeded`: when the allowance renews, or `null` when it will not —
   *  a fixed term has ended and the way back is a plan change. */
  reset_at?: string | null;

  /** `provider_not_entitled`: the model provider the plan excludes. */
  provider?: string;
  /** `provider_not_entitled`: the providers it does include. */
  allowed_providers?: string[];
  /** `provider_not_entitled` / `workspace_limit_reached`: the plan in force. */
  plan?: string;
  /** `provider_not_entitled` / `workspace_limit_reached`: where to upgrade. */
  upgrade_path?: string;

  /** Fields the server sent that this SDK does not name. */
  extra: Record<string, unknown>;
};

/** Every field this SDK names on a rejection. The rest go to `extra`. */
const REJECTION_FIELDS = new Set([
  'code', 'message', 'limit', 'active', 'granted_minutes', 'used_minutes',
  'balance_cents', 'top_up_path', 'meter', 'included', 'used', 'reset_at',
  'provider', 'allowed_providers', 'plan', 'upgrade_path',
]);

/** Build a rejection from a body, keeping unnamed fields on `extra` — the
 *  server may add one at any deploy. Mirrors Python's and Swift's parse, so
 *  all three expose the same fields from the same body. */
export function sessionStartRejectionFrom(
  body: Record<string, unknown>,
): SessionStartRejection {
  const named: Record<string, unknown> = {};
  const extra: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(body)) {
    (REJECTION_FIELDS.has(key) ? named : extra)[key] = value;
  }
  return { ...named, extra } as SessionStartRejection;
}

/** Why ``start`` did not produce a live session.
 *
 *  Closed: every one is thrown by this SDK, so it changes only when the SDK
 *  does. It says what happened to the attempt, never the server's own slug for
 *  why it refused — that is an open set, on `serverCode`. */
export type SessionStartErrorCode =
  /** The request never reached the server, so nothing happened server-side
   *  and retrying is safe. */
  | 'transport'
  /** The server answered, but not with a body this SDK could parse. The
   *  session may already exist, so this is not safe to retry blindly. */
  | 'invalid_response'
  /** The transport could not join the room. The server accepted the session,
   *  so this carries no verdict from it — the join itself failed. */
  | 'join_failed'
  /** The server refused the session configuration — an unavailable model, a
   *  tool config it cannot accept, instructions past its limit. */
  | 'config'
  /** The workspace is at its concurrent-session limit. Usually an abandoned
   *  session still holding a slot; retrying shortly after succeeds, and
   *  `retryAfterSeconds` carries the server's `Retry-After` when it sent one. */
  | 'busy'
  /** The plan refused the session: the free voice grant is spent, or the
   *  model's provider is not included. Not retryable. */
  | 'entitlement'
  /** This SDK is older than the server's supported floor. Upgrade the
   *  package. */
  | 'version_mismatch'
  /** Realtime voice is not configured for this deployment or workspace. */
  | 'voice_disabled'
  /** The server refused for a reason with no more specific code.
   *  `serverCode` carries its own slug. */
  | 'rejected'
  /** The transport joined but the room closed before `ready` — a failed boot.
   *  The session is torn down before `start()` rejects. */
  | 'handshake_failed'
  /** The transport joined but the server's ready handshake never arrived
   *  within the wait budget. */
  | 'ready_timeout';

/** ``start()`` did not produce a live session.
 *
 *  Covers the whole start sequence, which is more than one request: the
 *  session-start call, the transport join, and the server's ready handshake.
 *  `code` names how far it got — switch on it rather than reading HTTP
 *  statuses.
 *
 *  `serverCode` is the server's own rejection slug when it sent one, an open
 *  set. `status` is the HTTP status of a server rejection, `null` when the
 *  request never reached the server. `retryAfterSeconds` is set only for
 *  `'busy'`, and only when the server sent a `Retry-After`. */
export class SessionStartError extends RealtimeError {
  /** Always ``'SessionStartError'``. */
  readonly name = 'SessionStartError';
  /** How far the attempt got. A closed set this SDK throws — switch on it. */
  readonly code: SessionStartErrorCode;
  /** HTTP status of a server rejection, `null` when no server answered. */
  readonly status: number | null;
  /** The server's own rejection slug when it sent one. An open set: log it,
   *  do not switch on it. */
  readonly serverCode?: string;
  /** The server's structured reason, or `null` when it sent none. */
  readonly detail: SessionStartRejection | null;
  /** The server's `Retry-After` in seconds, for `'busy'`. */
  readonly retryAfterSeconds?: number;

  constructor(options: {
    code: SessionStartErrorCode;
    message: string;
    status?: number | null;
    serverCode?: string;
    detail?: SessionStartRejection | null;
    retryAfterSeconds?: number;
    /** The underlying failure, for a `'transport'` error the fetch raised. */
    cause?: unknown;
  }) {
    super(options.message || options.code, { cause: options.cause });
    this.code = options.code;
    this.status = options.status ?? null;
    this.serverCode = options.serverCode;
    this.detail = options.detail ?? null;
    this.retryAfterSeconds = options.retryAfterSeconds;
  }
}

const ENTITLEMENT_CODES = new Set(['free_minutes_exhausted', 'provider_not_entitled']);

const CONFIG_CODES = new Set([
  'model_unavailable',
  'invalid_tool_config',
  'instructions_too_long',
  'turn_detection_knob_mismatch',
  'unknown_agent',
  'agent_config_unavailable',
  'greeting_too_long',
  'invalid_session_config',
  'validation_error',
]);

/** A capability the chosen transport does not offer, reported in the shape of
 *  a config rejection so a caller branches on it the same way. */
export function unsupportedTransportCapability(
  code: string,
  message: string,
): SessionStartError {
  return new SessionStartError({
    code: 'config',
    message,
    status: 0,
    serverCode: code,
    detail: sessionStartRejectionFrom({ code, message }),
  });
}

/** Build the :class:`SessionStartError` for a server rejection. */
export function sessionStartErrorFrom(
  status: number,
  statusText: string,
  detail: SessionStartRejection | null,
  retryAfterSeconds?: number,
): SessionStartError {
  const serverCode = detail?.code;
  return new SessionStartError({
    code: classifyStartRejection(serverCode, status),
    message:
      detail?.message ?? `Realtime session/start rejected: ${status} ${statusText}`,
    status,
    serverCode,
    detail,
    retryAfterSeconds,
  });
}

/** Map one session-start rejection onto its closed code.
 *
 *  The slug decides when the meaning cannot be read off the status —
 *  `contract/session-start-error-vectors.json` pins those pairs and every SDK
 *  classifies them the same way. Everything else is read from the status. */
export function classifyStartRejection(
  serverCode: string | undefined,
  status: number | null,
): SessionStartErrorCode {
  if (serverCode === 'concurrent_session_limit') return 'busy';
  if (serverCode !== undefined && ENTITLEMENT_CODES.has(serverCode)) return 'entitlement';
  if (serverCode === 'version_mismatch') return 'version_mismatch';
  if (serverCode !== undefined && CONFIG_CODES.has(serverCode)) return 'config';
  if (status === 503) return 'voice_disabled';
  if (status === 400 || status === 422) return 'config';
  return 'rejected';
}

/** Parse a ``Retry-After`` value — delta-seconds or an HTTP-date — into
 *  seconds from now. Undefined when the header is absent or unparseable. */
export function parseRetryAfter(value: string | null): number | undefined {
  if (value === null || value.trim() === '') return undefined;
  const seconds = Number(value.trim());
  // Integer seconds only. The HTTP-date form is ignored rather than converted:
  // deriving a delay from it means trusting a clock the SDK does not share, and
  // reporting nothing is honester than reporting a number that may be wrong.
  if (!Number.isInteger(seconds)) return undefined;
  return Math.max(0, seconds);
}

/** One entry of FastAPI's request-validation ``detail`` array. */
type ValidationErrorEntry = { loc?: unknown[]; msg?: string };

/** Cap on rendered validation entries — a rejected config can produce one per
 *  field, and the message is for a human reading a console. */
const MAX_RENDERED_VALIDATION_ERRORS = 5;

/** Render FastAPI's validation-error array as one line naming the fields that
 *  failed. Without this a schema rejection reaches the caller as a bare status
 *  code, which is indistinguishable from any other 422 — the field path is the
 *  whole diagnosis, most often a client newer than the backend it is talking
 *  to sending a field that backend has no model for. */
function formatValidationErrors(
  entries: ValidationErrorEntry[],
): SessionStartRejection {
  const rendered = entries
    .slice(0, MAX_RENDERED_VALIDATION_ERRORS)
    .map((entry) => {
      // ``loc`` is prefixed with the source of the value ("body"), which says
      // nothing here — every session-config rejection is about the body.
      const loc = (entry.loc ?? []).filter(
        (part, index) => !(index === 0 && part === 'body'),
      );
      const path = loc.join('.');
      const msg = entry.msg ?? 'is invalid';
      return path ? `${path}: ${msg}` : msg;
    });
  const omitted = entries.length - rendered.length;
  if (omitted > 0) rendered.push(`(+${omitted} more)`);
  return sessionStartRejectionFrom({
    code: 'invalid_session_config',
    message: `Realtime session/start rejected the session config — ${rendered.join('; ')}`,
  });
}

/** Detail carried in the external ``{ error: {...} }`` envelope the
 *  session-start endpoint returns. A typed rejection has its ``code`` lifted
 *  onto the envelope alongside ``message`` (plus structured extras such as
 *  ``limit`` / ``active``); an untyped one carries only ``type`` + ``message``, so
 *  ``type`` (``api_error`` / ``validation_error``) is the closest thing to a
 *  code. Mirrors ``parseErrorDetail``'s precedence, including the legacy
 *  shape that nested ``{code, message}`` inside ``message``. */
function envelopeDetail(error: unknown): SessionStartRejection | null {
  if (typeof error !== 'object' || error === null || Array.isArray(error)) {
    return null;
  }
  const { type, ...detail } = error as { type?: unknown } & Record<
    string,
    unknown
  >;
  if (
    typeof detail.code === 'string' &&
    detail.code &&
    typeof detail.message === 'string'
  ) {
    return sessionStartRejectionFrom(detail as Record<string, unknown>);
  }
  const message = detail.message;
  if (typeof message === 'object' && message !== null && 'code' in message) {
    return sessionStartRejectionFrom(message as Record<string, unknown>);
  }
  if (typeof message === 'string') {
    return sessionStartRejectionFrom(
      typeof type === 'string' && type ? { code: type, message } : { message },
    );
  }
  return null;
}

/** Pull the backend's error body off a non-OK session/start response.
 *  The external endpoint wraps every error as ``{ error: {...} }`` (see
 *  ``envelopeDetail``). The internal ``{ detail }`` shape is still read for
 *  skew against older backends: an object detail for structured errors, an
 *  array of ``{loc, msg}`` entries for request-validation failures, and a
 *  bare string for plain ones. All are normalized to
 *  ``SessionStartRejection``. Returns null when the body isn't JSON
 *  (network error, proxy 5xx). */
export async function parseSessionStartErrorDetail(
  response: Response,
): Promise<SessionStartRejection | null> {
  try {
    const data = (await response.json()) as {
      error?: unknown;
      detail?: unknown;
    };
    const envelope = envelopeDetail(data?.error);
    if (envelope) return envelope;
    const detail = data?.detail;
    // Ordered before the object branch: an array is also an object, and
    // reading one as a structured detail yields no ``message`` at all.
    if (Array.isArray(detail)) {
      return detail.length > 0
        ? formatValidationErrors(detail as ValidationErrorEntry[])
        : null;
    }
    if (detail && typeof detail === 'object') {
      return sessionStartRejectionFrom(detail as Record<string, unknown>);
    }
    if (typeof detail === 'string') return sessionStartRejectionFrom({ message: detail });
    return null;
  } catch (err) {
    log.warn('[realtime] session/start error body was not JSON', err);
    return null;
  }
}
