/**
 * Session usage-summary REST unit (``GET sessions/{id}/usage``).
 *
 * Mirror of the Python SDK's ``RealtimeSession.usage``: an authenticated
 * read of one session's usage summary — duration, talk time, and token
 * counts in provider-reported units. Kept free of the ``livekit-client``
 * dependency (like ``verify.ts`` and ``transport/dial.ts``).
 */

import { RealtimeError, ApiError } from './errors';
import { log } from './logger';
import { parseErrorDetail } from '../transport/error_detail';

/** Lifecycle state of a voice session. Open-ended — treat an unknown value
 *  defensively. */
export type SessionStatus = 'active' | 'completed' | 'error' | (string & {});

/** Whether a session's detailed usage summary is available.
 *
 *  ``pending`` while the session runs and for a short window after it ends,
 *  before the summary is written. ``recorded`` once it is there and the
 *  numbers are final. ``unavailable`` once that window has passed without
 *  one arriving: a session with no turn or speech activity records none,
 *  and neither does one torn down abnormally. Open-ended — treat an
 *  unknown value defensively. */
export type UsageStatus = 'pending' | 'recorded' | 'unavailable' | (string & {});

/** Token usage reported by the session's model provider, split by direction
 *  and modality. The live ``cosmo.usage`` event's counters plus the input
 *  and output totals, with the same cumulative semantics. */
export type SessionTokenUsage = {
  /** Every input token, across all modalities. */
  inputTokens: number;
  /** Every output token, across all modalities. */
  outputTokens: number;
  /** Input plus output, as the provider reports it. */
  totalTokens: number;
  /** Audio the model was given. */
  inputAudioTokens: number;
  /** Text the model was given. */
  inputTextTokens: number;
  /** Images the model was given. */
  inputImageTokens: number;
  /** Input served from the provider's cache. Already counted in
   *  ``inputTokens`` — a subset, not an addition. */
  inputCachedTokens: number;
  /** Audio the model produced. On a session running ``audio.output: false``
   *  this depends on the provider: one with a native text-only mode produces
   *  none, while one without keeps generating speech that is discarded, and
   *  those tokens still accrue. */
  outputAudioTokens: number;
  /** Text the model produced. */
  outputTextTokens: number;
};

/** Usage summary for one session, in provider-reported units.
 *
 *  ``durationSeconds`` is set once the session ends. The rest of the detail
 *  arrives with the summary, so it is present only while ``usageStatus`` is
 *  ``recorded``, at which point the numbers are final. ``tokens`` is null
 *  when the provider reports none. */
export type SessionUsage = {
  /** Where the session itself ended up. */
  status: SessionStatus;
  /** Whether the usage summary exists yet. Poll while this is ``pending``;
   *  stop on ``unavailable``. */
  usageStatus: UsageStatus;
  /** Wall-clock length of the session, set once it ends. */
  durationSeconds: number | null;
  /** How many turns the conversation took. */
  turnCount: number | null;
  /** How long the user was speaking. */
  userSpeakingSeconds: number | null;
  /** How long the agent was speaking. */
  agentSpeakingSeconds: number | null;
  /** Which model provider actually ran the session, after the server
   *  resolved ``model``. */
  provider: string | null;
  /** The concrete model id that ran, which a family alias resolves to. */
  model: string | null;
  /** The token breakdown. ``null`` when the provider reported none — that is
   *  absence of reporting, not zero usage. */
  tokens: SessionTokenUsage | null;
};

/** How far a usage read got before it failed.
 *
 *  Closed: every one is thrown by this SDK, so it changes only when the SDK
 *  does. It says what happened to the attempt, never why the server refused —
 *  that is the server's own slug, an open set, on `ApiError.serverCode`. */
export type UsageErrorCode =
  /** The request did not produce a usable answer — a network failure or
   *  timeout, or a redirect, which is refused rather than followed so a
   *  credential is never re-sent to another origin. */
  | 'request_failed'
  /** The server refused. `serverCode` carries its own slug for why. */
  | 'request_rejected'
  /** The server answered, but not with a body this SDK could parse. */
  | 'invalid_response'
  /** The SDK refused to make the call — this session carries no usage
   *  surface. Nothing reached the server. */
  | 'invalid_request';

/** ``usage()`` failed. */
export class UsageError extends ApiError {
  /** Always ``'UsageError'``. */
  readonly name = 'UsageError';
  /** How far the attempt got. A closed set this SDK throws — switch on it.
   *  The server's own rejection slug, an open set, is on `serverCode`. */
  readonly code: UsageErrorCode;

  constructor(options: { code: UsageErrorCode; message: string; serverCode?: string }) {
    super(options.message || options.code, { serverCode: options.serverCode });
    this.code = options.code;
  }
}

export type GetUsageArgs = {
  sessionId: string;
  usageUrl: string;
  getAuthHeaders: () => Record<string, string> | Promise<Record<string, string>>;
};

/** Place the authenticated usage GET. Server rejections raise
 *  :class:`UsageError` carrying the server slug on `serverCode`; a network failure raises
 *  ``request_failed`` and a malformed success raises
 *  ``invalid_response``. */
export async function getUsage(args: GetUsageArgs): Promise<SessionUsage> {
  let response: Response;
  try {
    response = await fetch(args.usageUrl, {
      method: 'GET',
      headers: await args.getAuthHeaders(),
    });
  } catch (err) {
    throw new UsageError({
      code: 'request_failed',
      message: err instanceof Error ? err.message : 'Usage request failed to send.',
    });
  }
  if (!response.ok) {
    const { code, message } = await parseErrorDetail(response);
    log.warn('[realtime] usage rejected', {
      sessionId: args.sessionId,
      status: response.status,
      code,
    });
    throw new UsageError({ code: 'request_rejected', message, serverCode: code });
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch (err) {
    throw new UsageError({
      code: 'invalid_response',
      message: err instanceof Error ? err.message : 'Usage response was not JSON.',
    });
  }
  const usage = extractSessionUsage(body);
  if (usage === null) {
    throw new UsageError({ code: 'invalid_response', message: 'Usage response had an unexpected shape.' });
  }
  return usage;
}

function optionalNumber(value: unknown): number | null | undefined {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'number') return undefined;
  return value;
}

function extractTokenUsage(value: unknown): SessionTokenUsage | null | undefined {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'object') return undefined;
  const raw = value as Record<string, unknown>;
  const fields = [
    'input_tokens',
    'output_tokens',
    'total_tokens',
    'input_audio_tokens',
    'input_text_tokens',
    'input_image_tokens',
    'input_cached_tokens',
    'output_audio_tokens',
    'output_text_tokens',
  ] as const;
  const parsed: Record<string, number> = {};
  for (const field of fields) {
    const v = raw[field];
    if (v === null || v === undefined) {
      parsed[field] = 0;
    } else if (typeof v === 'number') {
      parsed[field] = v;
    } else {
      return undefined;
    }
  }
  return {
    inputTokens: parsed.input_tokens,
    outputTokens: parsed.output_tokens,
    totalTokens: parsed.total_tokens,
    inputAudioTokens: parsed.input_audio_tokens,
    inputTextTokens: parsed.input_text_tokens,
    inputImageTokens: parsed.input_image_tokens,
    inputCachedTokens: parsed.input_cached_tokens,
    outputAudioTokens: parsed.output_audio_tokens,
    outputTextTokens: parsed.output_text_tokens,
  };
}

function extractSessionUsage(body: unknown): SessionUsage | null {
  if (typeof body !== 'object' || body === null) return null;
  const obj = body as Record<string, unknown>;
  if (typeof obj.status !== 'string') return null;
  if (typeof obj.usage_status !== 'string') return null;
  const durationSeconds = optionalNumber(obj.duration_seconds);
  const turnCount = optionalNumber(obj.turn_count);
  const userSpeakingSeconds = optionalNumber(obj.user_speaking_seconds);
  const agentSpeakingSeconds = optionalNumber(obj.agent_speaking_seconds);
  if (
    durationSeconds === undefined ||
    turnCount === undefined ||
    userSpeakingSeconds === undefined ||
    agentSpeakingSeconds === undefined
  ) {
    return null;
  }
  const provider = obj.provider;
  if (provider !== null && provider !== undefined && typeof provider !== 'string') return null;
  const model = obj.model;
  if (model !== null && model !== undefined && typeof model !== 'string') return null;
  const tokens = extractTokenUsage(obj.tokens);
  if (tokens === undefined) return null;
  return {
    status: obj.status,
    usageStatus: obj.usage_status,
    durationSeconds,
    turnCount,
    userSpeakingSeconds,
    agentSpeakingSeconds,
    provider: provider ?? null,
    model: model ?? null,
    tokens,
  };
}
