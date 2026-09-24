import type { Plugin } from './plugins';
/**
 * ``RealtimeAgent`` — the reusable persona, and the cross-SDK entry point
 * for opening sessions.
 *
 * Build an agent once (``client.agent({instructions, voice, tools})``) and
 * start any number of sessions from it (``agent.start()``), or prepare one
 * ahead of its start (``agent.prepareSession()``). Python
 * (``cosmo_ai.Agent``) is the reference for shape and semantics.
 */

import type {
  Avatar,
  InterruptionSensitivity,
  NoiseCancellation,
  EndOfSpeechSensitivity,
  InlineAgentConfig,
  CatalogAgentConfig,
  SemanticEagerness,
  SessionConfig,
  SessionParams,
  GrokReasoningEffort,
  OpenAiLiveReasoningEffort as OpenAILiveReasoningEffort,
  OpenAiLiveDelegation as OpenAILiveDelegation,
  OpenAiLiveServiceTier as OpenAILiveServiceTier,
  OpenAiLiveToolChoice as OpenAILiveToolChoice,
  OpenAiLiveVerbosity as OpenAILiveVerbosity,
  ThinkingLevel,
} from '../protocol';

import { SDK_NAME, SDK_VERSION } from '../constants';
import { ToolDefinitionError } from '../tool/errors';
import { HookError } from './hooks';
import { isSdkClientTool } from '../tool/sdk_tool';
import type { ScreenCaptureHandler } from '../tool/screen';
import type { PreparedRoomRef } from '../transport/prepared_room';
import type { ClientToolJob } from './client_tool_jobs';
import { Hook, HookEngine, type ServerHook, resolveHooks } from './hooks';
import { log } from './logger';
import type { RealtimeClient } from './realtime_client';
import type { RealtimeSession } from './session';
import type { SessionState } from './state';
import {
  type Skill,
  buildLoadSkillTool,
  menuText,
  resolveSkills,
} from './skills';

/** An async client-tool handler: the returned object is the tool result
 *  reported back to the agent. Throw to surface a tool error. ``args`` is
 *  the decoded tool-call arguments. ``signal`` is aborted when the agent
 *  withdraws the call or the session ends. */
export type ClientToolHandler = (
  args: Record<string, unknown>,
  signal?: AbortSignal,
) => Promise<Record<string, unknown> | null | undefined | void>;

/** A background client-tool handler: ack the call with ``job.ack(note)``
 *  (releasing the RPC reply while the handler keeps running), then deliver
 *  the result later with ``job.complete(...)`` / ``job.fail(...)`` — never
 *  by returning a value. */
export type BackgroundClientToolHandler = (
  args: Record<string, unknown>,
  job: ClientToolJob,
) => Promise<void>;

/** A tool the client executes locally: the SDK declares it at session
 *  start, the server routes matching invocations back over the transport
 *  RPC bridge, and the ``handler`` runs them — a declared tool always
 *  carries its execution. For a method the server invokes over RPC without
 *  advertising it to the model, use ``session.registerRpcMethod``. */
export type ClientTool = {
  kind: 'client';
  background?: undefined;
  name: string;
  description: string;
  /** JSON-Schema object describing the tool's arguments. */
  parameters: Record<string, unknown>;
  /** Local execution callback — never serialized to the wire. */
  handler: ClientToolHandler;
};

/** A long-running client tool, declared explicitly (the cross-SDK,
 *  arity-free shape): the handler acks the call immediately and delivers
 *  its terminal result later through the ``ClientToolJob``. Serializes to
 *  the same ``kind: 'client'`` wire shape as ``ClientTool`` — the
 *  server infers deferral from the reply, so nothing on the wire changes. */
export type BackgroundClientTool = {
  kind: 'client';
  background: true;
  name: string;
  description: string;
  /** JSON-Schema object describing the tool's arguments. */
  parameters: Record<string, unknown>;
  /** Local execution callback — never serialized to the wire. */
  handler: BackgroundClientToolHandler;
};

/** Opt-in to the server-executed web-search tool. The server owns the
 *  model-facing declaration — zero-config. */
export type WebSearchTool = {
  kind: 'web_search';
};

/** Opt-in to the server-executed frame-examination tool: reads the
 *  freshest frame of the published video at full resolution to answer a
 *  fine-detail question. Zero-config. */
export type ExamineImageTool = {
  kind: 'examine_image';
};

/** Opt-in to the server-executed object locator that returns boxes — one
 *  per matching instance. Zero-config. */
export type DetectObjectsTool = {
  kind: 'detect_objects';
};

/** Opt-in to the server-executed object locator that returns points.
 *  Zero-config. */
export type PointAtObjectTool = {
  kind: 'point_at_object';
};

/** Opt-in to the server-executed hang-up, so the agent can end the call
 *  itself. Zero-config. Ending binds the call, not just the agent — every
 *  leg drops — and the spoken goodbye is allowed to finish first. Without
 *  it the agent can't hang up. */
export type EndCallTool = {
  kind: 'end_call';
};

/** Opt-in to the server-kept speaker log of the room: a diarizing
 *  transcript runs beside the model, and the agent can read the last few
 *  seconds back with one stable label per voice (``S0``, ``S1``, …). It
 *  binds labels to people from what they say about themselves. Zero-config. */
export type SpeakerLogTool = {
  kind: 'speaker_log';
};

/** Opt-in to the server-executed screen locator, ``cosmo_screen_locate``.
 *
 *  The other server-tool opt-ins are bare kinds because the server already has
 *  what they need. This one does not: it grounds against a screenshot and an
 *  element list only the client can produce, so seeing the screen is its
 *  configuration. It is not a client tool — the model never calls it, and the
 *  SDK answers the locator's capture RPC from ``capture`` instead. */
export type ScreenLocateTool = {
  /** Discriminates this arm of the ``AgentToolPayload`` union. */
  kind: 'screen_locate';
  /** Snapshot the screen the locator grounds against. The element list is an
   *  allowlist by construction: the model can only ever be handed something
   *  put in it, and an empty list resolves to no match. */
  capture: ScreenCaptureHandler;
};

/** Brand that keeps a hand-written object literal from passing as an
 *  ``AgentTool``; only a tool constructor can mint one. Type-level only;
 *  nothing extra is serialized. @internal */
declare const AGENT_TOOL_BRAND: unique symbol;

/** Anything that can be handed to ``client.agent({tools})``. Every tool is
 *  built by calling its constructor, so this is the only tool type a caller
 *  ever names — the type is opaque, and the per-tool shapes it stands for
 *  are internal. */
export type AgentTool = {
  readonly [AGENT_TOOL_BRAND]: true;
};

/** The structural union behind the opaque {@link AgentTool}: what the
 *  constructors build and the wire lowering narrows on. @internal */
export type AgentToolPayload =
  | ClientTool
  | BackgroundClientTool
  | WebSearchTool
  | ExamineImageTool
  | DetectObjectsTool
  | PointAtObjectTool
  | ScreenLocateTool
  | EndCallTool
  | SpeakerLogTool;

/** Constructor-only door from the structural payload to the opaque public
 *  type. The brand is type-level, so the runtime object is the payload
 *  itself. @internal */
export function mintAgentTool(payload: AgentToolPayload): AgentTool {
  return payload as unknown as AgentTool;
}

/** The inverse door: recover the structural payload the lowering and
 *  handler registration narrow on. @internal */
export function agentToolPayload(tool: AgentTool): AgentToolPayload {
  return tool as unknown as AgentToolPayload;
}

/** Web search, run on Cosmo's backend. */
export function webSearchTool(): AgentTool {
  return mintAgentTool({ kind: 'web_search' });
}

/** Examine the freshest published video frame at full resolution. */
export function examineImageTool(): AgentTool {
  return mintAgentTool({ kind: 'examine_image' });
}

/** Read who said what from the room's speaker-labelled transcript. */
export function speakerLogTool(): AgentTool {
  return mintAgentTool({ kind: 'speaker_log' });
}

/** Locate a named object in the frame, returning one box per instance. */
export function detectObjectsTool(): AgentTool {
  return mintAgentTool({ kind: 'detect_objects' });
}

/** Locate a named object in the frame, returning points. */
export function pointAtObjectTool(): AgentTool {
  return mintAgentTool({ kind: 'point_at_object' });
}

/** Let the agent hang up the call itself. */
export function endCallTool(): AgentTool {
  return mintAgentTool({ kind: 'end_call' });
}

/** Tuning for the ``cosmo_vad`` turn detector. Every knob names the
 *  detector's own machinery, so a caller always knows which endpointer a
 *  setting touches; an unset knob keeps the server default. */
export type CosmoVadConfig = {
  /** Silence (ms, 0–5000) that triggers the end-of-turn inference. */
  pauseMs?: number;
  /** Audio (ms, 0–5000) kept from before speech was detected, so a turn's
   *  opening syllable is not clipped. */
  prefixMs?: number;
  /** Total silence (ms, 0–5000) after which the turn ends regardless of the
   *  classifier's verdict. */
  maxHoldMs?: number;
};

/** Whether Gemini waits for a tool and when it responds to its result. */
export type GeminiToolResponsePolicy = {
  /** Blocking waits for a result; non_blocking allows conversation while it runs. */
  behavior: 'blocking' | 'non_blocking';
  /** Answer when idle, absorb silently, or interrupt speech. Unset uses when_idle
   * on Gemini Live; Extended Thinking requires this omitted. */
  scheduling?: 'when_idle' | 'silent' | 'interrupt';
};

/** The Gemini-realtime provider with its knobs. Assigning this block to
 *  ``model`` picks the provider; the ``provider`` discriminator makes setting
 *  a Gemini knob for another provider a type error rather than a silent
 *  no-op.
 *
 *  ``turnDetection`` selects which detector ends the user's turn, and each
 *  detector owns its knobs: ``endOfSpeechSensitivity``, ``silenceDurationMs``
 *  and ``prefixPaddingMs`` tune the provider's ``server_vad``; the
 *  ``cosmoVad`` block tunes ``cosmo_vad``. The union makes pairing a knob
 *  with the other detector a type error; the server rejects the same pairing
 *  rather than silently ignoring it. */
export type GeminiModel = {
  /** Default tool behavior. Unset keeps tools blocking, except Extended Thinking,
   * which requires non-blocking tools and does not accept scheduling. */
  toolResponsePolicy?: GeminiToolResponsePolicy;
  /** Policies keyed by declared tool name, replacing the default for those tools. */
  toolResponseOverrides?: Record<string, GeminiToolResponsePolicy>;
  /** Names the provider this block configures. Always ``gemini``;
   *  the constructor stamps it, so you never write it yourself. */
  provider: 'gemini';
  /** Concrete Gemini model to run. Unset runs the provider default. A model
   *  id that is not a Gemini model is rejected at session start. */
  modelId?: string;
  /** Sampling temperature (0–2) — higher is more varied, lower more
   *  deterministic. Unset uses the provider default. */
  temperature?: number;
  /** Cap on tokens per model response. Unset uses the provider default. */
  maxOutputTokens?: number;
  /** Reasoning depth. Unset keeps the server's per-mode default. */
  thinkingLevel?: ThinkingLevel;
  /** Stream thought summaries alongside the answer. Only worth enabling for
   *  an app that reads them. Unset keeps the server's per-mode default. */
  includeThoughts?: boolean;
} & (
  | {
      /** Opts the session into the provider's silence-window detection,
       *  which is what the three knobs on this branch tune. Unset (the
       *  default) is Cosmo's semantic turn detection; the knobs are unread
       *  under it. */
      turnDetection?: 'server_vad';
      /** How readily the model decides the user's turn ended — the
       *  end-of-turn counterpart to ``interruptionSensitivity``'s
       *  speech-start gate. ``high`` endpoints sooner, so the assistant
       *  answers faster but is more likely to cut in on a mid-thought
       *  pause. Read only with ``server_vad``. Unset keeps the provider
       *  default. */
      endOfSpeechSensitivity?: EndOfSpeechSensitivity;
      /** Silence (ms, 0–5000) that ends the user's turn. Read only with
       *  ``server_vad``. Unset keeps the provider default. */
      silenceDurationMs?: number;
      /** Audio (ms, 0–5000) kept from before speech was detected, so a
       *  turn's opening syllable is not clipped. Read only with
       *  ``server_vad``. Unset keeps the provider default. */
      prefixPaddingMs?: number;
      cosmoVad?: never;
    }
  | {
      /** Names the default detector explicitly: Cosmo's own semantic
       *  detector — a pause triggers one end-of-turn inference, so a
       *  mid-thought pause holds the turn open. */
      turnDetection: 'cosmo_vad';
      /** Tuning for the ``cosmo_vad`` detector. Unset keeps the server
       *  defaults. */
      cosmoVad?: CosmoVadConfig;
      endOfSpeechSensitivity?: never;
      silenceDurationMs?: never;
      prefixPaddingMs?: never;
    }
);

/** The OpenAI-Realtime provider with its knobs. OpenAI Realtime pins its own
 *  sampling and token limits, so only turn-taking is tunable here.
 *
 *  ``turnDetection`` decides which of the remaining knobs apply: ``eagerness``
 *  belongs to ``semantic_vad``, the two window knobs to ``server_vad``. The
 *  union makes pairing one with the other detector a type error; the server
 *  rejects the same pairing rather than silently ignoring it. */
export type OpenAIModel =
  | {
      /** Names the provider this block configures. Always ``openai``;
   *  the constructor stamps it, so you never write it yourself. */
  provider: 'openai';
      /** Concrete OpenAI Realtime model to run. Unset runs the provider
       *  default. */
      modelId?: string;
      /** Ends the turn after a fixed window of silence. Unset keeps the
       *  provider default, which is this detector. */
      turnDetection?: 'server_vad';
      /** Silence (ms, 0–5000) that ends the user's turn. */
      silenceDurationMs?: number;
      /** Audio (ms, 0–5000) kept from before speech was detected. */
      prefixPaddingMs?: number;
      eagerness?: never;
    }
  | {
      /** Names the provider this block configures. Always ``openai``;
   *  the constructor stamps it, so you never write it yourself. */
  provider: 'openai';
      /** Concrete OpenAI Realtime model to run. Unset runs the provider
       *  default. */
      modelId?: string;
      /** Ends the turn as soon as the utterance reads as complete. */
      turnDetection: 'semantic_vad';
      /** How eagerly the classifier closes the user's turn — ``high``
       *  answers sooner, ``low`` waits longer for them to continue. */
      eagerness?: SemanticEagerness;
      silenceDurationMs?: never;
      prefixPaddingMs?: never;
    };

/** The OpenAI-Realtime mini tier — the same API on a faster, cheaper model,
 *  and equally untunable today. */
export type OpenAIMiniModel = {
  /** Names the provider this block configures. Always ``openai_mini``;
   *  the constructor stamps it, so you never write it yourself. */
  provider: 'openai_mini';
  /** Concrete mini-tier model to run. Unset runs the provider default. */
  modelId?: string;
};

/** OpenAI's GPT Live full-duplex voice model. It listens and speaks at once
 *  and decides itself when each turn starts and ends, so no turn detector is
 *  tunable here; tool calls and reasoning are delegated to a backend
 *  Responses model, which is what the knobs configure. Audio only: a session
 *  on it ignores video and screen frames. A ``voice_…`` id on the agent's
 *  ``voice`` selects an authorized custom voice. */
export type OpenAILiveModel = {
  /** Names the provider this block configures. Always ``openai_live``;
   *  the constructor stamps it, so you never write it yourself. */
  provider: 'openai_live';
  /** Concrete GPT Live model to run. Unset runs the provider default. */
  modelId?: string;
  /** The Responses model tool calls and reasoning are delegated to, from
   *  the server's allowlist of small tiers; a model outside it is rejected
   *  at session start. Unset runs the provider default. */
  responsesModel?: string;
  /** Instructions for the Responses model, distinct from the voice model's.
   *  Unset gives it the agent's own instructions. */
  responsesInstructions?: string;
  /** How hard the Responses model reasons on delegated work. Unset keeps
   *  OpenAI's default. */
  reasoningEffort?: OpenAILiveReasoningEffort;
  /** How much the Responses model writes back for the voice model to say.
   *  Unset keeps OpenAI's default. */
  verbosity?: OpenAILiveVerbosity;
  /** Whether a delegated turn must call a tool. Unset lets the model decide
   *  (``auto``). */
  toolChoice?: OpenAILiveToolChoice;
  /** Whether one delegated turn may call several tools at once. Unset keeps
   *  OpenAI's default. */
  parallelToolCalls?: boolean;
  /** Cap on tokens one delegated response may generate (16–32768). Unset
   *  keeps OpenAI's default. */
  maxOutputTokens?: number;
  /** OpenAI processing tier for delegated work. Unset keeps OpenAI's
   *  default. */
  serviceTier?: OpenAILiveServiceTier;
  /** Who does the work the voice model hands off. Unset is ``responses``.
   *  Under ``client`` and ``cosmo`` the ``responses*`` knobs are unused and
   *  the agent may declare no tools. */
  delegation?: OpenAILiveDelegation;
};

/** The xAI Grok Voice provider with its knobs. Grok pins its own sampling and
 *  token limits; turn-taking, reasoning effort, and playback speed are
 *  tunable here.
 *
 *  Grok runs one detector — a fixed silence window — so the turn-taking
 *  knobs always apply. Naming any other detector is rejected at session
 *  start. */
export type GrokModel = {
  /** Names the provider this block configures. Always ``grok``;
   *  the constructor stamps it, so you never write it yourself. */
  provider: 'grok';
  /** Concrete Grok Voice model to run. Unset runs the provider default. */
  modelId?: string;
  /** Ends the turn after a fixed window of silence — the only detector Grok
   *  offers, and what unset selects. */
  turnDetection?: 'server_vad';
  /** Silence (ms, 0–5000) that ends the user's turn. */
  silenceDurationMs?: number;
  /** Audio (ms, 0–5000) kept from before speech was detected. */
  prefixPaddingMs?: number;
  /** Whether the model reasons before speaking. Grok's own default is
   *  ``high``, which buys deliberate answers at multi-second turn latency;
   *  ``none`` answers immediately. Unset keeps Grok's default. */
  reasoningEffort?: GrokReasoningEffort;
  /** Playback-rate multiplier for the agent's speech (0.7–1.5). Unset keeps
   *  normal speed. */
  speed?: number;
  /** Milliseconds of user silence after a response before the server
   *  re-engages the user, re-arming after every response. Unset never
   *  re-engages. */
  idleTimeoutMs?: number;
};

/** The block form of ``RealtimeModel``, discriminated on ``provider``. The
 *  provider a knob belongs to owns it — ``thinkingLevel`` lives only on the
 *  Gemini block — so an illegal pairing is a type error. */
export type RealtimeModelBlock =
  | GeminiModel
  | OpenAIModel
  | OpenAIMiniModel
  | OpenAILiveModel
  | GrokModel;

/** What runs on the other end. The string form is a provider family alias
 *  ('gemini', 'openai', 'openai_mini', 'openai_live', …) running that provider's default
 *  model, or a concrete model id. The block form picks the provider, carries
 *  its knobs, and optionally pins the concrete model via ``modelId``. One
 *  field names the provider exactly once, so a model/knob provider mismatch
 *  is unrepresentable. */
export type RealtimeModel = string | RealtimeModelBlock;

/** Each arm of a block type minus the ``provider`` tag the constructor
 *  stamps. Distributes over the arms so detector-scoped knobs keep their
 *  scoping — a flattening ``Omit`` would let an illegal pairing typecheck. */
type WithoutProvider<T> = T extends { provider: string }
  ? Omit<T, 'provider'>
  : never;

/** Builds a ``GeminiModel`` block, stamping the ``provider`` tag so the
 *  caller names the provider once by calling the constructor — the same
 *  once-naming Python's class and Swift's case give. The tagged literal
 *  stays valid; it is the wire shape this returns. */
export const GeminiModel = (
  options: WithoutProvider<GeminiModel> = {},
): GeminiModel => ({ provider: 'gemini', ...options }) as GeminiModel;

/** Builds an ``OpenAIModel`` block, stamping the ``provider`` tag. */
export const OpenAIModel = (
  options: WithoutProvider<OpenAIModel> = {},
): OpenAIModel => ({ provider: 'openai', ...options }) as OpenAIModel;

/** Builds an ``OpenAIMiniModel`` block, stamping the ``provider`` tag. */
export const OpenAIMiniModel = (
  options: WithoutProvider<OpenAIMiniModel> = {},
): OpenAIMiniModel => ({ provider: 'openai_mini', ...options });

/** Builds an ``OpenAILiveModel`` block, stamping the ``provider`` tag. */
export const OpenAILiveModel = (
  options: WithoutProvider<OpenAILiveModel> = {},
): OpenAILiveModel => ({ provider: 'openai_live', ...options });

/** Builds a ``GrokModel`` block, stamping the ``provider`` tag. */
export const GrokModel = (
  options: WithoutProvider<GrokModel> = {},
): GrokModel => ({ provider: 'grok', ...options });

/** How the agent sounds — the prebuilt voice and the per-run speaking
 *  style. Accepted anywhere a plain voice-id string is, when a speaking
 *  style rides along. */
export type VoiceConfig = {
  /** Provider voice id. Unset lets the upstream pick per session. */
  name?: string;
  /** "How to speak" instruction appended after the persona. */
  speakingStyle?: string;
};

/** The agent's audio pipeline, configured once — not per run. */
export type AudioConfig = {
  /** Whether the agent emits audio. ``false`` runs the session text-only:
   *  input transcription and text output are unaffected. Rejected at
   *  session start when the resolved model cannot run text-only. */
  output?: boolean;
  /** Which filter cleans the user's inbound audio before the model hears
   *  it. ``'denoise'`` removes noise and keeps every voice, for a microphone
   *  several people share; ``'voice_focus'`` also removes competing voices,
   *  keeping only the one it judges primary, for a single speaker. Unset is
   *  ``'off'``. */
  noiseCancellation?: NoiseCancellation;
};

/** The inline persona — what the agent is, independent of any one run.
 *  To run a workspace catalog agent by handle instead, use
 *  ``client.catalogAgent(name, {...})`` — this type has no catalog-launch
 *  fields, so the two cannot be mixed. */
export type AgentConfig = {
  /** Bundles expanded in order before directly supplied contributions. */
  plugins?: readonly Plugin[];
  /** System instructions. Replaces the server's neutral default when set. */
  instructions?: string;
  /** What runs on the other end: a family alias or concrete model id (string
   *  form), or a provider block carrying that provider's knobs and an optional
   *  concrete ``modelId``. Unknown or workspace-unavailable values are
   *  rejected at session start. */
  model?: RealtimeModel;
  /** How the agent sounds: the voice id as a plain string, or a
   *  ``VoiceConfig`` when a speaking style rides along. */
  voice?: string | VoiceConfig;
  /** Tool set for the session: client-executed specs plus server-tool
   *  opt-ins. Unset → the session runs with no tools. */
  tools?: AgentTool[];
  /** How readily user audio barges in over the assistant. */
  interruptionSensitivity?: InterruptionSensitivity;
  /** Opening line the assistant speaks as soon as the model session opens.
   *  Part of the persona: what this agent says to open a call. A resumed
   *  session never re-greets. */
  greeting?: string;
  /** The agent's audio pipeline — output emission and inbound noise
   *  cancellation. Part of the agent config so an
   *  agent's audio handling is configured once, not per run. Unset sends no
   *  audio block at all, so every knob keeps its server default —
   *  ``noiseCancellation`` among them, which is ``'off'``. */
  audio?: AudioConfig;
  /** Skills for this agent: the skill menu is folded into the instructions
   *  at ``start()`` and a ``cosmo_sdk_load_skill`` client tool serves skill
   *  bodies on demand. Duplicate names throw when the agent is built. Skills
   *  never cross the wire as such. */
  skills?: Skill[];
  /** One list, two kinds of hooks: in-process client hooks built by the
   *  seam factories (``sessionStart(fn)``, ``preToolUse(fn, {matcher})``,
   *  …; list order is fold order) and declarative server hooks
   *  (``SilenceTimeout``) the server executes even if this process dies
   *  mid-call. */
  hooks?: (Hook | ServerHook)[];
};

/** Per-run ride-alongs for ``client.catalogAgent(name, {...})`` — the
 *  stored config runs verbatim, so there are no persona fields here;
 *  sending one with a catalog launch is a type error, not a server rejection. */
export type CatalogAgentOptions = {
  /** Values for the referenced agent's declared input fields, substituted
   *  into the resolved prompt's ``{{key}}`` placeholders. */
  inputs?: Record<string, string>;
  /** Client-executed declarations (plus server-tool opt-ins), used
   *  verbatim as the session's tool set — the stored agent config carries
   *  no tools, so nothing is merged in. */
  tools?: AgentTool[];
  /** Per-run voice: the override id as a plain string, or a ``VoiceConfig``
   *  carrying a speaking style. The voice id is the one cosmetic exception
   *  to "stored config runs verbatim" — it never changes what the agent
   *  says (cf. Vapi's per-call assistant overrides). */
  voice?: string | VoiceConfig;
  /** In-process client hooks (seam-factory ``Hook``s). Server hooks are
   *  stored config — declare them on the catalog agent, not here. */
  hooks?: Hook[];
};

/** @internal — the resolved persona a ``RealtimeAgent`` holds: an inline
 *  config, or a catalog launch (``name`` set) whose only other fields
 *  are the ``CatalogAgentOptions`` ride-alongs. The public factories keep
 *  the two shapes apart at the type level. */
export type ResolvedAgentConfig = AgentConfig & {
  name?: string;
  inputs?: Record<string, string>;
};

/** Per-run, transport-level options for one ``agent.start()``. Persona
 *  fields — including ``greeting`` and the ``audio`` pipeline — live
 *  on ``AgentConfig``; build another agent to change them. */
export type SessionStartOptions = {
  /** Resume the named prior session — natively when the resumption handle
   *  is still warm, otherwise by seeding the new upstream session with the
   *  prior transcript. */
  resumeSessionId?: string;
  /** Ask for a video avatar: a renderer joins the session and republishes
   *  the agent's speech as lip-synced video, which ``<RealtimeVideo />``
   *  plays. Server-gated — a workspace without the avatar flag runs the
   *  session without one. */
  avatar?: Avatar;
  /** Persist this run's recording artifacts (audio/video/transcript/tool
   *  events) server-side. Unset stores as much as the account's consents
   *  allow. The per-artifact options below win over this one. */
  storeRecording?: boolean;
  /** Persist this run's audio. Narrowing only: a session can request less
   *  storage than the account permits, never more. Unset defers to
   *  ``storeRecording``, then to those consents. */
  storeAudio?: boolean;
  /** Persist this run's transcript and tool-call events. Same contract as
   *  ``storeAudio``. */
  storeTranscript?: boolean;
  /** Persist this run's screen-share video and screenshots. Same contract as
   *  ``storeAudio``. */
  storeVideo?: boolean;
  /** Publish the local microphone track into the room. Defaults to ``true``
   *  (a normal voice session). Set ``false`` to join as a silent observer —
   *  e.g. an operator watching a session that dials an outbound call via
   *  ``session.dial()``, where a second mic in the room would echo the
   *  callee's audio.
   *
   *  Client-side only (the backend never sees it). The agent's ear is
   *  unaffected either way — the worker binds its input to whichever
   *  participant actually carries the voice (a published mic, or the
   *  answered phone leg). */
  publishMicrophone?: boolean;
  /** Observe the run's connection lifecycle (``idle → connecting →
   *  connected ↔ reconnecting → disconnected``). Subscribed before the
   *  connect begins, so the callback sees the full state prefix — states
   *  that fire before ``start()`` resolves included. Stops at this run's
   *  terminal state. */
  onStateChange?: (state: SessionState) => void;
  /** Receive the session before its connect begins — the same object
   *  ``start()`` resolves to. Callbacks attached here are in place before
   *  any event can fire, which is the only way to observe events the
   *  connect itself produces: ``start()`` resolves after the transport is
   *  up, and only ``ready`` and ``lifecycle`` replay to late subscribers.
   *  A run that fails to start still calls this, then throws. */
  onSession?: (session: RealtimeSession) => void;
};

function prune<T extends object>(obj: T): T | undefined {
  const entries = Object.entries(obj).filter(([, v]) => v !== undefined);
  if (entries.length === 0) return undefined;
  return Object.fromEntries(entries) as T;
}

/** Wire form of ``voice``: a plain string is the voice id shorthand. */
function toWireVoice(
  voice: string | VoiceConfig | undefined,
): { name?: string; speaking_style?: string } | undefined {
  if (voice === undefined) return undefined;
  if (typeof voice === 'string') return { name: voice };
  return prune({ name: voice.name, speaking_style: voice.speakingStyle });
}

/** Wire form of ``audio``. */
function toWireAudio(audio: AudioConfig | undefined):
  | {
      output?: boolean;
      noise_cancellation?: NoiseCancellation;
    }
  | undefined {
  if (audio === undefined) return undefined;
  return prune({
    output: audio.output,
    noise_cancellation: audio.noiseCancellation,
  });
}

/** The wire form of a client tool: the declared spec with every local-only
 *  execution field (``handler``, the ``background`` marker) excluded by
 *  type, so a new local field cannot leak onto the wire unnoticed. */
type WireClientTool = Omit<ClientTool, 'handler' | 'background'>;

/** Zero-config typed server-tool opt-ins serialize as their bare kind —
 *  including ``screen_locate``, whose local capture handler is stripped the
 *  same way a client tool's is. */
type WireServerToolOptIn = {
  kind:
    | 'web_search'
    | 'examine_image'
    | 'detect_objects'
    | 'point_at_object'
    | 'screen_locate'
    | 'end_call'
    | 'speaker_log';
};

/** Strip local-only fields (``handler``, ``capture``, the ``background``
 *  marker) so the wire body carries only the declared spec — a background tool
 *  serializes identically to a plain client tool. */
function toWireTool(
  tool: AgentToolPayload,
): WireServerToolOptIn | WireClientTool {
  if (
    tool.kind === 'web_search' ||
    tool.kind === 'examine_image' ||
    tool.kind === 'detect_objects' ||
    tool.kind === 'point_at_object' ||
    tool.kind === 'screen_locate' ||
    tool.kind === 'end_call' ||
    tool.kind === 'speaker_log'
  ) {
    return { kind: tool.kind };
  }
  const { name, description, parameters } = tool;
  return { kind: 'client', name, description, parameters };
}

/** Map the ergonomic (camelCase) model onto its wire form. The string form
 *  crosses as-is; a block sends only the selected provider's knobs. */
function toWireModel(
  mo: RealtimeModel,
): NonNullable<InlineAgentConfig['model']> {
  if (typeof mo === 'string') {
    return mo;
  }
  switch (mo.provider) {
    case 'gemini':
      return {
        provider: 'gemini',
        ...prune({
          model_id: mo.modelId,
          tool_response_policy: mo.toolResponsePolicy,
          tool_response_overrides: mo.toolResponseOverrides,
          temperature: mo.temperature,
          max_output_tokens: mo.maxOutputTokens,
          thinking_level: mo.thinkingLevel,
          include_thoughts: mo.includeThoughts,
          ...(mo.turnDetection === 'cosmo_vad'
            ? {
                turn_detection: mo.turnDetection,
                cosmo_vad: mo.cosmoVad
                  ? prune({
                      pause_ms: mo.cosmoVad.pauseMs,
                      prefix_ms: mo.cosmoVad.prefixMs,
                      max_hold_ms: mo.cosmoVad.maxHoldMs,
                    })
                  : undefined,
              }
            : {
                turn_detection: mo.turnDetection,
                end_of_speech_sensitivity: mo.endOfSpeechSensitivity,
                silence_duration_ms: mo.silenceDurationMs,
                prefix_padding_ms: mo.prefixPaddingMs,
              }),
        }),
      };
    case 'openai':
      return {
        provider: 'openai',
        ...prune({ model_id: mo.modelId }),
        ...prune(
          mo.turnDetection === 'semantic_vad'
            ? { turn_detection: mo.turnDetection, eagerness: mo.eagerness }
            : {
                turn_detection: mo.turnDetection,
                silence_duration_ms: mo.silenceDurationMs,
                prefix_padding_ms: mo.prefixPaddingMs,
              },
        ),
      };
    case 'openai_mini':
      return { provider: 'openai_mini', ...prune({ model_id: mo.modelId }) };
    case 'openai_live':
      return {
        provider: 'openai_live',
        ...prune({
          model_id: mo.modelId,
          responses_model: mo.responsesModel,
          responses_instructions: mo.responsesInstructions,
          reasoning_effort: mo.reasoningEffort,
          verbosity: mo.verbosity,
          tool_choice: mo.toolChoice,
          parallel_tool_calls: mo.parallelToolCalls,
          max_output_tokens: mo.maxOutputTokens,
          service_tier: mo.serviceTier,
          delegation: mo.delegation,
        }),
      };
    case 'grok':
      return {
        provider: 'grok',
        ...prune({
          model_id: mo.modelId,
          turn_detection: mo.turnDetection,
          silence_duration_ms: mo.silenceDurationMs,
          prefix_padding_ms: mo.prefixPaddingMs,
          reasoning_effort: mo.reasoningEffort,
          speed: mo.speed,
          idle_timeout_ms: mo.idleTimeoutMs,
        }),
      };
  }
}

/** Fold the skills into the persona: the menu rides resident in the
 *  instructions and the ``cosmo_sdk_load_skill`` tool joins the tool set.
 *  That tool sits in the reserved namespace, so a caller tool claiming its
 *  name is rejected at config assembly rather than colliding here. */
function applySkills(config: AgentConfig): AgentConfig {
  const skills = resolveSkills(config.skills);
  const loadTool = buildLoadSkillTool(skills);
  if (loadTool === null) return config;
  const menu = menuText(skills);
  const instructions = config.instructions
    ? `${config.instructions}\n\n${menu}`
    : menu;
  return {
    ...config,
    instructions,
    tools: [...(config.tools ?? []), mintAgentTool(loadTool)],
  };
}

/** Client-tool names reserved for the tools the SDK ships itself. The SDK
 *  owns those names and schemas, so a caller's tool taking one would swap it
 *  for something the model was told behaves differently. The wider ``cosmo_``
 *  namespace belongs to server tools; this is the slice carved out of it for
 *  client-executed SDK tools. */
export const SDK_TOOL_NAME_PREFIX = 'cosmo_sdk_';

/** Thrown while the caller is still looking at the tool that caused it,
 *  rather than surfacing as the server's 422 at session start. The SDK's own
 *  renderers pass by construction — see ``markSdkClientTool`` — so taking an
 *  SDK tool's exact name is rejected like any other squat. */
function assertNoReservedToolNames(
  tools: readonly AgentToolPayload[] | undefined,
): void {
  for (const tool of tools ?? []) {
    if (tool.kind !== 'client') continue;
    if (!tool.name.startsWith(SDK_TOOL_NAME_PREFIX)) continue;
    if (isSdkClientTool(tool)) continue;
    throw new ToolDefinitionError({
      code: 'invalid_tool_name',
      message:
        `${tool.name}: the ${SDK_TOOL_NAME_PREFIX} prefix is reserved for tools ` +
        'the SDK ships — rename your tool',
    });
  }
}

/** Map one agent + per-run options onto the external ``session-config``
 *  wire body. ``undefined`` fields are omitted (server defaults apply). */
export function buildAgentSessionConfig(
  config: ResolvedAgentConfig,
  options: SessionStartOptions & { serverHooks?: ServerHook[] },
): SessionConfig {
  const toolPayloads = config.tools?.map(agentToolPayload);
  assertNoReservedToolNames(toolPayloads);
  const wireTools =
    toolPayloads !== undefined && toolPayloads.length > 0
      ? toolPayloads.map(toWireTool)
      : undefined;

  let agent: CatalogAgentConfig | InlineAgentConfig | undefined;
  if (config.name !== undefined) {
    // A catalog launch carries only per-run ride-alongs; the factory
    // split keeps stored config out at the type level — guard here so a
    // derived or hand-built config with stored fields fails before it
    // touches the wire.
    // Server hooks are refused as a hook problem, the same way Python's
    // resolve_hooks refuses them, so one catch covers hook registration
    // whichever guard rejects it.
    if ((options.serverHooks ?? []).length > 0) {
      throw new HookError({
        code: 'server_hook_not_allowed',
        message: 'a catalog agent runs its stored config verbatim — server hooks cannot ride along',
      });
    }
    const offending = [
      ['instructions', config.instructions],
      ['model', config.model],
      ['interruptionSensitivity', config.interruptionSensitivity],
      ['greeting', config.greeting],
      ['audio', config.audio],
    ]
      .filter(([, value]) => value !== undefined)
      .map(([key]) => key);
    if (offending.length > 0) {
      throw new Error(
        'a catalog agent runs its stored config verbatim — remove: ' +
          offending.join(', '),
      );
    }
    agent = {
      type: 'catalog',
      name: config.name,
      ...prune({
        inputs: config.inputs,
        tools: wireTools,
        voice: toWireVoice(config.voice),
      }),
    };
  } else {
    const fields = prune({
      instructions: config.instructions,
      model: config.model !== undefined ? toWireModel(config.model) : undefined,
      voice: toWireVoice(config.voice),
      interruption_sensitivity: config.interruptionSensitivity,
      hooks: (options.serverHooks ?? []).length > 0 ? options.serverHooks : undefined,
      tools: wireTools,
      greeting: config.greeting,
      audio: toWireAudio(config.audio),
    });
    agent = { type: 'inline', ...fields };
  }

  const session: SessionParams = {
    store_recording: options.storeRecording,
    store_audio: options.storeAudio,
    store_transcript: options.storeTranscript,
    store_video: options.storeVideo,
    experimental:
      options.resumeSessionId !== undefined || options.avatar !== undefined
        ? {
            ...(options.resumeSessionId !== undefined
              ? { resume_session_id: options.resumeSessionId }
              : {}),
            ...(options.avatar !== undefined ? { avatar: options.avatar } : {}),
          }
        : undefined,
  };

  return {
    type: 'session-config',
    sdk: { name: SDK_NAME, version: SDK_VERSION },
    agent,
    session: prune(session),
  };
}

/**
 * A configured persona, ready to open sessions from.
 *
 * ```ts
 * const agent = client.agent({ instructions: 'Be brief.', tools: [...] });
 * const session = await agent.start();
 * ```
 *
 * Built by ``client.agent()`` (an inline persona) or
 * ``client.catalogAgent()`` (one stored in the workspace). The instance is
 * frozen at construction, so its fields cannot be reassigned, and its
 * configuration reads back off it (``agent.instructions``, ``agent.voice``,
 * …). The freeze is shallow: values you passed in are held by reference,
 * not copied, so mutating an array or object you handed to ``agent()``
 * still changes what later starts send.
 *
 * Reusable: call ``start()`` as many times as you like, concurrently if you
 * want, and each call returns its own independent ``RealtimeSession``. Use
 * ``prepareSession()`` instead when you know a session is coming and want it
 * to start faster.
 */
export class RealtimeAgent {
  private readonly client: RealtimeClient;
  /** The resolved persona, kept whole for the fold at ``start()``. The
   *  fields below are the caller's view of it. */
  private readonly resolved: Readonly<ResolvedAgentConfig>;

  /** Catalog handle this agent was built from, if any. */
  readonly name?: string;
  /** Values bound into the catalog agent's stored template. */
  readonly inputs?: Record<string, string>;
  /** System instructions as given. Unset means the server's default runs —
   *  this never reads back the server's own text. */
  readonly instructions?: string;
  /** What was requested, verbatim: the alias or id string, or the provider
   *  block. Unset leaves the choice to the server, and this does not tell you
   *  what it chose — read the session's usage summary for that. */
  readonly model?: RealtimeModel;
  /** The voice as given, string id or ``VoiceConfig``. */
  readonly voice?: string | VoiceConfig;
  /** Tools as given, in declaration order. This is the configured list,
   *  not the effective one: when ``skills`` are set, ``start()`` appends the
   *  load-skill tool, and that addition is not reflected here. */
  readonly tools?: AgentTool[];
  /** Barge-in setting as given. */
  readonly interruptionSensitivity?: InterruptionSensitivity;
  /** Opening line, if one was set. */
  readonly greeting?: string;
  /** Audio pipeline settings as given. */
  readonly audio?: AudioConfig;
  /** Skills as given. Names are checked for duplicates when the agent is
   *  built, but the list is otherwise verbatim — this SDK does no directory
   *  expansion, so every skill is one you constructed. */
  readonly skills?: Skill[];
  /** Hooks as declared, both kinds in one array: ``Hook`` runs in-process
   *  here, ``ServerHook`` is sent for the server to run. */
  readonly hooks?: (Hook | ServerHook)[];

  /** @internal — construct via ``client.agent()`` / ``client.catalogAgent()``. */
  constructor(client: RealtimeClient, config: ResolvedAgentConfig) {
    // Validate at build, not at start() — a duplicate skill name or a
    // malformed hooks element throws the instant the agent is built,
    // matching the Python reference.
    resolveSkills(config.skills);
    resolveHooks(config.hooks);
    this.client = client;
    this.resolved = Object.freeze({ ...config });
    this.name = config.name;
    this.inputs = config.inputs;
    this.instructions = config.instructions;
    this.model = config.model;
    this.voice = config.voice;
    this.tools = config.tools;
    this.interruptionSensitivity = config.interruptionSensitivity;
    this.greeting = config.greeting;
    this.audio = config.audio;
    this.skills = config.skills;
    this.hooks = config.hooks;
    // The persona is fixed at creation. `readonly` is compile-time only, so
    // the freeze is what actually holds it — it used to sit on the config
    // object these fields replaced.
    Object.freeze(this);
  }

  /** Open one session from this persona. Resolves once the session is
   *  ready — the server's handshake has landed and every session method is
   *  usable immediately. Rejects on any failure to get there — the caller
   *  never receives a session for a run that failed to start. A server
   *  rejection throws the most specific ``SessionStartError`` subclass
   *  (``SessionStartError``, ``SessionStartError``, ``SessionStartError``,
   *  ``SessionStartError``); a request that never reached the server
   *  throws ``SessionStartError``; a room that closes before
   *  ready throws ``SessionStartError`` (the server's pre-close error
   *  frame rides on ``detail``); a ready handshake that never arrives is
   *  torn down after a bounded wait and throws ``SessionStartError``.
   *  Each start is independent — sessions from one client run concurrently. */
  async start(options: SessionStartOptions = {}): Promise<RealtimeSession> {
    return this.client._startSession(this.startArgs(options));
  }

  /** Prepare one session ahead of its start, so it starts faster. Reserves
   *  a room in the background immediately; the returned ``PreparedSession``
   *  joins it while the session request is still in flight when you call
   *  ``prepared.start()``, instead of waiting for a room to be allocated.
   *  Prepare as early as the app knows a session is coming — while the rest
   *  of its setup runs — and start when the user is ready. ``options`` are
   *  the same per-run options ``start()`` takes; they are fixed here, and
   *  the start takes none.
   *
   *  Purely an accelerator: a reservation that failed, lapsed, or is
   *  declined by the server leaves the start on the ordinary path, with the
   *  same result as ``start()``. Throws when this client's sessions do not
   *  run in rooms (the ``websocket`` transport, or a custom
   *  ``transportFactory``). */
  prepareSession(options: SessionStartOptions = {}): PreparedSession {
    if (!this.client._canPrepareRooms) {
      throw new Error(
        'prepareSession needs the default webrtc transport; other lanes have no rooms to prepare',
      );
    }
    return new PreparedSession(this.client, this.startArgs(options));
  }

  private startArgs(options: SessionStartOptions): StartSessionArgs {
    const { clientHooks, serverHooks } = resolveHooks(this.hooks);
    const effective = applySkills(this.resolved);
    const config = buildAgentSessionConfig(effective, { ...options, serverHooks });
    const tools = (effective.tools ?? []).map(agentToolPayload);
    return {
      config,
      publishMicrophone: options.publishMicrophone ?? true,
      onStateChange: options.onStateChange,
      onSession: options.onSession,
      clientTools: tools.filter(
        (tool): tool is ClientTool | BackgroundClientTool =>
          tool.kind === 'client',
      ),
      screenLocate: tools.find(
        (tool): tool is ScreenLocateTool => tool.kind === 'screen_locate',
      ),
      hooks: clientHooks.length > 0 ? new HookEngine(clientHooks) : undefined,
    };
  }
}

/** Everything one start needs, folded from the persona and the per-run
 *  options. Built once by ``RealtimeAgent``, so a prepared session can hold
 *  it until it is started. @internal */
type StartSessionArgs = Parameters<RealtimeClient['_startSession']>[0];

// The server's prepared join token and room both live 30 minutes; a room
// older than this is presumed lapsed and dropped rather than risking a join
// against a reclaimed room. Matches the Python and Swift guards. A held
// reservation is renewed a minute before that, so the replacement lands
// while the old room is still good.
const PREPARED_ROOM_MAX_AGE_MS = 26 * 60 * 1000;
const PREPARED_ROOM_REFRESH_MS = PREPARED_ROOM_MAX_AGE_MS - 60 * 1000;

/** One session prepared ahead of its start, from
 *  ``agent.prepareSession()``: a room reserved in the background that
 *  ``start()`` joins while the session request is still in flight.
 *
 *  The reservation is refreshed in the background until the handle is
 *  started or closed, so one held for hours stays warm. ``start()`` is
 *  single-use — prepare another session for another start — and a handle
 *  that will never be started should be ``close()``d so the refresh stops. */
export class PreparedSession {
  readonly #client: RealtimeClient;
  readonly #args: StartSessionArgs;
  #room: PreparedRoomRef | null = null;
  #inflight: Promise<PreparedRoomRef | null>;
  #refresh: ReturnType<typeof setTimeout> | null = null;
  #consumed = false;

  /** @internal — construct via ``agent.prepareSession()``. */
  constructor(client: RealtimeClient, args: StartSessionArgs) {
    this.#client = client;
    this.#args = args;
    this.#inflight = this.#reserve();
  }

  /** Land a reservation, then schedule its renewal before the room lapses;
   *  one the server declines ends the refresh and the start runs
   *  ordinarily. */
  async #reserve(): Promise<PreparedRoomRef | null> {
    const room = await this.#client._prepareRoom();
    if (room === null || this.#consumed) return room;
    this.#room = room;
    const timer = setTimeout(() => {
      this.#inflight = this.#reserve();
    }, PREPARED_ROOM_REFRESH_MS);
    // A held reservation must not keep a Node process alive on its own.
    if (typeof timer === 'object' && 'unref' in timer) timer.unref();
    this.#refresh = timer;
    return room;
  }

  /** Start the prepared session. Resolves and rejects exactly as
   *  ``agent.start()`` does; throws on a second call — the handle is
   *  single-use. */
  async start(): Promise<RealtimeSession> {
    if (this.#consumed) {
      throw new Error('PreparedSession.start is single-use — prepare another session.');
    }
    this.#consumed = true;
    this.#stopRefresh();
    const connectStartedAt = performance.now();
    // A reservation still in flight is worth the wait: the room it is about
    // to produce still takes the join off the critical path.
    const room = (await this.#inflight) ?? this.#room;
    this.#room = null;
    let prepared: PreparedRoomRef | undefined;
    if (room !== null) {
      if (Date.now() - room.preparedAt > PREPARED_ROOM_MAX_AGE_MS) {
        log.debug('[realtime] reserved room lapsed — starting unprepared');
      } else {
        prepared = room;
      }
    }
    return this.#client._startSession({ ...this.#args, prepared, connectStartedAt });
  }

  /** Drop the reservation and stop refreshing it. A no-op once started. */
  close(): void {
    this.#consumed = true;
    this.#stopRefresh();
    this.#room = null;
  }

  #stopRefresh(): void {
    if (this.#refresh !== null) {
      clearTimeout(this.#refresh);
      this.#refresh = null;
    }
  }
}
