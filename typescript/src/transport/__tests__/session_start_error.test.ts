/**
 * The session/start endpoint fails closed with a structured ``detail``
 * (``minute_limit_exceeded``, ``workflow_not_ready``, …). The transport
 * must surface that detail on the thrown error so callers can show the
 * real reason instead of a generic "Failed to start the session" toast.
 */
import { describe, expect, it } from 'vitest';

import {
  SessionStartError,
  parseRetryAfter,
  parseSessionStartErrorDetail,
  sessionStartErrorFrom,
  sessionStartRejectionFrom,
} from '../session_start_error';

function jsonResponse(body: unknown): Response {
  return { json: async () => body } as unknown as Response;
}

function nonJsonResponse(): Response {
  return {
    json: async () => {
      throw new SyntaxError('Unexpected token < in JSON');
    },
  } as unknown as Response;
}

describe('parseSessionStartErrorDetail', () => {
  // The external endpoint's real envelopes: a typed HTTPException lifts
  // {code, message} onto ``error``; an AppException spreads its structured
  // details there; validation and auth rejections carry only type + message.
  it('reads a typed rejection off the external envelope (422 invalid_tool_config)', async () => {
    const res = jsonResponse({
      error: {
        type: 'api_error',
        code: 'invalid_tool_config',
        message:
          "Invalid tool configuration: 'lookup order': tool name must be snake_case",
      },
    });
    expect(await parseSessionStartErrorDetail(res)).toEqual(sessionStartRejectionFrom({
      code: 'invalid_tool_config',
      message:
        "Invalid tool configuration: 'lookup order': tool name must be snake_case",
    }));
  });

  it('carries the structured extras of an envelope rejection (402 free_minutes_exhausted)', async () => {
    const res = jsonResponse({
      error: {
        type: 'api_error',
        message: 'Free voice minutes are exhausted for this organization.',
        code: 'free_minutes_exhausted',
        granted_minutes: 40,
        used_minutes: 40,
      },
    });
    expect(await parseSessionStartErrorDetail(res)).toEqual(sessionStartRejectionFrom({
      code: 'free_minutes_exhausted',
      message: 'Free voice minutes are exhausted for this organization.',
      granted_minutes: 40,
      used_minutes: 40,
    }));
  });

  it('reads version_mismatch off the external envelope (400)', async () => {
    const res = jsonResponse({
      error: {
        type: 'api_error',
        code: 'version_mismatch',
        message:
          "Realtime wire protocol version mismatch: client speaks '2.0', server speaks '1.0'. Upgrade the Cosmo realtime SDK.",
      },
    });
    const detail = await parseSessionStartErrorDetail(res);
    expect(detail?.code).toBe('version_mismatch');
    expect(detail?.message).toContain('protocol version mismatch');
  });

  it('falls back to the envelope type when the rejection carries no code', async () => {
    const res = jsonResponse({
      error: {
        type: 'validation_error',
        message:
          'Invalid request parameters — agent.inline.audio: Extra inputs are not permitted',
        errors: [
          {
            loc: ['body', 'agent', 'inline', 'audio'],
            type: 'extra_forbidden',
            msg: 'Extra inputs are not permitted',
          },
        ],
      },
    });
    expect(await parseSessionStartErrorDetail(res)).toEqual(sessionStartRejectionFrom({
      code: 'validation_error',
      message:
        'Invalid request parameters — agent.inline.audio: Extra inputs are not permitted',
    }));
  });

  it('reads the legacy envelope that nests {code, message} inside message', async () => {
    const res = jsonResponse({
      error: {
        type: 'api_error',
        message: { code: 'model_unavailable', message: 'Unknown model id.' },
      },
    });
    expect(await parseSessionStartErrorDetail(res)).toEqual(sessionStartRejectionFrom({
      code: 'model_unavailable',
      message: 'Unknown model id.',
    }));
  });

  it('returns the structured detail object', async () => {
    const res = jsonResponse({
      detail: { code: 'workflow_not_ready', message: 'workflow is not ready to run (status: generating).' },
    });
    expect(await parseSessionStartErrorDetail(res)).toEqual(sessionStartRejectionFrom({
      code: 'workflow_not_ready',
      message: 'workflow is not ready to run (status: generating).',
    }));
  });

  it('normalizes a bare string detail to a message', async () => {
    const res = jsonResponse({ detail: 'playground_agent_id is not accessible from this workspace.' });
    expect(await parseSessionStartErrorDetail(res)).toEqual(sessionStartRejectionFrom({
      message: 'playground_agent_id is not accessible from this workspace.',
    }));
  });

  it('names the offending fields from a request-validation array', async () => {
    // The shape a client newer than its backend gets: pydantic's
    // ``extra="forbid"`` on a field that backend has no model for. An array
    // is also an object, so reading it as a structured detail yields no
    // ``message`` and the error degrades to a bare status code.
    const res = jsonResponse({
      detail: [
        {
          type: 'extra_forbidden',
          loc: ['body', 'agent', 'inline', 'audio'],
          msg: 'Extra inputs are not permitted',
        },
      ],
    });
    expect(await parseSessionStartErrorDetail(res)).toEqual(sessionStartRejectionFrom({
      code: 'invalid_session_config',
      message:
        'Realtime session/start rejected the session config — ' +
        'agent.inline.audio: Extra inputs are not permitted',
    }));
  });

  it('caps the rendered entries and counts the rest', async () => {
    const res = jsonResponse({
      detail: Array.from({ length: 7 }, (_, i) => ({
        loc: ['body', 'agent', `f${i}`],
        msg: 'nope',
      })),
    });
    const detail = await parseSessionStartErrorDetail(res);
    expect(detail?.message).toContain('agent.f4: nope');
    expect(detail?.message).not.toContain('agent.f5');
    expect(detail?.message).toContain('(+2 more)');
  });

  it('returns null for an empty validation array', async () => {
    expect(await parseSessionStartErrorDetail(jsonResponse({ detail: [] }))).toBeNull();
  });

  it('returns null when the body is not JSON', async () => {
    expect(await parseSessionStartErrorDetail(nonJsonResponse())).toBeNull();
  });
});

describe('SessionStartError', () => {
  it("uses the backend detail message as the error message and carries detail", () => {
    const err = sessionStartErrorFrom(400, 'Bad Request', sessionStartRejectionFrom({
      code: 'workflow_not_ready',
      message: 'workflow is not ready to run (status: generating).',
    }));
    expect(err.message).toBe('workflow is not ready to run (status: generating).');
    expect(err.detail?.code).toBe('workflow_not_ready');
    expect(err.status).toBe(400);
  });

  it('falls back to the status line when there is no detail', () => {
    const err = sessionStartErrorFrom(502, 'Bad Gateway', null);
    expect(err.message).toBe('Realtime session/start rejected: 502 Bad Gateway');
    expect(err.detail).toBeNull();
  });
});

describe('sessionStartErrorFrom', () => {
  // The classifier is code-first: a subclass claims a specific cause, and
  // only the server's stable code proves it. A 429 or 402 whose code the
  // SDK doesn't know classifies as 'rejected'; 400/422 fall back to 'config',
  // which claims only what the status already means.
  it("classifies concurrent_session_limit as 'busy', carrying the limit extras", () => {
    const err = sessionStartErrorFrom(429, 'Too Many Requests', sessionStartRejectionFrom({
      code: 'concurrent_session_limit',
      message: 'This workspace already has 2 active sessions (limit 2).',
      limit: 2,
      active: 2,
    }));
    expect(err.code).toBe('busy');
    expect(err.serverCode).toBe('concurrent_session_limit');
    expect(err.retryAfterSeconds).toBeUndefined();
    expect(err.detail?.limit).toBe(2);
    expect(err.detail?.active).toBe(2);
  });

  it('carries retryAfterSeconds when the server sent one', () => {
    const err = sessionStartErrorFrom(429, 'Too Many Requests', sessionStartRejectionFrom({ code: 'concurrent_session_limit', message: 'busy' }), 30);
    expect(err.retryAfterSeconds).toBe(30);
  });

  it.each([
    ['free_minutes_exhausted', 'Free voice minutes are exhausted.'],
    ['provider_not_entitled', 'This plan does not include the model.'],
  ])("classifies a 402 %s as 'entitlement'", (code, message) => {
    const err = sessionStartErrorFrom(402, 'Payment Required', sessionStartRejectionFrom({ code, message }));
    expect(err.code).toBe('entitlement');
    expect(err.serverCode).toBe(code);
    expect(err.message).toBe(message);
  });

  it.each<[number, string | undefined]>([
    [422, 'invalid_tool_config'],
    [422, 'model_unavailable'],
    [422, 'instructions_too_long'],
    [400, undefined], // audio.output=false on a speech-to-speech-only model
  ])("classifies a %s %s rejection as 'config'", (status, code) => {
    const err = sessionStartErrorFrom(status, 'Rejected', sessionStartRejectionFrom({
      code,
      message: 'rejected',
    }));
    expect(err.code).toBe('config');
  });

  it("classifies version_mismatch as 'version_mismatch', not 'config'", () => {
    const err = sessionStartErrorFrom(400, 'Bad Request', sessionStartRejectionFrom({
      code: 'version_mismatch',
      message: "client speaks '2.0', server speaks '1.0'",
    }));
    expect(err.code).toBe('version_mismatch');
  });

  it.each([
    [401, 'Unauthorized'],
    [403, 'Forbidden'],
    [503, 'Service Unavailable'],
  ])('classifies a bare %s by status alone', (status, statusText) => {
    const err = sessionStartErrorFrom(status, statusText, null);
    expect(err.code).toBe(status === 503 ? 'voice_disabled' : 'rejected');
    expect(err.serverCode).toBeUndefined();
    expect(err.status).toBe(status);
  });

  it("leaves a 429 with an unrecognized code on 'rejected'", () => {
    // A gateway rate limit is not "another session holds the slot" —
    // without the concurrent_session_limit code, 'busy' is unproven.
    const err = sessionStartErrorFrom(429, 'Too Many Requests', sessionStartRejectionFrom({
      code: 'global_rate_limited',
      message: 'Too many requests.',
    }));
    expect(err.code).toBe('rejected');
    expect(err.serverCode).toBe('global_rate_limited');
  });

  it("leaves a 402 with an unrecognized code on 'rejected'", () => {
    const err = sessionStartErrorFrom(402, 'Payment Required', sessionStartRejectionFrom({
      code: 'account_frozen',
      message: 'Account frozen.',
    }));
    expect(err.code).toBe('rejected');
    expect(err.serverCode).toBe('account_frozen');
  });

  it('classifies a known config code regardless of status', () => {
    // A backend that moves invalid_tool_config to a different 4xx keeps
    // classifying — the code, not the status, carries the meaning.
    const err = sessionStartErrorFrom(400, 'Bad Request', sessionStartRejectionFrom({
      code: 'invalid_tool_config',
      message: "Invalid tool configuration: 'lookup order'",
    }));
    expect(err.code).toBe('config');
  });
});

describe('parseRetryAfter', () => {
  it('parses delta-seconds', () => {
    expect(parseRetryAfter('30')).toBe(30);
  });

  it('clamps a negative delta to zero', () => {
    expect(parseRetryAfter('-5')).toBe(0);
  });

  it('ignores an HTTP-date rather than deriving seconds from it', () => {
    // Converting one means trusting a clock the SDK does not share. Python and
    // Swift ignore it too, so the same header reads the same in all three.
    expect(parseRetryAfter(new Date(Date.now() + 60_000).toUTCString())).toBeUndefined();
  });

  it('never reports a negative delay', () => {
    expect(parseRetryAfter('-5')).toBe(0);
  });

  it('returns undefined for an absent or unparseable value', () => {
    expect(parseRetryAfter(null)).toBeUndefined();
    expect(parseRetryAfter('')).toBeUndefined();
    expect(parseRetryAfter('soon')).toBeUndefined();
  });
});
