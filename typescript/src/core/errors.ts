/** Base for every error class this SDK exports, so `err instanceof
 *  RealtimeError` catches them as one family, and exported from every entry
 *  point that carries an error so the check works whichever subpath you
 *  import from. A tool declaration the SDK refuses — a malformed name, a
 *  missing or overlong description, a schema outside the dialect — throws
 *  `ToolDefinitionError` and is part of the family. An `input` that is not a
 *  minted `ToolInput` still throws a plain `TypeError`. Mirrors Python's
 *  `cosmo_ai.RealtimeError`. */
export class RealtimeError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'RealtimeError';
  }
}

/** Which audio failure occurred.
 *
 *  Closed: every one is raised by this SDK, so it changes only when the SDK
 *  does. Each SDK reports the ones its platform can tell apart — a member
 *  absent from one platform's vocabulary is still declared, so a `switch`
 *  written against it stays exhaustive everywhere. */
export type AudioUnavailableErrorCode =
  /** The host refused microphone permission. Nothing retries around it — the
   *  user grants access, or the session runs without a microphone. */
  | 'mic_denied'
  /** No input device exists to open. */
  | 'mic_not_found'
  /** An input device exists but another process holds it exclusively. */
  | 'mic_in_use'
  /** Audio could not be initialized and the platform did not say which of the
   *  above it was. */
  | 'audio_unavailable';

/** OS audio could not be initialized: the capture device would not open.
 *
 *  `code` names which of those it was — branch on it rather than on the
 *  message. The browser names all three device failures, so this SDK reports
 *  `'mic_denied'`, `'mic_not_found'` and `'mic_in_use'`. Mirrors Python's and
 *  Swift's `AudioUnavailableError`. */
export class AudioUnavailableError extends RealtimeError {
  /** Always ``'AudioUnavailableError'``. */
  readonly name = 'AudioUnavailableError';
  /** Which audio failure occurred. A closed set this SDK raises — switch on it. */
  readonly code: AudioUnavailableErrorCode;

  constructor(message: string, code: AudioUnavailableErrorCode = 'audio_unavailable') {
    super(message);
    this.code = code;
  }
}

/** Why the session could not serve the call.
 *
 *  Closed: every one is thrown by this SDK, so it changes only when the SDK
 *  does. Every member is declared in every SDK even where that SDK cannot
 *  reach the case, so a branch written against one ports unchanged. */
export type SessionStateErrorCode =
  /** The session is not live. Either it has not reached `ready` yet — await
   *  `session.waitUntilReady()` — or it has already ended. */
  | 'not_connected'
  /** The session was already started. A session is single-attempt; build a
   *  new one rather than restarting this one. */
  | 'already_started'
  /** A second audio publish was requested while one was live. A session
   *  carries one voice — the microphone or a caller-owned stream. */
  | 'audio_publish_already_active'
  /** A second video publish was requested while one was live, so a camera
   *  stream and a screen share cannot run together. */
  | 'video_publish_already_active'
  /** Screen capture could not be started by the platform. */
  | 'screen_share_unavailable'
  /** A caller-supplied payload would violate a wire-protocol invariant. */
  | 'invalid_payload';

/** The session cannot serve this call in its current state.
 *
 *  Thrown from a live-session method rather than at start: a send before
 *  `ready` or after the session ended, a second publish on a track that
 *  carries one. `code` names which — switch on it rather than matching the
 *  message. */
export class SessionStateError extends RealtimeError {
  /** Why the session refused. A closed set this SDK throws — switch on it. */
  readonly code: SessionStateErrorCode;

  constructor(options: { code: SessionStateErrorCode; message: string }) {
    super(options.message);
    this.name = 'SessionStateError';
    this.code = options.code;
  }
}

/** A request to the Cosmo backend failed.
 *
 *  The base every per-call error extends — `MintTokenError`,
 *  `TokenSourceError`, `VerifyError`, `UsageError`, `DialError` — so
 *  `err instanceof ApiError` covers any backend call while catching a
 *  specific one still says which call it was. Starting a session throws
 *  `SessionStartError` instead, which carries the HTTP status a start
 *  rejection turns on.
 *
 *  Each subclass carries its own closed `code`; `serverCode` is the open half
 *  and lives here, because a rejection slug belongs to whichever backend
 *  answered rather than to the call that asked. */
export class ApiError extends RealtimeError {
  /** The server's own rejection slug when it sent one, or a synthetic
   *  `http_<status>`. An open set: log it, do not switch on it. Absent when no
   *  server verdict was parsed. */
  readonly serverCode?: string;

  constructor(message: string, options?: { serverCode?: string }) {
    super(message);
    this.name = 'ApiError';
    this.serverCode = options?.serverCode;
  }
}
