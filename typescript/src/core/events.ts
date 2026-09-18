/**
 * Tight public event surface for ``RealtimeClient``.
 *
 * The client emits six logical events — three normalized state axes
 * (transport / agent / media), three payload events (transcript delta,
 * tool call, tool result), and ``error``. Every subscriber — state
 * stores, reconnect listeners, UI adapters — wires through this
 * one mechanism; none reach into the client's message-handler
 * internals.
 *
 * The emitter is intentionally minimal — type-safe ``on(event,
 * handler)`` with an unsubscribe return. No once / wildcard / priority
 * — those belong in app-level subscribers if ever needed.
 */

import { log } from './logger';
import type { RejectedTool } from '../protocol';
import type { ServerHookAction } from './hooks';
import type { AudioUnavailableError } from './errors';
import type { SessionStartError } from '../transport/session_start_error';

import type {
  AgentState,
  MediaState,
  SessionState,
  TransportState,
} from './state';
import type { ErrorEvent } from './types';

/** Speaker for a transcript delta or item. The wire spells these
 *  ``USER`` / ``ASSISTANT``; the SDK normalizes to lowercase, so the wire
 *  form never reaches user code. */
export type TranscriptRole = 'user' | 'assistant';

/** A fragment of speech-to-text as it arrives, before coalescing. ``text``
 *  is the fragment alone, not the turn so far, and ``isFinal`` marks the
 *  fragment that closes the turn. For the folded conversation — one item per
 *  turn, ready to render — read ``transcript_updated`` instead. */
export type TranscriptDeltaEvent = {
  /** Who was speaking — the user, or the assistant. */
  role: TranscriptRole;
  /** The new fragment alone, not the turn so far. */
  text: string;
  /** Whether this fragment closes the turn.
   *
   *  Two finals carry less than the whole turn, and each needs the opposite
   *  handling. A turn the model produced nothing usable for closes with an
   *  empty ``text``, meaning an empty turn — retract the partial rather than
   *  keeping it. On a session running ``audio.output: false``, a user final
   *  arriving after the endpoint already committed the utterance is stripped
   *  of the committed prefix and carries only the remainder — keep the prefix
   *  rather than replacing with it. Reading ``transcript_updated`` avoids
   *  both, since the session folds this stream for you. */
  isFinal: boolean;
};

/** One coalesced turn in ``RealtimeSession.transcript``.
 *
 *  ``id`` is a stable render key, minted when the turn opens and never
 *  reused. While ``isFinal`` is ``false`` the turn is in progress: its
 *  ``text`` may grow, be replaced wholesale by the closing final, or the
 *  item may be removed entirely (a retracted turn). Once ``isFinal`` is
 *  ``true`` the item never changes again. */
export type TranscriptItem = {
  /** Stable render key for this turn, minted when it opens and never
   *  reused, so a UI can update in place rather than re-key. */
  readonly id: string;
  /** Who spoke. */
  readonly role: TranscriptRole;
  /** The turn's text so far, coalesced from the deltas. */
  readonly text: string;
  /** Whether the turn is closed. A closed turn never changes again. */
  readonly isFinal: boolean;
};

/** The session's coalesced transcript changed. ``items`` is the complete
 *  updated transcript — replace, don't merge. The same value is readable
 *  at any time as ``RealtimeSession.transcript``. */
export type TranscriptUpdatedEvent = {
  /** The complete transcript after this change — replace what you held, do
   *  not merge. */
  readonly items: readonly TranscriptItem[];
};

/** Written text the model produced alongside its reply. Separate from the
 *  transcript: nothing here was necessarily spoken. */
export type ModelTextEvent = {
  /** Streaming text fragment from the model's ``model_turn.parts[].text``
   *  channel. NOT a transcription of spoken audio — see ``transcript``
   *  for that. In AUDIO sessions Gemini may emit function-call narration
   *  or other written-style text here that the listener never heard.
   *  Consumers building a "what was spoken" UI should ignore this. */
  text: string;
  /** Whether this closes the text response. */
  isFinal: boolean;
};

/** The model decided to invoke a tool. First of the three events a call
 *  produces — ``tool_call`` → ``tool_dispatch_started`` → ``tool_result`` —
 *  all carrying the same ``toolCallId``, which is what joins them. */
export type ToolCallEvent = {
  /** Stable per-invocation id. Correlates this with
   *  ``tool_dispatch_started`` and ``tool_result`` for the same call. */
  toolCallId: string;
  /** Name of the tool being invoked. */
  name: string;
};

/** A tool call finished. ``ok`` is false when the handler failed or the call
 *  was denied; ``summary`` is a short human-readable line, or ``null`` when
 *  the tool reported none. Last of the three events keyed by
 *  ``toolCallId``. */
export type ToolResultEvent = {
  /** Correlates with the ``tool_call`` that opened this invocation. */
  toolCallId: string;
  /** Whether the tool succeeded. */
  ok: boolean;
  /** Short human-readable line about the outcome, or ``null`` when the tool
   *  reported none. */
  summary: string | null;
};

/** Current input and output loudness, each a 0–1 RMS level for driving a
 *  meter. Emitted only while levels are moving, and once with both at ``0``
 *  when metering stops. */
export type VolumeEvent = {
  /** RMS of what the microphone is capturing, ``0``–``1``. */
  mic: number;
  /** RMS of the agent's voice as played out, ``0``–``1``. */
  output: number;
};

/** Resolved-agent summary echoed on ``ready`` when the session referenced
 *  a registry agent (``AgentConfig.name``). Informational only — never
 *  authoritative; clients don't act on it. */
export type ResolvedAgentInfo = {
  /** Machine handle of the registry agent the session resolved. */
  name: string;
  /** Effective tool names the session runs with. */
  tools: string[];
};

/** The session is established and the model is listening — the point at
 *  which sends are safe. Fires once per session, and is replayed to
 *  subscribers that attach after it. */
export type ReadyEvent = {
  /** Server-assigned id for this session. Persist it to resume after a
   *  disconnect, and to correlate with server-side records. */
  sessionId: string;
  /** Tool specs the server refused (unknown server-tool names, sanitization,
   *  schema caps), with the reason. The session still starts without them. */
  rejectedTools: RejectedTool[];
  /** Server-enforced session duration cap (seconds), measured from session
   *  start server-side. ``null`` = no cap. Lets the UI render its own
   *  countdown without depending on the last-moment warning frame. */
  maxSessionSeconds: number | null;
  /** Resolved registry agent for an ``AgentConfig.name`` session;
   *  ``null`` for a purely inline agent. */
  agent: ResolvedAgentInfo | null;
};

/** The handler for a tool call began running. Sits between ``tool_call``
 *  and ``tool_result`` so a UI can show a "working…" state on a slow tool;
 *  same ``toolCallId`` as both. */
export type ToolDispatchStartedEvent = {
  /** Correlates with the ``tool_call`` that opened this invocation. */
  toolCallId: string;
  /** Name of the tool that started executing. */
  name: string;
};

/** Token usage for the session so far, split by direction and modality.
 *
 *  Every count is a cumulative total for the session, not a per-turn delta,
 *  so each event supersedes the previous one. A provider that reports no
 *  usage emits no event at all — absence is not zero. */
export type UsageEvent = {
  /** Text the model read: instructions, transcripts, tool results. */
  inputTextTokens: number;
  /** Images the model read, from ``sendImage`` or a video frame. */
  inputImageTokens: number;
  /** Audio the model heard from the user. */
  inputAudioTokens: number;
  /** The share of input tokens served from the provider's prompt cache,
   *  billed at a lower rate. Counted within the input totals, not added to
   *  them. */
  inputCachedTokens: number;
  /** Text the model wrote, tool calls included. */
  outputTextTokens: number;
  /** Audio the model spoke. */
  outputAudioTokens: number;
  /** Input and output together, as the provider counts them. Not a bill:
   *  modalities price differently, cached input is discounted, and some
   *  models add per-minute charges. */
  totalTokens: number;
};

/** The session's durable state changed, because the model called
 *  ``set_state``. */
export type SessionStateWriteEvent = {
  /** Full canonical state after the merge — not a delta. */
  state: Record<string, unknown>;
  /** Keys touched by the ``set_state`` write that produced this event. */
  updatedKeys: string[];
  /** Advisory schema findings (e.g. required capture still empty on a
   *  stage advance). The model saw the same list in its tool result. */
  warnings: string[];
  /** ``state.stage`` hoisted by the server for the live stage timeline. */
  stage: string | null;
};

/** The server is rotating the upstream model. The session stays live and
 *  no action is needed; surface it if you want a "reconnecting…" cue. */
export type ReconnectingEvent = {
  /** Optional ETA hint from the server. */
  secondsRemaining: number | null;
};

/** The server will end the session shortly. The session is still live —
 *  ``session_ended`` follows when it actually ends. */
export type SessionEndingSoonEvent = {
  /** How long until the server ends the session. */
  secondsRemaining: number;
  /** Stable slug (e.g. ``max_session_duration``). */
  reason: string;
};

/** The session reached its terminal state. Fires exactly once, on every
 *  exit path. */
export type SessionEndedEvent = {
  /** Stable slug (e.g. ``max_session_duration``). */
  reason: string;
};

/** A turn finished, after its transcript and tool activity. ``role`` is
 *  whose turn ended. */
export type TurnCompleteEvent = {
  /** Whose turn ended. */
  role: TranscriptRole;
};

/** Reply to ``session.ping()``. Carries nothing but its name — the arrival
 *  is the signal. */
export type PongEvent = Record<never, never>;

/** The user began speaking, as the server's turn detector heard it. */
export type UserStartedSpeakingEvent = Record<never, never>;

/** The user stopped speaking; the turn is closing. */
export type UserStoppedSpeakingEvent = Record<never, never>;

/** The agent's voice began playing out. */
export type BotStartedSpeakingEvent = Record<never, never>;

/** The agent's voice stopped playing out. */
export type BotStoppedSpeakingEvent = Record<never, never>;

/** The model began generating a reply. Precedes the audio by the time the
 *  model takes to think. */
export type BotLlmStartedEvent = Record<never, never>;

/** The model finished generating a reply. */
export type BotLlmStoppedEvent = Record<never, never>;

/** Speech synthesis began for the reply. */
export type BotTtsStartedEvent = Record<never, never>;

/** Speech synthesis finished for the reply. */
export type BotTtsStoppedEvent = Record<never, never>;

/** Where a tool invocation came from: the realtime model itself, or a
 *  server-side caller acting on the session. */
export type ToolInvocationOrigin = 'realtime' | 'server';

/** The server is asking this client to run a tool. Carries the arguments
 *  and the request id a reply must quote; ``executable`` is ``false`` when
 *  the server is only announcing the call rather than delegating it. */
export type ToolInvocationEvent = {
  /** Correlates with the ``tool_call`` that opened this invocation. */
  toolCallId: string;
  /** Id this invocation's reply must quote. */
  requestId: string;
  /** Name of the tool to run. */
  name: string;
  /** Arguments for the call, as the model produced them. */
  args: Record<string, unknown>;
  /** Who asked for the call. */
  origin: ToolInvocationOrigin;
  /** Whether this client is expected to run it and reply. */
  executable: boolean;
};

/** A server-runtime silence timeout fired: the user was silent past a
 *  configured threshold and the server performed ``action``. Observability
 *  only — the server already acted. */
export type UserSpeechTimeoutEvent = {
  /** Session the timeout fired on. */
  sessionId: string;
  /** Silence accrued in the window that fired. The clock restarts after each
   *  firing, so on a second or later nudge this measures from the previous
   *  one, not from the last time the user spoke. */
  silenceMs: number;
  /** Which firing this is in the current run, from one. Under
   *  ``resetMode: 'on_user_speech'`` the count restarts when the user speaks,
   *  so it can return to one within a session. */
  triggerCount: number;
  /** The hook's nudge ceiling. It goes quiet after the last one rather than
   *  escalating; under ``resetMode: 'on_user_speech'`` the count resets on
   *  user speech, so this bounds one run of silence, not the session. */
  maxCount: number;
  /** What the server did in response — speak a line, or end the call. */
  action: ServerHookAction;
};

/** The voice model decided the user's request needs work done and handed
 *  it to your application. Do the work, then answer with the session's
 *  ``appendThinking`` / ``appendCommentary`` / ``appendInstructions``
 *  carrying this id; the model keeps talking with the user meanwhile. */
export type DelegationCreatedEvent = {
  /** Identifies this hand-off. Pass it on every append that answers it. */
  delegationId: string;
  /** What the user said in the turn that prompted the hand-off. Earlier
   *  turns are yours to keep from the ``transcript`` events. */
  transcript: string;
};

/** Every event name a session emits, mapped to the payload its handler
 *  receives. This is what types ``session.on(name, handler)``, so it is the
 *  catalogue to read when writing one. */
export type RealtimeEventMap = {
  /** Where the transport is — connecting, connected, reconnecting, closed.
   *  Fires on change only; read ``getSnapshot()`` for the current value. */
  transport_state: TransportState;
  /** What the agent is doing right now: idle, listening, thinking, speaking.
   *  Fires on change only; read ``getSnapshot()`` for the current value. */
  agent_state: AgentState;
  /** Which media are live — microphone, speaker, camera, screen share.
   *  Fires on change only; read ``getSnapshot()`` for the current value. */
  media_state: MediaState;
  /** Formal session lifecycle (``idle → connecting → connected ↔
   *  reconnecting → disconnected``) with typed end reasons. Drives
   *  ``RealtimeSession.state`` and the stream's terminal item. The current
   *  state is replayed to each new subscriber, so attaching after
   *  ``agent.start()`` resolves misses nothing. */
  lifecycle: SessionState;
  /** One raw transcript fragment. For the folded conversation, read
   *  ``transcript_updated`` instead. */
  transcript: TranscriptDeltaEvent;
  /** The coalesced transcript changed; carries the full updated item
   *  list. The current value is replayed to each new subscriber, so
   *  attaching after ``agent.start()`` resolves misses nothing. */
  transcript_updated: TranscriptUpdatedEvent;
  /** Written text the model produced alongside its reply — not a
   *  transcription of what was spoken. */
  model_text: ModelTextEvent;
  /** The model decided to call a tool. First of the three events keyed by
   *  ``toolCallId``. */
  tool_call: ToolCallEvent;
  /** The server-side handler for that call began executing. Second of the
   *  three, for showing a "working…" state on a slow tool. */
  tool_dispatch_started: ToolDispatchStartedEvent;
  /** The call finished. Last of the three. */
  tool_result: ToolResultEvent;
  /** Durable session state changed (a server-side ``set_state`` write). */
  session_state: SessionStateWriteEvent;
  /** Cumulative token usage for the session, split by direction and
   *  modality. Each event supersedes the previous one. */
  usage: UsageEvent;
  /** Input and output loudness for driving a meter. Emitted only while
   *  levels are moving, and once with both at zero when metering stops. */
  volume: VolumeEvent;
  /** Latest terminal-ish error, or ``null`` when the SDK has cleared
   *  back to a healthy state (e.g. on the next session start). The payload
   *  is the error itself, not a summary: the ``SessionStartError`` or
   *  ``AudioUnavailableError`` the failed ``start()`` rejected with, or the
   *  decoded wire ``error`` frame with the server's own ``code`` and
   *  ``fatal``. Branch with ``instanceof RealtimeError`` and ``name``; the
   *  remaining case is the wire frame. React consumers via
   *  ``useRealtimeError()`` need both transitions to hide a stale banner
   *  after a recovery. */
  error: SessionStartError | AudioUnavailableError | ErrorEvent | null;
  /** Fires once per session when the server sends ``ready``; replayed to
   *  subscribers that attach after it fired. */
  ready: ReadyEvent;
  /** Fires once per session the instant the session-start POST
   *  returns the server-minted ``session_id`` — well before
   *  ``ready`` (which waits for the realtime model to handshake
   *  over the data channel). Consumers that need a per-session id
   *  but not full transport-ready state (e.g. polling per-session
   *  REST endpoints) bind here. */
  session_started: {
    /** Server-assigned id for this session, the key REST endpoints take. */
    sessionId: string;
  };
  /** Server is rotating the upstream model; session stays live. */
  reconnecting: ReconnectingEvent;
  /** Server will end the session shortly (e.g. max-duration cap); the
   *  session stays live until ``session_ended``. */
  session_ending_soon: SessionEndingSoonEvent;
  /** Fires exactly once when the session reaches its terminal state, on
   *  any exit path — server end, client ``end()``/``close()``, transport
   *  failure. ``reason`` is the server's slug when the server ended it,
   *  otherwise the disconnect reason (e.g. ``client_ended``). */
  session_ended: SessionEndedEvent;
  /** End-of-turn marker; fires after a turn's transcript + tool activity. */
  turn_complete: TurnCompleteEvent;
  /** Reply to ``sendPing()``; surfaced for liveness checks. */
  pong: PongEvent;
  /** A server-runtime silence timeout fired (``user-speech-timeout``). */
  user_speech_timeout: UserSpeechTimeoutEvent;
  /** The voice model handed the user's request off (``delegation-created``). */
  delegation_created: DelegationCreatedEvent;
};

/** Any event name a session emits — the keys of ``RealtimeEventMap``. */
export type RealtimeEventName = keyof RealtimeEventMap;

/** Returned by every ``on(...)`` subscription; call it to stop listening.
 *  Idempotent. */
export type Unsubscribe = () => void;

/** A handler for one event, receiving that event's payload. */
type Handler<E extends RealtimeEventName> = (payload: RealtimeEventMap[E]) => void;

type HandlerSets = { [E in RealtimeEventName]?: Set<Handler<E>> };

/** Notified with the new listener count whenever an event gains or loses a
 *  subscriber, so the emitter's owner can start and stop work nobody is
 *  listening to. */
type SubscriberChangeHandler = (count: number) => void;
type SubscriberChangeSets = { [E in RealtimeEventName]?: Set<SubscriberChangeHandler> };

/**
 * Type-safe in-process event emitter behind a session's ``on()``.
 *
 * Intentionally minimal — ``on`` with an unsubscribe return, and nothing
 * else. Wildcards and priorities belong in app code, not this boundary. A
 * throwing handler is logged and isolated from the others.
 */
export class RealtimeEventEmitter {
  private handlers: HandlerSets = {};
  private subscriberChangeHandlers: SubscriberChangeSets = {};

  /** Register a handler for one event; returns a function that removes it.
   *  Registering the same handler twice is a no-op — handlers are a set.
   *  This is the raw emitter: unlike ``RealtimeSession.on()`` it replays
   *  nothing to a new subscriber. */
  on<E extends RealtimeEventName>(event: E, handler: Handler<E>): Unsubscribe {
    let set = this.handlers[event] as Set<Handler<E>> | undefined;
    if (set === undefined) {
      set = new Set();
      this.handlers[event] = set as HandlerSets[E];
    }
    set.add(handler);
    this.notifySubscriberChange(event, set.size);
    return () => {
      if (set === undefined) return;
      const removed = set.delete(handler);
      if (removed) this.notifySubscriberChange(event, set.size);
    };
  }

  /** Deliver a payload to every handler for one event, in registration
   *  order. A handler that throws is logged and does not stop the rest. */
  emit<E extends RealtimeEventName>(event: E, payload: RealtimeEventMap[E]): void {
    const set = this.handlers[event] as Set<Handler<E>> | undefined;
    if (set === undefined) return;
    for (const handler of set) {
      try {
        handler(payload);
      } catch (err) {
        log.error(`[realtime] event handler for ${event} threw`, err);
      }
    }
  }

  /** How many handlers are registered for one event. */
  listenerCount(event: RealtimeEventName): number {
    const set = this.handlers[event];
    return set ? set.size : 0;
  }

  /** Observe how many handlers one event has, so a producer can start and
   *  stop work with demand — this is how the volume meter avoids running
   *  with nothing listening. Fires on ``on()`` and on the unsubscribe it
   *  returns; ``clear()`` is not a remove for this purpose and fires
   *  nothing. Returns a function that stops observing. */
  onSubscriberChange(
    event: RealtimeEventName,
    cb: SubscriberChangeHandler,
  ): Unsubscribe {
    let set = this.subscriberChangeHandlers[event];
    if (set === undefined) {
      set = new Set();
      this.subscriberChangeHandlers[event] = set;
    }
    set.add(cb);
    return () => {
      set?.delete(cb);
    };
  }

  private notifySubscriberChange(event: RealtimeEventName, count: number): void {
    const set = this.subscriberChangeHandlers[event];
    if (set === undefined) return;
    for (const cb of set) {
      try {
        cb(count);
      } catch (err) {
        log.error(`[realtime] subscriber-change handler for ${event} threw`, err);
      }
    }
  }

  /** Drop every event handler. Subscriber-change observers are kept but are
   *  not notified, so a producer tracking demand will not see the count fall
   *  — unsubscribe handlers individually if it must. */
  clear(): void {
    this.handlers = {};
  }
}
