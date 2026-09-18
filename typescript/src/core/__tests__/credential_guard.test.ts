/**
 * A workspace API key in the ``token`` slot is refused at construction. The
 * backend honors any ``cosmo_…`` bearer, so without this the mistake works —
 * which is how a key reaches an app's users.
 */

import { describe, expect, it } from 'vitest';

import { assertNotApiKeyInTokenSlot } from '../credential_guard';
import { RealtimeClient } from '../realtime_client';

const KEY = `cosmo_${'a'.repeat(64)}`;
const PAT = `cosmo_pat_${'b'.repeat(32)}`;
const JWT = 'eyJhbGciOiJIUzI1NiJ9.payload.sig';

describe('the token slot', () => {
  it('refuses an API key, naming the parameter that takes one', () => {
    expect(() => assertNotApiKeyInTokenSlot(KEY)).toThrowError(/apiKey|mintToken/);
  });

  it('lets minted JWTs and acts-as-user tokens through', () => {
    expect(() => assertNotApiKeyInTokenSlot(JWT)).not.toThrow();
    expect(() => assertNotApiKeyInTokenSlot(PAT)).not.toThrow();
  });

  it('refuses at construction, before any network path', () => {
    expect(() => new RealtimeClient({ token: KEY })).toThrowError(/apiKey/);
  });

  it('leaves the apiKey parameter alone — a key there is correct anywhere', () => {
    expect(() => new RealtimeClient({ apiKey: KEY })).not.toThrow();
  });
});
