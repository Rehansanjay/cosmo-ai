import { describe, expect, it } from 'vitest';

import { ApiError, RealtimeError } from '../errors';
import { MintTokenError } from '../auth';
import { TokenSourceError } from '../token_source';
import { UsageError } from '../usage';
import { VerifyError } from '../verify';
import { DialError } from '../../transport/dial';

/** The headline of the `ApiError` base: one catch covers any backend call,
 *  while catching a specific one still says which call it was. */
describe('ApiError', () => {
  const calls = [
    new MintTokenError({ code: 'missing_api_key', message: 'no key' }),
    new TokenSourceError({ code: 'fetcher_failed', message: 'callable threw' }),
    new VerifyError({ code: 'request_failed', message: 'socket closed' }),
    new UsageError({ code: 'invalid_request', message: 'no usage surface' }),
    new DialError({ code: 'invalid_request', message: 'bad number' }),
  ];

  it('catches every backend-call error as one family', () => {
    for (const err of calls) {
      expect(err).toBeInstanceOf(ApiError);
      expect(err).toBeInstanceOf(RealtimeError);
    }
  });

  it('keeps the specific type catchable', () => {
    expect(calls[0]).toBeInstanceOf(MintTokenError);
    expect(calls[4]).toBeInstanceOf(DialError);
    expect(calls[4]).not.toBeInstanceOf(MintTokenError);
  });

  it('leaves serverCode absent when no server verdict was parsed', () => {
    for (const err of calls) expect(err.serverCode).toBeUndefined();
  });
});
