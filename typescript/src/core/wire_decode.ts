/**
 * Wire frame → published event, one function per event.
 *
 * This is the only place a generated symbol appears in the client path. The
 * SDK's event types are declared independently in ``./events`` and
 * ``./types``; these functions are what connect them to what the server
 * actually sends, which is exactly the job Swift gives ``CodingKeys`` and
 * Python gives ``model_validate``.
 *
 * **Every mapper destructures its whole wire frame and asserts the rest is
 * empty.** A field added to the schema therefore fails ``tsc`` on the mapper
 * that would have dropped it, rather than disappearing silently between the
 * server and a consumer. That check replaces the hand-written mirror this
 * module retired: it lives in the code doing the work instead of in a
 * separate structural comparison, so it cannot pass while the real mapping
 * is wrong.
 */

import type * as Wire from '../wire/types.gen';
import type {
  BotLlmStartedEvent,
  BotLlmStoppedEvent,
  BotStartedSpeakingEvent,
  BotStoppedSpeakingEvent,
  BotTtsStartedEvent,
  BotTtsStoppedEvent,
  DelegationCreatedEvent,
  ModelTextEvent,
  PongEvent,
  ReadyEvent,
  ReconnectingEvent,
  SessionEndedEvent,
  SessionEndingSoonEvent,
  SessionStateWriteEvent,
  ToolCallEvent,
  ToolDispatchStartedEvent,
  ToolInvocationEvent,
  ToolResultEvent,
  TranscriptDeltaEvent,
  TranscriptRole,
  TurnCompleteEvent,
  UsageEvent,
  UserSpeechTimeoutEvent,
  UserStartedSpeakingEvent,
  UserStoppedSpeakingEvent,
} from './events';
import type { ErrorEvent } from './types';


/** Every inbound frame this SDK recognizes, composed from the generated
 *  wire types. Composition, not a copy: each member is the generated type
 *  itself, so a changed frame changes here with no second declaration to
 *  keep in step. */
export type WireServerMessage =
  | Wire.ReadyEvent
  | Wire.TranscriptDeltaEvent
  | Wire.ModelTextEvent
  | Wire.TurnCompleteEvent
  | Wire.UserStartedSpeakingEvent
  | Wire.UserStoppedSpeakingEvent
  | Wire.UserSpeechTimeoutEvent
  | Wire.DelegationCreatedEvent
  | Wire.BotStartedSpeakingEvent
  | Wire.BotStoppedSpeakingEvent
  | Wire.BotLlmStartedEvent
  | Wire.BotLlmStoppedEvent
  | Wire.BotTtsStartedEvent
  | Wire.BotTtsStoppedEvent
  | Wire.ToolCallEvent
  | Wire.ToolDispatchStartedEvent
  | Wire.ToolResultEvent
  | Wire.ToolInvocationEvent
  | Wire.UsageEvent
  | Wire.SessionStateWriteEvent
  | Wire.ReconnectingEvent
  | Wire.SessionEndingSoonEvent
  | Wire.SessionEndedEvent
  | Wire.ErrorEvent
  | Wire.PongEvent;

/** Assigning a rest object here compiles only while that object is empty,
 *  so a mapper that stops covering its frame stops building. */
type NoRemainingFields = Record<string, never>;

/** The wire spells the speaker in caps; every SDK publishes it lowercase. */
function role(wire: Wire.TranscriptRole): TranscriptRole {
  return wire === 'USER' ? 'user' : 'assistant';
}

export function readyEvent({
  type,
  session_id,
  rejected_tools,
  max_session_seconds,
  agent,
  ...rest
}: Wire.ReadyEvent): ReadyEvent {
  const covered: NoRemainingFields = rest;
  void covered;
  void type;
  return {
    sessionId: session_id,
    rejectedTools: rejected_tools ?? [],
    maxSessionSeconds: max_session_seconds ?? null,
    // The schema types this optional, but the server dumps its models
    // without ``exclude_none``, so an inline or default-agent session sends
    // ``agent: null`` rather than omitting it. Both spellings mean the same
    // thing here.
    agent: agent ? { name: agent.name, tools: agent.tools ?? [] } : null,
  };
}

export function transcriptDeltaEvent({
  type,
  role: wireRole,
  text,
  is_final,
  ...rest
}: Wire.TranscriptDeltaEvent): TranscriptDeltaEvent {
  const covered: NoRemainingFields = rest;
  void covered;
  void type;
  return { role: role(wireRole), text, isFinal: is_final };
}

export function modelTextEvent({
  type,
  text,
  is_final,
  ...rest
}: Wire.ModelTextEvent): ModelTextEvent {
  const covered: NoRemainingFields = rest;
  void covered;
  void type;
  return { text, isFinal: is_final ?? false };
}

export function turnCompleteEvent({
  type,
  role: wireRole,
  ...rest
}: Wire.TurnCompleteEvent): TurnCompleteEvent {
  const covered: NoRemainingFields = rest;
  void covered;
  void type;
  return { role: role(wireRole) };
}

export function userStartedSpeakingEvent({
  type,
  ...rest
}: Wire.UserStartedSpeakingEvent): UserStartedSpeakingEvent {
  const covered: NoRemainingFields = rest;
  void covered;
  void type;
  return {};
}

export function userStoppedSpeakingEvent({
  type,
  ...rest
}: Wire.UserStoppedSpeakingEvent): UserStoppedSpeakingEvent {
  const covered: NoRemainingFields = rest;
  void covered;
  void type;
  return {};
}

export function botStartedSpeakingEvent({
  type,
  ...rest
}: Wire.BotStartedSpeakingEvent): BotStartedSpeakingEvent {
  const covered: NoRemainingFields = rest;
  void covered;
  void type;
  return {};
}

export function botStoppedSpeakingEvent({
  type,
  ...rest
}: Wire.BotStoppedSpeakingEvent): BotStoppedSpeakingEvent {
  const covered: NoRemainingFields = rest;
  void covered;
  void type;
  return {};
}

export function botLlmStartedEvent({
  type,
  ...rest
}: Wire.BotLlmStartedEvent): BotLlmStartedEvent {
  const covered: NoRemainingFields = rest;
  void covered;
  void type;
  return {};
}

export function botLlmStoppedEvent({
  type,
  ...rest
}: Wire.BotLlmStoppedEvent): BotLlmStoppedEvent {
  const covered: NoRemainingFields = rest;
  void covered;
  void type;
  return {};
}

export function botTtsStartedEvent({
  type,
  ...rest
}: Wire.BotTtsStartedEvent): BotTtsStartedEvent {
  const covered: NoRemainingFields = rest;
  void covered;
  void type;
  return {};
}

export function botTtsStoppedEvent({
  type,
  ...rest
}: Wire.BotTtsStoppedEvent): BotTtsStoppedEvent {
  const covered: NoRemainingFields = rest;
  void covered;
  void type;
  return {};
}

export function userSpeechTimeoutEvent({
  type,
  session_id,
  silence_ms,
  trigger_count,
  max_count,
  action,
  ...rest
}: Wire.UserSpeechTimeoutEvent): UserSpeechTimeoutEvent {
  const covered: NoRemainingFields = rest;
  void covered;
  void type;
  return {
    sessionId: session_id,
    silenceMs: silence_ms,
    triggerCount: trigger_count,
    maxCount: max_count,
    action,
  };
}

export function delegationCreatedEvent({
  type,
  delegation_id,
  transcript,
  ...rest
}: Wire.DelegationCreatedEvent): DelegationCreatedEvent {
  const covered: NoRemainingFields = rest;
  void covered;
  void type;
  return { delegationId: delegation_id, transcript };
}

export function toolCallEvent({
  type,
  tool_call_id,
  name,
  ...rest
}: Wire.ToolCallEvent): ToolCallEvent {
  const covered: NoRemainingFields = rest;
  void covered;
  void type;
  return { toolCallId: tool_call_id, name };
}

export function toolDispatchStartedEvent({
  type,
  tool_call_id,
  name,
  ...rest
}: Wire.ToolDispatchStartedEvent): ToolDispatchStartedEvent {
  const covered: NoRemainingFields = rest;
  void covered;
  void type;
  return { toolCallId: tool_call_id, name };
}

export function toolResultEvent({
  type,
  tool_call_id,
  ok,
  summary,
  ...rest
}: Wire.ToolResultEvent): ToolResultEvent {
  const covered: NoRemainingFields = rest;
  void covered;
  void type;
  return { toolCallId: tool_call_id, ok, summary: summary ?? null };
}

export function toolInvocationEvent({
  type,
  tool_call_id,
  request_id,
  name,
  args,
  origin,
  executable,
  ...rest
}: Wire.ToolInvocationEvent): ToolInvocationEvent {
  const covered: NoRemainingFields = rest;
  void covered;
  void type;
  return {
    toolCallId: tool_call_id,
    requestId: request_id,
    name,
    args: args ?? {},
    origin: origin ?? 'realtime',
    executable: executable ?? true,
  };
}

export function usageEvent({
  type,
  input_text_tokens,
  input_image_tokens,
  input_audio_tokens,
  input_cached_tokens,
  output_text_tokens,
  output_audio_tokens,
  total_tokens,
  ...rest
}: Wire.UsageEvent): UsageEvent {
  const covered: NoRemainingFields = rest;
  void covered;
  void type;
  return {
    inputTextTokens: input_text_tokens ?? 0,
    inputImageTokens: input_image_tokens ?? 0,
    inputAudioTokens: input_audio_tokens ?? 0,
    inputCachedTokens: input_cached_tokens ?? 0,
    outputTextTokens: output_text_tokens ?? 0,
    outputAudioTokens: output_audio_tokens ?? 0,
    totalTokens: total_tokens ?? 0,
  };
}

export function sessionStateWriteEvent({
  type,
  state,
  updated_keys,
  stage,
  warnings,
  ...rest
}: Wire.SessionStateWriteEvent): SessionStateWriteEvent {
  const covered: NoRemainingFields = rest;
  void covered;
  void type;
  return {
    state: state ?? {},
    updatedKeys: updated_keys ?? [],
    stage: stage ?? null,
    warnings: warnings ?? [],
  };
}

export function reconnectingEvent({
  type,
  seconds_remaining,
  ...rest
}: Wire.ReconnectingEvent): ReconnectingEvent {
  const covered: NoRemainingFields = rest;
  void covered;
  void type;
  return { secondsRemaining: seconds_remaining ?? null };
}

export function sessionEndingSoonEvent({
  type,
  reason,
  seconds_remaining,
  ...rest
}: Wire.SessionEndingSoonEvent): SessionEndingSoonEvent {
  const covered: NoRemainingFields = rest;
  void covered;
  void type;
  return { reason, secondsRemaining: seconds_remaining };
}

export function sessionEndedEvent({
  type,
  reason,
  ...rest
}: Wire.SessionEndedEvent): SessionEndedEvent {
  const covered: NoRemainingFields = rest;
  void covered;
  void type;
  return { reason };
}

export function errorEvent({
  type,
  code,
  message,
  fatal,
  ...rest
}: Wire.ErrorEvent): ErrorEvent {
  const covered: NoRemainingFields = rest;
  void covered;
  void type;
  return { code, message, fatal: fatal ?? false };
}

export function pongEvent({ type, ...rest }: Wire.PongEvent): PongEvent {
  const covered: NoRemainingFields = rest;
  void covered;
  void type;
  return {};
}

/** The session's own name for an event, on the stream.
 *
 * The wire spells these ``tool-call`` and ``cosmo.usage``; neither casing
 * appears anywhere else on this SDK's surface, and neither Python nor Swift
 * exposes the wire string at all — one discriminates by class, the other by
 * enum case. TypeScript needs a literal to narrow a union, so it gets one in
 * the SDK's own vocabulary: where the event also has a callback, this is
 * the name ``on()`` takes, so a consumer spells it the same way on either
 * surface. The markers with no callback (``bot_*``, ``user_*_speaking``,
 * ``tool_invocation``) follow the same spelling.
 */
const STREAM_NAME = {
  ready: 'ready',
  transcript: 'transcript',
  'model-text': 'model_text',
  'turn-complete': 'turn_complete',
  'user-started-speaking': 'user_started_speaking',
  'user-stopped-speaking': 'user_stopped_speaking',
  'user-speech-timeout': 'user_speech_timeout',
  'delegation-created': 'delegation_created',
  'bot-started-speaking': 'bot_started_speaking',
  'bot-stopped-speaking': 'bot_stopped_speaking',
  'bot-llm-started': 'bot_llm_started',
  'bot-llm-stopped': 'bot_llm_stopped',
  'bot-tts-started': 'bot_tts_started',
  'bot-tts-stopped': 'bot_tts_stopped',
  'tool-call': 'tool_call',
  'tool-dispatch-started': 'tool_dispatch_started',
  'tool-result': 'tool_result',
  'tool-invocation': 'tool_invocation',
  'cosmo.usage': 'usage',
  'cosmo.session-state': 'session_state',
  reconnecting: 'reconnecting',
  'session-ending-soon': 'session_ending_soon',
  'session-ended': 'session_ended',
  error: 'error',
  pong: 'pong',
} as const satisfies Record<WireServerMessage['type'], string>;

/** The wire name a stream event was decoded from. The contract traces speak
 *  the wire's vocabulary, so they map back through this. */
export const WIRE_NAME: Record<string, string> = Object.fromEntries(
  Object.entries(STREAM_NAME).map(([wire, sdk]) => [sdk, wire]),
);

/** An event on the session stream: the published payload, named. */
export type StreamEvent<T, K extends string> = T & { type: K };

/** Every event the stream yields for a recognized frame. */
export type DecodedStreamEvent =
  | StreamEvent<ReadyEvent, 'ready'>
  | StreamEvent<TranscriptDeltaEvent, 'transcript'>
  | StreamEvent<ModelTextEvent, 'model_text'>
  | StreamEvent<TurnCompleteEvent, 'turn_complete'>
  | StreamEvent<UserStartedSpeakingEvent, 'user_started_speaking'>
  | StreamEvent<UserStoppedSpeakingEvent, 'user_stopped_speaking'>
  | StreamEvent<UserSpeechTimeoutEvent, 'user_speech_timeout'>
  | StreamEvent<DelegationCreatedEvent, 'delegation_created'>
  | StreamEvent<BotStartedSpeakingEvent, 'bot_started_speaking'>
  | StreamEvent<BotStoppedSpeakingEvent, 'bot_stopped_speaking'>
  | StreamEvent<BotLlmStartedEvent, 'bot_llm_started'>
  | StreamEvent<BotLlmStoppedEvent, 'bot_llm_stopped'>
  | StreamEvent<BotTtsStartedEvent, 'bot_tts_started'>
  | StreamEvent<BotTtsStoppedEvent, 'bot_tts_stopped'>
  | StreamEvent<ToolCallEvent, 'tool_call'>
  | StreamEvent<ToolDispatchStartedEvent, 'tool_dispatch_started'>
  | StreamEvent<ToolResultEvent, 'tool_result'>
  | StreamEvent<ToolInvocationEvent, 'tool_invocation'>
  | StreamEvent<UsageEvent, 'usage'>
  | StreamEvent<SessionStateWriteEvent, 'session_state'>
  | StreamEvent<ReconnectingEvent, 'reconnecting'>
  | StreamEvent<SessionEndingSoonEvent, 'session_ending_soon'>
  | StreamEvent<SessionEndedEvent, 'session_ended'>
  | StreamEvent<ErrorEvent, 'error'>
  | StreamEvent<PongEvent, 'pong'>;

/** One recognized server frame, as the session's own named event.
 *
 * The caller has already filtered to the frames the stream passes through,
 * so the switch is total over them; an unhandled ``type`` is a compile error
 * here, which is what keeps this dispatch honest as frames are added.
 */
export function decodeStreamEvent(message: WireServerMessage): DecodedStreamEvent {
  switch (message.type) {
    case 'ready': return { ...readyEvent(message), type: 'ready' };
    case 'transcript': return { ...transcriptDeltaEvent(message), type: 'transcript' };
    case 'model-text': return { ...modelTextEvent(message), type: 'model_text' };
    case 'turn-complete': return { ...turnCompleteEvent(message), type: 'turn_complete' };
    case 'user-started-speaking':
      return { ...userStartedSpeakingEvent(message), type: 'user_started_speaking' };
    case 'user-stopped-speaking':
      return { ...userStoppedSpeakingEvent(message), type: 'user_stopped_speaking' };
    case 'user-speech-timeout':
      return { ...userSpeechTimeoutEvent(message), type: 'user_speech_timeout' };
    case 'delegation-created':
      return { ...delegationCreatedEvent(message), type: 'delegation_created' };
    case 'bot-started-speaking':
      return { ...botStartedSpeakingEvent(message), type: 'bot_started_speaking' };
    case 'bot-stopped-speaking':
      return { ...botStoppedSpeakingEvent(message), type: 'bot_stopped_speaking' };
    case 'bot-llm-started': return { ...botLlmStartedEvent(message), type: 'bot_llm_started' };
    case 'bot-llm-stopped': return { ...botLlmStoppedEvent(message), type: 'bot_llm_stopped' };
    case 'bot-tts-started': return { ...botTtsStartedEvent(message), type: 'bot_tts_started' };
    case 'bot-tts-stopped': return { ...botTtsStoppedEvent(message), type: 'bot_tts_stopped' };
    case 'tool-call': return { ...toolCallEvent(message), type: 'tool_call' };
    case 'tool-dispatch-started':
      return { ...toolDispatchStartedEvent(message), type: 'tool_dispatch_started' };
    case 'tool-result': return { ...toolResultEvent(message), type: 'tool_result' };
    case 'tool-invocation': return { ...toolInvocationEvent(message), type: 'tool_invocation' };
    case 'cosmo.usage': return { ...usageEvent(message), type: 'usage' };
    case 'cosmo.session-state':
      return { ...sessionStateWriteEvent(message), type: 'session_state' };
    case 'reconnecting': return { ...reconnectingEvent(message), type: 'reconnecting' };
    case 'session-ending-soon':
      return { ...sessionEndingSoonEvent(message), type: 'session_ending_soon' };
    case 'session-ended': return { ...sessionEndedEvent(message), type: 'session_ended' };
    case 'error': return { ...errorEvent(message), type: 'error' };
    case 'pong': return { ...pongEvent(message), type: 'pong' };
  }
}
