// @vitest-environment jsdom
/**
 * In a browser-shaped runtime (a ``window`` exists) the resolution chain
 * must fail with ``no_credential`` without touching Node builtins — a
 * browser has no environment or credentials file to resolve from, so a
 * zero-argument client there is unrecoverable and bundlers never execute
 * the ``node:fs`` import.
 */

import { describe, expect, it } from 'vitest';

import { CredentialsError } from '../auth';
import { resolveCredentialFromRuntime } from '../credentials_file';

describe('browser guard', () => {
  it('throws no_credential where a window exists, even with env present', async () => {
    process.env.COSMO_API_KEY = 'cosmo_env_key';
    let thrown: unknown;
    try {
      await resolveCredentialFromRuntime();
    } catch (err) {
      thrown = err;
    } finally {
      delete process.env.COSMO_API_KEY;
    }
    expect(thrown).toBeInstanceOf(CredentialsError);
    expect((thrown as CredentialsError).code).toBe('no_credential');
    for (const remedy of ['token', 'getAuthHeaders']) {
      expect((thrown as CredentialsError).message).toContain(remedy);
    }
  });
});
