// The wire protocol this SDK speaks is declared in ``./protocol``, not
// re-exported from the schema-generated ``./wire/``. Every published type is
// therefore the SDK's own, so regenerating the backend schema cannot change a
// consumer's types on its own; ``protocol/__tests__/wire_parity.test.ts``
// holds each declaration identical to its generated twin.

export { setLogLevel, getLogLevel } from './core/logger';
export type { LogLevel } from './core/logger';
export { RealtimeClient } from './core/realtime_client';
export type { RealtimeClientOptions } from './core/realtime_client';

export { PreparedSession, RealtimeAgent } from './core/agent';
export {
  detectObjectsTool,
  endCallTool,
  examineImageTool,
  pointAtObjectTool,
  speakerLogTool,
  webSearchTool,
} from './core/agent';
export {
  GeminiModel,
  GrokModel,
  OpenAILiveModel,
  OpenAIMiniModel,
  OpenAIModel,
} from './core/agent';
export type {
  AgentConfig,
  AgentTool,
  AudioConfig,
  BackgroundClientToolHandler,
  ClientToolHandler,
  CatalogAgentOptions,
  CosmoVadConfig,
  GeminiToolResponsePolicy,
  RealtimeModel,
  RealtimeModelBlock,
  SessionStartOptions,
  VoiceConfig,
} from './core/agent';

export {
  DRAW_BOX_TOOL_NAME,
  DRAW_POINT_TOOL_NAME,
  drawBoxTool,
  drawPointTool,
  notShown,
  parseDrawBoxRequest,
  parseDrawPointRequest,
  shown,
} from './tool/draw';
export type {
  DrawBoxRequest,
  DrawOutcome,
  DrawPointRequest,
  NotShown,
  NormalizedBox,
  NormalizedPoint,
} from './tool/draw';

export {
  SCREEN_CLICK_TOOL_NAME,
  SCREEN_HIGHLIGHT_BOX_TOOL_NAME,
  SCREEN_HIGHLIGHT_TOOL_NAME,
  clicked,
  landedOnControl,
  landedOnEstimate,
  notClicked,
  parseScreenHighlightBoxRequest,
  screenClickElementTool,
  screenLocateTool,
  screenHighlightBoxTool,
  screenHighlightElementTool,
} from './tool/screen';
export type {
  ScreenAffordance,
  ScreenBox,
  ScreenCapture,
  ScreenCaptureHandler,
  ScreenCaptureRequest,
  ScreenClickAction,
  ScreenClickButton,
  ScreenClickOutcome,
  ScreenClickRequest,
  ScreenElement,
  ScreenElementHint,
  ScreenHighlightBoxRequest,
  ScreenHighlightOutcome,
  ScreenHighlightRequest,
  ScreenPlacement,
} from './tool/screen';

export { boxRect, pointPosition } from './tool/video_geometry';
export type {
  Point,
  Rect,
  Size,
  VideoContentMode,
  VideoPlacement,
} from './tool/video_geometry';

export { ClientToolJob } from './core/client_tool_jobs';

export {
  SessionStateError,
  type SessionStateErrorCode,
  AudioUnavailableError,
  type AudioUnavailableErrorCode,
  ApiError,
  RealtimeError,
} from './core/errors';

export {
  Hook,
  HookError,
  type HookErrorCode,
  postToolUse,
  preToolUse,
  sessionEnd,
  sessionStart,
} from './core/hooks';
export type {
  EndCall,
  HookEventName,
  Say,
  ServerHook,
  SilenceTimeout,
  PostToolUseContext,
  PostToolUseHook,
  PreToolUseContext,
  PreToolUseHook,
  PreToolUseResult,
  ServerHookAction,
  SessionStartContext,
  SessionStartHook,
  SessionStartResult,
  SessionEndContext,
  SessionEndHook,
  ToolOutcome,
} from './core/hooks';

export { SkillError, parseSkillMd } from './core/skills';
export type { SkillErrorCode } from './core/skills';
export type { Skill } from './core/skills';

// The only generated types on the public surface: closed string unions, whose
// members are the wire's values in every language, so they carry no wire
// spelling into user code. Everything else is declared in ``./protocol``.
export type {
  EndOfSpeechSensitivity,
  GrokReasoningEffort,
  InterruptionSensitivity,
  NoiseCancellation,
  SemanticEagerness,
  OpenAiLiveDelegation as OpenAILiveDelegation,
  OpenAiLiveReasoningEffort as OpenAILiveReasoningEffort,
  OpenAiLiveServiceTier as OpenAILiveServiceTier,
  OpenAiLiveToolChoice as OpenAILiveToolChoice,
  OpenAiLiveVerbosity as OpenAILiveVerbosity,
  ThinkingLevel,
} from './wire/types.gen';

export type { SessionConnectTimings } from './core/state';

// The wire shapes the barrel publishes. Declared in ``./protocol`` and
// imported, not re-exported, by the modules that use them, so they stay off
// the ``core/*`` entry points. ``ErrorCode`` is the server's error enum, a
// closed union of wire values that Python and Swift publish identically.
export type { DelegationChannel, ErrorCode, RejectedTool, SessionStartTimings } from './protocol';

export { RealtimeSession } from './core/session';
export type {
  RealtimeSessionEvent,
  SessionEndedEventItem,
  UnknownEvent,
} from './core/session';

export {
  CredentialsError,
  type CredentialsErrorCode,
  MintTokenError,
} from './core/auth';
export type { MintedToken, MintTokenErrorCode } from './core/auth';
export { TokenSourceError } from './core/token_source';
export type { TokenSourceErrorCode } from './core/token_source';

export { TokenSource } from './core/token_source';
export type { TokenSourceEndpointOptions } from './core/token_source';

export { VerifyError } from './core/verify';
export type {
  CredentialInfo,
  CredentialKind,
  VerifyErrorCode,
  VerifyWorkspace,
} from './core/verify';

export { UsageError } from './core/usage';
export type {
  SessionStatus,
  UsageErrorCode,
  UsageStatus,
  SessionTokenUsage,
  SessionUsage,
} from './core/usage';

// The React bindings are not re-exported here: importing them would pull
// react into the module graph of every consumer, including headless ones.
// They live at `cosmo-ai/react`.

export type { ErrorEvent, ScreenShareState } from './core/types';

export { DialError } from './transport/dial';
export type { DialResult, DialErrorCode } from './transport/dial';

export { SessionStartError } from './transport/session_start_error';
export type {
  SessionStartRejection,
  SessionStartErrorCode,
} from './transport/session_start_error';

export type {
  TransportState,
  AgentState,
  DisconnectReason,
  MediaState,
  OutputState,
  MicState,
  SessionState,
  SessionStateKind,
} from './core/state';

export type {
  DelegationCreatedEvent,
  UserSpeechTimeoutEvent,
  TranscriptDeltaEvent,
  TranscriptItem,
  TranscriptRole,
  TranscriptUpdatedEvent,
  ModelTextEvent,
  ToolCallEvent,
  ToolResultEvent,
  ToolDispatchStartedEvent,
  ReconnectingEvent,
  TurnCompleteEvent,
  PongEvent,
  VolumeEvent,
  ReadyEvent,
  ResolvedAgentInfo,
  RealtimeEventMap,
  RealtimeEventName,
  Unsubscribe,
} from './core/events';

export { SDK_NAME, SDK_VERSION } from './constants';

export type { NaturalnessRung } from './presets';
export {
  naturalness,
  NATURALNESS_INSTRUCTIONS,
  NATURALNESS_RUNGS,
  NATURALNESS_VERSION,
} from './presets';

export { PluginError } from './core/plugins';
export type { Plugin, PluginErrorCode } from './core/plugins';
