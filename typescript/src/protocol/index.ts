/**
 * The external realtime protocol, declared by the SDK.
 *
 * Every frame that crosses the wire has its twin here rather than being
 * re-exported from ``../wire/types.gen``. The generated types stay an
 * implementation detail of decoding; these are what the published surface
 * refers to, so a regenerated schema cannot change a consumer's types
 * without someone editing this directory first.
 *
 * ``__tests__/wire_parity.test.ts`` holds each twin identical to its
 * generated counterpart, so the decoupling costs no accuracy.
 */

export type * from './shared';
export type * from './server_frames';
export type * from './client_frames';
export type * from './session_config';
