/**
 * Which credential belongs in which parameter.
 *
 * ``cosmo_…`` values are self-identifying, so an API key handed to ``token``
 * is a category error the constructor can name — and one worth naming: the
 * backend honors any ``cosmo_…`` bearer, so a key in that slot works, right
 * up until the app carrying it reaches someone else.
 */

import { CredentialsError } from './auth';

const SECRET_PREFIX = 'cosmo_';
const ACTS_AS_USER_PREFIX = 'cosmo_pat_';

const END_USER_CREDENTIALS_DOCS =
  'https://platform.askcosmo.ai/docs/production/end-user-credentials';

/** Refuse a workspace API key passed as ``token``. Acts-as-user tokens
 *  (``cosmo_pat_…``) are a real bearer credential and pass through. */
export function assertNotApiKeyInTokenSlot(token: string): void {
  if (!token.startsWith(SECRET_PREFIX) || token.startsWith(ACTS_AS_USER_PREFIX)) return;
  throw new CredentialsError({
    code: 'api_key_in_token_slot',
    message:
      'This is a workspace API key (cosmo_…), not a minted end-user token. ' +
      'Pass it as apiKey — or mint a token for this user with mintToken() ' +
      `on your server and pass that. See ${END_USER_CREDENTIALS_DOCS}`,
  });
}
