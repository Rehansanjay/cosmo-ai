/**
 * ``SessionEngine`` — the single-use engine behind one live session.
 *
 * Owns everything one run needs: the transport (mic + data channel),
 * normalized state, the typed event stream, analysers, screen share, and
 * teardown. ``RealtimeClient`` creates one engine per start and holds none
 * of this state itself, so N engines — N concurrent sessions — coexist on
 * one client. An engine never restarts; the session that owns it latches
 * its terminal state.
 *
 * Internal to the SDK: the public surfaces are ``RealtimeClient`` (which
 * bridges engine events for its client-level compat API) and
 * ``RealtimeSession`` (which owns exactly one engine).
 */

import {
  AudioUnavailableError,
  type AudioUnavailableErrorCode,
  SessionStateError,
} from './errors';
import { log } from './logger';
import * as decode from './wire_decode';
import type {
  ClientConnectTimings,
  SessionConfig,
  DelegationChannel,
} from '../protocol';
import type { SessionConnectTimings } from './state';

import type {
  BackgroundClientTool,
  ClientTool,
} from './agent';
import { ClientToolJobSink } from './client_tool_jobs';
import { makeRpcHandler, registerClientToolHandlers } from './client_tools';
import { SCREEN_CAPTURE_RPC_METHOD, screenCaptureRpc } from '../tool/screen_capture_rpc';
import type { ScreenLocateTool } from './agent';
import type { HookEngine } from './hooks';

import type { RealtimeInboundMessage } from '../transport/envelope';
import type { PreparedConnectOptions, PreparedRoomRef } from '../transport/prepared_room';
import type {
  RealtimeCloseInfo,
  RealtimeTransport,
  VideoStreamHandle,
  VideoStreamKind,
  VideoStreamOptions,
} from '../transport/types';
import { postDial, validateE164, type DialResult } from '../transport/dial';
import { getUsage, type SessionUsage } from './usage';
import {
  SessionStartError,
  unsupportedTransportCapability,
  sessionStartRejectionFrom,
} from '../transport/session_start_error';
import { computeVisionInputStatus } from './vision_input_status';

import { DelegationTranscripts } from './delegation_transcript';
import {
  RealtimeEventEmitter,
  type DelegationCreatedEvent,
  type UserSpeechTimeoutEvent,
  type RealtimeEventMap,
  type RealtimeEventName,
  type TranscriptDeltaEvent,
  type TranscriptItem,
  type Unsubscribe,
} from './events';
import { TranscriptStore } from './transcript_state';
import {
  INITIAL_LIFECYCLE_STATE,
  INITIAL_SNAPSHOT,
  type AgentState,
  type DisconnectReason,
  type MediaState,
  type MicState,
  type RealtimeSnapshot,
  type SessionState,
  type TransportState,
} from './state';
import { type ErrorEvent, type ScreenShareState } from './types';

/** What an engine needs from its ``RealtimeClient``: transport construction,
 *  URL composition against the client's (possibly late-resolved) base URL,
 *  auth headers, and the 401 hatch that lets the client drop a cached
 *  ``TokenSource`` JWT. */
export type SessionEngineContext = {
  createTransport: () => RealtimeTransport;
  startUrl: () => string;
  dialUrl: (sessionId: string) => string;
  usageUrl: (sessionId: string) => string;
  resolveAuthHeaders: () => Promise<Record<string, string>>;
  /** The session-start POST was rejected with a 401. */
  onStartUnauthorized: () => void;
};

/** The three ways acquiring a microphone fails, named as the ``MicState``
 *  each one leaves behind. */
type MicFailure = Extract<MicState, 'denied' | 'not-found' | 'in-use'>;

/** The slug each failure carries on ``AudioUnavailableError`` — the same set
 *  Python and Swift publish for the same situations. It lives on the error
 *  rather than in ``ErrorCode``, which is the server's wire enum. */
const MIC_FAILURE_CODES: Record<MicFailure, AudioUnavailableErrorCode> = {
  denied: 'mic_denied',
  'not-found': 'mic_not_found',
  'in-use': 'mic_in_use',
};

/** Which microphone failure an error describes, or ``null`` when it is not
 *  one. Classified by ``DOMException.name``: the transport rethrows the
 *  browser's own error unwrapped, and reading the name keeps ``MicState``
 *  free of any vendor type. The aliases are the pre-standard names still
 *  emitted by some browsers. */
function micFailureKind(err: unknown): MicFailure | null {
  if (!err || typeof err !== 'object') return null;
  switch ((err as { name?: unknown }).name) {
    case 'NotAllowedError':
    case 'PermissionDeniedError':
    case 'SecurityError':
      return 'denied';
    case 'NotFoundError':
    case 'DevicesNotFoundError':
    case 'OverconstrainedError':
      return 'not-found';
    case 'NotReadableError':
    case 'TrackStartError':
      return 'in-use';
    default:
      return null;
  }
}

function isScreenPermissionDenied(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const name = (err as { name?: unknown }).name;
  return name === 'NotAllowedError' || name === 'PermissionDeniedError';
}

/** Strip the ``livekit:`` (or other transport vendor) prefix so error
 *  messages handed to ``useRealtimeError`` consumers don't leak the
 *  underlying transport's name. Vendor-specific diagnostics still flow
 *  via ``console.error`` from the transport for debugging. */
function normalizeCloseReason(reason: string | undefined): string {
  if (!reason) return 'Voice session disconnected.';
  const colonIdx = reason.indexOf(':');
  if (colonIdx === -1) return reason;
  // Heuristic: only strip a leading ``<word>:`` (vendor tag) — preserve
  // free-form messages that happen to contain a colon.
  const head = reason.slice(0, colonIdx);
  if (/^[a-z0-9_-]{2,32}$/i.test(head)) {
    return reason.slice(colonIdx + 1).trim() || 'Voice session disconnected.';
  }
  return reason;
}

/** What the error axis carries: the typed error a failed ``start()``
 *  rejected with, or the server's error event. */
type BubbledError = SessionStartError | AudioUnavailableError | ErrorEvent;

/** Grace between a ``session-ended`` frame and a forced teardown when
 *  the expected transport close never follows. */
const SERVER_END_GRACE_MS = 5_000;

/** Bound on the wait between the transport joining and the server's
 *  ``ready`` handshake. Deliberately longer than the server's own 30s boot
 *  deadline (which fails a stuck boot as an ``error`` frame + room close),
 *  so a failed boot reaches ``start()`` as that informative close rather
 *  than this blind timeout; only genuine infra loss lands here. A session
 *  that has not readied by then is torn down and ``start()`` rejects with
 *  ``SessionStartError`` and code ``'ready_timeout'``. */
const READY_TIMEOUT_MS = 40_000;

/** A close before ``ready`` — a failed boot. Synthetic status ``0``; the
 *  server's boot-failure ``error`` frame supplies ``serverCode`` and ``detail``
 *  when one preceded the close, else ``handshake_disconnect`` + the close
 *  reason. */
/** A close before ready. No `status`: no HTTP exchange failed. `serverCode`
 *  only when the server's pre-close `error` frame supplied one — a close with
 *  no frame has no server verdict to report, and Python and Swift report none
 *  either. */
function handshakeFailed(code: string | undefined, message: string): SessionStartError {
  return new SessionStartError({
    code: 'handshake_failed',
    message,
    serverCode: code,
    detail: code === undefined ? null : sessionStartRejectionFrom({ code, message }),
  });
}

/** The refusal every video entry point answers on a transport without video
 *  (the websocket transport). */
function videoUnsupported(): SessionStartError {
  return unsupportedTransportCapability(
    'video_unsupported',
    'This transport carries no video; use the WebRTC transport for camera or screen input.',
  );
}

/** Map a wire transcript role onto the public union.
 *
 * Returns ``null`` for anything unrecognized rather than guessing. The old
 * ``role === 'USER' ? 'user' : 'assistant'`` ternary silently filed every
 * unknown value under ``assistant``, which would put a caller's own words in
 * the agent's bubble if the wire ever grew a third role or changed casing.
 */
function normalizeTranscriptRole(role: string): 'user' | 'assistant' | null {
  const lowered = role.toLowerCase();
  if (lowered === 'user') return 'user';
  if (lowered === 'assistant') return 'assistant';
  return null;
}

/** Machinery behind one ``RealtimeSession``: its transport, state machine,
 *  event emitter and media. One engine per run, created by the client at
 *  start. Not part of the public surface — everything here is reached
 *  through ``RealtimeSession``. @internal */
export class SessionEngine {
  /** Raw emitter — ``on()`` adds the subscribe-time replay on top. The
   *  client's event bridge taps this directly so a bridge attach never
   *  re-broadcasts a replayed state. */
  readonly emitter = new RealtimeEventEmitter();
  private readonly context: SessionEngineContext;
  private started = false;
  /** Set by the first ``disconnect()``/``close()``; an in-flight ``start``
   *  checks it after each await so a session cannot come up live after the
   *  caller ended it. */
  private cancelReason: 'client_ended' | 'client_closed' | null = null;
  /** Shutdown runs once; concurrent ``end()``/``disconnect()`` calls share
   *  it, so the terminal ``session_ended`` cannot double-emit. */
  private shutdownPromise: Promise<void> | null = null;

  private connection: RealtimeTransport | null = null;
  /** Owner of in-flight background client-tool jobs for the active
   *  session; closed on teardown so late terminal results are dropped. */
  private jobSink: ClientToolJobSink | null = null;
  private unbindClientTools: Unsubscribe | null = null;
  private unbindScreenCapture: Unsubscribe | null = null;
  /** The active session's hook registry; drives the SessionEnd and
   *  UserSpeechTimeout seams, which fire from the engine's close /
   *  wire-message paths rather than the tool RPC path. */
  private activeHooks: HookEngine | null = null;
  /** SessionEnd fires exactly once per session, whatever exit path runs first. */
  private sessionEndFired = false;
  private hostAudioElement: HTMLAudioElement | null = null;
  private hostVideoElement: HTMLVideoElement | null = null;
  // Stashed from the session-start POST so consumers can read it before
  // ``ready`` lands — see ``onSessionStarted`` below for why that matters on
  // outbound-phone sessions.
  private earlySessionId: string | null = null;
  private connectTimings: SessionConnectTimings | null = null;
  /** ``performance.now()`` origin the marks that land after the connect
   *  measure from. Stamped before ``connect()`` so a transport that reports
   *  no origin still yields usable marks, then replaced by the transport's
   *  own origin, which shares a clock with ``wsMs``. */
  private connectStartedAt: number | null = null;
  private readyAt: number | null = null;
  /** The ``connect-timings`` report goes out once — the worker accepts one
   *  per session, and the engine is single-use. */
  private connectTimingsReported = false;
  private analyserContext: AudioContext | null = null;
  private inputAnalyser: AnalyserNode | null = null;
  private outputAnalyser: AnalyserNode | null = null;
  private inputAnalyserSource: MediaStreamAudioSourceNode | null = null;
  private outputAnalyserSource: MediaStreamAudioSourceNode | null = null;
  /** Stream the current output tap was built from, so a refresh for an
   *  unchanged stream is a no-op. */
  private outputAnalyserStream: MediaStream | null = null;
  private readonly inputAnalyserListeners = new Set<(a: AnalyserNode | null) => void>();
  private readonly outputAnalyserListeners = new Set<(a: AnalyserNode | null) => void>();

  private snapshot: RealtimeSnapshot = { ...INITIAL_SNAPSHOT };
  private lifecycle: SessionState = INITIAL_LIFECYCLE_STATE;
  /** Coalesced conversation state, folded from the transcript and
   *  turn-complete streams. Survives teardown so ``transcript`` stays
   *  readable after the session ends. */
  private readonly transcriptStore = new TranscriptStore();
  private readonly delegationTranscripts = new DelegationTranscripts();
  /** Last ``ready`` payload of the current session, replayed to late
   *  subscribers — ``ready`` can fire before ``agent.start()`` resolves. */
  private lastReadyEvent: RealtimeEventMap['ready'] | null = null;
  /** Pre-ready ``error`` frame, stashed as enrichment: a failed boot closes
   *  the room, and this upgrades that close's rejection with the server's
   *  own code and message. */
  private pendingHandshakeError: { code: string; message: string } | null = null;
  /** ``session_ended`` fires exactly once per session, on any exit path. */
  private sessionEndedEmitted = false;
  private readonly wireMessageListeners = new Set<
    (message: RealtimeInboundMessage) => void
  >();
  // Reason slug from a ``session-ended`` frame. Marks the transport close
  // that follows as an expected server end, not a failure.
  private serverEndReason: string | null = null;
  private serverEndGraceTimer: ReturnType<typeof setTimeout> | null = null;

  private screenShareHandle: VideoStreamHandle | null = null;
  private screenShareTrack: MediaStreamTrack | null = null;
  private screenShareStream: MediaStream | null = null;
  private screenShareEndedListener: (() => void) | null = null;

  /** Every published video track this engine is currently publishing,
   *  including screen-share AND camera tracks. The dispatcher's
   *  ``get_current_screen`` handler reads this map to answer "does the
   *  model have a fresh frame in its vision input right now?" — the same
   *  question the backend's ``has_recent_video_frame`` used to answer
   *  across both sources. */
  private visionSources = new Map<
    VideoStreamHandle,
    { kind: VideoStreamKind; track: MediaStreamTrack; endedListener: () => void }
  >();

  private volumeRafHandle: number | null = null;
  private volumeBuffer: Float32Array<ArrayBuffer> | null = null;
  private lastEmittedMic: number = 0;
  private lastEmittedOutput: number = 0;

  constructor(context: SessionEngineContext) {
    this.context = context;
    this.emitter.onSubscriberChange('volume', (count) => {
      if (count === 1) this.startVolumeLoop();
      else if (count === 0) this.stopVolumeLoop();
    });
  }

  // ─── Public lifecycle ──────────────────────────────────────────────────

  isActive(): boolean {
    return this.connection !== null;
  }

  getSnapshot(): RealtimeSnapshot {
    // Shallow clone so consumers can't mutate the SDK's internal state
    // by writing into the returned object.
    return { ...this.snapshot };
  }

  /** Server-minted session id, available the instant the session-start
   *  POST returns (before ``ready``); ``null`` when no session started. */
  getSessionId(): string | null {
    return this.earlySessionId;
  }

  /** Connect-latency breakdown for this session's start: the client-measured
   *  phases plus the server's own breakdown. ``null`` before the connect
   *  completes, and dropped when the session ends. */
  getConnectTimings(): SessionConnectTimings | null {
    return this.connectTimings;
  }

  getLifecycleState(): SessionState {
    return this.lifecycle;
  }

  getLastReady(): RealtimeEventMap['ready'] | null {
    return this.lastReadyEvent;
  }

  getTranscript(): readonly TranscriptItem[] {
    return this.transcriptStore.current;
  }

  /** The hand-off, with the session's last user turn standing in when the
   *  provider attached none. Resolving twice for one hand-off returns the
   *  first answer, so the callback and the stream agree. */
  resolveDelegation(event: DelegationCreatedEvent): DelegationCreatedEvent {
    return {
      ...event,
      transcript: this.delegationTranscripts.resolve(
        event.delegationId,
        event.transcript,
        this.transcriptStore.current,
      ),
    };
  }

  on<E extends RealtimeEventName>(
    event: E,
    handler: (payload: RealtimeEventMap[E]) => void,
  ): Unsubscribe {
    const unsubscribe = this.emitter.on(event, handler);
    // Connect-phase events can fire before ``agent.start()`` resolves, so a
    // subscriber attaching to the returned session would otherwise miss
    // them. Replay current state so subscribe-then-read needs no reconcile.
    if (event === 'lifecycle') {
      (handler as (payload: RealtimeEventMap['lifecycle']) => void)(this.lifecycle);
    } else if (event === 'ready' && this.lastReadyEvent !== null) {
      (handler as (payload: RealtimeEventMap['ready']) => void)(this.lastReadyEvent);
    } else if (event === 'transcript_updated') {
      (handler as (payload: RealtimeEventMap['transcript_updated']) => void)({
        items: this.transcriptStore.current,
      });
    }
    return unsubscribe;
  }

  /** Raw external-protocol frames as they arrive off the transport —
   *  the feed behind ``RealtimeSession``'s async iterator. */
  subscribeWireMessages(cb: (message: RealtimeInboundMessage) => void): Unsubscribe {
    this.wireMessageListeners.add(cb);
    return () => {
      this.wireMessageListeners.delete(cb);
    };
  }

  getInputAnalyser(): AnalyserNode | null {
    return this.inputAnalyser;
  }

  getOutputAnalyser(): AnalyserNode | null {
    return this.outputAnalyser;
  }

  subscribeInputAnalyser(cb: (a: AnalyserNode | null) => void): Unsubscribe {
    this.inputAnalyserListeners.add(cb);
    return () => this.inputAnalyserListeners.delete(cb) as unknown as void;
  }

  subscribeOutputAnalyser(cb: (a: AnalyserNode | null) => void): Unsubscribe {
    this.outputAnalyserListeners.add(cb);
    return () => this.outputAnalyserListeners.delete(cb) as unknown as void;
  }

  /** Open this engine's one session. Takes the prebuilt external
   *  ``session-config`` body; single-use — a second call is a programmer
   *  error, not a state to recover from. */
  async start(options: {
    config: SessionConfig;
    publishMicrophone: boolean;
    clientTools?: readonly (ClientTool | BackgroundClientTool)[];
    screenLocate?: ScreenLocateTool;
    hooks?: HookEngine;
    prepared?: PreparedRoomRef;
    /** When the caller began waiting, if before this call. */
    connectStartedAt?: number;
  }): Promise<void> {
    if (this.started) {
      throw new Error('SessionEngine.start is single-use — create a new engine.');
    }
    this.started = true;
    this.resetSnapshot();
    this.setLifecycle({ kind: 'connecting' });

    // Freeze before the first dispatch (concurrent registration must never
    // race a running session), then let SessionStart hooks fold additional
    // context into the instructions ahead of the session-config POST.
    const hooks = options.hooks ?? null;
    this.activeHooks = hooks;
    this.sessionEndFired = false;
    let config: SessionConfig;
    try {
      config = await this.applySessionStartHooks(options.config, hooks);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'session-start hook fold failed';
      await this.fireSessionEnd('handshake_failed', message);
      this.activeHooks = null;
      this.setLifecycle({
        kind: 'disconnected',
        disconnectReason: 'handshake_failed',
        detail: message,
      });
      const failure = new SessionStartError({
        code: 'handshake_failed',
        message,
        status: 0,
        serverCode: 'session_start_hook_failed',
        detail: sessionStartRejectionFrom({
          code: 'session_start_hook_failed',
          message,
        }),
      });
      this.reportError(failure);
      throw failure;
    }
    if (this.cancelReason !== null) {
      this.setLifecycle({ kind: 'disconnected', disconnectReason: this.cancelReason });
      throw new SessionStateError({
        code: 'not_connected',
        message: 'Session was ended before start completed.',
      });
    }

    this.setTransportState('requesting-permission');
    this.setMediaState({ ...this.snapshot.mediaState, mic: 'requesting' });

    try {
      const local = this.context.createTransport();
      if (this.hostVideoElement) local.attachVideoElement?.(this.hostVideoElement);
      if (this.hostAudioElement) {
        local.attachAudioElement(this.hostAudioElement);
      }
      local.onMessage((m) => {
        // ``ready`` arrives on two channels — the agent's participant
        // attribute (room state, read by late joiners) and the data-channel
        // frame. First delivery wins; the echo reaches neither surface.
        if (m.type === 'ready' && this.lastReadyEvent !== null) return;
        this.handleServerMessage(m);
        this.emitWireMessage(m);
      });
      local.onClose((event) => void this.handleUnsolicitedClose(event));
      // The remote track is subscribed after the connect resolves, and can
      // be replaced mid-session when a speaker leaves, so the output
      // analyser is rebuilt on the transport's signal rather than guessed at
      // from the connect.
      local.onOutputStreamChanged?.(() => this.refreshOutputAnalyser());
      local.onReconnecting(() => {
        // Layer-1 transient reconnect: LiveKit is recovering the room
        // itself. Surface for UI but take no action; LiveKit will fire
        // ``onReconnected`` on success or ``onClose`` on failure.
        this.setTransportState('reconnecting');
        this.setLifecycle({ kind: 'reconnecting' });
      });
      local.onReconnected(() => {
        // Restore the pre-reconnect truth — a transport recovery is not a
        // handshake, so it must never forge readiness. A genuinely ready
        // session re-latches anyway: rejoining re-delivers the agent's
        // readiness attribute.
        this.setTransportState(this.readyAt !== null ? 'ready' : 'connecting');
        this.setLifecycle({ kind: 'connected' });
        // The server-side mic gate is session-server state that may reset with
        // the transport; re-assert the last state this client set. Best-effort.
        if (this.snapshot.mediaState.mic === 'muted') {
          local.setMicMuted(true).catch((err: unknown) => {
            log.error('[realtime] mute re-assert after reconnect failed', err);
          });
        }
      });
      this.connection = local;

      // Flip to 'connecting' BEFORE awaiting local.connect — ready
      // can arrive over the LiveKit data channel while local.connect is
      // still pending (the data channel opens before connect() resolves
      // its overall setup), and that handler sets state to 'ready'.
      // Doing the 'connecting' set after the await would clobber a
      // legitimate 'ready' transition back to 'connecting' and the UI
      // would never recover.
      this.setTransportState('connecting');
      // Bind client-tool + screen-capture RPC methods BEFORE the connect:
      // the transport parks pre-connect registrations and binds them onto the
      // room ahead of the join, so a tool invocation arriving the instant the
      // room connects (first-turn call, pre-``ready``) is handled instead of
      // failing "method not found". The session id resolves lazily — it is
      // minted by the session-start POST inside ``connect`` and set before
      // any agent can exist to invoke a tool.
      this.bindClientTools(local, options.clientTools ?? [], options.hooks);
      this.bindScreenCapture(local, options.screenLocate);
      this.connectStartedAt = options.connectStartedAt ?? performance.now();
      const connectOptions: PreparedConnectOptions = {
        config,
        sessionStartUrl: this.context.startUrl(),
        publishMicrophone: options.publishMicrophone,
        getAuthHeaders: () => this.context.resolveAuthHeaders(),
        // Publish the server-minted ``session_id`` the instant the
        // session-start POST returns, well ahead of the ``ready``
        // data-channel message. Without this, outbound-phone
        // sessions that never publish a browser track (and so
        // sometimes never observe ``ready`` over LiveKit's data
        // channel) would leave consumers without a session id —
        // silently blocking any per-session API polling.
        onSessionStarted: (sessionId) => {
          this.earlySessionId = sessionId;
          this.emitter.emit('session_started', { sessionId });
        },
        onConnectTimings: (timings, startedAt) => {
          this.connectTimings = timings;
          if (startedAt !== undefined) this.connectStartedAt = startedAt;
          log.debug(
            `cosmo connect timings ws_ms=${timings.wsMs} room_ms=${timings.roomMs}` +
              ` mic_ms=${timings.micMs} total_ms=${timings.totalConnectMs}` +
              ` server_ms=${timings.serverTimings?.total_ms ?? '-'}`,
          );
          this.foldConnectMarks();
        },
        onOutputBlocked: (blocked) => this.setOutputBlocked(blocked),
        prepared: options.prepared,
        startedAt: this.connectStartedAt,
      };
      await local.connect(connectOptions);
      if (this.cancelReason !== null) {
        throw new SessionStateError({
        code: 'not_connected',
        message: 'Session was ended before start completed.',
      });
      }
      this.attachAnalysers(local);
      if (this.snapshot.mediaState.mic !== 'muted') {
        this.setMediaState({ ...this.snapshot.mediaState, mic: 'granted' });
      }
      this.setLifecycle({ kind: 'connected' });
      await this.awaitReadyForStart();
      if (this.cancelReason !== null) {
        throw new SessionStateError({
        code: 'not_connected',
        message: 'Session was ended before start completed.',
      });
      }
    } catch (err) {
      if (this.cancelReason !== null) {
        // ``disconnect()``/``close()`` raced the start and already published
        // the terminal state — a user-initiated end, not a failure.
        throw err;
      }
      log.error('[realtime] transport setup failed', err);
      if (err instanceof SessionStartError && err.status === 401) {
        this.context.onStartUnauthorized();
      }
      // A close before ``ready`` settles the ready waiters with the window's
      // typed failure, so that rejection IS this error. Recomputing it would
      // mint a second instance whose message quotes the lifecycle detail the
      // first one just wrote. Only ``handshakeFailed`` mints this code — a
      // server rejection never classifies to it.
      const settled =
        err instanceof SessionStartError && err.code === 'handshake_failed' ? err : null;
      if (this.lifecycle.kind === 'disconnected') {
        // Another path — an unsolicited transport close, a server-side end —
        // already published the terminal state and tore down while the start
        // was still pending (most often during the ready wait). Don't
        // re-publish it or clobber its error with a generic one; do raise
        // the typed handshake failure over whatever the racing phase threw.
        throw settled ?? this.handshakeFailure() ?? err;
      }
      // The room can die before the join resolves — a boot that failed fast,
      // deleting the room while ``connect`` is still negotiating. The join
      // then fails on its own timeout, but the session-ending evidence (the
      // server's pre-ready error frame, or a close seen mid-connect) is what
      // the caller needs: raise the window's typed close exit, not the raw
      // transport error.
      const handshakeFailure = settled ?? this.handshakeFailure();
      if (handshakeFailure !== null) {
        await this.fireSessionEnd('handshake_failed', handshakeFailure.message);
        await this.teardown();
        this.reportError(handshakeFailure);
        this.setTransportState('failed');
        this.setLifecycle({
          kind: 'disconnected',
          disconnectReason: 'handshake_failed',
          detail: handshakeFailure.message,
        });
        throw handshakeFailure;
      }
      const message = err instanceof Error ? err.message : 'Voice session connection failed.';
      const disconnectReason: DisconnectReason =
        err instanceof SessionStartError ? 'handshake_failed' : 'transport_error';
      await this.fireSessionEnd(disconnectReason, message);
      await this.teardown();
      const micFailure = micFailureKind(err);
      if (micFailure !== null) {
        this.setMediaState({ ...this.snapshot.mediaState, mic: micFailure });
      }
      // The browser's or transport's own error names the failure for a
      // developer reading a stack trace; the typed one names it the way the
      // other SDKs do, and is both what ``start()`` rejects with and what
      // the error axis latches — one object, not two vocabularies.
      const typed: BubbledError =
        micFailure !== null
          ? new AudioUnavailableError(message, MIC_FAILURE_CODES[micFailure])
          : err instanceof SessionStartError
            ? err
            : new SessionStartError({ code: 'join_failed', message, cause: err });
      this.reportError(typed);
      this.setTransportState('failed');
      this.setLifecycle({
        kind: 'disconnected',
        disconnectReason,
        detail: message,
      });
      throw typed;
    }
  }

  /** The window's close exit as a typed error, when the evidence for one
   *  exists: the server's stashed pre-ready ``error`` frame (enrichment), or
   *  a session that reached its terminal state before ``ready``. ``null``
   *  when neither — an ordinary transport failure with nothing to enrich. */
  private handshakeFailure(): SessionStartError | null {
    if (this.snapshot.transportState === 'ready') return null;
    const stashed = this.pendingHandshakeError;
    if (stashed !== null) {
      return handshakeFailed(stashed.code, stashed.message);
    }
    if (this.lifecycle.kind !== 'disconnected') return null;
    const detail = this.lifecycle.detail;
    return handshakeFailed(
      undefined,
      detail
        ? `The session ended before ready: ${detail}`
        : 'The session ended before ready.',
    );
  }

  /** Hold ``start()`` until the server's ``ready`` handshake lands, so a
   *  resolved start is a usable session. Bounded: a session that never
   *  readies is a start failure, not a live-looking object whose every
   *  method throws. */
  private async awaitReadyForStart(): Promise<void> {
    if (this.snapshot.transportState === 'ready') return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    try {
      await Promise.race([
        this.waitUntilReady(),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(
            () =>
              reject(
                // No status and no serverCode: nothing was refused. The
                // server never answered, so attributing a verdict to it —
                // which Python and Swift do not — would be a fabrication.
                new SessionStartError({
                  code: 'ready_timeout',
                  message: `The server's ready handshake did not arrive within ${READY_TIMEOUT_MS / 1000}s.`,
                }),
              ),
            READY_TIMEOUT_MS,
          );
        }),
      ]);
    } finally {
      if (timer !== null) clearTimeout(timer);
    }
  }

  /** Fold every SessionStart hook's ``additionalContext`` into the
   *  session-config instructions before the config crosses the wire. */
  private async applySessionStartHooks(
    config: SessionConfig,
    hooks: HookEngine | null,
  ): Promise<SessionConfig> {
    if (hooks === null) return config;
    const extra = await hooks.runSessionStart({ event: 'SessionStart' });
    if (extra === null) return config;
    const agent = config.agent;
    if (agent !== undefined && agent.type === 'catalog') {
      log.warn(
        '[realtime] a catalog agent runs its stored config verbatim — SessionStart additionalContext is not injected',
      );
      return config;
    }
    const base = agent?.instructions;
    const merged = base ? `${base}\n\n${extra}` : extra;
    log.info('[realtime] session-start hook context folded', {
      addedChars: extra.length,
    });
    return { ...config, agent: { ...agent, type: 'inline', instructions: merged } };
  }

  /** Run the SessionEnd hooks exactly once for the active session. The context is
   *  captured synchronously (before any teardown nulls the session id). */
  private async fireSessionEnd(reason: DisconnectReason, detail: string | null): Promise<void> {
    const hooks = this.activeHooks;
    if (hooks === null || this.sessionEndFired) return;
    this.sessionEndFired = true;
    await hooks.runSessionEnd({
      event: 'SessionEnd',
      reason,
      detail,
      sessionId: this.getSessionId(),
    });
  }

  /** Bind declared client tools to the transport's RPC bridge (pre-connect —
   *  the transport parks the registrations and binds them ahead of the join):
   *  freeze the hook registry (concurrent tool dispatch must never race
   *  registration), stand up the session's job sink for background tools,
   *  and register one guarded RPC method per declared tool. */
  private bindClientTools(
    transport: RealtimeTransport,
    clientTools: readonly (ClientTool | BackgroundClientTool)[],
    hooks: HookEngine | undefined,
  ): void {
    if (clientTools.length === 0) return;
    const registerRpcMethod = transport.registerRpcMethod?.bind(transport);
    if (registerRpcMethod === undefined) {
      log.warn(
        '[realtime] client tools declared but the transport does not support RPC registration',
      );
      return;
    }
    const sink = new ClientToolJobSink({
      publish: (message) => transport.send(message),
      isOpen: () => this.connection === transport,
    });
    this.jobSink = sink;
    this.unbindClientTools = registerClientToolHandlers({ registerRpcMethod }, clientTools, {
      hooks: hooks ?? null,
      // Lazy: binding happens pre-connect, before the session-start POST
      // mints the id; any real invocation resolves it non-null.
      sessionId: () => this.getSessionId(),
      jobSink: sink,
    });
  }

  /** Register the screen locator's capture RPC (register-without-advertise:
   *  the tool list declares the locator, never this method), if the agent
   *  declared a capture handler and the transport supports RPC registration +
   *  byte streams. */
  private bindScreenCapture(
    transport: RealtimeTransport,
    spec: ScreenLocateTool | undefined,
  ): void {
    if (spec === undefined) return;
    const registerRpcMethod = transport.registerRpcMethod?.bind(transport);
    const sendBytes = transport.sendBytes?.bind(transport);
    if (registerRpcMethod === undefined || sendBytes === undefined) {
      // The locator's capture payload travels as a byte stream, a channel
      // the single-socket carrier does not have — refusing here means the
      // capture handler never runs.
      throw new SessionStartError({
        code: 'config',
        message: 'screen_locate is not supported on the websocket transport',
        serverCode: 'screen_locate_unsupported',
      });
    }
    this.unbindScreenCapture = registerRpcMethod(
      SCREEN_CAPTURE_RPC_METHOD,
      makeRpcHandler(SCREEN_CAPTURE_RPC_METHOD, screenCaptureRpc(spec, sendBytes)),
    );
  }

  async disconnect(): Promise<void> {
    await this.shutdown('client_ended');
  }

  /** Abrupt local teardown without the graceful wire ``end`` frame; the
   *  stream finishes with reason ``client closed``. Idempotent. */
  async close(): Promise<void> {
    await this.shutdown('client_closed');
  }

  private shutdown(reason: 'client_ended' | 'client_closed'): Promise<void> {
    this.cancelReason ??= reason;
    this.shutdownPromise ??= this.runShutdown(this.cancelReason);
    return this.shutdownPromise;
  }

  private async runShutdown(reason: 'client_ended' | 'client_closed'): Promise<void> {
    const wasActive = this.connection !== null;
    this.setTransportState('disconnecting');
    if (wasActive) await this.fireSessionEnd(reason, null);
    try {
      await this.teardown({ sendEndFrame: reason === 'client_ended' });
    } finally {
      // Terminal states publish even when the transport's disconnect
      // rejects, so the engine always detaches from its client.
      if (wasActive) {
        this.setLifecycle({ kind: 'disconnected', disconnectReason: reason });
      }
      this.resetSnapshot();
      // Terminal quiescent state: the owning ``RealtimeSession`` has already
      // latched ``disconnected``; client-level subscribers see the machine
      // return to ``idle``.
      this.setLifecycle({ kind: 'idle' });
    }
  }

  /** Send a text turn. ``transcript: false`` keeps the sent text out of the
   *  local transcript, for context notes the user never typed and shouldn't
   *  see. */
  async sendText(
    content: string,
    options?: { transcript?: boolean },
  ): Promise<void> {
    if (!this.connection || this.snapshot.transportState !== 'ready') {
      throw new SessionStateError({
        code: 'not_connected',
        message: `sendText requires the session to be live, currently ${this.snapshot.transportState}.`,
    });
    }
    if (!content.trim()) return;
    // Await delivery before emitting the optimistic user transcript so
    // a failed publish doesn't leave a phantom user bubble in the UI.
    await this.connection.send({ type: 'send-text', content });
    if (options?.transcript === false) return;
    // The echo is a complete turn of its own — never folded through the
    // wire-final path, which would replace an in-progress speech bubble.
    const changed = this.transcriptStore.appendClosed('user', content);
    this.emitter.emit('transcript', {
      role: 'user',
      text: content,
      isFinal: true,
    });
    if (changed) this.emitTranscriptUpdated();
  }

  /** Give the agent context without asking it anything.
   *
   *  The note lands in the model's context for its next reply and never
   *  becomes a turn of its own: no spoken response, no assistant message,
   *  no interruption of what the agent is saying. Nothing is added to the
   *  transcript either — the user didn't say this.
   *
   *  For live application state — scroll position, selection, current
   *  record, form values. ``sendText`` is the opposite: it asks. */
  async sendContext(content: string): Promise<void> {
    if (!this.connection || this.snapshot.transportState !== 'ready') {
      throw new SessionStateError({
        code: 'not_connected',
        message: `sendContext requires the session to be live, currently ${this.snapshot.transportState}.`,
    });
    }
    if (!content.trim()) return;
    await this.connection.send({ type: 'send-context', content });
  }

  async appendDelegation(
    channel: DelegationChannel,
    content: string,
    options?: { delegationId?: string },
  ): Promise<void> {
    if (!this.connection || this.snapshot.transportState !== 'ready') {
      throw new SessionStateError({
        code: 'not_connected',
        message: `append${channel[0].toUpperCase()}${channel.slice(1)} requires the session to be live, currently ${this.snapshot.transportState}.`,
      });
    }
    if (!content.trim()) return;
    await this.connection.send({
      type: 'delegation-append',
      channel,
      content,
      ...(options?.delegationId === undefined ? {} : { delegation_id: options.delegationId }),
    });
  }

  /** Send a single image frame to the agent as base64 JSON. Use for
   *  one-shot captures (a photo, a screenshot, a sampled frame); for
   *  continuous streams prefer ``startScreenShare`` / video tracks. */
  async sendImage(args: {
    /** Base64-encoded image bytes (not raw bytes). */
    data: string;
    mimeType?: string;
    streamId?: string;
  }): Promise<void> {
    if (!this.connection || this.snapshot.transportState !== 'ready') {
      throw new SessionStateError({
        code: 'not_connected',
        message: `sendImage requires the session to be live, currently ${this.snapshot.transportState}.`,
    });
    }
    await this.connection.send({
      type: 'send-image',
      data: args.data,
      mime_type: args.mimeType ?? 'image/jpeg',
      stream_id: args.streamId ?? 'video.input.default',
    });
  }

  /** Send a keep-alive ping. Server replies with a ``pong`` event. */
  async sendPing(): Promise<void> {
    if (!this.connection || this.snapshot.transportState !== 'ready') {
      throw new SessionStateError({
        code: 'not_connected',
        message: `sendPing requires the session to be live, currently ${this.snapshot.transportState}.`,
    });
    }
    await this.connection.send({ type: 'ping' });
  }

  /** Signal end-of-turn for manual-VAD turn-taking: the agent stops
   *  waiting for further user audio and responds to what it has. Distinct
   *  from ending the session. */
  async sendActivityEnd(): Promise<void> {
    if (!this.connection || this.snapshot.transportState !== 'ready') {
      throw new SessionStateError({
        code: 'not_connected',
        message: `sendActivityEnd requires the session to be live, currently ${this.snapshot.transportState}.`,
    });
    }
    await this.connection.send({ type: 'activity-end' });
  }

  /** Place an outbound phone call into this live session's room.
   *
   *  The dialed party joins as a SIP participant and the agent — already in
   *  the room — converses with them. Unlike ``sendText`` / ``sendImage`` this
   *  is an authenticated REST call to the Cosmo API. Outbound calling must
   *  be enabled for the workspace and is bounded by its weekly per-user
   *  minute limit, both enforced server-side.
   *
   *  ``phoneNumber`` must be E.164 (``+`` then 8–15 digits), e.g.
   *  ``"+14155550199"``. Resolves once the dial is queued; the call rings
   *  asynchronously — watch session events for the conversation.
   *
   *  Throws ``DialError`` for a malformed number (validated locally,
   *  before any request) or a server rejection (phone calls disabled, over
   *  the minute limit, ended session, …); and ``SessionStateError`` when
   *  no session has started. */
  async dial(phoneNumber: string, callerNumber?: string): Promise<DialResult> {
    const validated = validateE164(phoneNumber);
    const validatedCaller = callerNumber === undefined ? undefined : validateE164(callerNumber);
    const sessionId = this.getSessionId();
    if (sessionId === null) {
      throw new SessionStateError({
        code: 'not_connected',
        message: `dial requires an active session, currently ${this.snapshot.transportState}.`,
    });
    }
    return postDial({
      dialUrl: this.context.dialUrl(sessionId),
      phoneNumber: validated,
      callerNumber: validatedCaller,
      getAuthHeaders: () => this.context.resolveAuthHeaders(),
    });
  }

  /** Fetch a session's usage summary (``GET sessions/{id}/usage``).
   *  An authenticated REST read like ``dial``; the id is passed in because
   *  the caller may outlive this engine's copy of it. */
  async getUsage(sessionId: string): Promise<SessionUsage> {
    return getUsage({
      sessionId,
      usageUrl: this.context.usageUrl(sessionId),
      getAuthHeaders: () => this.context.resolveAuthHeaders(),
    });
  }

  /** Hand the engine a host-owned ``<audio>`` element. Forwarded to the
   *  active transport and re-applied on reconnect so the remote bot audio
   *  always lands on the host's element. Pass ``null`` to detach.
   *  Idempotent. */
  attachAudioElement(el: HTMLAudioElement | null): void {
    this.hostAudioElement = el;
    this.connection?.attachAudioElement(el);
  }

  /** Play the session's remote video — an avatar renderer speaking for the
   *  agent — through ``el``. Pass ``null`` to detach. Idempotent; a session
   *  without a renderer simply never has a track to play. */
  attachVideoElement(el: HTMLVideoElement | null): void {
    this.hostVideoElement = el;
    this.connection?.attachVideoElement?.(el);
  }

  /** Register a transport-level RPC method handler the server invokes via
   *  LiveKit ``perform_rpc`` for client-tool execution. Forwarded to the
   *  active transport; throws if no session is connected.
   *
   *  Why this exists: server dispatch goes through ``perform_rpc`` and
   *  drops any ``tool-reply`` data-channel messages, so the browser must
   *  reply via the RPC return value. */
  registerRpcMethod(
    name: string,
    handler: (payload: string) => Promise<string>,
  ): Unsubscribe {
    if (!this.connection?.registerRpcMethod) {
      throw new SessionStateError({
        code: 'not_connected',
        message: `registerRpcMethod requires a connected transport, currently ${this.snapshot.transportState}.`,
    });
    }
    // Manual RPC wiring predates the typed client-tool runtime and stays
    // payload-only (no caller guard) for compatibility; declared client
    // tools go through ``registerClientToolHandlers`` instead.
    return this.connection.registerRpcMethod(name, (invocation) =>
      handler(invocation.payload),
    );
  }

  /** Replay all remote audio from a user gesture (the StartAudio affordance)
   *  to clear a browser autoplay block. Forwarded to the active transport;
   *  a no-op when no session is connected. */
  async resumeAudioPlayback(): Promise<void> {
    await this.connection?.resumeAudioPlayback?.();
  }

  setOutputBlocked(blocked: boolean): void {
    const current = this.snapshot.mediaState.output;
    if (blocked && current !== 'blocked') {
      this.setMediaState({ ...this.snapshot.mediaState, output: 'blocked' });
    } else if (!blocked && current === 'blocked') {
      this.setMediaState({ ...this.snapshot.mediaState, output: 'silent' });
    }
  }

  async setMicMuted(muted: boolean): Promise<void> {
    if (!this.connection || this.snapshot.transportState !== 'ready') {
      throw new SessionStateError({
        code: 'not_connected',
        message: `setMicMuted requires the session to be live, currently ${this.snapshot.transportState}.`,
    });
    }
    const previous = this.snapshot.mediaState.mic;
    if (muted) {
      this.setMediaState({ ...this.snapshot.mediaState, mic: 'muted' });
    } else if (previous === 'muted') {
      this.setMediaState({ ...this.snapshot.mediaState, mic: 'granted' });
    }
    try {
      await this.connection.setMicMuted(muted);
    } catch (err) {
      // Roll back optimistic state. The caller awaited this and receives
      // the throw; a toggle failure on a live session is request-scoped,
      // not session health, so it does not latch on the error axis.
      this.setMediaState({ ...this.snapshot.mediaState, mic: previous });
      throw err;
    }
  }

  // ─── Screen share ──────────────────────────────────────────────────────

  isScreenSharing(): boolean {
    return this.snapshot.mediaState.screen.kind === 'active';
  }

  getScreenShareState(): ScreenShareState {
    return this.snapshot.mediaState.screen;
  }

  /** The locally captured display stream while a share is active, for the
   *  app to render its own "you are sharing this" preview. ``null`` when
   *  nothing is being shared. The engine owns the stream's lifecycle — do
   *  not stop its tracks; call ``stopScreenShare`` instead. */
  getScreenShareStream(): MediaStream | null {
    return this.screenShareStream;
  }

  async startScreenShare(): Promise<void> {
    if (!this.connection || this.snapshot.transportState !== 'ready') {
      throw new SessionStateError({
        code: 'not_connected',
        message: `startScreenShare requires the session to be live, currently ${this.snapshot.transportState}.`,
    });
    }
    const current = this.snapshot.mediaState.screen;
    if (current.kind === 'active' || current.kind === 'requesting') {
      log.info('[realtime] screen share already in progress', current.kind);
      return;
    }
    if (this.connection.addVideoStream === undefined) {
      const refusal = videoUnsupported();
      this.setScreenShareState({
        kind: 'error',
        error: { code: 'screen_start_failed', message: refusal.message },
      });
      throw refusal;
    }
    if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getDisplayMedia) {
      const code = 'screen_start_failed';
      const message = 'Screen capture is not supported in this environment.';
      this.setScreenShareState({ kind: 'error', error: { code, message } });
      throw new Error(message);
    }
    this.setScreenShareState({ kind: 'requesting' });
    log.info('[realtime] requesting screen-share permission…');
    let displayStream: MediaStream;
    try {
      displayStream = await navigator.mediaDevices.getDisplayMedia({ video: true });
    } catch (err) {
      log.error('[realtime] screen-share permission failed', err);
      const message = err instanceof Error ? err.message : 'Screen share was not granted.';
      const denied = isScreenPermissionDenied(err);
      const code = denied ? 'screen_denied' : 'screen_start_failed';
      this.setScreenShareState({ kind: 'error', error: { code, message } });
      throw err;
    }
    const videoTrack = displayStream.getVideoTracks()[0] ?? null;
    if (!videoTrack) {
      for (const t of displayStream.getTracks()) t.stop();
      const code = 'screen_start_failed';
      const message = 'Screen capture stream contained no video track.';
      this.setScreenShareState({ kind: 'error', error: { code, message } });
      throw new Error(message);
    }
    let handle: VideoStreamHandle;
    try {
      handle = await this.addVideoStream(displayStream, { kind: 'screen' });
    } catch (err) {
      for (const t of displayStream.getTracks()) t.stop();
      log.error('[realtime] screen-share publish failed', err);
      const message = err instanceof Error ? err.message : 'Failed to publish screen share.';
      const code = 'screen_start_failed';
      this.setScreenShareState({ kind: 'error', error: { code, message } });
      throw err;
    }
    this.screenShareHandle = handle;
    this.screenShareTrack = videoTrack;
    this.screenShareStream = displayStream;
    const onEnded = (): void => {
      log.info('[realtime] screen-share track ended');
      void this.stopScreenShare();
    };
    videoTrack.addEventListener('ended', onEnded);
    this.screenShareEndedListener = onEnded;
    log.info('[realtime] screen-share active — video track published');
    this.setScreenShareState({ kind: 'active', startedAt: Date.now() });
  }

  async stopScreenShare(): Promise<void> {
    const current = this.snapshot.mediaState.screen;
    if (current.kind === 'inactive') {
      this.disposeScreenShareResources();
      return;
    }
    const handle = this.screenShareHandle;
    if (handle) {
      try {
        await this.removeVideoStream(handle);
      } catch (err) {
        log.error('[realtime] stopScreenShare unpublish failed', err);
      }
    }
    this.disposeScreenShareResources();
    this.setScreenShareState({ kind: 'inactive' });
  }

  /** Snapshot whether fresh frames are flowing into the model's vision
   *  input. Looks across every published video track this engine owns
   *  (screen-share AND camera) and picks the most informative answer the
   *  model can act on. Returned shape mirrors the wire output of the
   *  desktop adapter's ``get_current_screen`` tool so the dispatcher can
   *  pass it straight through to the model. */
  getVisionInputStatus(): { captured: boolean; message: string } {
    return computeVisionInputStatus(
      Array.from(this.visionSources.values()),
      this.screenShareTrack,
    );
  }

  private disposeScreenShareResources(): void {
    const track = this.screenShareTrack;
    const listener = this.screenShareEndedListener;
    if (track && listener) {
      try { track.removeEventListener('ended', listener); } catch { /* ignore */ }
    }
    if (track) {
      try { track.stop(); } catch { /* ignore */ }
    }
    for (const t of this.screenShareStream?.getTracks() ?? []) {
      try { t.stop(); } catch { /* ignore */ }
    }
    this.screenShareStream = null;
    this.screenShareTrack = null;
    this.screenShareEndedListener = null;
    this.screenShareHandle = null;
  }

  // ─── Video streams ────────────────────────────────────────────────────

  async addVideoStream(
    stream: MediaStream,
    options?: VideoStreamOptions,
  ): Promise<VideoStreamHandle> {
    const conn = this.connection;
    // Consistent with sendText / startScreenShare / setMicMuted —
    // publishing tracks before ``ready`` can race the LiveKit room
    // join and silently drop the publish. Throwing keeps the failure
    // visible.
    if (!conn || this.snapshot.transportState !== 'ready') {
      throw new SessionStateError({
        code: 'not_connected',
        message: `addVideoStream requires the session to be live, currently ${this.snapshot.transportState}.`,
    });
    }
    if (!conn.addVideoStream) {
      throw videoUnsupported();
    }
    const handle = await conn.addVideoStream(stream, options);
    const track = stream.getVideoTracks()[0] ?? null;
    if (track) {
      const kind: VideoStreamKind = options?.kind ?? 'camera';
      const endedListener = (): void => {
        this.visionSources.delete(handle);
      };
      track.addEventListener('ended', endedListener);
      this.visionSources.set(handle, { kind, track, endedListener });
    }
    return handle;
  }

  async removeVideoStream(streamId: VideoStreamHandle): Promise<void> {
    const source = this.visionSources.get(streamId);
    if (source) {
      try {
        source.track.removeEventListener('ended', source.endedListener);
      } catch {
        /* ignore */
      }
      this.visionSources.delete(streamId);
    }
    const conn = this.connection;
    if (!conn?.removeVideoStream) return;
    await conn.removeVideoStream(streamId);
  }

  // ─── Audio streams ────────────────────────────────────────────────────

  async startAudioStream(stream: MediaStream): Promise<void> {
    const conn = this.connection;
    if (!conn || this.snapshot.transportState !== 'ready') {
      throw new SessionStateError({
        code: 'not_connected',
        message: `startAudioStream requires the session to be live, currently ${this.snapshot.transportState}.`,
    });
    }
    if (!conn.startAudioStream) {
      throw new Error('Active transport does not support audio streams.');
    }
    await conn.startAudioStream(stream);
  }

  async stopAudioStream(): Promise<void> {
    const conn = this.connection;
    if (!conn?.stopAudioStream) return;
    await conn.stopAudioStream();
  }

  // ─── Internals: state mutation ─────────────────────────────────────────

  /** The one intake for the error axis: latch the error object itself and
   *  emit it. Call sites own any transport-state transition — a non-fatal
   *  server error frame arrives on a healthy transport. */
  private reportError(error: BubbledError): void {
    if (this.snapshot.error === error) return;
    this.snapshot = { ...this.snapshot, error };
    this.emitter.emit('error', error);
  }

  /** Clear the axis back to healthy, so subscribers drop a stale banner. */
  private clearError(): void {
    if (this.snapshot.error === null) return;
    this.snapshot = { ...this.snapshot, error: null };
    this.emitter.emit('error', null);
  }

  private setLifecycle(next: SessionState): void {
    if (this.lifecycle.kind === next.kind && next.kind !== 'disconnected') return;
    const previous = this.lifecycle.kind;
    this.lifecycle = next;
    log.info('[realtime] session state changed', {
      previous,
      kind: next.kind,
      disconnectReason: next.disconnectReason ?? null,
      detail: next.detail ?? null,
      sessionId: this.getSessionId(),
    });
    // Close any still-open bubble before the terminal notifications, so a
    // ``session_ended`` handler reading ``transcript`` sees finals only.
    const transcriptChanged =
      next.kind === 'disconnected' ? this.transcriptStore.closeOpen() : false;
    // The fold goes out before the ending does. A subscriber told the
    // session ended tears its subscriptions down, so an update emitted after
    // that lands on nothing — and Python settles the transcript first for the
    // same reason: a consumer draining to the end sees finals only.
    if (transcriptChanged) this.emitTranscriptUpdated();
    this.emitter.emit('lifecycle', next);
    if (next.kind === 'disconnected' && !this.sessionEndedEmitted) {
      this.sessionEndedEmitted = true;
      this.emitter.emit('session_ended', {
        reason: next.detail ?? next.disconnectReason ?? 'unknown',
      });
    }
  }

  private emitWireMessage(message: RealtimeInboundMessage): void {
    for (const cb of this.wireMessageListeners) {
      try {
        cb(message);
      } catch (err) {
        log.error('[realtime] wire-message subscriber threw', err);
      }
    }
  }

  private setTransportState(next: TransportState): void {
    if (this.snapshot.transportState === next) return;
    this.snapshot = { ...this.snapshot, transportState: next };
    this.emitter.emit('transport_state', next);
  }

  private setAgentState(next: AgentState): void {
    if (this.snapshot.agentState === next) return;
    this.snapshot = { ...this.snapshot, agentState: next };
    this.emitter.emit('agent_state', next);
  }

  private setMediaState(next: MediaState): void {
    this.snapshot = { ...this.snapshot, mediaState: next };
    this.emitter.emit('media_state', next);
  }

  private setScreenShareState(next: ScreenShareState): void {
    this.setMediaState({ ...this.snapshot.mediaState, screen: next });
  }

  private resetSnapshot(): void {
    const hadError = this.snapshot.error !== null;
    this.snapshot = { ...INITIAL_SNAPSHOT };
    this.serverEndReason = null;
    this.lastReadyEvent = null;
    this.pendingHandshakeError = null;
    this.emitter.emit('transport_state', this.snapshot.transportState);
    this.emitter.emit('agent_state', this.snapshot.agentState);
    this.emitter.emit('media_state', this.snapshot.mediaState);
    // Snapshot reset clears any prior error; subscribers (provider,
    // useRealtimeError) need the explicit null emit to drop a stale
    // banner — they don't poll snapshot.error.
    if (hadError) this.emitter.emit('error', null);
  }

  // ─── Internals: transcript / message handling ──────────────────────────

  private emitTranscript(args: {
    role: 'user' | 'assistant';
    text: string;
    isFinal: boolean;
  }): void {
    const event: TranscriptDeltaEvent = {
      role: args.role,
      text: args.text,
      isFinal: args.isFinal,
    };
    // Fold into the session-owned transcript before either notification
    // goes out, so a handler reading ``transcript`` always sees this
    // delta applied.
    const changed = this.transcriptStore.applyDelta(args.role, args.text, args.isFinal);
    this.emitter.emit('transcript', event);
    if (changed) this.emitTranscriptUpdated();
  }

  private emitTranscriptUpdated(): void {
    this.emitter.emit('transcript_updated', { items: this.transcriptStore.current });
  }

  /** Resolve the ``ready`` mark against the connect origin, then report the
   *  waterfall. Runs from both sides of the race: ``ready`` can arrive over
   *  the data channel before ``connect()`` resolves, so the mark is taken raw
   *  and folded once both exist. */
  private foldConnectMarks(): void {
    const timings = this.connectTimings;
    const startedAt = this.connectStartedAt;
    if (timings === null || startedAt === null) return;
    this.connectTimings = {
      ...timings,
      readyMs: this.readyAt === null ? (timings.readyMs ?? null) : this.readyAt - startedAt,
    };
    this.reportConnectTimings();
  }

  /** Hand the client's half of the connect waterfall to the worker, which
   *  can't see the start request, the room join or the mic permission.
   *  Released at ``ready`` — readiness is room state now, so every session
   *  that comes up observes it.
   *  Fire-and-forget diagnostics: a failure never reaches the session. */
  private reportConnectTimings(): void {
    const timings = this.connectTimings;
    if (this.connectTimingsReported || timings === null) return;
    if (this.readyAt === null) return;
    this.connectTimingsReported = true;
    const readyMs = timings.readyMs ?? null;
    const frame: ClientConnectTimings = {
      type: 'connect-timings',
      request_ms: Math.round(timings.wsMs),
      room_ms: Math.round(timings.roomMs),
      mic_ms: Math.round(timings.micMs),
      ...(readyMs === null ? {} : { ready_ms: Math.round(readyMs) }),
      ...(timings.serverTimings === null ? {} : { server: timings.serverTimings }),
    };
    this.connection?.send(frame).catch((err: unknown) => {
      log.warn('[realtime] connect-timings send failed', err);
    });
  }

  private handleServerMessage(message: RealtimeInboundMessage): void {
    // An undecodable packet drives no client state — it reaches the session
    // stream as an ``unknown`` item and nothing else.
    if (message.type === null) return;
    switch (message.type) {
      case 'ready': {
        const ready = message;
        if (this.readyAt === null) {
          this.readyAt = performance.now();
          this.foldConnectMarks();
        }
        this.clearError();
        this.setTransportState('ready');
        this.setAgentState('listening');
        const rejectedTools = ready.rejected_tools ?? [];
        for (const rejected of rejectedTools) {
          log.warn(
            `[realtime] server rejected tool spec "${rejected.name}": ${rejected.reason}`,
          );
        }
        this.lastReadyEvent = decode.readyEvent(ready);
        this.emitter.emit('ready', this.lastReadyEvent);
        this.settleReadyWaiters(null);
        return;
      }
      case 'transcript': {
        const role = normalizeTranscriptRole(message.role);
        if (role === null) {
          log.warn(`[realtime] dropping transcript with unknown role: ${message.role}`);
          return;
        }
        this.emitTranscript({
          role,
          text: message.text,
          isFinal: message.is_final,
        });
        return;
      }
      case 'model-text': {
        // Distinct from ``transcript``: model-text carries the model's
        // text-channel output (``model_turn.parts[].text`` on Gemini),
        // not transcribed audio. Consumers that render a transcript
        // bubble should subscribe to ``transcript`` only. SDK ships
        // this verbatim so debug surfaces / TEXT-mode callers can use it.
        this.emitter.emit('model_text', decode.modelTextEvent(message));
        return;
      }
      case 'turn-complete': {
        const role = normalizeTranscriptRole(message.role);
        if (role === null) {
          log.warn(`[realtime] dropping turn-complete with unknown role: ${message.role}`);
          return;
        }
        const closedDangling = this.transcriptStore.applyTurnComplete(role);
        this.emitter.emit('turn_complete', { role });
        if (closedDangling) this.emitTranscriptUpdated();
        this.setAgentState('listening');
        return;
      }
      case 'tool-call':
        this.emitter.emit('tool_call', decode.toolCallEvent(message));
        return;
      case 'tool-dispatch-started':
        this.emitter.emit(
          'tool_dispatch_started',
          decode.toolDispatchStartedEvent(message),
        );
        return;
      case 'tool-result':
        this.emitter.emit('tool_result', decode.toolResultEvent(message));
        return;
      case 'cosmo.session-state':
        this.emitter.emit('session_state', decode.sessionStateWriteEvent(message));
        return;
      case 'user-started-speaking':
        this.setAgentState('listening');
        return;
      case 'user-stopped-speaking':
        this.setAgentState('thinking');
        return;
      case 'bot-llm-started':
        this.setAgentState('thinking');
        return;
      case 'bot-started-speaking':
        this.setAgentState('speaking');
        // Preserve 'blocked' if the user hasn't unblocked autoplay yet —
        // otherwise StartAudio's gate vanishes while audio is still
        // silently being suppressed by the browser.
        if (this.snapshot.mediaState.output !== 'blocked') {
          this.setMediaState({ ...this.snapshot.mediaState, output: 'playing' });
        }
        return;
      case 'bot-stopped-speaking':
        this.setAgentState('listening');
        if (this.snapshot.mediaState.output !== 'blocked') {
          this.setMediaState({ ...this.snapshot.mediaState, output: 'silent' });
        }
        return;
      case 'bot-llm-stopped':
        if (this.snapshot.agentState === 'thinking') this.setAgentState('listening');
        return;
      case 'bot-tts-started':
      case 'bot-tts-stopped':
        return;
      // ``tool-invocation`` mirrors client-tool dispatch, which rides the
      // LiveKit RPC bridge (``registerRpcMethod``) instead, so there is no
      // client behavior to run here.
      case 'tool-invocation':
        return;
      case 'cosmo.usage':
        this.emitter.emit('usage', decode.usageEvent(message));
        return;
      case 'user-speech-timeout': {
        this.emitter.emit('user_speech_timeout', decode.userSpeechTimeoutEvent(message));
        return;
      }
      case 'delegation-created': {
        this.emitter.emit(
          'delegation_created',
          this.resolveDelegation(decode.delegationCreatedEvent(message)),
        );
        return;
      }
      case 'pong':
        this.emitter.emit('pong', decode.pongEvent(message));
        return;
      case 'reconnecting':
        this.emitter.emit('reconnecting', decode.reconnectingEvent(message));
        return;
      case 'session-ending-soon':
        this.emitter.emit(
          'session_ending_soon',
          decode.sessionEndingSoonEvent(message),
        );
        return;
      case 'session-ended':
        // The server ends the session on purpose (e.g. max-duration cap).
        // Latch the reason so the transport close that follows renders as
        // a clean end instead of a transport failure; the ``session_ended``
        // event fires from the terminal lifecycle transition.
        this.serverEndReason = message.reason;
        this.armServerEndGrace();
        return;
      case 'error': {
        // The wire omits ``fatal`` for a non-fatal error; the published
        // event states it, the way every other event here reads its
        // optional wire fields as settled values.
        this.reportError(decode.errorEvent(message));
        // Before ready, an error frame is enrichment for the room close a
        // failed boot sends next — stashed so that close rejects with the
        // server's own code and message. The frame itself settles nothing:
        // the structural close is the authoritative failure signal.
        if (this.snapshot.transportState !== 'ready') {
          this.pendingHandshakeError = {
            code: message.code,
            message: message.message,
          };
        }
        return;
      }
    }
  }

  /** Pending ``waitUntilReady()`` resolvers, drained on ``ready``
   *  or rejected from disconnect()/teardown(). */
  private readyWaiters: Array<{
    resolve: () => void;
    reject: (err: unknown) => void;
  }> = [];

  /** Resolve when the current session reaches ``transportState === 'ready'``.
   *  Resolves immediately if already ready, rejects if the session ends
   *  (or disconnects) before becoming ready. ``agent.start()`` already
   *  resolves at ready, so after a resolved start this is instant; it
   *  exists for code holding a session reference from before the start
   *  settled (the ``onSession`` callback). */
  waitUntilReady(): Promise<void> {
    if (this.snapshot.transportState === 'ready') return Promise.resolve();
    if (this.connection === null) {
      return Promise.reject(
        new SessionStateError({
          code: 'not_connected',
          message: 'waitUntilReady called with no active connection.',
        }),
      );
    }
    return new Promise<void>((resolve, reject) => {
      this.readyWaiters.push({ resolve, reject });
    });
  }

  /** Settle every pending ``waitUntilReady`` waiter. ``reason`` is null
   *  when ready arrived; otherwise the waiters reject with the
   *  supplied error (disconnect, teardown, fatal transport error). */
  private settleReadyWaiters(reason: Error | null): void {
    const pending = this.readyWaiters;
    this.readyWaiters = [];
    if (reason === null) {
      for (const { resolve } of pending) resolve();
    } else {
      for (const { reject } of pending) reject(reason);
    }
  }

  // ─── Internals: close / reconnect / analysers / teardown ───────────────

  /** ``session-ended`` is normally followed by the transport closing; if
   *  that close never arrives, finish after this grace so consumers are not
   *  left on a live-looking session forever. */
  private armServerEndGrace(): void {
    if (this.connection === null) return;
    if (this.serverEndGraceTimer !== null) return;
    this.serverEndGraceTimer = setTimeout(() => {
      this.serverEndGraceTimer = null;
      if (this.connection === null || this.serverEndReason === null) return;
      log.warn('[realtime] session-ended without a transport close — forcing teardown');
      void this.handleUnsolicitedClose();
    }, SERVER_END_GRACE_MS);
  }

  // Async so SessionEnd hooks complete before the terminal lifecycle publish and
  // teardown (Python awaits ``_fire_session_end`` before clearing session state);
  // transports invoke it fire-and-forget off their close callbacks.
  private async handleUnsolicitedClose(event?: RealtimeCloseInfo): Promise<void> {
    // A close before ``ready`` fails the handshake: settle the pending
    // ready waiters (``start()``, ``waitUntilReady()``) with the typed
    // start-taxonomy error before the teardown below drains them. A
    // stashed pre-ready error frame supplies the detail — the close is the
    // authoritative signal, the frame its enrichment.
    if (this.snapshot.transportState !== 'ready') {
      const stashed = this.pendingHandshakeError;
      const detail = this.serverEndReason ?? normalizeCloseReason(event?.reason);
      const failure =
        stashed !== null
          ? handshakeFailed(stashed.code, stashed.message)
          : handshakeFailed(
              undefined,
              `The session ended before ready: ${detail}`,
            );
      this.settleReadyWaiters(failure);
      // One terminal reason for one ending: a close before ``ready`` is the
      // window's handshake failure on every surface — the rejection
      // ``start()`` raises, the state ``onStateChange`` reports, the stream's
      // terminal item, and the SessionEnd hook. Falling through to the
      // server-ended / transport-error branches below would report a
      // different reason than the caller was just handed.
      await this.fireSessionEnd('handshake_failed', failure.message);
      this.reportError(failure);
      this.setTransportState('failed');
      this.setLifecycle({
        kind: 'disconnected',
        disconnectReason: 'handshake_failed',
        detail: failure.message,
      });
      await this.teardown();
      return;
    }
    // A close preceded by ``session-ended`` is the server hanging up on
    // purpose — tear down cleanly, no error banner.
    if (this.serverEndReason !== null) {
      await this.endServerSide('server ended the session', this.serverEndReason);
      return;
    }
    // A deliberate server-side close (room deleted when a transfer's call
    // ends, room closed, this participant removed) arrives as a bare
    // LiveKit disconnect with no session-ended frame — same clean
    // teardown, no error. Mirrors the backend webhook's normal-disconnect
    // set.
    if (event?.reason && /ROOM_DELETED|ROOM_CLOSED|PARTICIPANT_REMOVED/.test(event.reason)) {
      await this.endServerSide('server ended the call', normalizeCloseReason(event.reason));
      return;
    }
    // A transport that can tell a deliberate remote close from a failure
    // says so itself; the close code is transport-defined and means
    // nothing here on its own.
    if (event?.serverEnded === true) {
      await this.endServerSide('server closed the socket', normalizeCloseReason(event.reason));
      return;
    }
    // LiveKit handles transient transport recovery on its own (ICE
    // restart, signal reconnect) — this handler is only called when
    // LiveKit has fully given up. We don't auto-retry at the session
    // layer; callers can start a new session (``agent.start()``) from
    // their transport_state / session_ended handlers if they want to
    // re-mint one.
    log.error('[voice] transport closed unexpectedly', event);
    const closeReason = normalizeCloseReason(event?.reason);
    const detail = event?.code !== undefined
      ? `${closeReason} (close code ${event.code})`
      : closeReason;
    // The lifecycle axis carries this ending — ``disconnected`` with
    // ``transport_error`` and the close detail. It is not latched on the
    // error axis, which holds typed errors and wire error frames only.
    await this.fireSessionEnd('transport_error', detail);
    this.setTransportState('failed');
    this.setLifecycle({
      kind: 'disconnected',
      disconnectReason: 'transport_error',
      detail,
    });
    await this.teardown();
  }

  private async endServerSide(logMessage: string, detail: string): Promise<void> {
    log.info(`[voice] ${logMessage}`, { reason: detail, sessionId: this.getSessionId() });
    await this.fireSessionEnd('server_ended', detail);
    this.setLifecycle({
      kind: 'disconnected',
      disconnectReason: 'server_ended',
      detail,
    });
    await this.teardown();
  }

  private setInputAnalyser(next: AnalyserNode | null): void {
    this.inputAnalyser = next;
    for (const cb of this.inputAnalyserListeners) cb(next);
  }

  private setOutputAnalyser(next: AnalyserNode | null): void {
    this.outputAnalyser = next;
    for (const cb of this.outputAnalyserListeners) cb(next);
  }

  private attachAnalysers(local: RealtimeTransport): void {
    try {
      const ctx = this.analyserContext ?? new AudioContext();
      this.analyserContext = ctx;
      const input = local.getInputStream();
      if (input) {
        const src = ctx.createMediaStreamSource(input);
        const an = ctx.createAnalyser();
        an.fftSize = 256;
        src.connect(an);
        this.inputAnalyserSource = src;
        this.setInputAnalyser(an);
      }
    } catch (err) {
      log.warn('[voice] analyser setup failed (non-fatal)', err);
    }
    this.refreshOutputAnalyser();
  }

  /** Point the output analyser at the transport's current remote audio.
   *
   * Runs at connect and again whenever the stream changes, because the
   * remote track is subscribed after the connect resolves and can be
   * replaced mid-session. A no-op when the stream has not moved. */
  private refreshOutputAnalyser(): void {
    const local = this.connection;
    if (local === null) return;
    const stream = local.getOutputStream?.() ?? null;
    if (stream === this.outputAnalyserStream) return;
    try {
      if (this.outputAnalyserSource) {
        this.outputAnalyserSource.disconnect();
        this.outputAnalyserSource = null;
      }
      this.outputAnalyserStream = stream;
      if (stream === null) {
        this.setOutputAnalyser(null);
      } else {
        const ctx = this.analyserContext ?? new AudioContext();
        this.analyserContext = ctx;
        const src = ctx.createMediaStreamSource(stream);
        const an = ctx.createAnalyser();
        an.fftSize = 256;
        // No ``connect(destination)``: the element plays this track itself
        // and the source only feeds the analyser. Routing it to the speakers
        // as well would double the agent's voice.
        src.connect(an);
        this.outputAnalyserSource = src;
        this.setOutputAnalyser(an);
      }
    } catch (err) {
      log.warn('[voice] output analyser setup failed (non-fatal)', err);
    }
    if (this.emitter.listenerCount('volume') > 0) {
      this.stopVolumeLoop();
      this.startVolumeLoop();
    }
  }

  private startVolumeLoop(): void {
    if (this.volumeRafHandle !== null) return;
    if (typeof requestAnimationFrame === 'undefined') return;
    const tick = () => {
      const mic = this.readAnalyserRms(this.inputAnalyser);
      const output = this.readAnalyserRms(this.outputAnalyser);
      if (mic !== this.lastEmittedMic || output !== this.lastEmittedOutput) {
        this.emitter.emit('volume', { mic, output });
        this.lastEmittedMic = mic;
        this.lastEmittedOutput = output;
      }
      this.volumeRafHandle = requestAnimationFrame(tick);
    };
    this.volumeRafHandle = requestAnimationFrame(tick);
  }

  private stopVolumeLoop(): void {
    if (this.volumeRafHandle === null) return;
    if (typeof cancelAnimationFrame !== 'undefined') {
      cancelAnimationFrame(this.volumeRafHandle);
    }
    this.volumeRafHandle = null;
    this.emitter.emit('volume', { mic: 0, output: 0 });
  }

  private readAnalyserRms(analyser: AnalyserNode | null): number {
    if (analyser === null) return 0;
    const len = analyser.fftSize;
    if (this.volumeBuffer === null || this.volumeBuffer.length !== len) {
      this.volumeBuffer = new Float32Array(new ArrayBuffer(len * 4));
    }
    const buf = this.volumeBuffer;
    analyser.getFloatTimeDomainData(buf);
    let sum = 0;
    for (let i = 0; i < buf.length; i++) {
      const v = buf[i] ?? 0;
      sum += v * v;
    }
    return Math.sqrt(sum / buf.length);
  }

  private async teardown(options?: { sendEndFrame?: boolean }): Promise<void> {
    const local = this.connection;
    const wasSharing = this.snapshot.mediaState.screen.kind === 'active';
    this.connection = null;
    if (this.serverEndGraceTimer !== null) {
      clearTimeout(this.serverEndGraceTimer);
      this.serverEndGraceTimer = null;
    }
    // In-flight background client-tool jobs have nowhere to land once the
    // session is torn down — drop their terminal deliveries.
    this.unbindClientTools?.();
    this.unbindClientTools = null;
    this.unbindScreenCapture?.();
    this.unbindScreenCapture = null;
    this.jobSink?.close();
    this.jobSink = null;
    this.activeHooks = null;
    // Drop the start response with the connection so a torn-down session's
    // id can't outlive it and leak into a later ``dial()``.
    this.earlySessionId = null;
    this.connectTimings = null;
    this.settleReadyWaiters(
      new SessionStateError({
        code: 'not_connected',
        message: 'Realtime session ended before reaching ready.',
      }),
    );
    // Screen-share state resets in this synchronous prologue — the client's
    // detach runs one microtask after the terminal lifecycle, so an emission
    // deferred past teardown's first await would never reach it.
    if (wasSharing) {
      this.disposeScreenShareResources();
      this.setScreenShareState({ kind: 'inactive' });
    }
    this.stopVolumeLoop();
    this.volumeBuffer = null;
    this.setInputAnalyser(null);
    this.setOutputAnalyser(null);
    if (this.inputAnalyserSource) {
      try { this.inputAnalyserSource.disconnect(); } catch { /* ignore */ }
      this.inputAnalyserSource = null;
    }
    if (this.outputAnalyserSource) {
      try { this.outputAnalyserSource.disconnect(); } catch { /* ignore */ }
      this.outputAnalyserSource = null;
    }
    this.outputAnalyserStream = null;
    // Both taps are stream sources on this engine's own context, and neither
    // owns anything a later session needs, so closing it is safe.
    if (this.analyserContext) {
      try {
        await this.analyserContext.close();
      } catch {
        // best-effort
      }
      this.analyserContext = null;
    }
    if (local) await local.disconnect(options);
  }
}
