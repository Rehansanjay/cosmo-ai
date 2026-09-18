/**
 * Outbound-dial REST unit for the Cosmo Realtime SDK.
 *
 * Mirrors the Python SDK's ``session.dial()``: an authenticated POST to
 * ``…/external/realtime/session/{id}/dial`` that brings a phone callee into a
 * live session's LiveKit room as a SIP participant. Kept free of the
 * ``livekit-client`` dependency (like ``session_start_error.ts``) — dialing is
 * a plain REST call, not a transport / data-channel concern. The dial URL is
 * composed by ``composeDialUrl`` in ``external_session_url.ts``.
 */

import { ApiError } from '../core/errors';
import { log } from '../core/logger';
import { parseErrorDetail } from './error_detail';
import { describeFetchFailure } from './fetch_failure';

/** Outcome of a successful ``dial()`` (``POST …/session/{id}/dial``): the dial
 *  was queued. The call rings asynchronously — observe progress via session
 *  events, not this value. ``dialId`` correlates the call server-side. */
export type DialResult = {
  /** Handle for this dial, to correlate the call with server-side dial
   *  status. The call rings asynchronously — watch session events for
   *  progress rather than this return value. */
  dialId: string;
};

/** How far a dial got before it failed.
 *
 *  Closed: every one is thrown by this SDK, so it changes only when the SDK
 *  does. It says what happened to the attempt, never why the server refused —
 *  that is the server's own slug, an open set, on `ApiError.serverCode`
 *  (`phone_calls_disabled`, `minute_limit_exceeded`, `session_not_found`, …). */
export type DialErrorCode =
  /** The request did not produce a usable answer — a network failure or
   *  timeout. */
  | 'request_failed'
  /** The server refused. `serverCode` carries its own slug for why. */
  | 'request_rejected'
  /** The server answered, but not with a body this SDK could parse. */
  | 'invalid_response'
  /** The SDK refused to send the request — a malformed phone number, or a
   *  session that cannot be dialed. Nothing reached the server. */
  | 'invalid_request';

/** `dial()` failed. `code` names how far the attempt got; `serverCode` on the
 *  `ApiError` base carries the server's own slug when it sent one. */
export class DialError extends ApiError {
  /** Always ``'DialError'``. */
  readonly name = 'DialError';
  /** How far the attempt got. A closed set this SDK throws — switch on it. */
  readonly code: DialErrorCode;

  constructor(options: { code: DialErrorCode; message: string; serverCode?: string }) {
    super(options.message || options.code, { serverCode: options.serverCode });
    this.code = options.code;
  }
}

/** Local fast-fail mirror of the server's E.164 check so an obviously
 *  malformed number throws before any round-trip. ``+`` then 8–15 digits. */
export function validateE164(phoneNumber: string): string {
  const value = phoneNumber.trim();
  const digits = value.slice(1);
  if (!value.startsWith('+') || !/^\d+$/.test(digits) || digits.length < 8 || digits.length > 15) {
    throw new DialError({
      code: 'invalid_request',
      message: 'phone_number must be E.164, e.g. +14155550199',
    });
  }
  return value;
}

export type PostDialArgs = {
  dialUrl: string;
  phoneNumber: string;
  /** Optional E.164 caller-ID to present. Must be an ACTIVE number in the
   *  workspace pool (server rejects otherwise). Omit for the trunk default. */
  callerNumber?: string;
  getAuthHeaders?: () => Record<string, string> | Promise<Record<string, string>>;
};

/** Place the authenticated dial POST. Server rejections raise
 *  :class:`DialError` carrying the server slug on `serverCode`; a network failure
 *  raises ``request_failed`` and a malformed success raises
 *  ``invalid_response``. */
export async function postDial(args: PostDialArgs): Promise<DialResult> {
  const extraHeaders = args.getAuthHeaders ? await args.getAuthHeaders() : {};
  const headers: Record<string, string> = {
    ...extraHeaders,
    'Content-Type': 'application/json',
  };
  const requestBody: Record<string, string> = { phone_number: args.phoneNumber };
  if (args.callerNumber !== undefined) {
    requestBody.caller_number = args.callerNumber;
  }
  let response: Response;
  try {
    response = await fetch(args.dialUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify(requestBody),
    });
  } catch (err) {
    throw new DialError({
      code: 'request_failed',
      message: describeFetchFailure(args.dialUrl, err),
    });
  }
  if (!response.ok) {
    const { code, message } = await parseErrorDetail(response);
    log.warn('[realtime] dial rejected', { status: response.status, code });
    throw new DialError({ code: 'request_rejected', message, serverCode: code });
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch (err) {
    throw new DialError({
      code: 'invalid_response',
      message: err instanceof Error ? err.message : 'Dial response was not JSON.',
    });
  }
  const dialId = extractDialId(body);
  if (dialId === null) {
    throw new DialError({ code: 'invalid_response', message: 'Dial response missing dial_id.' });
  }
  return { dialId };
}

function extractDialId(body: unknown): string | null {
  if (typeof body !== 'object' || body === null) return null;
  const id = (body as Record<string, unknown>).dial_id;
  return typeof id === 'string' && id.length > 0 ? id : null;
}
