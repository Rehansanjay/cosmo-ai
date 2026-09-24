/**
 * The session-start request body and everything reachable from it.
 *
 * Declared by the SDK rather than re-exported from ``../wire/types.gen``, so
 * no generated symbol reaches a published entry point and a regenerated
 * schema cannot change a consumer's types without this file changing first.
 * ``__tests__/wire_parity.test.ts`` holds every twin identical to its
 * generated counterpart, so the decoupling costs no accuracy.
 *
 * Field spellings are the wire's, because these types are the wire. The
 * SDK's own camelCase surface lives in ``core/`` and maps onto these.
 *
 * The closed string unions the barrel re-exports by name stay generated:
 * their members are the wire's values in every language, so they carry no
 * wire spelling into user code. ``TurnDetectionMode`` is not one of them —
 * it reaches consumers only structurally, through this graph, so it is
 * declared here like the rest of the graph.
 */

import type {
  EndOfSpeechSensitivity,
  GrokReasoningEffort,
  InterruptionSensitivity,
  NoiseCancellation,
  OpenAiLiveDelegation,
  OpenAiLiveReasoningEffort,
  OpenAiLiveServiceTier,
  OpenAiLiveToolChoice,
  OpenAiLiveVerbosity,
  SemanticEagerness,
  ThinkingLevel,
} from '../wire/types.gen';
import type { SilenceTimeout } from './shared';

export type {
  EndOfSpeechSensitivity,
  GrokReasoningEffort,
  InterruptionSensitivity,
  NoiseCancellation,
  OpenAiLiveDelegation,
  OpenAiLiveReasoningEffort,
  OpenAiLiveServiceTier,
  OpenAiLiveToolChoice,
  OpenAiLiveVerbosity,
  SemanticEagerness,
  ThinkingLevel,
};

/**
 * Which turn detector ends the user's turn.
 *
 * ``server_vad`` ends the turn on a fixed silence window;
 * ``semantic_vad`` runs OpenAI's classifier that ends it as soon as the
 * utterance reads as complete (OpenAI-only); ``cosmo_vad`` runs Cosmo's own
 * semantic detector in the realtime worker (Gemini-only). ``None`` keeps
 * the provider default: ``server_vad`` on OpenAI and Grok, ``cosmo_vad``
 * on Gemini.
 */
export type TurnDetectionMode = 'server_vad' | 'semantic_vad' | 'cosmo_vad';

/**
 * Self-reported identity of the SDK that opened the session.
 *
 * ``name`` is the SDK's registry package name ("cosmo-ai-sdk" on PyPI,
 * "cosmo-ai" on npm, "cosmo-swift-sdk" for SwiftPM) — with ``version``,
 * exactly what is installed. Deployed clients keep sending the name they
 * were built with; a package rename maps the old name onto the new line
 * server-side.
 *
 * The pair is a claim, not a fact: it feeds telemetry and, for packages
 * we ship, support decisions — never authorization or billing. An unknown
 * or absent identity is bucketed, never refused.
 */
export type SdkInfo = {
    /**
     * Registry package name of the SDK, e.g. ``cosmo-ai-sdk``.
     */
    name: string;
    /**
     * Installed version of that package.
     */
    version: string;
};

/**
 * How the agent sounds: the prebuilt voice and the per-run speaking
 * style. One sub-object shared by both agent variants.
 */
export type VoiceConfig = {
    /**
     * Provider-specific prebuilt voice id. When ``None`` the upstream picks
     * per session — the voice then drifts between connects. Clients that want
     * a stable voice send one explicitly.
     */
    name?: string;
    /**
     * Caller-supplied "how to speak" instruction text, appended to the system
     * prompt as its own section after the persona. Resolved client-side (the SDK
     * calls a callback → string) before this is sent. ``None`` = none.
     */
    speaking_style?: string;
};

/**
 * The agent's audio pipeline, configured once — not per run.
 */
export type AudioConfig = {
    /**
     * Apply background-voice cancellation to the user's inbound audio before
     * it reaches the model. Off by default — send ``true`` when the microphone
     * will hear more than one voice. The isolator sits ahead of the model on the
     * inbound path, so it also filters what the model's own turn-taking hears:
     * an integrator who never asked for it should not pay its endpointing
     * cost.
     */
    noise_cancellation?: NoiseCancellation;
    /**
     * Whether the agent emits audio. ``False`` leaves the session silent —
     * for transcription, captioning, or text-response apps — while input
     * transcription and text output are unaffected. Part of the persona: a
     * text-only agent never speaks.
     *
     * How that silence is achieved depends on the provider, and it matters for
     * billing. A provider with a native text-only mode stops generating speech;
     * one without a modalities knob keeps generating audio and has its output
     * gated instead, so audio output tokens still accrue. Rejected at session
     * start when the resolved model owns its audio path end to end and cannot
     * be gated either way.
     */
    output?: boolean;
};

/**
 * Tuning for the ``cosmo_vad`` turn detector. Every knob names the
 * detector's own machinery, so a caller always knows which endpointer a
 * setting touches; an unset knob keeps the server default.
 */
export type CosmoVadConfig = {
    /**
     * Total silence, in milliseconds, after which the turn ends regardless
     * of the classifier's verdict — the bound on how long a pause the
     * classifier reads as mid-thought can hold the turn open.
     */
    max_hold_ms?: number;
    /**
     * Silence, in milliseconds, that triggers the end-of-turn inference.
     */
    pause_ms?: number;
    /**
     * Audio, in milliseconds, kept from before speech was detected, so a
     * turn's opening syllable is not clipped.
     */
    prefix_ms?: number;
};

/** Whether Gemini waits for a tool and when it responds to its result. */
export type GeminiToolResponsePolicy = {
    /** Blocking waits for a result; non_blocking allows conversation while it runs. */
    behavior: 'blocking' | 'non_blocking';
    /** Answer when idle, absorb silently, or interrupt speech. Omitted uses
     * when_idle on Gemini Live; Extended Thinking requires this omitted. */
    scheduling?: 'when_idle' | 'silent' | 'interrupt';
};

/**
 * The Gemini-realtime provider with its knobs. Assigning this block to
 * ``model`` picks the provider; the ``provider`` discriminator makes setting
 * a Gemini knob for any other provider a schema error rather than a silent
 * no-op.
 *
 * ``turn_detection`` selects which detector ends the user's turn, and each
 * detector owns its knobs: ``end_of_speech_sensitivity``,
 * ``silence_duration_ms`` and ``prefix_padding_ms`` tune the provider's
 * ``server_vad``; the ``cosmo_vad`` block tunes ``cosmo_vad`` (the Gemini
 * default). Naming a detector and sending the other one's knobs is rejected
 * at session start rather than silently ignored.
 */
export type GeminiModel = {
    /** Default tool behavior. Extended Thinking requires non-blocking without scheduling. */
    tool_response_policy?: GeminiToolResponsePolicy;
    /** Policies keyed by declared tool name, replacing the default for those tools. */
    tool_response_overrides?: { [key: string]: GeminiToolResponsePolicy };
    /**
     * Tuning for the ``cosmo_vad`` detector. Valid only while that detector
     * runs (``turn_detection`` unset or ``cosmo_vad``); sending it alongside
     * ``server_vad`` is rejected. ``None`` keeps the server defaults.
     */
    cosmo_vad?: CosmoVadConfig;
    /**
     * How readily the model decides the user's turn ended — the end-of-turn
     * counterpart to ``interruption_sensitivity``'s speech-start gate. ``high``
     * endpoints sooner, so the assistant answers faster but is more likely to
     * cut in on a mid-thought pause. Read only with ``server_vad``. ``None``
     * keeps the provider default.
     */
    end_of_speech_sensitivity?: EndOfSpeechSensitivity;
    /**
     * Whether the model streams thought summaries alongside its answer. Only
     * worth enabling for an app that reads them. ``None`` keeps the server's
     * per-mode default.
     */
    include_thoughts?: boolean;
    /**
     * Cap on tokens per model response. ``None`` uses the provider default.
     */
    max_output_tokens?: number;
    /**
     * Concrete Gemini model to run. ``None`` runs the provider default. A
     * model id that is not a Gemini model is rejected at session start.
     */
    model_id?: string;
    /**
     * Audio, in milliseconds, kept from before speech was detected, so a
     * turn's opening syllable is not clipped. Read only with ``server_vad``.
     * ``None`` keeps the provider default.
     */
    prefix_padding_ms?: number;
    /**
     * Names the provider this block configures. Always ``gemini``;
     * the SDKs stamp it, so you never write it yourself.
     */
    provider: 'gemini';
    /**
     * Silence, in milliseconds, that ends the user's turn. Lower shortens the
     * wait before the model starts answering; too low fragments a turn across a
     * natural pause. Read only with ``server_vad``. ``None`` keeps the provider
     * default.
     */
    silence_duration_ms?: number;
    /**
     * Sampling temperature — higher is more varied, lower more deterministic.
     * ``None`` uses the provider default.
     */
    temperature?: number;
    /**
     * Reasoning depth. ``None`` keeps the server's per-mode default.
     */
    thinking_level?: ThinkingLevel;
    /**
     * Which end-of-turn detector runs. ``None`` (the default) and
     * ``cosmo_vad`` run Cosmo's semantic turn detection, which classifies
     * whether the utterance reads as finished instead of timing a silence
     * window — a mid-thought pause no longer ends the turn. ``server_vad``
     * opts the session into the provider's own silence-window detection,
     * which is what the three knobs below tune; they are unread under the
     * default detector. ``semantic_vad`` is OpenAI-only and rejected.
     */
    turn_detection?: TurnDetectionMode;
};

/**
 * The OpenAI-Realtime provider with its knobs. OpenAI Realtime pins its
 * own sampling and token limits, so only turn-taking is tunable here.
 *
 * ``turn_detection`` selects which detector runs and decides which of the
 * remaining knobs apply: ``eagerness`` belongs to ``semantic_vad``, the two
 * window knobs to ``server_vad``. Sending a knob from the other mode is
 * rejected at session start rather than silently ignored.
 */
export type OpenAiModel = {
    /**
     * How eagerly ``semantic_vad`` closes the user's turn — ``high`` answers
     * sooner, ``low`` waits longer for them to continue. Valid only with
     * ``turn_detection: semantic_vad``. ``None`` keeps the provider default.
     */
    eagerness?: SemanticEagerness;
    /**
     * Concrete OpenAI Realtime model to run. ``None`` runs the provider
     * default. A model id that is not an OpenAI model is rejected at session
     * start.
     */
    model_id?: string;
    /**
     * Audio, in milliseconds, kept from before speech was detected. Valid only
     * with ``server_vad``. ``None`` keeps the server's default.
     */
    prefix_padding_ms?: number;
    /**
     * Names the provider this block configures. Always ``openai``;
     * the SDKs stamp it, so you never write it yourself.
     */
    provider: 'openai';
    /**
     * Silence, in milliseconds, that ends the user's turn. Valid only with
     * ``server_vad``. ``None`` keeps the server's default.
     */
    silence_duration_ms?: number;
    /**
     * Which turn detector runs. ``semantic_vad`` ends the turn as soon as the
     * utterance reads as complete rather than after a fixed silence window.
     * ``None`` keeps the provider default (``server_vad``).
     */
    turn_detection?: TurnDetectionMode;
};

/**
 * The OpenAI-Realtime mini tier — the same API as
 * ``OpenAIModel`` on a faster, cheaper model, and equally
 * untunable today.
 */
export type OpenAiMiniModel = {
    /**
     * Concrete mini-tier model to run. ``None`` runs the provider default.
     */
    model_id?: string;
    /**
     * Names the provider this block configures. Always ``openai_mini``;
     * the SDKs stamp it, so you never write it yourself.
     */
    provider: 'openai_mini';
};

/**
 * OpenAI's GPT Live full-duplex voice model. It listens and speaks at
 * once and decides itself when each turn starts and ends, so no turn
 * detector is tunable here; tool calls and reasoning are delegated to a
 * backend Responses model, which is what the knobs configure. Audio only:
 * a session on it ignores video and screen frames. A ``voice_…`` id on the agent's ``voice`` selects an authorized
 * custom voice.
 */
export type OpenAiLiveModel = {
    /**
     * Who does the work the voice model hands off. ``None`` is
     * ``responses``. Under ``client`` and ``cosmo`` the ``responses_*`` knobs
     * are unused and the agent may declare no tools.
     */
    delegation?: OpenAiLiveDelegation;
    /**
     * Cap on tokens one delegated response may generate. ``None`` keeps
     * OpenAI's default.
     */
    max_output_tokens?: number;
    /**
     * Concrete GPT Live model to run. ``None`` runs the provider default.
     */
    model_id?: string;
    /**
     * Whether one delegated turn may call several tools at once. ``None``
     * keeps OpenAI's default.
     */
    parallel_tool_calls?: boolean;
    /**
     * Names the provider this block configures. Always ``openai_live``;
     * the SDKs stamp it, so you never write it yourself.
     */
    provider: 'openai_live';
    /**
     * How hard the Responses model reasons on delegated work. ``None``
     * keeps OpenAI's default.
     */
    reasoning_effort?: OpenAiLiveReasoningEffort;
    /**
     * Instructions for the Responses model, distinct from the voice model's.
     * ``None`` gives it the agent's own instructions.
     */
    responses_instructions?: string;
    /**
     * The Responses model tool calls and reasoning are delegated to.
     * ``None`` runs the provider default.
     */
    responses_model?: string;
    /**
     * OpenAI processing tier for delegated work. ``None`` keeps
     * OpenAI's default.
     */
    service_tier?: OpenAiLiveServiceTier;
    /**
     * Whether a delegated turn must call a tool. ``None`` lets the model
     * decide (``auto``).
     */
    tool_choice?: OpenAiLiveToolChoice;
    /**
     * How much the Responses model writes back for the voice model to say.
     * ``None`` keeps OpenAI's default.
     */
    verbosity?: OpenAiLiveVerbosity;
};


/**
 * The xAI Grok Voice provider with its knobs. Grok pins its own sampling
 * and token limits; turn-taking, reasoning effort, and playback speed are
 * tunable here.
 *
 * Grok runs one detector — a fixed silence window — so the turn-taking
 * knobs below always apply. Naming any other detector is rejected at
 * session start rather than silently downgraded.
 */
export type GrokModel = {
    /**
     * Milliseconds of user silence after a response before the server
     * re-engages the user, re-arming after every response. ``None`` never
     * re-engages.
     */
    idle_timeout_ms?: number;
    /**
     * Concrete Grok Voice model to run. ``None`` runs the provider default.
     */
    model_id?: string;
    /**
     * Audio, in milliseconds, kept from before speech was detected. ``None``
     * keeps the server's default.
     */
    prefix_padding_ms?: number;
    /**
     * Names the provider this block configures. Always ``grok``;
     * the SDKs stamp it, so you never write it yourself.
     */
    provider: 'grok';
    /**
     * Whether the model reasons before speaking. Grok's own default is
     * ``high``, which buys benchmark-grade answers at multi-second turn
     * latency; ``none`` answers immediately. ``None`` keeps Grok's default.
     */
    reasoning_effort?: GrokReasoningEffort;
    /**
     * Silence, in milliseconds, that ends the user's turn. ``None`` keeps the
     * server's default.
     */
    silence_duration_ms?: number;
    /**
     * Playback-rate multiplier for the agent's speech (0.7–1.5). ``None``
     * keeps normal speed (1.0).
     */
    speed?: number;
    /**
     * Which turn detector runs. ``server_vad`` is the only one Grok offers,
     * and ``None`` selects it. ``semantic_vad`` and ``cosmo_vad`` are rejected —
     * the first is an OpenAI detector Grok has no equivalent of, the second is
     * Cosmo's own and runs only on Gemini.
     */
    turn_detection?: TurnDetectionMode;
};

/**
 * Opt-in to the server-executed web-search tool, as its own typed kind.
 *
 * The server owns the model-facing declaration (name, description, query
 * schema) — the client only opts in, so the spec carries no fields today.
 * Future configuration (result count, domain filters, freshness) lands as
 * typed fields here. Unknown fields are a schema error.
 *
 * Typed per-tool kinds supersede the generic ``kind="server"``
 * name-reference, which is deprecated and rejected at session start.
 * Availability is checked at session start: a
 * deployment or workspace that cannot run the tool starts the session
 * without it and reports the drop on ``ready.rejected_tools``.
 */
export type WebSearchToolSpec = {
    /**
     * The tool kind. Always ``web_search``.
     */
    kind: 'web_search';
};

/**
 * Opt-in to the server-executed frame-examination tool.
 *
 * Reads the freshest frame of the client's published video (camera or
 * screen share) at full resolution to answer a fine-detail question.
 * The server owns the model-facing declaration — zero-config; unknown
 * fields are a schema error. Sessions without a fresh frame get the
 * tool's own typed "no frame" answer at call time; there is no
 * session-start availability gate.
 */
export type ExamineImageToolSpec = {
    /**
     * The tool kind. Always ``examine_image``.
     */
    kind: 'examine_image';
};

/**
 * Opt-in to the server-executed object locator, which returns boxes.
 *
 * Locates a named object in the freshest camera/screen frame — one box
 * per matching instance — and hands the candidates to the model, which
 * picks one and passes it to whichever renderer the client declared.
 * Zero-config; unknown fields are a schema error. Availability is checked
 * at session start: a deployment that cannot run the tool starts the
 * session without it and reports the drop on ``ready.rejected_tools``.
 * A session with no frame gets the tool's own typed answer at call time.
 */
export type DetectObjectsToolSpec = {
    /**
     * The tool kind. Always ``detect_objects``.
     */
    kind: 'detect_objects';
};

/**
 * Opt-in to the server-executed object locator, which returns points.
 *
 * The sibling of ``detect_objects``: a marked point says one thing where
 * a box around a leaf includes everything behind it. Same zero-config and
 * availability terms.
 */
export type PointAtObjectToolSpec = {
    /**
     * The tool kind. Always ``point_at_object``.
     */
    kind: 'point_at_object';
};

/**
 * Opt-in to the server-executed hang-up tool, so the model can end the
 * call itself once the exchange is finished.
 *
 * The server owns the model-facing declaration — zero-config; unknown
 * fields are a schema error. No availability gate: declaring it is the
 * grant. Ending binds the call, not just the agent — every leg drops —
 * and the spoken goodbye is allowed to finish playing first.
 *
 * Not the ``end_call`` silence-hook action, which hangs up on a caller who
 * stopped talking; this is the hang-up the model decides on.
 */
export type EndCallToolSpec = {
    /**
     * The tool kind. Always ``end_call``.
     */
    kind: 'end_call';
};

/**
 * Opt-in to the server-kept speaker log of the room.
 *
 * The server runs a diarizing transcript of the room's audio beside the
 * model and offers a tool that reads the last few seconds of it back,
 * one stable label per voice (``S0``, ``S1``, …); the model binds labels
 * to people from what they say about themselves. Zero-config; unknown
 * fields are a schema error. Availability is checked at session start: a
 * deployment that cannot run the transcript starts the session without
 * it and reports the drop on ``ready.rejected_tools``.
 */
export type SpeakerLogToolSpec = {
    /**
     * The tool kind. Always ``speaker_log``.
     */
    kind: 'speaker_log';
};

/**
 * Opt-in to the server-executed screen locator.
 *
 * Resolves a description to an element on the client's shared screen and
 * hands the model an opaque handle for it, which the model passes to
 * whichever screen renderer the client declared
 * (``cosmo_sdk_screen_click_element`` /
 * ``cosmo_sdk_screen_highlight_element``). Not authorable: SDKs emit this
 * entry mechanically when the host supplies a screen-capture handler, whose
 * ``screen_capture`` RPC the locator drives. Zero-config;
 * unknown fields are a schema error.
 *
 * The locator itself has no availability gate.
 * ``cosmo_sdk_screen_click_element`` does — clicking acts on the user's
 * machine, so it stays behind the desktop-control policy, and a session that
 * cannot run it starts without it and reports the drop on
 * ``ready.rejected_tools`` under that name.
 */
export type ScreenLocateToolSpec = {
    /**
     * The tool kind. Always ``screen_locate``.
     */
    kind: 'screen_locate';
};

/**
 * One client-executed tool, self-described at session start.
 *
 * The server materializes a session-scoped tool definition from each spec,
 * so a new client tool ships with a client release alone — no per-tool
 * backend code. Field names mirror MCP's ``Tool`` descriptor.
 *
 * Only size/resource bounds are enforced here (they bind at the API edge);
 * content checks soft-reject per spec server-side and are echoed on
 * ``ReadyEvent.rejected_tools`` — a client can see *why* a spec was
 * dropped instead of debugging silence.
 */
export type ClientToolSpec = {
    /**
     * What the tool does, written for the model — this is what it decides
     * from when choosing to call it.
     */
    description: string;
    /**
     * The tool kind. Always ``client``.
     */
    kind: 'client';
    /**
     * Name the model calls the tool by, and the name the SDK dispatches on
     * locally. Unique within the session's tool set.
     */
    name: string;
    /**
     * JSON Schema for the tool's arguments — restricted dialect (``type`` /
     * ``properties`` / ``required`` / ``items`` / ``enum`` / ``description``),
     * top-level ``type: "object"``.
     */
    parameters: {
        [key: string]: unknown;
    };
};

/**
 * Attach a workspace-defined tool by its catalog name
 * (``voice_agent_tools.name``); the server resolves the stored definition.
 *
 * Protocol reservation only: the wire shape is fixed, but neither
 * session-start flow executes catalog tools yet — a config carrying one is
 * rejected with a typed 422 (``invalid_tool_config``). Unknown fields are
 * a schema error.
 */
export type CatalogToolSpec = {
    /**
     * The tool kind. Always ``catalog``.
     */
    kind: 'catalog';
    /**
     * Catalog name of the workspace-defined tool to attach. Reserved: no
     * session-start flow executes catalog tools yet, so a config carrying one
     * is refused.
     */
    name: string;
};

/**
 * Opt-in to one server-executed tool by its dot-namespaced name
 * (e.g. ``"cosmo.web_search"``).
 *
 * Deprecated and no longer executed anywhere: typed per-tool kinds
 * (``web_search``, ``examine_image``, ``detect``, ``point``,
 * ``end_call``) supersede the generic name-reference, and the flow that
 * honored it is gone — a config carrying one is rejected at session start
 * with a typed 422 (``invalid_tool_config``). ``cosmo.view_state`` /
 * ``cosmo.set_state`` have no typed kinds yet, so they are unreachable
 * until they gain them.
 *
 * Server tools execute server-side; the session observes them through the
 * ``tool-call`` / ``tool-dispatch-started`` / ``tool-result`` lifecycle.
 */
export type ServerToolSpec = {
    /**
     * The tool kind. Always ``server`` — the deprecated form, which
     * session start rejects.
     */
    kind: 'server';
    /**
     * Dot-namespaced name of the server tool, e.g. ``cosmo.web_search``.
     * Kept so the wire shape still decodes; use the tool's own typed kind
     * instead, since a config carrying this one is refused.
     */
    name: string;
};

/**
 * Unstable session-config knobs.
 *
 * Fields here are experimental: unlike the rest of the protocol they may
 * change shape or disappear between releases. Stable equivalents graduate
 * to top-level ``SessionConfig`` fields.
 */
export type TavusAvatar = {
    /**
     * Which Tavus face renders the agent.
     */
    face_id: string;
    provider: 'tavus';
};

/**
 * The avatar a session asks for, discriminated on ``provider``. One member
 * today; further renderers join the union without a transport change.
 */
export type Avatar = TavusAvatar;

export type ExperimentalParams = {
    /**
     * When set, a vendor renderer joins the room and republishes the
     * agent's speech as lip-synced video; the agent then publishes no audio
     * of its own. Refused, and the session starts without one, unless the
     * workspace has the avatar flag on.
     */
    avatar?: {
        provider?: 'tavus';
    } & TavusAvatar;
    /**
     * When set, the server resumes the named prior session — natively when
     * a resumption handle is still warm, otherwise by seeding the new
     * upstream session with the prior transcript. The server picks between
     * the two; clients just pass the id.
     */
    resume_session_id?: string;
};

/**
 * Define the agent inline — the persona/configuration of the model on
 * the other end, independent of any one run. Reused unchanged across
 * sessions. Catalog-only fields (``name``, ``inputs``) are structurally
 * absent — sending one is a schema error (``extra="forbid"``), so a
 * mistagged catalog launch fails loudly instead of silently running the
 * neutral default agent.
 */
export type InlineAgentConfig = {
    /**
     * The agent's audio pipeline — output emission and inbound noise
     * cancellation. ``None`` keeps every default (audio on, no
     * cancellation).
     */
    audio?: AudioConfig;
    /**
     * Opening line the assistant speaks first, voiced as soon as the model
     * session opens — before the client even receives ``ready``. Part of the
     * persona: what this agent says to open a call. ``None`` (the default)
     * keeps the wait-for-user behavior; a resumed session never re-greets.
     */
    greeting?: string;
    /**
     * Server hooks: declarative trigger→action configs the server
     * executes. On the wire these are the only hooks that exist — an SDK's
     * client-side callback hooks never serialize.
     */
    hooks?: Array<SilenceTimeout>;
    /**
     * Caller-supplied system instructions. Replaces the server's neutral
     * default when set; ``None`` keeps the default. Capped at 131072
     * characters, checked at session start; the cap is fixed rather than
     * derived from the selected model's context budget.
     */
    instructions?: string;
    /**
     * How readily user audio barges in over the assistant, and (where the
     * provider supports it) how long the assistant waits before
     * treating the user's turn as complete. ``low`` raises the provider's
     * speech-start gate and lengthens the end-of-turn wait, so ambient noise is
     * less likely to cut the assistant off mid-utterance and a pause or
     * backchannel is less likely to end the user's turn early — at the cost of
     * a slower response. ``high`` lowers both.
     */
    interruption_sensitivity?: InterruptionSensitivity;
    /**
     * What runs on the other end: a family alias or concrete model id
     * (string form), or a provider block carrying that provider's knobs and an
     * optional concrete ``model_id``. ``None`` lets the server choose its
     * default. The valid set is provider/workspace-dependent: the server
     * validates the value at session start and rejects unavailable ones
     * explicitly. Part of the persona: the same agent runs the same model the
     * same way across sessions.
     */
    model?: string | (({
        provider?: 'gemini';
    } & GeminiModel) | ({
        provider?: 'openai';
    } & OpenAiModel) | ({
        provider?: 'openai_mini';
    } & OpenAiMiniModel) | ({
        provider?: 'openai_live';
    } & OpenAiLiveModel) | ({
        provider?: 'grok';
    } & GrokModel));
    /**
     * Tool set for the session: client-executed specs the SDK fulfils
     * locally, opt-in server tools by typed kind, and inline server-tool
     * definitions (one wire kind per executor type). ``None`` / empty → the
     * session runs with no tools.
     */
    tools?: Array<({
        kind?: 'client';
    } & ClientToolSpec) | ({
        kind?: 'server';
    } & ServerToolSpec) | ({
        kind?: 'catalog';
    } & CatalogToolSpec) | ({
        kind?: 'web_search';
    } & WebSearchToolSpec) | ({
        kind?: 'examine_image';
    } & ExamineImageToolSpec) | ({
        kind?: 'detect_objects';
    } & DetectObjectsToolSpec) | ({
        kind?: 'point_at_object';
    } & PointAtObjectToolSpec) | ({
        kind?: 'screen_locate';
    } & ScreenLocateToolSpec) | ({
        kind?: 'end_call';
    } & EndCallToolSpec) | ({
        kind?: 'speaker_log';
    } & SpeakerLogToolSpec)>;
    /**
     * Selects the agent form. Always ``inline`` — an agent defined inline.
     */
    type: 'inline';
    /**
     * How the agent sounds — prebuilt voice id and speaking style. ``None``
     * keeps the server defaults for both.
     */
    voice?: VoiceConfig;
};

/**
 * Run a workspace catalog agent by handle — the stored config runs
 * verbatim. Only per-run ride-alongs may accompany the launch:
 * ``inputs`` (per-run input values), ``tools`` (client-executed
 * declarations the server cannot provide), and ``voice`` (per-run
 * speaking style plus the one cosmetic override). Other stored-config
 * fields (``instructions``, ``model``, …) are structurally absent from
 * this variant — sending one is a schema error (``extra="forbid"``), not
 * a runtime rejection.
 */
export type CatalogAgentConfig = {
    /**
     * Per-run values for the referenced agent's declared input fields
     * (e.g. ``{"caller_name": "Sam"}``), substituted into the resolved
     * prompt's ``{{key}}`` placeholders. ``None`` / empty injects nothing.
     */
    inputs?: {
        [key: string]: string;
    };
    /**
     * Workspace catalog agent to run, by its workspace-unique machine
     * handle (a hyphen-only slug). The server resolves it at session start
     * and fails closed — an unknown or cross-workspace name rejects before
     * any provider allocation.
     */
    name: string;
    /**
     * Tool set for the session: client-executed specs the SDK fulfils
     * locally, opt-in server tools by typed kind, and inline server-tool
     * definitions (one wire kind per executor type). Used verbatim — the
     * stored agent config carries no tools, so nothing is merged in.
     * ``None`` / empty → the session runs with no tools.
     */
    tools?: Array<({
        kind?: 'client';
    } & ClientToolSpec) | ({
        kind?: 'server';
    } & ServerToolSpec) | ({
        kind?: 'catalog';
    } & CatalogToolSpec) | ({
        kind?: 'web_search';
    } & WebSearchToolSpec) | ({
        kind?: 'examine_image';
    } & ExamineImageToolSpec) | ({
        kind?: 'detect_objects';
    } & DetectObjectsToolSpec) | ({
        kind?: 'point_at_object';
    } & PointAtObjectToolSpec) | ({
        kind?: 'screen_locate';
    } & ScreenLocateToolSpec) | ({
        kind?: 'end_call';
    } & EndCallToolSpec) | ({
        kind?: 'speaker_log';
    } & SpeakerLogToolSpec)>;
    /**
     * Selects the agent form. Always ``catalog`` — a workspace catalog agent by name.
     */
    type: 'catalog';
    /**
     * Per-run voice for the referenced agent: ``speaking_style`` is
     * client-resolved per-run text, and ``name`` is the one cosmetic exception
     * to "stored config runs verbatim" — it changes how the agent sounds,
     * never what it says or can do. ``None`` keeps the stored voice.
     */
    voice?: VoiceConfig;
};

/**
 * Per-run, transport-level options for one session — continuity and other
 * knobs that vary run-to-run for the same agent. Audio config lives on the
 * ``agent`` block (it's part of the agent, configured once).
 */
export type SessionParams = {
    /**
     * Unstable opt-in knobs (see ``ExperimentalParams``).
     * May change shape between releases.
     */
    experimental?: ExperimentalParams;
    /**
     * Requested wall-clock cap on the session, in seconds. The server
     * resolves the effective cap as the minimum of this and its own limits —
     * callers can only shorten, never extend. The effective value is echoed
     * on ``ready``; the server pushes ``session-ending-soon`` near the
     * deadline and ``session-ended`` at cutoff.
     */
    max_session_seconds?: number;
    /**
     * Persist this session's audio. Narrowing only: a session may ask for
     * less storage than the account's consents allow, never more. Unset defers
     * to ``store_recording``, then to those consents.
     */
    store_audio?: boolean;
    /**
     * Persist this session's recording artifacts (audio/video/transcript/tool
     * events) server-side. ``False`` writes nothing for the run. Unset stores as
     * much as the account's consents allow. The per-artifact fields below take
     * precedence over this one where both are sent.
     */
    store_recording?: boolean;
    /**
     * Persist this session's transcript and tool-call events. Same contract
     * as ``store_audio``.
     */
    store_transcript?: boolean;
    /**
     * Persist this session's screen-share video. Same contract as
     * ``store_audio``. Screenshots have no field of their own and follow
     * ``store_recording``, so turning this off does not stop them.
     */
    store_video?: boolean;
};

/**
 * Session-start payload for external sessions — carried on the HTTP
 * session-start request (or as the first frame on the WS connect path).
 * The server replies with ``ReadyEvent`` once the agent is up.
 *
 * Split into the two concerns of a session: ``agent`` (the persona — what the
 * model is) and ``session`` (per-run transport options). ``sdk`` identifies
 * the client (see ``SdkInfo``).
 */
export type SessionConfig = {
    /**
     * The persona to run: defined inline, or a reference to a workspace
     * catalog agent. Omitted runs the default agent.
     */
    agent?: ({
        type?: 'catalog';
    } & CatalogAgentConfig) | ({
        type?: 'inline';
    } & InlineAgentConfig);
    /**
     * Which SDK and version opened the session.
     */
    sdk: SdkInfo;
    /**
     * Per-run options for this session — storage consents, duration cap,
     * experimental knobs. Omitted takes every default.
     */
    session?: SessionParams;
    /**
     * The message type. Always ``session-config``.
     */
    type: 'session-config';
};
