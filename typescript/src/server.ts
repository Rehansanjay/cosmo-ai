// Server-safe entry: hold an API key on a backend — mint end-user tokens,
// verify credentials. A narrow surface for the credential-holding half of an
// app, kept separate from the session and agent API the root entry carries.
export { ApiError, RealtimeError } from './core/errors';
export { RealtimeClient } from './core/realtime_client';
export type { RealtimeClientOptions } from './core/realtime_client';
export type { MintedToken, MintTokenErrorCode, CredentialsErrorCode } from './core/auth';
export { TokenSourceError } from './core/token_source';
export type { TokenSourceErrorCode } from './core/token_source';
export { CredentialsError, MintTokenError } from './core/auth';
export { VerifyError } from './core/verify';
export type { CredentialInfo } from './core/verify';
export { setLogLevel, getLogLevel } from './core/logger';
export type { LogLevel } from './core/logger';
