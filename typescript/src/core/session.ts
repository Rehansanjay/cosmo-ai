/**
 * ``RealtimeSession`` — one live run of an agent.
 *
 * Created by ``RealtimeAgent.start()``; owns its ``SessionEngine``
 * (transport, lifecycle, snapshot, media state), so N sessions on one
 * client are fully independent — separate streams, separate state.
 *
 * Events are consumable two ways, matching the cross-SDK pattern:
 *
 * - callbacks: ``session.on('transcript', …)`` — the same typed event map
 *   the engine emits (UI-normalized payloads);
 * - async iteration: ``for await (const event of session)`` — the wire-level
 *   event stream (Python's ``async for event in session`` is the reference;
 *   ``tests/test_session_stream.py`` is the spec). Unknown event types
 *   surface as ``{type: 'unknown'}`` items and never terminate the stream;
 *   a ``session-ended`` item is always the final one.
 *
 * The connection lifecycle is a formal state machine
 * (``idle → connecting → connected ↔ reconnecting → disconnected``) with
 * typed end reasons — see ``SessionState`` in ``./state``.
 */

import { log } from './logger';
import {
  decodeStreamEvent,
  type DecodedStreamEvent,
  type StreamEvent,
  type WireServerMessage,
} from './wire_decode';
import { SessionStateError } from './errors';
import type { DialResult } from '../transport/dial';
import { UsageError, type SessionUsage } from './usage';
import type {
  RealtimeInboundMessage,
  RealtimeServerMessage,
} from '../transport/envelope';
import type {
  VideoStreamHandle,
  VideoStreamOptions,
} from '../transport/types';

import type { SessionEngine } from './session_engine';
import type {
  BotLlmStartedEvent,
  BotLlmStoppedEvent,
  BotStartedSpeakingEvent,
  BotStoppedSpeakingEvent,
  BotTtsStartedEvent,
  BotTtsStoppedEvent,
  ModelTextEvent,
  PongEvent,
  ReadyEvent,
  RealtimeEventMap,
  RealtimeEventName,
  ReconnectingEvent,
  SessionEndingSoonEvent,
  SessionStateWriteEvent,
  ToolCallEvent,
  ToolDispatchStartedEvent,
  ToolInvocationEvent,
  ToolResultEvent,
  TranscriptDeltaEvent,
  TranscriptItem,
  TranscriptUpdatedEvent,
  TurnCompleteEvent,
  Unsubscribe,
  UsageEvent,
  UserSpeechTimeoutEvent,
  UserStartedSpeakingEvent,
  UserStoppedSpeakingEvent,
} from './events';
import type { ErrorEvent } from './types';
import type {
  DisconnectReason,
  RealtimeSnapshot,
  SessionConnectTimings,
  SessionState,
} from './state';
import type { ScreenShareState } from './types';


/** Forward-compat stream item for a frame the SDK does not recognize.
 *  ``rawType`` is the wire ``type`` string, or ``null`` when the frame was
 *  not decodable at all — ``rawText`` then carries it verbatim and
 *  ``payload`` is null. Never terminal. Mirrors Python's ``UnknownEvent``. */
export type UnknownEvent = {
  /** Always ``'unknown'`` — the discriminator that separates this from a
   *  recognized wire frame. */
  type: 'unknown';
  /** The wire ``type`` this SDK does not handle. ``null`` when the frame
   *  carried no string ``type`` to read. */
  rawType: string | null;
  /** The decoded frame, when it parsed as a JSON object. */
  payload: Record<string, unknown> | null;
  /** The frame verbatim, when the bytes decoded as text. */
  rawText?: string;
};

/** SDK-local terminal stream item — not a wire frame. Always the final
 *  item the iterator yields for a session that connected; ``reason`` is
 *  the server's end slug when it hung up on purpose, else a default for
 *  the typed disconnect reason. */
export type SessionEndedEventItem = {
  /** Always ``'session_ended'`` — the terminal item's discriminator. */
  type: 'session_ended';
  /** Why the session ended. A server teardown carries its stable slug; an
   *  ending the SDK synthesizes carries a short description of the
   *  disconnect. ``null`` when neither was available. */
  reason: string | null;
};

/** Items yielded by ``for await (const event of session)``: the session's
 *  own event types — the same values ``on()`` delivers — plus ``unknown``
 *  for unrecognized types and the SDK-local terminal ``session-ended``.
 *  Switch on ``type``. The wire ``session-ended`` frame itself is folded
 *  into the terminal item so "session-ended is always final" holds even
 *  when the server's notice races later frames. */
export type RealtimeSessionEvent =
  | DecodedStreamEvent
  | StreamEvent<TranscriptUpdatedEvent, 'transcript_updated'>
  | SessionEndedEventItem
  | UnknownEvent;

/** Wire ``type`` strings the stream passes through verbatim. Anything
 *  else becomes an ``unknown`` item (never terminal). */
const KNOWN_STREAM_TYPES: ReadonlySet<string> = new Set([
  'ready',
  'transcript',
  'model-text',
  'turn-complete',
  'user-started-speaking',
  'user-stopped-speaking',
  'user-speech-timeout',
  'delegation-created',
  'bot-started-speaking',
  'bot-stopped-speaking',
  'bot-llm-started',
  'bot-llm-stopped',
  'bot-tts-started',
  'bot-tts-stopped',
  'tool-call',
  'tool-dispatch-started',
  'tool-result',
  'tool-invocation',
  'cosmo.usage',
  'cosmo.session-state',
  'reconnecting',
  'session-ending-soon',
  'error',
  'pong',
]);

/** Queue bound, mirroring Python's ``_MAX_QUEUED_EVENTS``: a consumer that
 *  stops pulling drops overflow events (logged) instead of growing without
 *  bound; terminal items evict a buffered event rather than being lost. */
const MAX_QUEUED_EVENTS = 1024;

const DEFAULT_ENDED_REASON: Record<DisconnectReason, string> = {
  client_ended: 'client ended',
  client_closed: 'client closed',
  handshake_failed: 'handshake failed',
  server_ended: 'server ended',
  transport_error: 'transport error',
};

/** @internal — see ``RealtimeSession._internal`` for usage notes. */
export type RealtimeSessionInternal = {
  getInputAnalyser: () => AnalyserNode | null;
  getOutputAnalyser: () => AnalyserNode | null;
  subscribeInputAnalyser: (cb: (a: AnalyserNode | null) => void) => Unsubscribe;
  subscribeOutputAnalyser: (cb: (a: AnalyserNode | null) => void) => Unsubscribe;
};

/**
 * One live run of an agent — the whole per-session surface.
 *
 * ```ts
 * const session = await agent.start();
 * session.on('transcript_updated', ({ items }) => render(items));
 * await session.end();
 * ```
 *
 * Returned by ``RealtimeAgent.start()``, never constructed directly. Owns
 * its own transport and state, so sessions from one client are fully
 * independent.
 *
 * Read what happened two ways: ``on(name, handler)`` for the normalized,
 * UI-shaped events in ``RealtimeEventMap``, or ``for await (const event of
 * session)`` for the wire-level stream, whose final item is always
 * ``session-ended``. The current transcript and lifecycle state are also
 * readable directly, at any time, from ``transcript`` and ``state``.
 *
 * ``start()`` resolves at ``ready``, so a session you have been handed is
 * already usable and the first send needs no wait. ``waitUntilReady()``
 * remains for a session obtained another way. Ending is ``end()``
 * (graceful) or ``close()`` (abrupt); both are idempotent, and ``usage()``
 * still works afterwards.
 */
export class RealtimeSession implements AsyncIterable<RealtimeSessionEvent> {
  private readonly engine: SessionEngine;
  private readonly queue: RealtimeSessionEvent[] = [];
  private readonly pendingTranscriptUpdates: TranscriptUpdatedEvent[] = [];
  private pendingPull:
    | { resolve: (r: IteratorResult<RealtimeSessionEvent>) => void }
    | null = null;
  private streamEnded = false;
  private terminalQueued = false;
  private droppedEvents = 0;
  /** Latched final lifecycle state. The engine's own machine settles back
   *  to ``idle`` after teardown, but THIS session stays ``disconnected``
   *  forever once it ends. */
  private terminalState: SessionState | null = null;
  /** Backend id of THIS run, bound once — to the first ``session_started``
   *  after construction, which is this session's own start. The engine
   *  drops its copy at teardown, so it is not a source that outlives the
   *  run; binding once is what lets ``usage()`` work after the session
   *  ends. */
  private ownSessionId: string | null = null;
  private readonly unsubscribers: Unsubscribe[] = [];

  /** @internal — construct via ``RealtimeAgent.start()``. ``stateUnsub``
   *  is the caller's ``onStateChange`` subscription; the session owns it so
   *  the callback stops at this run's terminal state instead of observing
   *  the engine settle back to ``idle`` after teardown. */
  constructor(engine: SessionEngine, stateUnsub: Unsubscribe | null = null) {
    this.engine = engine;
    if (stateUnsub !== null) this.unsubscribers.push(stateUnsub);
    this.unsubscribers.push(
      engine.subscribeWireMessages((message) => {
        this.onWireMessage(message);
      }),
    );
    // The engine folds the transcript while dispatching a frame, which runs
    // before that frame reaches this stream. Holding the folded value until
    // the frame has been pushed keeps the order every SDK yields: the event,
    // then the update it produced. The ``sendText`` echo folds with no frame
    // behind it and nothing to wait for, so the microtask flushes it; the
    // close that shuts an open turn is flushed by ``finishStream``, which
    // has to place it ahead of the terminal item.
    // ``on`` replays the current transcript to a new subscriber so a
    // callback consumer needs no reconcile. That replay is state, not a
    // fold, and putting it on the stream would open every session with an
    // empty update before ``ready``. It fires synchronously inside the
    // subscribe call, so the flag is still set while it runs.
    let replayingTranscript = true;
    this.unsubscribers.push(
      engine.on('transcript_updated', (event) => {
        if (replayingTranscript) return;
        // A queue, not a slot: two folds can land before either flush runs —
        // two ``sendText`` calls settling in one turn do exactly that — and
        // each fold is its own event on the stream, as it is in Python and
        // Swift.
        this.pendingTranscriptUpdates.push(event);
        queueMicrotask(() => {
          this.flushTranscriptUpdates();
        });
      }),
    );
    replayingTranscript = false;
    this.unsubscribers.push(
      engine.on('session_started', ({ sessionId }) => {
        this.ownSessionId ??= sessionId;
      }),
    );
    this.unsubscribers.push(
      engine.on('lifecycle', (state) => {
        if (state.kind === 'disconnected') this.finishStream(state);
      }),
    );
  }

  // ── Events ───────────────────────────────────────────────────────────

  /** Subscribe to one event; returns a function that unsubscribes.
   *  ``RealtimeEventMap`` is the catalogue of names and payloads.
   *
   *  Three events replay their current value to a new subscriber, so
   *  subscribing to them after ``start()`` resolves misses nothing:
   *  ``lifecycle``, ``transcript_updated``, and ``ready`` once the session
   *  is ready. Every other event — the three state axes among them — fires
   *  on change only, so pair a late subscription with ``getSnapshot()`` to
   *  avoid rendering a stale value until the next transition. */
  on<E extends RealtimeEventName>(
    event: E,
    handler: (payload: RealtimeEventMap[E]) => void,
  ): Unsubscribe {
    return this.engine.on(event, handler);
  }

  /** Iterate the wire-level event stream: ``for await (const event of
   *  session)``. Intended for one consumer: every call returns a new
   *  iterator over one shared queue, so a second concurrent iteration
   *  splits the events between them and eventually rejects rather than
   *  failing cleanly at the start. Unrecognized frames arrive as
   *  ``unknown`` items and never end the stream; a ``session-ended`` item
   *  is always the last one. */
  [Symbol.asyncIterator](): AsyncIterator<RealtimeSessionEvent> {
    return {
      next: (): Promise<IteratorResult<RealtimeSessionEvent>> => {
        const buffered = this.queue.shift();
        if (buffered !== undefined) {
          return Promise.resolve({ value: buffered, done: false });
        }
        if (this.streamEnded) {
          return Promise.resolve({ value: undefined, done: true });
        }
        if (this.pendingPull !== null) {
          return Promise.reject(
            new Error('RealtimeSession supports a single stream consumer.'),
          );
        }
        return new Promise((resolve) => {
          this.pendingPull = { resolve };
        });
      },
    };
  }

  // ── Lifecycle ────────────────────────────────────────────────────────

  /** Formal connection state (``idle → connecting → connected ↔
   *  reconnecting → disconnected``) with the typed end reason once
   *  disconnected. */
  get state(): SessionState {
    return this.terminalState ?? this.engine.getLifecycleState();
  }

  /** Server-minted id for this run, available from the moment the session
   *  starts. ``null`` before that, and again once the session has ended —
   *  capture it while the session is live if you need it afterwards. */
  get sessionId(): string | null {
    return this.engine.getSessionId();
  }

  /** Connect-latency breakdown for this session's start: the client-measured
   *  phases plus the server's own breakdown. ``null`` before the connect
   *  completes; dropped when the session ends. */
  get connectTimings(): SessionConnectTimings | null {
    return this.engine.getConnectTimings();
  }

  /** The coalesced conversation so far — one item per turn, folded by the
   *  session from its own transcript stream. The array reference is stable
   *  between changes; ``transcript_updated`` fires with the new value on
   *  every change. Survives ``end()``, so the full conversation stays
   *  readable after the session ends. */
  get transcript(): readonly TranscriptItem[] {
    return this.engine.getTranscript();
  }

  /** Gracefully end the session: the transport sends the ``end`` frame and
   *  leaves the room; the stream finishes with reason ``client ended``.
   *  Idempotent. Teardown is immediate — events still in flight are
   *  dropped, so consume the turn's final transcript event before ending
   *  if you need it. */
  async end(): Promise<void> {
    await this.engine.disconnect();
  }

  /** Abrupt local teardown without telling the server — no wire ``end``
   *  frame; the stream finishes with reason ``client closed``. Idempotent. */
  async close(): Promise<void> {
    await this.engine.close();
  }

  /** Resolve once the session is ready. ``agent.start()`` already resolves
   *  at ready, so after a resolved start this is instant; it exists for
   *  code holding a session from before the start settled (the
   *  ``onSession`` callback). Rejects if the session ends first. */
  waitUntilReady(): Promise<void> {
    return this.engine.waitUntilReady();
  }

  /** Every state axis read together at this instant. A one-shot read — to
   *  re-render as state changes, subscribe with ``on()`` or use the React
   *  hooks. */
  getSnapshot(): RealtimeSnapshot {
    return this.engine.getSnapshot();
  }

  // ── Sends / actions (delegates to this session's engine) ────────────

  /** Send a text turn; the agent replies in the session's modality. Usable
   *  the moment ``agent.start()`` resolves; throws ``SessionStateError`` once
   *  the session has ended.
   *
   *  Takes a turn, so the text is filed as a user turn in the transcript
   *  unless ``transcript: false``. To hand the agent context without asking
   *  for a reply, use ``sendContext``. Blank content is a no-op. */
  sendText(
    content: string,
    options?: { transcript?: boolean },
  ): Promise<void> {
    return this.engine.sendText(content, options);
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
  sendContext(content: string): Promise<void> {
    return this.engine.sendContext(content);
  }

  /** Give the voice model background it keeps to itself and draws on
   *  when relevant. Answers a ``delegation_created`` event when
   *  ``delegationId`` names it; without one it informs the session as a
   *  whole. */
  appendThinking(content: string, options?: { delegationId?: string }): Promise<void> {
    return this.engine.appendDelegation('thinking', content, options);
  }

  /** Give the voice model something to say now, in its own words. Answers
   *  a ``delegation_created`` event when ``delegationId`` names it. */
  appendCommentary(content: string, options?: { delegationId?: string }): Promise<void> {
    return this.engine.appendDelegation('commentary', content, options);
  }

  /** Change how the voice model behaves from here on. ``delegationId``
   *  scopes it to one hand-off; without one it applies to the session. */
  appendInstructions(content: string, options?: { delegationId?: string }): Promise<void> {
    return this.engine.appendDelegation('instructions', content, options);
  }

  /** Send one image frame into the agent's vision input; for continuous
   *  capture prefer ``startScreenShare`` / ``addVideoStream``. Throws
   *  ``SessionStateError`` once the session has ended.
   *
   *  ``data`` is base64-encoded bytes, not raw bytes. ``mimeType`` defaults
   *  to ``image/jpeg`` and ``streamId`` to ``video.input.default``; a
   *  distinct ``streamId`` groups successive frames as one visual source. */
  sendImage(args: { data: string; mimeType?: string; streamId?: string }): Promise<void> {
    return this.engine.sendImage(args);
  }

  /** Keep-alive; the server answers with a ``pong`` event. Throws
   *  ``SessionStateError`` once the session has ended. */
  ping(): Promise<void> {
    return this.engine.sendPing();
  }

  /** Signal end-of-turn for manual-VAD turn-taking. */
  sendActivityEnd(): Promise<void> {
    return this.engine.sendActivityEnd();
  }

  /** Place an outbound phone call into this session's room. Throws
   *  ``DialError`` for a malformed number (validated locally, before any
   *  request) or a server rejection. ``callerNumber`` selects the caller id
   *  when the workspace has more than one number provisioned. */
  dial(phoneNumber: string, callerNumber?: string): Promise<DialResult> {
    return this.engine.dial(phoneNumber, callerNumber);
  }

  /** Fetch this session's usage summary: duration, talk time, and token
   *  counts in provider-reported units.
   *
   *  An authenticated REST read, not a data-channel frame — callable while
   *  the session is live and, unlike the sends, after it ends. The detailed
   *  summary is written shortly after the session ends; ``usageStatus``
   *  on the result reports whether it is present yet.
   *
   *  Throws ``UsageError`` on a server rejection or transport failure, or
   *  if the session never started. */
  usage(): Promise<SessionUsage> {
    if (this.ownSessionId === null) {
      return Promise.reject(
        new UsageError({ code: 'invalid_request', message: 'usage requires a started session.' }),
      );
    }
    return this.engine.getUsage(this.ownSessionId);
  }

  /** Toggle the mic mute — the local track and the server-side gate.
   *  ``setMuted`` is the cross-SDK session surface (Python ``set_muted``,
   *  Swift ``setMuted``). */
  setMuted(muted: boolean): Promise<void> {
    return this.engine.setMicMuted(muted);
  }

  /** Publish a screen capture as the session's video input (prompts for
   *  permission). Usable the moment ``agent.start()`` resolves; throws
   *  ``SessionStateError`` once the session has ended.
   *
   *  A no-op while a share is already active or being picked. A declined
   *  picker sets the screen state to ``error`` and rethrows, so handle both
   *  — progress is readable from ``getScreenShareState()`` and the
   *  ``media_state`` event. */
  startScreenShare(): Promise<void> {
    return this.engine.startScreenShare();
  }

  /** Stop sharing the screen and release the capture. Idempotent. */
  stopScreenShare(): Promise<void> {
    return this.engine.stopScreenShare();
  }

  /** Where the screen share is in its lifecycle right now. */
  getScreenShareState(): ScreenShareState {
    return this.engine.getScreenShareState();
  }

  /** The locally captured display stream while a share is active, for the
   *  app to render its own "you are sharing this" preview. ``null`` when
   *  nothing is being shared. The session owns the stream's lifecycle — do
   *  not stop its tracks; call ``stopScreenShare`` instead. */
  getScreenShareStream(): MediaStream | null {
    return this.engine.getScreenShareStream();
  }

  /** Give the agent something to look at — a webcam, a canvas, any
   *  ``MediaStream``. Returns the handle to pass back to
   *  ``removeVideoStream``. Frames are sampled at a low rate suited to
   *  vision input; raise it with ``options.fps``. Use ``startScreenShare``
   *  for screen capture, which handles the picker for you. */
  addVideoStream(
    stream: MediaStream,
    options?: VideoStreamOptions,
  ): Promise<VideoStreamHandle> {
    return this.engine.addVideoStream(stream, options);
  }

  /** Stop sending a video stream added with ``addVideoStream``. A handle
   *  that is not published is a no-op. */
  removeVideoStream(streamId: VideoStreamHandle): Promise<void> {
    return this.engine.removeVideoStream(streamId);
  }

  /** Take the session's voice with a caller-owned ``MediaStream`` — a Web
   *  Audio graph, a decoded WAV, an ``<audio>`` element's ``captureStream()``,
   *  or a non-default input device. Declares this client the session's voice
   *  and clears the server-side mute gate. A session carries one voice, so the
   *  stream takes it from the microphone until ``stopAudioStream``; starting a
   *  second one throws ``SessionStateError``. */
  startAudioStream(stream: MediaStream): Promise<void> {
    return this.engine.startAudioStream(stream);
  }

  /** Give the voice back to the microphone the stream displaced.
   *  Idempotent. */
  stopAudioStream(): Promise<void> {
    return this.engine.stopAudioStream();
  }

  /** Expose a raw RPC method the server can invoke on this client. The
   *  low-level escape hatch beneath declared client tools — prefer
   *  ``clientTool()`` on the agent, which handles schemas, validation and
   *  hooks. ``handler`` takes and returns JSON strings. Returns a function
   *  that unregisters it; throws ``SessionStateError`` with no live transport. */
  registerRpcMethod(
    name: string,
    handler: (payload: string) => Promise<string>,
  ): Unsubscribe {
    return this.engine.registerRpcMethod(name, handler);
  }

  /** Play the agent's voice through an ``<audio>`` element you own, instead
   *  of the hidden one the SDK creates. Pass ``null`` to hand playback
   *  back. Idempotent, and callable before or after the session connects.
   *  React apps get this from ``<RealtimeAudio />``. */
  attachAudioElement(el: HTMLAudioElement | null): void {
    this.engine.attachAudioElement(el);
  }

  /** Play the session's remote video through a ``<video>`` element you own.
   *  There is a track to play only when an avatar renderer is speaking for
   *  the agent; otherwise the element stays empty. Pass ``null`` to detach.
   *  Idempotent, and callable before or after the session connects. React
   *  apps get this from ``<RealtimeVideo />``. */
  attachVideoElement(el: HTMLVideoElement | null): void {
    this.engine.attachVideoElement(el);
  }

  /** Retry playback after a browser autoplay block. Call it from a user
   *  gesture handler — that is what makes the retry succeed. ``<StartAudio
   *  />`` is the React affordance for this. */
  resumeAudioPlayback(): Promise<void> {
    return this.engine.resumeAudioPlayback();
  }

  /** Mark the remote-audio output as blocked (browser refused autoplay)
   *  or unblocked (a user gesture has caused ``play()`` to succeed).
   *  Called by ``<RealtimeAudio />`` from its own ``play``/``pause``
   *  listeners — the SDK's own state machine doesn't observe the audio
   *  element directly, so the React primitive that owns the element is
   *  the source of truth for autoplay status. */
  setOutputBlocked(blocked: boolean): void {
    this.engine.setOutputBlocked(blocked);
  }

  /** Snapshot whether fresh frames are flowing into the model's vision
   *  input. Looks across every published video track (screen-share AND
   *  camera) and picks the most informative answer the model can act on.
   *  Returned shape mirrors the wire output of the desktop adapter's
   *  ``get_current_screen`` tool so the dispatcher can pass it straight
   *  through to the model. */
  getVisionInputStatus(): {
    /** Whether fresh frames are reaching the model's vision input. */
    captured: boolean;
    /** Model-facing explanation, phrased for the agent to act on. */
    message: string;
  } {
    return this.engine.getVisionInputStatus();
  }

  // ─── Internal hatch ────────────────────────────────────────────────────
  //
  // Raw ``AnalyserNode`` access for waveform UIs. The public surface for
  // audio levels is the ``volume`` event, which carries RMS — enough for a
  // meter, but not for the frequency-domain draw a waveform needs, which is
  // why this hatch exists. Marked ``@internal`` so external consumers know
  // not to depend on it, and bundled into one object so the published
  // ``RealtimeSession`` type keeps a narrow surface. Session-scoped: the
  // analysers belong to this run's engine and go with it.
  /** @internal */
  readonly _internal: RealtimeSessionInternal = {
    getInputAnalyser: () => this.engine.getInputAnalyser(),
    getOutputAnalyser: () => this.engine.getOutputAnalyser(),
    subscribeInputAnalyser: (cb) => this.engine.subscribeInputAnalyser(cb),
    subscribeOutputAnalyser: (cb) => this.engine.subscribeOutputAnalyser(cb),
  };

  // ── Internals: stream plumbing ───────────────────────────────────────

  private onWireMessage(message: RealtimeInboundMessage): void {
    if (this.streamEnded || this.terminalQueued) return;
    if (message.type === null) {
      this.push({
        type: 'unknown',
        rawType: null,
        payload: null,
        rawText: message.raw,
      });
      return;
    }
    const rawType = (message as { type?: unknown }).type;
    if (rawType === 'session-ended') {
      // The server's own end notice is folded into the terminal item the
      // teardown emits (the engine latches the reason) so it is always
      // the stream's final item even if later frames race the close.
      return;
    }
    if (typeof rawType !== 'string' || !KNOWN_STREAM_TYPES.has(rawType)) {
      this.push({
        type: 'unknown',
        rawType: typeof rawType === 'string' ? rawType : null,
        payload: message as unknown as Record<string, unknown>,
      });
      return;
    }
    const decoded = decodeStreamEvent(message as WireServerMessage);
    this.push(
      decoded.type === 'delegation_created'
        ? { ...this.engine.resolveDelegation(decoded), type: 'delegation_created' }
        : decoded,
    );
    this.flushTranscriptUpdates();
  }

  /** Put the folded transcript on the stream, once, after the frame that
   *  produced it. A no-op when nothing is pending. */
  private flushTranscriptUpdates(options?: { terminal: boolean }): void {
    if (this.pendingTranscriptUpdates.length === 0) return;
    const pending = this.pendingTranscriptUpdates.splice(0);
    for (const event of pending) {
      const item = { ...event, type: 'transcript_updated' as const };
      // The closing fold rides the terminal path: a consumer that stopped
      // pulling should lose an older buffered event rather than the settled
      // transcript, which is the last thing the stream has to say.
      if (options?.terminal === true) this.pushBeforeTerminal(item);
      else this.push(item);
    }
  }

  /** Queue an item that must survive a full queue, without claiming the
   *  terminal slot — the eviction half of ``pushTerminal``. */
  private pushBeforeTerminal(event: RealtimeSessionEvent): void {
    if (this.pendingPull !== null) {
      const pull = this.pendingPull;
      this.pendingPull = null;
      pull.resolve({ value: event, done: false });
      return;
    }
    if (this.queue.length >= MAX_QUEUED_EVENTS) this.queue.shift();
    this.queue.push(event);
  }

  private finishStream(state: SessionState): void {
    if (this.streamEnded || this.terminalQueued) return;
    this.terminalState = state;
    // A turn still open when the session ends is closed by the engine's
    // fold. That update has to land before the terminal item — Python puts
    // both through its terminal path in this order — so it is flushed here
    // rather than left to the microtask, which would run after the stream
    // has ended.
    this.flushTranscriptUpdates({ terminal: true });
    // Handshake failures throw from ``agent.start()`` — the stream a
    // caller never received ends empty, mirroring Python.
    if (state.disconnectReason !== 'handshake_failed') {
      const reason =
        state.detail ??
        DEFAULT_ENDED_REASON[state.disconnectReason ?? 'transport_error'];
      this.pushTerminal({ type: 'session_ended', reason });
    }
    this.endStream();
    for (const unsubscribe of this.unsubscribers) unsubscribe();
    this.unsubscribers.length = 0;
  }

  private push(event: RealtimeSessionEvent): void {
    if (this.pendingPull !== null) {
      const pull = this.pendingPull;
      this.pendingPull = null;
      pull.resolve({ value: event, done: false });
      return;
    }
    if (this.queue.length >= MAX_QUEUED_EVENTS) {
      this.droppedEvents += 1;
      log.warn(
        `[realtime] session event queue full — dropped ${String(this.droppedEvents)} event(s)`,
      );
      return;
    }
    this.queue.push(event);
  }

  /** Terminal items survive a full queue by evicting the oldest buffered
   *  event instead of being dropped (Python's ``_put_terminal``). */
  private pushTerminal(event: SessionEndedEventItem): void {
    this.terminalQueued = true;
    if (this.pendingPull !== null) {
      const pull = this.pendingPull;
      this.pendingPull = null;
      pull.resolve({ value: event, done: false });
      return;
    }
    if (this.queue.length >= MAX_QUEUED_EVENTS) {
      this.queue.shift();
    }
    this.queue.push(event);
  }

  private endStream(): void {
    this.streamEnded = true;
    if (this.pendingPull !== null) {
      const pull = this.pendingPull;
      this.pendingPull = null;
      pull.resolve({ value: undefined, done: true });
    }
  }
}
