/**
 * ``TokenSource`` — the credential shape for distributed apps.
 *
 * A shipped app must not hold an API key, and a static minted JWT expires
 * after 24 hours. A ``TokenSource`` closes the gap: it knows how to fetch a
 * fresh ``MintedToken`` from the developer's own backend, caches it in
 * memory, and re-fetches when the cached token nears expiry — so
 * ``new RealtimeClient({ token: TokenSource.endpoint(...) })`` stays valid
 * for the life of the process with no refresh code in the app.
 */

import { RealtimeError, ApiError } from './errors';
import { CredentialsError } from './auth';
import { parseRfc3339, type MintedToken } from './auth';
import { log } from './logger';
import { parseErrorDetail } from '../transport/error_detail';
import { describeFetchFailure } from '../transport/fetch_failure';

/** Why a `TokenSource` could not produce a token.
 *
 *  Closed: every one is raised by this SDK. The token endpoint's own
 *  rejection slug is open and rides on `serverCode`. */
export type TokenSourceErrorCode =
  | 'request_failed'
  | 'request_rejected'
  | 'invalid_response'
  | 'fetcher_failed';

/** A `TokenSource` could not produce a token.
 *
 *  Raised while the SDK obtains a credential for itself, which happens
 *  beneath every authenticated call — verify, mintToken, session start, dial
 *  and usage reads all resolve the source first, and it re-resolves on expiry
 *  and after a 401. So this surfaces from whichever call needed a token, not
 *  from one operation.
 *
 *  `code` names what this SDK saw; `serverCode` carries the token endpoint's
 *  own slug when `code` is `request_rejected`. */
export class TokenSourceError extends ApiError {
  /** Always ``'TokenSourceError'``. */
  readonly name = 'TokenSourceError';
  /** How far the fetch got. A closed set this SDK raises — switch on it. */
  readonly code: TokenSourceErrorCode;
  /** The token endpoint's own rejection slug when it sent one. An open set:
   *  log it, do not switch on it. */
  readonly serverCode?: string;

  constructor(options: {
    code: TokenSourceErrorCode;
    message: string;
    serverCode?: string;
  }) {
    super(options.message);
    this.code = options.code;
    this.serverCode = options.serverCode;
  }
}


/** Re-fetch this long before ``expiresAt`` so an in-flight session start
 *  never races the expiry boundary. Matches the cross-SDK contract
 *  (``token-source-vectors.json``). */
const REFRESH_SKEW_MS = 60_000;

/** Options for ``TokenSource.endpoint(url, options)``. */
export type TokenSourceEndpointOptions = {
  /** Headers attached to every token request — the app's own auth (its
   *  session cookie rides automatically only same-origin; a bearer or
   *  custom header goes here). Static, or a (possibly async) callback
   *  resolved per fetch. */
  headers?:
    | Record<string, string>
    | (() => Record<string, string> | Promise<Record<string, string>>);
};

/** A credential that fetches — and keeps fresh — a minted end-user token.
 *
 *  Pass one as ``token`` in ``RealtimeClientOptions``. The client asks the
 *  source for a JWT whenever a request needs auth; the source reuses its
 *  cached token while comfortably within its lifetime and re-fetches
 *  otherwise. A session-start rejected with HTTP 401 drops the cache, so
 *  the next start fetches fresh.
 *
 *  Two constructors:
 *
 *  - ``TokenSource.endpoint(url)`` — POST a token endpoint that returns
 *    ``{ jwt, expires_at }`` (the shape ``mintToken`` responses already
 *    have; any backend that forwards ``POST auth/token`` qualifies).
 *  - ``TokenSource.custom(fn)`` — any async function resolving with a
 *    ``MintedToken`` — full control over transport and auth.
 */
export class TokenSource {
  readonly #fetchToken: () => Promise<MintedToken>;
  #cached: MintedToken | null = null;
  #inflight: Promise<MintedToken> | null = null;

  private constructor(fetchToken: () => Promise<MintedToken>) {
    this.#fetchToken = fetchToken;
  }

  /** A source that POSTs ``url`` (empty JSON body) and reads
   *  ``{ jwt, expires_at }`` from the response — the wire shape of
   *  ``POST /api/v1/external/auth/token`` and of the token-server
   *  template. Failures throw ``TokenSourceError``; on a rejection its
   *  ``serverCode`` carries the endpoint's own slug when the body
   *  parses, else an ``http_<status>`` synthetic. ``url`` is a string or a
   *  ``URL`` instance — the pair ``fetch`` itself accepts. An absolute
   *  ``url`` must be https
   *  (http only for localhost) — auth headers and JWTs must not cross
   *  the network in the clear; a relative ``url`` (string form only, since
   *  a ``URL`` is absolute by construction) rides the page's own
   *  origin. */
  static endpoint(url: string | URL, options: TokenSourceEndpointOptions = {}): TokenSource {
    const target = typeof url === 'string' ? url : url.href;
    assertSupportedEndpointUrl(target);
    return new TokenSource(() => postTokenEndpoint(target, options));
  }

  /** A source backed by ``fetchToken`` — called whenever a fresh token is
   *  needed. Resolve with a ``MintedToken`` — the same shape ``mintToken``
   *  returns; an empty ``jwt`` or invalid ``expiresAt`` raises
   *  ``TokenSourceError``. */
  static custom(fetchToken: () => Promise<MintedToken>): TokenSource {
    return new TokenSource(async () => validateFetched(await fetchToken()));
  }

  /** @internal The JWT to send right now: cached while it has more than
   *  the refresh skew left, else one shared re-fetch (concurrent callers
   *  await the same request). */
  async _getJwt(): Promise<string> {
    if (
      this.#cached !== null &&
      this.#cached.expiresAt.getTime() - Date.now() > REFRESH_SKEW_MS
    ) {
      return this.#cached.jwt;
    }
    this.#inflight ??= this.#fetchToken()
      .then((minted) => {
        this.#cached = minted;
        return minted;
      })
      .finally(() => {
        this.#inflight = null;
      });
    return (await this.#inflight).jwt;
  }

  /** @internal Drop the cached token so the next ``_getJwt`` re-fetches. */
  _invalidate(): void {
    this.#cached = null;
  }
}

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

function assertSupportedEndpointUrl(url: string): void {
  // Classify the way fetch will actually resolve it — prefix checks miss
  // the normalizations browsers apply (leading whitespace stripped,
  // backslashes read as slashes). Resolving against two sentinel bases
  // separates the three cases: a truly relative path lands on whichever
  // sentinel resolved it (safe: fetch sends it to the page's own origin);
  // a scheme-relative ``//host`` inherits the base's scheme, so the two
  // resolutions disagree (refused: an http page would send auth headers
  // to remote plaintext); an absolute URL resolves identically under both
  // and its scheme/host are checked.
  let asHttps: URL;
  let asHttp: URL;
  try {
    asHttps = new URL(url, 'https://cosmo-relative.invalid');
    asHttp = new URL(url, 'http://cosmo-relative.invalid');
  } catch {
    throw new TypeError(`TokenSource.endpoint could not be parsed as a URL: ${JSON.stringify(url)}`);
  }
  if (asHttps.hostname === 'cosmo-relative.invalid' && asHttp.hostname === 'cosmo-relative.invalid') {
    return; // relative — resolves against the page's own origin
  }
  if (asHttps.protocol !== asHttp.protocol) {
    throw new TypeError('TokenSource.endpoint must be an absolute https URL or a relative path, not scheme-relative.');
  }
  if (asHttps.protocol === 'https:') return;
  if (asHttps.protocol === 'http:' && LOCAL_HOSTS.has(asHttps.hostname)) return;
  throw new CredentialsError({
    code: 'insecure_base_url',
    message:
      'TokenSource.endpoint must use https:// (http is allowed only for localhost).',
  });
}

function validateFetched(fetched: MintedToken): MintedToken {
  const jwt = fetched?.jwt;
  const expiresAt = fetched?.expiresAt;
  if (
    typeof jwt !== 'string' ||
    jwt.length === 0 ||
    !(expiresAt instanceof Date) ||
    Number.isNaN(expiresAt.getTime())
  ) {
    throw new TokenSourceError({
      code: 'fetcher_failed',
      message: 'TokenSource.custom fetcher must resolve with a MintedToken ({ jwt, expiresAt }).',
    });
  }
  return { jwt, expiresAt, tokenId: fetched.tokenId };
}

async function postTokenEndpoint(
  url: string,
  options: TokenSourceEndpointOptions,
): Promise<MintedToken> {
  const extra =
    typeof options.headers === 'function' ? await options.headers() : (options.headers ?? {});
  let response: Response;
  try {
    // ``redirect: 'error'``: following one could silently downgrade the
    // exchange (an https endpoint answering 30x to plain http) — refuse.
    response = await fetch(url, {
      method: 'POST',
      headers: { ...extra, 'Content-Type': 'application/json' },
      body: '{}',
      redirect: 'error',
    });
  } catch (err) {
    throw new TokenSourceError({
      code: 'request_failed',
      message: describeFetchFailure(url, err),
    });
  }
  if (!response.ok) {
    const { code, message } = await parseErrorDetail(response);
    log.warn('[realtime] token source rejected', { status: response.status, code });
    throw new TokenSourceError({
      code: 'request_rejected',
      message,
      serverCode: code,
    });
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new TokenSourceError({
      code: 'invalid_response',
      message: 'Token endpoint response was not JSON.',
    });
  }
  const obj = (typeof body === 'object' && body !== null ? body : {}) as Record<string, unknown>;
  const jwt = obj.jwt;
  // ``expires_at`` is the wire shape (a forwarded mint response);
  // ``expiresAt`` is a serialized SDK ``MintedToken`` — a backend returning
  // its ``mintToken()`` result as-is emits this spelling.
  const expiresAt = parseRfc3339(obj.expires_at ?? obj.expiresAt);
  if (typeof jwt !== 'string' || jwt.length === 0 || expiresAt === null) {
    throw new TokenSourceError({
      code: 'invalid_response',
      message: 'Token endpoint response missing jwt / expires_at.',
    });
  }
  return { jwt, expiresAt };
}
