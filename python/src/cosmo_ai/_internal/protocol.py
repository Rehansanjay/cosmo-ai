"""External realtime wire protocol — typed models for the published SDK surface.

Hand-written Pydantic mirrors of the external protocol's component schemas
(the published realtime OpenAPI spec, exported from the backend wire models). Drift between these
models and the spec fails a CI pin test.

Forward compatibility: a server frame with an unrecognized ``type`` (or a
recognized type that fails validation) surfaces as :class:`UnknownEvent` and
the session stays alive — decode failures are never terminal.
"""

from __future__ import annotations

import re
import uuid
from collections.abc import Awaitable, Callable
from datetime import datetime
from enum import Enum
from typing import TYPE_CHECKING, Annotated, Any, Literal, Union
from uuid import UUID

from pydantic import (
    BaseModel,
    ConfigDict,
    Field,
    ValidationError,
    model_validator,
)
from pydantic.json_schema import SkipJsonSchema

from cosmo_ai._version import __version__

if TYPE_CHECKING:
    from cosmo_ai.tools._jobs import ClientToolJob


SDK_NAME = "cosmo-ai-sdk"
"""The PyPI package name, sent as the SDK identity on ``session-config`` and
the ``X-Cosmo-SDK`` request header."""

SDK_VERSION = __version__
"""The package version, carried in the package itself."""

_INSTRUCTIONS_MAX_LEN = 16384
_SPEAKING_STYLE_MAX_LEN = 8192
_VOICE_MAX_LEN = 128
_TOOL_SPECS_MAX_COUNT = 64
_CLIENT_TOOL_MAX_NAME_LEN = 64
_CLIENT_TOOL_MAX_DESCRIPTION_LEN = 2048
_SERVER_HOOKS_MAX_COUNT = 16
_SERVER_HOOK_TEXT_MAX_LEN = 4096
_SERVER_HOOK_NAME_MAX_LEN = 256
_CONTEXT_NOTE_MAX_CHARS = 4096


def _new_message_id() -> str:
    """Per-message UUID4 hex — for log correlation + transport-level dedupe."""
    return uuid.uuid4().hex


# ─────────────────────────────────────────────────────────────────────────────
# Shared
# ─────────────────────────────────────────────────────────────────────────────


class TranscriptRole(str, Enum):
    """Speaker for a transcript fragment.

    Members are lowercase so ``event.role == "assistant"`` reads the way
    Python developers expect, matching the other Cosmo SDKs' developer-facing
    surface. The wire spells these ``"USER"`` / ``"ASSISTANT"``; decoding
    accepts either casing, so the wire form never reaches user code.
    """

    USER = "user"
    """The person on the call."""
    ASSISTANT = "assistant"
    """The agent."""

    @classmethod
    def _missing_(cls, value: object) -> "TranscriptRole | None":
        if isinstance(value, str):
            lowered = value.lower()
            for member in cls:
                if member.value == lowered:
                    return member
        return None


class ErrorCode(str, Enum):
    """Stable error codes clients switch on to choose a recovery UX."""

    AUTH_FAILED = "auth_failed"
    """The credential was rejected. Re-minting a token or fixing the API key
    is the only recovery; retrying as-is will not help."""
    WORKSPACE_FORBIDDEN = "workspace_forbidden"
    """The credential is valid but not allowed to run this session."""
    VOICE_DISABLED = "voice_disabled"
    """Realtime voice is not configured for this deployment or workspace."""
    UPSTREAM_DISCONNECT = "upstream_disconnect"
    """The model provider dropped the connection. Usually fatal for the
    session; start a new one."""
    INTERNAL_ERROR = "internal_error"
    """The server failed for a reason it does not attribute to the client."""
    INVALID_MESSAGE = "invalid_message"
    """A frame this SDK sent did not decode or did not validate."""
    VERSION_MISMATCH = "version_mismatch"
    """This SDK is older than the server's supported floor. Upgrade the
    package; nothing about the session can be retried."""

    @classmethod
    def _missing_(cls, value: object) -> "ErrorCode | None":
        # The server authors this set, so a deployment newer than this package
        # can name a value it does not. Keep it as a member carrying the raw
        # string rather than raising: rejecting would cost the whole payload,
        # not just this field. Openness lives on the type so no field can be
        # widened and no use site can forget — the same place TypeScript and
        # Swift put it.
        if isinstance(value, str):
            member = str.__new__(cls, value)
            member._name_ = value.upper()
            member._value_ = value
            return member
        return None


class NoiseCancellation(str, Enum):
    """Which filter cleans the user's inbound audio before the model hears it.

    ``DENOISE`` removes non-speech noise and keeps every voice in the room —
    the mode for a microphone several people share. ``VOICE_FOCUS`` also
    removes competing *voices*, keeping only the one it judges primary, which
    is what a single-speaker setup wants and what a shared microphone must
    avoid: to it, the second person is background.
    """

    OFF = "off"
    DENOISE = "denoise"
    VOICE_FOCUS = "voice_focus"


class InterruptionSensitivity(str, Enum):
    """How readily user audio barges in over the assistant."""

    DEFAULT = "default"
    """The provider's own barge-in behavior."""
    HIGH = "high"
    """Cuts in readily — good for a quiet headset, more likely to interrupt
    on background noise."""
    LOW = "low"
    """Holds the floor longer, so ambient noise is less likely to interrupt
    the assistant mid-sentence."""


class GrokReasoningEffort(str, Enum):
    """Whether the Grok Voice model reasons before speaking."""

    HIGH = "high"
    """Grok's own default: deliberate answers at multi-second turn latency."""
    NONE = "none"
    """Answers immediately, without a reasoning pass."""


class OpenAILiveReasoningEffort(str, Enum):
    """How hard the Responses model behind GPT Live reasons on delegated
    work (tool calls and lookups)."""

    MINIMAL = "minimal"
    LOW = "low"
    MEDIUM = "medium"
    HIGH = "high"


class OpenAILiveVerbosity(str, Enum):
    """How much the Responses model behind GPT Live writes back for the
    voice model to say."""

    LOW = "low"
    """Short delegated answers."""
    MEDIUM = "medium"
    HIGH = "high"


class OpenAILiveToolChoice(str, Enum):
    """Whether the Responses model behind GPT Live must call a tool on each
    delegated turn."""

    AUTO = "auto"
    """The model decides."""
    REQUIRED = "required"
    """Every delegated turn calls at least one tool."""
    NONE = "none"
    """Tools are declared but never called."""


class OpenAILiveServiceTier(str, Enum):
    """OpenAI processing tier for the Responses model behind GPT Live."""

    AUTO = "auto"
    DEFAULT = "default"
    FLEX = "flex"
    """Cheaper, slower."""
    PRIORITY = "priority"
    """Faster, dearer."""


class OpenAILiveDelegation(str, Enum):
    """Where GPT Live sends the work it decides a turn needs. The voice
    model itself only listens and speaks."""

    RESPONSES = "responses"
    """A backend Responses model, configured by the ``responses_*`` knobs,
    runs the reasoning and the agent's tools."""
    CLIENT = "client"
    """Your application does the work. Each hand-off arrives as a
    ``delegation-created`` event carrying the user's request; you answer
    through ``delegation-append`` messages. No tools run on the model, so
    an agent under client delegation declares none."""
    COSMO = "cosmo"
    """Cosmo's workspace agent does the work on the server, with the
    workspace's tools and skills, and speaks its findings back through the
    voice model. Each hand-off still arrives as a ``delegation-created``
    event, and ``delegation-append`` still steers the model."""


class DelegationChannel(str, Enum):
    """How an appended text reaches the voice model."""

    THINKING = "thinking"
    """Background the model keeps to itself and draws on when relevant."""
    COMMENTARY = "commentary"
    """Something for the model to say now, in its own words."""
    INSTRUCTIONS = "instructions"
    """Guidance that changes how the model behaves from here on."""


class ThinkingLevel(str, Enum):
    """Reasoning depth the client may request for the Gemini realtime model."""

    MINIMAL = "minimal"
    """Barely deliberates. Fastest to first audio, and most likely to act on
    context it should have questioned."""
    LOW = "low"
    """Light deliberation — enough to weigh what it was given."""
    MEDIUM = "medium"
    """More reasoning per turn, at a latency cost before the agent speaks."""
    HIGH = "high"
    """Most reasoning, slowest to answer. For agents that have something to
    work out rather than conversational ones."""


class EndOfSpeechSensitivity(str, Enum):
    """How readily the Gemini realtime model decides the user's turn ended —
    the end-of-turn counterpart to ``InterruptionSensitivity``'s speech-start
    gate. ``high`` endpoints sooner, so the assistant answers faster."""

    LOW = "low"
    """Waits longer before deciding the turn ended, so a mid-thought pause is
    less likely to cut the speaker off."""
    HIGH = "high"
    """Ends the turn sooner, so the assistant answers faster."""


class TurnDetectionMode(str, Enum):
    """Which turn detector ends the user's turn. ``server_vad`` ends the turn
    on a fixed silence window; ``semantic_vad`` (OpenAI) ends it as soon as
    the utterance reads as complete; ``cosmo_vad`` (Gemini) runs Cosmo's own
    semantic detector server-side. Unset keeps the provider default:
    ``server_vad`` on OpenAI and Grok, ``cosmo_vad`` on Gemini."""

    SERVER_VAD = "server_vad"
    """Fixed silence window. Available on every provider, and the only
    detector Grok offers."""
    SEMANTIC_VAD = "semantic_vad"
    """OpenAI's own detector, which ends the turn once the utterance reads as
    complete. OpenAI only."""
    COSMO_VAD = "cosmo_vad"
    """Cosmo's semantic detector, which classifies whether the utterance is
    finished rather than timing silence. Gemini only, and its default."""


class SemanticEagerness(str, Enum):
    """How eagerly OpenAI's ``semantic_vad`` closes the user's turn. ``low``
    waits longer for the user to continue, ``high`` responds sooner; ``auto``
    behaves like ``medium``."""

    LOW = "low"
    """Waits longest for the speaker to continue."""
    MEDIUM = "medium"
    """Balanced."""
    HIGH = "high"
    """Answers as soon as the utterance reads as complete."""
    AUTO = "auto"
    """Provider's choice; behaves like ``MEDIUM`` today."""


class SessionStartTimings(BaseModel):
    """Server-side phase breakdown of session start (milliseconds).

    A phase the serving flow doesn't have reports ``0`` rather than a
    fabricated split; ``resolve_ms`` covers the server's single
    resolution seam and is absent from a backend that predates it.
    """

    version_check_ms: int
    """Checking the client's SDK version against the supported floor."""
    project_check_ms: int
    """Resolving and authorizing the calling project."""
    provider_resolve_ms: int
    """Choosing the model provider and confirming it is available here."""
    db_insert_ms: int
    """Recording the session row."""
    mint_tokens_ms: int
    """Minting the room join token."""
    dispatch_ms: int
    """Dispatching the agent to the room. Reports ``0`` when dispatch
    runs after the response, where it costs the client nothing."""
    total_ms: int
    """The whole server-side start, end to end. Not the sum of the
    phases above — phases folded into ``resolve_ms`` report ``0``
    individually."""
    resolve_ms: int | None = None
    """Version check, project, provider, tools and limits, resolved
    together and reported as one number. The phases folded into it
    report ``0`` in their own fields rather than a fabricated split, and
    ``dispatch_ms`` reports ``0`` too — dispatch runs after the
    response, so it costs the client nothing."""


# ─────────────────────────────────────────────────────────────────────────────
# Tool specs (session-config payload)
# ─────────────────────────────────────────────────────────────────────────────


ClientToolHandler = Callable[[dict[str, Any]], Awaitable[dict[str, Any] | None]]
"""An async client-tool handler: ``async (args) -> result``. ``args`` is the
decoded tool-call arguments; the returned dict is reported back to the agent as
the tool result. A handler may return ``None`` for an empty (``null``) result —
the reply envelope's ``result`` slot is ``object | null``. Raise to surface a
tool error. The handler is local-only — it is excluded from serialization and
never crosses the wire."""


BackgroundClientToolHandler = Callable[
    [dict[str, Any], "ClientToolJob"], Awaitable[None]
]
"""An async background client-tool handler: ``async (args, job) -> None``. Used by
:class:`BackgroundClientTool` for work that outlives the voice turn — ack the call
with ``await job.ack(note)`` (releasing the reply while the handler keeps running),
then deliver the result later with ``job.complete(...)`` / ``job.fail(...)``."""


class ClientTool(BaseModel):
    """One client-executed tool, self-described at session start.

    The server materializes a session-scoped tool definition from each spec.
    ``parameters`` is a JSON Schema for the tool's arguments (restricted
    dialect, top-level ``type: "object"``). Specs the server refuses are
    echoed on ``ReadyEvent.rejected_tools`` and the session starts
    without them.

    ``handler`` executes the tool: when the agent invokes it, the SDK calls
    ``await handler(args)`` and reports the returned dict back as the result.
    Every client tool carries one — a declared tool the client cannot execute
    would fail on every invocation, so constructing a spec without a handler
    is a validation error. The handler is local-only — it is excluded from
    serialization and never crosses the wire.
    """

    model_config = ConfigDict(arbitrary_types_allowed=True)

    kind: Literal["client"] = "client"
    """The tool kind. Always ``client``."""
    name: str = Field(max_length=_CLIENT_TOOL_MAX_NAME_LEN)
    """Name the model calls the tool by, and the name the SDK dispatches
    on locally. Unique within the session's tool set."""
    description: str = Field(max_length=_CLIENT_TOOL_MAX_DESCRIPTION_LEN)
    """What the tool does, written for the model — this is what it
    decides from when choosing to call it."""
    parameters: dict[str, Any]
    """JSON Schema for the tool's arguments, top-level ``type: "object"``.

    A restricted dialect: ``type``, ``properties``, ``required``, ``items``,
    ``enum``, ``description``, ``anyOf``, ``default``, ``minLength``,
    ``maxLength``, ``minimum`` and ``maximum``. An optional argument lowers
    to ``anyOf``. A keyword outside the set raises
    :class:`~cosmo_ai.errors.ToolDefinitionError` where the tool is built, so a
    constraint the dialect cannot express fails at startup rather than at
    connect."""
    handler: SkipJsonSchema[ClientToolHandler] = Field(exclude=True)
    """What runs locally when the model calls this tool. Never serialized —
    it stays on this machine."""


class BackgroundClientTool(ClientTool):
    """A client-executed tool whose work runs in the background.

    Declared and sent identically to :class:`ClientTool` — the background
    behavior is entirely client-side. Its ``handler`` receives a
    :class:`ClientToolJob`: it acks the call immediately (``job.ack``) so the
    session isn't blocked, then delivers the result later (``job.complete`` /
    ``job.fail``). Use it for a tool whose execution can outlast the voice
    turn (an export, a scan, a wait for user input).
    """

    # Concrete (no forward ref) so Pydantic can build the model; the public
    # contract is the ``BackgroundClientToolHandler`` alias.
    handler: SkipJsonSchema[Callable[..., Awaitable[None]]] = Field(exclude=True)
    """What runs locally when the model calls this tool. Receives a
    :class:`~cosmo_ai.tools.ClientToolJob` as its second argument, so it can
    acknowledge now and deliver the result later. Never serialized."""


class WebSearchTool(BaseModel):
    """Opt-in to the server-executed web-search tool. The server owns the
    model-facing declaration — zero-config; unknown fields are a validation
    error. Server tools execute server-side; the session observes them
    through the ``tool-call`` / ``tool-dispatch-started`` / ``tool-result``
    lifecycle."""

    model_config = ConfigDict(extra="forbid")

    kind: Literal["web_search"] = "web_search"
    """The tool kind. Always ``web_search``."""


class ExamineImageTool(BaseModel):
    """Opt-in to the server-executed frame-examination tool: reads the
    freshest frame of the published video at full resolution to answer a
    fine-detail question. Zero-config; unknown fields are a validation
    error."""

    model_config = ConfigDict(extra="forbid")

    kind: Literal["examine_image"] = "examine_image"
    """The tool kind. Always ``examine_image``."""


class DetectObjectsTool(BaseModel):
    """Opt-in to the server-executed object locator that returns boxes —
    one per matching instance. Zero-config; unknown fields are a
    validation error."""

    model_config = ConfigDict(extra="forbid")

    kind: Literal["detect_objects"] = "detect_objects"
    """The tool kind. Always ``detect_objects``."""


class PointAtObjectTool(BaseModel):
    """Opt-in to the server-executed object locator that returns points.
    Zero-config; unknown fields are a validation error."""

    model_config = ConfigDict(extra="forbid")

    kind: Literal["point_at_object"] = "point_at_object"
    """The tool kind. Always ``point_at_object``."""


class SpeakerLogTool(BaseModel):
    """Opt-in to the server-kept speaker log of the room: a diarizing
    transcript runs beside the model, and the agent can read the last few
    seconds back with one stable label per voice (``S0``, ``S1``, …). It
    binds labels to people from what they say about themselves. Zero-config;
    unknown fields are a validation error."""

    model_config = ConfigDict(extra="forbid")

    kind: Literal["speaker_log"] = "speaker_log"
    """The tool kind. Always ``speaker_log``."""


class EndCallTool(BaseModel):
    """Opt-in to the server-executed hang-up, so the agent can end the call
    itself. Zero-config; unknown fields are a validation error. Ending binds
    the call, not just the agent — every leg drops — and the spoken goodbye
    is allowed to finish first.

    Not :class:`EndCall`, which is what a silence hook does when it fires.
    """

    model_config = ConfigDict(extra="forbid")

    kind: Literal["end_call"] = "end_call"
    """The tool kind. Always ``end_call``."""


ScreenCaptureHandler = Callable[..., Any]
"""The host's screen-capture callback, taking the capture request. Loosely
typed at the protocol layer to
keep the screen dataclasses out of the wire models; the precisely-typed public
alias lives in :mod:`cosmo_ai.tools._screen_types`, and the
:func:`~cosmo_ai.tools.screen_locate_tool` factory that enforces it in
:mod:`cosmo_ai.tools._screen`."""


class ScreenLocateTool(BaseModel):
    """Opt-in to the server-executed screen locator.

    Resolves a description to an element on the client's shared screen and
    hands the model a ``found_element`` handle addressing it, which the model
    passes to whichever screen renderer the client declared
    (``cosmo_sdk_screen_click_element`` / ``cosmo_sdk_screen_highlight_element``).
    Not authorable as a bare kind: the SDK emits ``{kind: "screen_locate"}``
    mechanically when the host supplies a ``capture`` handler, whose
    ``screen_capture`` RPC the locator drives.

    ``capture`` executes the capture: the locator RPCs the client, the SDK
    calls ``await capture()``, and publishes the snapshot over a byte stream.
    Every screen-locate spec carries one — the locator cannot ground without
    a screen to look at — so it has no default. Local-only: excluded from
    serialization, it never crosses the wire, and the spec reaches the server
    as the bare ``{kind: "screen_locate"}``.

    The locator itself has no availability gate. ``cosmo_sdk_screen_click_element``
    does — clicking acts on the user's machine, so a session that cannot run
    it starts without it and reports the drop on ``ready.rejected_tools``
    under that name.
    """

    model_config = ConfigDict(arbitrary_types_allowed=True)

    kind: Literal["screen_locate"] = "screen_locate"
    """The tool kind. Always ``screen_locate``."""
    capture: SkipJsonSchema[ScreenCaptureHandler] = Field(exclude=True)
    """What produces the screenshot and element list the locator works from.
    Runs locally and is never serialized; the tool cannot resolve anything
    without it."""


AgentTool = Annotated[
    Union[
        ClientTool,
        WebSearchTool,
        ExamineImageTool,
        DetectObjectsTool,
        PointAtObjectTool,
        EndCallTool,
        ScreenLocateTool,
        SpeakerLogTool,
    ],
    Field(discriminator="kind"),
]
"""What ``tools=`` accepts. Build one by calling its constructor
(:func:`~cosmo_ai.web_search_tool`, :func:`~cosmo_ai.tools.draw_box_tool`);
the member classes are internal."""


# ─────────────────────────────────────────────────────────────────────────────
# Client → server
# ─────────────────────────────────────────────────────────────────────────────


class ExperimentalParams(BaseModel):
    """Unstable session-config knobs nested under
    ``SessionConfig.session.experimental``. Fields here may change
    shape or disappear between releases; stable equivalents graduate to
    fields on the agent or session config."""

    resume_session_id: UUID | None = None
    """When set, the server resumes the named prior session."""


class Say(BaseModel):
    """Idle-message action: `text` = exact words, `prompt` = model-generated,
    both unset = free model speech."""

    type: Literal["say"] = "say"
    """The action type. Always ``say``."""
    text: str | None = Field(default=None, max_length=_SERVER_HOOK_TEXT_MAX_LEN)
    """Exact words for the assistant to speak. Mutually exclusive with
    ``prompt``."""
    prompt: str | None = Field(default=None, max_length=_SERVER_HOOK_TEXT_MAX_LEN)
    """Instruction the model composes its line from, for wording that
    follows what has been said so far. Mutually exclusive with ``text``."""

    @model_validator(mode="after")
    def _at_most_one(self) -> "Say":
        if self.text is not None and self.prompt is not None:
            raise ValueError("Say takes at most one of text / prompt")
        return self


class EndCall(BaseModel):
    type: Literal["end_call"] = "end_call"
    """The action type. Always ``end_call``."""
    farewell: str | None = Field(default=None, max_length=_SERVER_HOOK_TEXT_MAX_LEN)
    """Parting line to speak before hanging up. ``None`` ends the call
    without one."""


ServerHookAction = Annotated[Union[Say, EndCall], Field(discriminator="type")]


class SilenceTimeout(BaseModel):
    """Server-hook config: perform `action` after `timeout_seconds` of
    user silence. See the design doc — no client behavior; wire config only."""

    trigger: Literal["user.speech.timeout"] = "user.speech.timeout"
    """What fires the hook. Always ``user.speech.timeout``."""
    timeout_seconds: float = Field(ge=1, le=1000)
    """Seconds of user silence before the action runs, 1–1000. Scaled by
    ``present_multiplier`` once the caller has spoken at least once."""
    present_multiplier: float | None = Field(default=None, ge=1, le=10)
    """How much to widen ``timeout_seconds`` once the caller has spoken
    at least once, 1–10, so a present but quiet caller waits longer than
    a line that was silent from the start. ``1`` waits the same either
    way. Omit to use the server's default."""
    action: ServerHookAction
    """What to do when the timeout fires — speak a line, or end the
    call."""
    max_count: int = Field(default=3, ge=1, le=10)
    """How many times this hook may fire, 1–10, so a silent caller is
    not prompted forever. Counted per run of silence when ``reset_mode``
    is ``on_user_speech``, and across the session when it is ``never``."""
    reset_mode: Literal["never", "on_user_speech"] = "never"
    """Whether the fire count resets. ``never`` counts across the whole
    session; ``on_user_speech`` starts over each time the user speaks."""
    name: str | None = Field(default=None, max_length=_SERVER_HOOK_NAME_MAX_LEN)
    """Label for this hook, for your own reference and the server's
    logs. It is not carried on the event the hook fires, so a session
    running several silence hooks cannot tell from the event which one
    fired."""


ServerHook = SilenceTimeout
"""Every server-hook kind. One kind today; becomes a ``|`` union discriminated
on ``trigger`` when a second lands — signatures and ``isinstance`` checks
against this name keep working either way."""


class VoiceConfig(BaseModel):
    """How the agent sounds: the prebuilt voice and the per-run speaking
    style. One sub-object shared by both agent variants."""

    model_config = ConfigDict(extra="forbid")

    name: str | None = Field(default=None, max_length=_VOICE_MAX_LEN)
    """Provider-specific prebuilt voice id. ``None`` lets the upstream pick
    per session."""
    speaking_style: str | None = Field(default=None, max_length=_SPEAKING_STYLE_MAX_LEN)
    """Caller-supplied "how to speak" instruction text, appended to the system
    prompt as its own section after the persona. ``None`` = none."""


class AudioConfig(BaseModel):
    """The agent's audio pipeline, configured once — not per run."""

    model_config = ConfigDict(extra="forbid")

    output: bool | None = None
    """Whether the agent emits audio. ``False`` runs the session text-only:
    no speech reaches the room while input transcription and text output are
    unaffected — for transcription, captioning, or text-response apps.
    Rejected at session start when the resolved model cannot run text-only
    (self-contained speech-to-speech providers). ``None`` stays off the wire
    and keeps the server default (on). This is the only way to run a session
    without speech; there is no per-turn equivalent.

    Silence is guaranteed; skipping the work behind it is not. Only providers
    that can be asked for a text-only modality drop the synthesis — elsewhere
    speech is generated and discarded, so :class:`UsageEvent` can still
    report ``output_audio_tokens`` for a session nobody hears."""
    noise_cancellation: NoiseCancellation | None = None
    """Which filter cleans the user's inbound audio before the model hears it
    — see :class:`NoiseCancellation`. ``None`` stays off the wire and keeps
    the server default, which is ``off``. The filter sits ahead of the model
    on the inbound path, so it also shapes what the model's own turn-taking
    hears."""


class CatalogAgentConfig(BaseModel):
    """Run a workspace catalog agent by machine handle — the stored config
    runs verbatim. Only per-run ride-alongs may accompany the launch;
    other stored-config fields are structurally absent from this variant, so
    the illegal combination is unrepresentable."""

    model_config = ConfigDict(extra="forbid")

    type: Literal["catalog"] = "catalog"
    """Selects the agent form. Always ``catalog`` — a workspace catalog
    agent by name."""
    name: str = Field(
        max_length=100,
        pattern=r"^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$",
    )
    """Machine handle of the workspace catalog agent to run. The server
    resolves it fail-closed at session start."""
    inputs: dict[str, str] | None = None
    """Per-run values for the referenced agent's declared input fields,
    substituted into the resolved prompt's ``{{key}}`` placeholders."""
    tools: list[AgentTool] | None = Field(
        default=None, max_length=_TOOL_SPECS_MAX_COUNT
    )
    """Tool set for the session: :class:`ClientTool` specs the SDK fulfils
    locally, plus typed server-tool opt-ins (:class:`WebSearchTool`, …).
    Used verbatim — the stored agent config carries no tools, so nothing
    is merged in. ``None`` / empty runs the session with no tools."""
    voice: VoiceConfig | None = None
    """Per-run voice for the referenced agent: ``speaking_style`` is per-run
    text, and ``name`` is the one cosmetic exception to "the stored config
    runs verbatim" — it changes how the agent sounds, never what it says or
    can do. ``None`` keeps the stored voice."""


class CosmoVadConfig(BaseModel):
    """Tuning for the ``cosmo_vad`` turn detector. Every knob names the
    detector's own machinery, so a caller always knows which endpointer a
    setting touches; an unset knob keeps the server default."""

    model_config = ConfigDict(extra="forbid")

    pause_ms: int | None = Field(default=None, ge=0, le=5000)
    """Silence, in milliseconds, that triggers the end-of-turn inference."""
    prefix_ms: int | None = Field(default=None, ge=0, le=5000)
    """Audio, in milliseconds, kept from before speech was detected, so a
    turn's opening syllable is not clipped."""
    max_hold_ms: int | None = Field(default=None, ge=0, le=5000)
    """Total silence, in milliseconds, after which the turn ends regardless
    of the classifier's verdict."""


class GeminiModel(BaseModel):
    """The Gemini-realtime provider with its knobs. Assigning this block to
    ``model`` picks the provider; the ``provider`` discriminator makes setting
    a Gemini knob for another provider a schema error, not a silent no-op.

    ``turn_detection`` selects which detector ends the user's turn, and each
    detector owns its knobs: ``end_of_speech_sensitivity``,
    ``silence_duration_ms`` and ``prefix_padding_ms`` tune the provider's
    ``server_vad``; the ``cosmo_vad`` block tunes ``cosmo_vad`` (the Gemini
    default). Naming a detector and sending the other one's knobs is
    rejected at session start."""

    model_config = ConfigDict(extra="forbid")

    provider: Literal["gemini"] = "gemini"
    """Names the provider this block configures. Always ``gemini``; the
    SDKs stamp it, so you never write it yourself."""
    model_id: str | None = None
    """Concrete Gemini model to run. ``None`` runs the provider default. A
    model id that is not a Gemini model is rejected at session start."""
    temperature: float | None = Field(default=None, ge=0.0, le=2.0)
    """How much randomness the model samples with, ``0.0``–``2.0``. Lower
    reads as more repeatable, higher as more varied. ``None`` keeps the server
    default."""
    max_output_tokens: int | None = Field(default=None, ge=1, le=32768)
    """Ceiling on the tokens the model may produce in one reply,
    ``1``–``32768``. ``None`` keeps the server default."""
    thinking_level: ThinkingLevel | None = None
    """How much the model reasons before it answers, from
    :attr:`ThinkingLevel.MINIMAL` to :attr:`ThinkingLevel.HIGH`. More
    reasoning costs time before the turn's first audio, so raise it for an
    agent that has something to work out rather than for a conversational
    one. ``None`` keeps the server default."""
    include_thoughts: bool | None = None
    """Whether the model streams thought summaries alongside its answer. Only
    worth enabling for an app that reads them."""
    turn_detection: Literal["cosmo_vad", "server_vad"] | None = None
    """Which end-of-turn detector runs. ``None`` (the default) and
    ``cosmo_vad`` run Cosmo's semantic turn detection, which classifies
    whether the utterance reads as finished instead of timing a silence
    window — a mid-thought pause no longer ends the turn. ``server_vad``
    pins the provider's silence-window detection, which the three knobs
    below tune; they are unread under the default detector.
    ``semantic_vad`` is OpenAI-only and unrepresentable here."""
    end_of_speech_sensitivity: EndOfSpeechSensitivity | None = None
    """How readily the model decides the user's turn ended. ``high`` endpoints
    sooner, so the assistant answers faster but is more likely to cut in on a
    mid-thought pause. Read only with ``server_vad``."""
    silence_duration_ms: int | None = Field(default=None, ge=0, le=5000)
    """Silence, in milliseconds, that ends the user's turn. Read only with
    ``server_vad``."""
    prefix_padding_ms: int | None = Field(default=None, ge=0, le=5000)
    """Audio, in milliseconds, kept from before speech was detected. Read
    only with ``server_vad``."""
    cosmo_vad: CosmoVadConfig | None = None
    """Tuning for the ``cosmo_vad`` detector. Valid only while that detector
    runs (``turn_detection`` unset or ``cosmo_vad``); sending it alongside
    ``server_vad`` is rejected. ``None`` keeps the server defaults."""


class OpenAIModel(BaseModel):
    """The OpenAI-Realtime provider with its knobs. OpenAI Realtime pins its
    own sampling and token limits, so only turn-taking is tunable here.

    ``turn_detection`` decides which of the remaining knobs apply:
    ``eagerness`` belongs to ``semantic_vad``, the two window knobs to
    ``server_vad``. Sending a knob from the other mode is rejected at session
    start rather than silently ignored."""

    model_config = ConfigDict(extra="forbid")

    provider: Literal["openai"] = "openai"
    """Names the provider this block configures. Always ``openai``; the
    SDKs stamp it, so you never write it yourself."""
    model_id: str | None = None
    """Concrete OpenAI Realtime model to run. ``None`` runs the provider
    default. A model id that is not an OpenAI model is rejected at session
    start."""
    turn_detection: Literal["semantic_vad", "server_vad"] | None = None
    """Which turn detector runs. ``None`` keeps the provider default
    (``server_vad``)."""
    eagerness: SemanticEagerness | None = None
    """How eagerly ``semantic_vad`` closes the user's turn. Valid only with
    ``turn_detection`` set to ``semantic_vad``."""
    silence_duration_ms: int | None = Field(default=None, ge=0, le=5000)
    """Silence, in milliseconds, that ends the user's turn. Valid only with
    ``server_vad``."""
    prefix_padding_ms: int | None = Field(default=None, ge=0, le=5000)
    """Audio, in milliseconds, kept from before speech was detected. Valid
    only with ``server_vad``."""


class OpenAIMiniModel(BaseModel):
    """The OpenAI-Realtime mini tier — the same API on a faster, cheaper
    model, and equally untunable today."""

    model_config = ConfigDict(extra="forbid")

    provider: Literal["openai_mini"] = "openai_mini"
    """Names the provider this block configures. Always ``openai_mini``;
    the SDKs stamp it, so you never write it yourself."""
    model_id: str | None = None
    """Concrete mini-tier model to run. ``None`` runs the provider default."""


class OpenAILiveModel(BaseModel):
    """OpenAI's GPT Live full-duplex voice model. It listens and speaks at
    once and decides itself when each turn starts and ends, so no turn
    detector is tunable here; tool calls and reasoning are delegated to a
    backend Responses model, which is what the knobs configure. Audio only:
    a session on it ignores video and screen frames. A ``voice_…`` id on the agent's ``voice`` selects an authorized
    custom voice."""

    model_config = ConfigDict(extra="forbid")

    provider: Literal["openai_live"] = "openai_live"
    """Names the provider this block configures. Always ``openai_live``;
    the SDKs stamp it, so you never write it yourself."""
    model_id: str | None = None
    """Concrete GPT Live model to run. ``None`` runs the provider default."""
    responses_model: str | None = None
    """The Responses model tool calls and reasoning are delegated to, from
    the server's allowlist of small tiers; a model outside it is rejected at
    session start. ``None`` runs the provider default."""
    responses_instructions: str | None = Field(default=None, max_length=16384)
    """Instructions for the Responses model, distinct from the voice model's.
    ``None`` gives it the agent's own instructions."""
    reasoning_effort: OpenAILiveReasoningEffort | None = None
    """How hard the Responses model reasons on delegated work. ``None``
    keeps OpenAI's default."""
    verbosity: OpenAILiveVerbosity | None = None
    """How much the Responses model writes back for the voice model to say.
    ``None`` keeps OpenAI's default."""
    tool_choice: OpenAILiveToolChoice | None = None
    """Whether a delegated turn must call a tool. ``None`` lets the model
    decide (``auto``)."""
    parallel_tool_calls: bool | None = None
    """Whether one delegated turn may call several tools at once. ``None``
    keeps OpenAI's default."""
    max_output_tokens: int | None = Field(default=None, ge=16, le=32768)
    """Cap on tokens one delegated response may generate. ``None`` keeps
    OpenAI's default."""
    service_tier: OpenAILiveServiceTier | None = None
    """OpenAI processing tier for delegated work. ``None`` keeps OpenAI's
    default."""
    delegation: OpenAILiveDelegation | None = None
    """Who does the work the voice model hands off. ``None`` is
    ``responses``. Under ``client`` and ``cosmo`` the ``responses_*`` knobs
    are unused and the agent may declare no tools."""


class GrokModel(BaseModel):
    """The xAI Grok Voice provider with its knobs. Grok pins its own sampling
    and token limits; turn-taking, reasoning effort, and playback speed are
    tunable here.

    Grok runs one detector — a fixed silence window — so the turn-taking
    knobs always apply. Naming any other detector is rejected at session
    start."""

    model_config = ConfigDict(extra="forbid")

    provider: Literal["grok"] = "grok"
    """Names the provider this block configures. Always ``grok``; the
    SDKs stamp it, so you never write it yourself."""
    model_id: str | None = None
    """Concrete Grok Voice model to run. ``None`` runs the provider default."""
    turn_detection: Literal["server_vad"] | None = None
    """Which turn detector runs. ``"server_vad"`` is the only one Grok offers,
    and ``None`` selects it."""
    silence_duration_ms: int | None = Field(default=None, ge=0, le=5000)
    """Silence, in milliseconds, that ends the user's turn."""
    prefix_padding_ms: int | None = Field(default=None, ge=0, le=5000)
    """Audio, in milliseconds, kept from before speech was detected."""
    reasoning_effort: GrokReasoningEffort | None = None
    """Whether the model reasons before speaking. Grok's own default is
    :attr:`GrokReasoningEffort.HIGH`, which buys deliberate answers at
    multi-second turn latency; :attr:`GrokReasoningEffort.NONE` answers
    immediately. ``None`` keeps Grok's default."""
    speed: float | None = Field(default=None, ge=0.7, le=1.5)
    """Playback-rate multiplier for the agent's speech (0.7–1.5). ``None``
    keeps normal speed."""
    idle_timeout_ms: int | None = Field(default=None, ge=0, le=120000)
    """Milliseconds of user silence after a response before the server
    re-engages the user, re-arming after every response. ``None`` never
    re-engages."""


RealtimeModelBlock = Annotated[
    Union[
        GeminiModel,
        OpenAIModel,
        OpenAIMiniModel,
        OpenAILiveModel,
        GrokModel,
    ],
    Field(discriminator="provider"),
]
"""The block form of ``RealtimeModel``, discriminated on ``provider``. The
provider a knob belongs to owns it — ``thinking_level`` lives only on the
Gemini block — so an illegal pairing is unrepresentable."""

RealtimeModel = Union[str, RealtimeModelBlock]
"""What runs on the other end. The string form is a provider family alias
running that provider's default model, or a concrete model id. The block form
picks the provider, carries its knobs, and optionally pins the concrete model
via ``model_id``. One field names the provider exactly once, so a model/knob
provider mismatch is unrepresentable.

The family aliases are ``"gemini"``, ``"openai"``, ``"openai_mini"``,
``"openai_live"`` and ``"grok"``. That set is owned by the server, not by this SDK: a backend can
offer a new provider or a new concrete model id without an SDK release, so
treat the list as current rather than closed, and which of them a given
workspace may run is a server-side decision too.

Because the string arm is open, nothing here is validated locally — an
unrecognized alias or model id, or one this workspace cannot run, is rejected
when the session starts, not when the agent is built. Leave ``model`` unset to
run the workspace default."""


class InlineAgentConfig(BaseModel):
    """Define the agent inline — the persona/configuration of the model on
    the other end, independent of any one run. Reused unchanged across
    sessions. Catalog-only fields (``name``, ``inputs``) are structurally
    absent from this variant."""

    model_config = ConfigDict(extra="forbid")

    type: Literal["inline"] = "inline"
    """Selects the agent form. Always ``inline`` — an agent defined
    inline."""
    instructions: str | None = Field(default=None, max_length=_INSTRUCTIONS_MAX_LEN)
    """Caller-supplied system instructions. Replaces the server's neutral
    default when set; ``None`` keeps the default."""
    model: RealtimeModel | None = None
    """What runs on the other end: a family alias or concrete model id (string
    form), or a provider block carrying that provider's knobs and an optional
    concrete ``model_id``. ``None`` lets the server choose its default;
    unavailable values are rejected explicitly at session start."""
    voice: VoiceConfig | None = None
    """How the agent sounds — prebuilt voice id and speaking style. ``None``
    keeps the server defaults for both."""
    audio: AudioConfig | None = None
    """The agent's audio pipeline — output emission and inbound noise
    cancellation. ``None`` keeps every server default."""
    greeting: str | None = Field(default=None, max_length=4000)
    """Opening line the assistant speaks first, voiced as soon as the model
    session opens. Part of the persona: what this agent says to open a call.
    ``None`` keeps the wait-for-user behavior."""
    tools: list[AgentTool] | None = Field(
        default=None, max_length=_TOOL_SPECS_MAX_COUNT
    )
    """Tool set for the session: :class:`ClientTool` specs the SDK fulfils
    locally, plus typed server-tool opt-ins (:class:`WebSearchTool`, …).
    ``None`` / empty → no tools."""
    interruption_sensitivity: InterruptionSensitivity | None = None
    """How readily user audio barges in over the assistant. ``None`` stays off
    the wire and keeps the server default."""
    hooks: list[ServerHook] | None = Field(
        default=None, max_length=_SERVER_HOOKS_MAX_COUNT
    )
    """Server hooks (wire config; the server executes them). The only hooks
    that exist on the wire — client-side callback hooks never serialize."""


RealtimeAgentConfig = Annotated[
    Union[CatalogAgentConfig, InlineAgentConfig],
    Field(discriminator="type"),
]
"""The ``agent`` block of a session-config: launch a workspace catalog
agent by handle, or define one inline — discriminated on ``type``."""


class SessionParams(BaseModel):
    """Per-run, transport-level options for one session — continuity and other
    knobs that vary run-to-run for the same agent. Audio config lives on the
    ``agent`` block."""

    max_session_seconds: int | None = Field(default=None, ge=60, le=14400)
    """Requested wall-clock cap on the session, in seconds. The server resolves
    the effective cap as the minimum of this and its own limits — callers can
    only shorten, never extend. The effective value is echoed on
    :class:`ReadyEvent`."""
    store_recording: bool | None = None
    """Persist this session's recording artifacts (audio/video/transcript/tool
    events) server-side. ``False`` writes nothing for the run; ``None`` stays
    off the wire and stores as much as the account's consents allow. The
    per-artifact fields below win over this one."""
    store_audio: bool | None = None
    """Persist this session's audio. Narrowing only: a session may request
    less storage than the account permits, never more. ``None`` defers to
    ``store_recording``, then to those consents."""
    store_transcript: bool | None = None
    """Persist this session's transcript and tool-call events. Same contract
    as ``store_audio``."""
    store_video: bool | None = None
    """Persist this session's screen-share video. Same contract as
    ``store_audio``, including the ``store_recording`` fallback. Screenshots
    have no field of their own and follow ``store_recording``, so turning
    this off does not stop them."""
    experimental: ExperimentalParams | None = None
    """Opt-in unstable knobs (see :class:`ExperimentalParams`)."""


class SdkInfo(BaseModel):
    """Self-reported SDK identity stamped on ``session-config`` — which SDK
    and which package version opened the session."""

    name: str
    """Registry package name of the SDK, e.g. ``cosmo-ai-sdk``."""
    version: str
    """Installed version of that package."""


def _sdk_info() -> SdkInfo:
    return SdkInfo(name=SDK_NAME, version=SDK_VERSION)


class SessionConfig(BaseModel):
    """Session-start payload — the body of POST
    ``/api/v1/external/realtime/session/start``. Split into ``agent`` (the
    persona) and ``session`` (per-run transport options). The server replies
    with the join credentials, then ``ReadyEvent`` arrives on the data channel once the
    agent is up.
    """

    type: Literal["session-config"] = "session-config"
    """The message type. Always ``session-config``."""
    id: str = Field(default_factory=_new_message_id)
    """Local message id this SDK stamps on each outbound message. The
    server ignores it and it is absent from the published schema; it
    exists only so older clients keep decoding. Nothing correlates on
    it — use the ids carried on the events themselves."""
    sdk: SdkInfo
    """Which SDK and version opened the session."""
    agent: RealtimeAgentConfig = Field(default_factory=InlineAgentConfig)
    """The persona to run: defined inline, or a reference to a workspace
    catalog agent. Omitted runs the default agent."""
    session: SessionParams = Field(default_factory=SessionParams)
    """Per-run options for this session — storage consents, duration
    cap, experimental knobs. Omitted takes every default."""


class ClientMute(BaseModel):
    """Toggle the mic gate. While muted the client drops outbound audio frames."""

    type: Literal["mute"] = "mute"
    """The message type. Always ``mute``."""
    id: str = Field(default_factory=_new_message_id)
    """Local message id this SDK stamps on each outbound message. The
    server ignores it and it is absent from the published schema; it
    exists only so older clients keep decoding. Nothing correlates on
    it — use the ids carried on the events themselves."""
    muted: bool
    """``true`` gates outbound audio, ``false`` reopens it."""


class ClientEnd(BaseModel):
    """User ended the session. Server tears down the upstream session and closes."""

    type: Literal["end"] = "end"
    """The message type. Always ``end``."""
    id: str = Field(default_factory=_new_message_id)
    """Local message id this SDK stamps on each outbound message. The
    server ignores it and it is absent from the published schema; it
    exists only so older clients keep decoding. Nothing correlates on
    it — use the ids carried on the events themselves."""


class ClientPing(BaseModel):
    """Heartbeat. Server replies with ``PongEvent``."""

    type: Literal["ping"] = "ping"
    """The message type. Always ``ping``."""
    id: str = Field(default_factory=_new_message_id)
    """Local message id this SDK stamps on each outbound message. The
    server ignores it and it is absent from the published schema; it
    exists only so older clients keep decoding. Nothing correlates on
    it — use the ids carried on the events themselves."""


class ClientBindInput(BaseModel):
    """Bind the agent's audio input to this client.

    Sent after the client publishes its own audio (the human voice) so the
    agent listens to *this* participant. The server binds to the sender's
    participant identity — a client can only bind its own input — and the pin is
    sticky thereafter. A client that joins only to receive events or serve
    client tools, publishing no audio, never sends this and so is never the
    voice."""

    type: Literal["bind-input"] = "bind-input"
    """The message type. Always ``bind-input``."""
    id: str = Field(default_factory=_new_message_id)
    """Local message id this SDK stamps on each outbound message. The
    server ignores it and it is absent from the published schema; it
    exists only so older clients keep decoding. Nothing correlates on
    it — use the ids carried on the events themselves."""


class ClientText(BaseModel):
    """Send a text message instead of audio."""

    type: Literal["send-text"] = "send-text"
    """The message type. Always ``send-text``."""
    id: str = Field(default_factory=_new_message_id)
    """Local message id this SDK stamps on each outbound message. The
    server ignores it and it is absent from the published schema; it
    exists only so older clients keep decoding. Nothing correlates on
    it — use the ids carried on the events themselves."""
    content: str
    """The message text, treated exactly as a spoken turn would be."""


class ClientContext(BaseModel):
    """Add text to the model's context without asking it to reply.

    The content rides the provider's pre-turn channel, so the model is never
    asked for a response and cannot open a turn for it; it reads the note as
    background when it next answers. The opposite of ``send-text``, which
    *is* a turn."""

    type: Literal["send-context"] = "send-context"
    """The message type. Always ``send-context``."""
    id: str = Field(default_factory=_new_message_id)
    """Local message id this SDK stamps on each outbound message. The
    server ignores it and it is absent from the published schema; it
    exists only so older clients keep decoding. Nothing correlates on
    it — use the ids carried on the events themselves."""
    content: str = Field(min_length=1, max_length=_CONTEXT_NOTE_MAX_CHARS)
    """The note to put in front of the model. Read as background, never
    answered directly."""


class DelegationAppend(BaseModel):
    """Hand text back to the voice model for work it delegated to you, or
    steer it outside any delegation.

    Three channels: ``thinking`` is background the model keeps to itself,
    ``commentary`` is something it says now in its own words, and
    ``instructions`` changes how it behaves from here on. Each append is
    one short piece; send several as work progresses rather than one
    long one at the end.
    """

    type: Literal["delegation-append"] = "delegation-append"
    """The message type. Always ``delegation-append``."""
    id: str = Field(default_factory=_new_message_id)
    """Local message id this SDK stamps on each outbound message. The
    server ignores it and it is absent from the published schema; it
    exists only so older clients keep decoding. Nothing correlates on
    it — use the ids carried on the events themselves."""
    channel: DelegationChannel
    """How the text reaches the model."""
    content: str = Field(min_length=1, max_length=_CONTEXT_NOTE_MAX_CHARS)
    """The text. Under ``commentary`` the model paraphrases it rather than
    reading it verbatim."""
    delegation_id: str | None = None
    """The ``delegation-created`` event this answers. ``None`` steers the
    session as a whole, outside any delegation."""


class ClientActivityEnd(BaseModel):
    """Client signals end-of-turn (manual VAD)."""

    type: Literal["activity-end"] = "activity-end"
    """The message type. Always ``activity-end``."""
    id: str = Field(default_factory=_new_message_id)
    """Local message id this SDK stamps on each outbound message. The
    server ignores it and it is absent from the published schema; it
    exists only so older clients keep decoding. Nothing correlates on
    it — use the ids carried on the events themselves."""


class ClientImage(BaseModel):
    """One image frame from the client — screen share, camera capture, or any
    other visual input. ``data`` is base64-encoded image bytes."""

    type: Literal["send-image"] = "send-image"
    """The message type. Always ``send-image``."""
    id: str = Field(default_factory=_new_message_id)
    """Local message id this SDK stamps on each outbound message. The
    server ignores it and it is absent from the published schema; it
    exists only so older clients keep decoding. Nothing correlates on
    it — use the ids carried on the events themselves."""
    mime_type: str
    """Media type of the encoded frame, e.g. ``image/jpeg``."""
    data: str
    """The frame itself, base64-encoded."""
    stream_id: str
    """Labels this stream so several concurrent video streams stay
    distinguishable. Always sent; it has no server-side default."""


class ToolJobResult(BaseModel):
    """Terminal result of a long-running (deferred) client tool.

    The SDK sends this over the data channel when a tool's background job calls
    ``job.complete(...)`` / ``job.fail(...)``. The server resolves the original
    tool call from ``job_id`` and injects the outcome into the live session.
    ``summary`` / ``error`` are the model-facing text; ``result`` is structured
    data logged server-side."""

    type: Literal["tool_job_result"] = "tool_job_result"
    """The message type. Always ``tool_job_result``."""
    id: str = Field(default_factory=_new_message_id)
    """Local message id this SDK stamps on each outbound message. The
    server ignores it and it is absent from the published schema; it
    exists only so older clients keep decoding. Nothing correlates on
    it — use the ids carried on the events themselves."""
    job_id: str
    """Identifies the job this result belongs to — the id the acked tool
    call was given."""
    tool_name: str
    """Name of the tool that ran, for logging and attribution."""
    status: Literal["completed", "failed"]
    """Whether the work succeeded. ``failed`` pairs with ``error``."""
    result: dict[str, Any] | None = None
    """Structured outcome. Accepted for forward compatibility but not
    consumed today — only ``status`` and ``summary``/``error`` reach the
    model, so put anything the agent must act on in those."""
    summary: str | None = None
    """Model-facing text for a completed job — what the assistant is
    told came back."""
    error: str | None = None
    """Model-facing text for a failed job — what the assistant is told
    went wrong."""


class ClientConnectTimings(BaseModel):
    """How long the client's own half of the connect took, sent once the
    session is live.

    Only the client can see the session-start call, the media join and the
    microphone permission, so without this report the connect waterfall stops
    at the worker's edge. Durations only, in milliseconds. ``server`` echoes
    back the timings the session-start response carried, which the worker that
    records the session never saw."""

    type: Literal["connect-timings"] = "connect-timings"
    """The message type. Always ``connect-timings``."""
    id: str = Field(default_factory=_new_message_id)
    """Local message id this SDK stamps on each outbound message. The
    server ignores it and it is absent from the published schema; it
    exists only so older clients keep decoding. Nothing correlates on
    it — use the ids carried on the events themselves."""
    request_ms: int | None = None
    """Session-start API call: request sent → response received."""
    room_ms: int | None = None
    """Media transport: room connect → connected."""
    mic_ms: int | None = None
    """Local capture: microphone requested → publishing."""
    ready_ms: int | None = None
    """The whole client-side wait: session start requested → agent ready."""
    server: SessionStartTimings | None = None
    """The server-side breakdown from the session-start response, echoed
    back so both halves of the connect land on one record."""


class ClientEnvelope(BaseModel):
    """Generic chunked carrier for any oversized client message. ``data`` is
    a base64-encoded fragment of the UTF-8 bytes of the inner message JSON."""

    type: Literal["envelope-chunk"] = "envelope-chunk"
    """The message type. Always ``envelope-chunk``."""
    id: str = Field(default_factory=_new_message_id)
    """Local message id this SDK stamps on each outbound message. The
    server ignores it and it is absent from the published schema; it
    exists only so older clients keep decoding. Nothing correlates on
    it — use the ids carried on the events themselves."""
    envelope_id: str
    """Groups the chunks of one message, so concurrent envelopes do not
    interleave."""
    seq: int
    """Position of this chunk, ``0`` to ``total - 1``."""
    total: int
    """How many chunks the message was split into."""
    data: str
    """This chunk's slice of the inner message, base64-encoded."""


RealtimeClientMessage = Annotated[
    Union[
        SessionConfig,
        ClientMute,
        ClientEnd,
        ClientPing,
        ClientBindInput,
        ClientText,
        ClientContext,
        DelegationAppend,
        ClientActivityEnd,
        ClientImage,
        ToolJobResult,
        ClientEnvelope,
        ClientConnectTimings,
    ],
    Field(discriminator="type"),
]


# ─────────────────────────────────────────────────────────────────────────────
# Server → client
# ─────────────────────────────────────────────────────────────────────────────


class RejectedTool(BaseModel):
    """One tool spec the server refused, with the reason."""

    name: str
    """What the dropped tool was called — a client tool's declared name,
    or a server tool's wire kind."""
    reason: str
    """Why it was unavailable, e.g. a capability this workspace has not
    enabled. Free text for logs and display, not a stable code to match
    on."""


class ResolvedAgent(BaseModel):
    """Resolved-agent summary echoed on ``ready`` when the session referenced a
    catalog agent (``agent.name``). Informational only — never authoritative;
    clients don't act on it."""

    name: str
    """The registry agent the session resolved against."""
    tools: list[str] = Field(default_factory=list)
    """The tool names this session ended up running with — client tools by
    their declared name, server tools by their wire kind."""


class ReadyEvent(BaseModel):
    """Sent after the upstream session is established and the agent is ready."""

    session_id: str
    """Server-assigned id for this session. Clients persist it and pass
    it back as ``experimental.resume_session_id`` on a fresh ``session-
    config`` to resume after a disconnect."""
    rejected_tools: list[RejectedTool] = Field(default_factory=list)
    """Tools this session could not get — a registered tool the
    deployment or workspace cannot run right now — with the reason for
    each. The session starts without them, so check this to see what it
    is actually running. Only availability drops appear here. A spec the
    server considers malformed — a bad schema, a duplicate or reserved
    name, a ``kind`` this flow does not execute — rejects the whole
    session start with a 422 (``invalid_tool_config``) instead, and
    never reaches this list."""
    max_session_seconds: int | None = None
    """Effective wall-clock cap the server resolved for this session, in seconds
    (min of the client's requested cap and the server's own limits). ``None``
    when no cap applies."""
    agent: ResolvedAgent | None = None
    """Which catalog agent resolved and the tool names it runs with.
    ``None`` for inline agents."""


class TranscriptDeltaEvent(BaseModel):
    """One raw transcript delta for either speaker.

    To render a conversation, read :attr:`RealtimeSession.transcript` or
    consume :class:`TranscriptUpdatedEvent` — the session folds this stream
    into coalesced turns for you. This event is the layer underneath:
    streaming events (``is_final=False``) carry the new fragment since the
    previous event for that role's turn; the terminating event
    (``is_final=True``) carries the turn's cumulative text.
    """

    role: TranscriptRole
    """Who was speaking — the user, or the assistant."""
    text: str
    """The new fragment while ``is_final`` is false, the whole turn once
    it is true. The class docstring names the two cases where a final
    carries less than the whole turn."""
    is_final: bool
    """Whether this closes the turn. Append while it is false; on true the
    final normally carries the turn's whole text, so replace what you
    accumulated.

    Two finals carry less than that, and each needs the opposite handling. A
    turn the model produced nothing usable for finalizes with an empty
    ``text``, meaning an empty turn — retract the partial rather than keeping
    it. On a session running ``audio.output=False``, a user final arriving
    after the endpoint already committed the utterance is stripped of the
    committed prefix and carries only the remainder — keep the prefix rather
    than replacing with it. Reading :attr:`RealtimeSession.transcript` or
    consuming :class:`TranscriptUpdatedEvent` avoids both, since the session
    folds this stream for you."""


class TranscriptItem(BaseModel):
    """One coalesced turn in :attr:`RealtimeSession.transcript`.

    ``id`` is a stable render key, minted when the turn opens and never
    reused. While ``is_final`` is ``False`` the turn is in progress: its
    ``text`` may grow, be replaced wholesale by the closing final, or the
    item may be removed entirely (a retracted turn). Once ``is_final`` is
    ``True`` the item never changes again.
    """

    model_config = ConfigDict(frozen=True)

    id: str
    """Stable render key for this turn — minted when the turn opens and kept
    as the text grows, so a UI can update in place rather than re-key."""
    role: TranscriptRole
    """Who spoke."""
    text: str
    """The turn's text so far, coalesced from the deltas."""
    is_final: bool
    """Whether the turn is closed. A closed turn's text no longer
    changes."""


class TranscriptUpdatedEvent(BaseModel):
    """The session's coalesced transcript changed. ``items`` is the complete
    updated transcript — replace, don't merge. The same value is readable at
    any time as :attr:`RealtimeSession.transcript`."""

    items: tuple[TranscriptItem, ...]
    """The complete transcript after this change — replace what you held,
    do not merge."""


class ModelTextEvent(BaseModel):
    """Streaming text-channel fragment from the model. Distinct from
    ``transcript``: text the model emits alongside its audio output, not a
    transcription of the audio itself."""

    text: str
    """The fragment of model text emitted since the previous event."""
    is_final: bool = False
    """Whether this closes the text response."""


class TurnCompleteEvent(BaseModel):
    """Marks the end of a turn so the client can finalize a transcript bubble."""

    role: TranscriptRole
    """Whose turn ended."""


class UserStartedSpeakingEvent(BaseModel):
    """Server-side VAD detected user voice activity start. Information-only."""



class UserStoppedSpeakingEvent(BaseModel):
    """Server-side VAD detected user voice activity end. Information-only."""


class UserSpeechTimeoutEvent(BaseModel):
    """A server-runtime silence hook fired: the user was silent past the
    configured threshold and the server performed ``action``."""

    session_id: str
    """Session the timeout fired on."""
    silence_ms: int
    """Silence accrued in the window that fired. The clock restarts
    after each firing, so on a second or later nudge this measures from
    the previous one, not from the last time the user spoke."""
    trigger_count: int
    """Which firing this is in the current run, from one. Under
    ``reset_mode: on_user_speech`` the count restarts when the user
    speaks, so it can return to one within a session."""
    max_count: int
    """The hook's nudge ceiling. It goes quiet after the last one rather
    than escalating; under ``reset_mode: on_user_speech`` the count
    resets on user speech, so this bounds one run of silence, not the
    session."""
    action: ServerHookAction
    """What the server did in response."""


class DelegationCreatedEvent(BaseModel):
    """The voice model decided the user's request needs work done and
    handed it to your application. Do the work, then answer with
    ``delegation-append`` messages carrying this event's id; the model
    keeps talking with the user meanwhile."""

    delegation_id: str
    """Identifies this hand-off. Pass it on every ``delegation-append``
    that answers it."""
    transcript: str
    """What the user said in the turn that prompted the hand-off. Earlier
    turns are yours to keep from the ``transcript`` events."""


class BotStartedSpeakingEvent(BaseModel):
    """First audio frame of an assistant turn left the server. Information-only."""



class BotStoppedSpeakingEvent(BaseModel):
    """Last audio frame of an assistant turn left the server. Information-only."""


class BotLlmStartedEvent(BaseModel):
    """Model began generating its turn (first text or audio event arrived)."""



class BotLlmStoppedEvent(BaseModel):
    """Model finished generating its turn. Information-only."""


class BotTtsStartedEvent(BaseModel):
    """Assistant TTS audio frames started flowing."""



class BotTtsStoppedEvent(BaseModel):
    """Assistant TTS audio frames stopped flowing. Information-only."""


class ToolCallEvent(BaseModel):
    """Model decided to invoke a server-executed tool.

    Three-event lifecycle: ``tool-call`` → ``tool-dispatch-started`` →
    ``tool-result``, correlated by ``tool_call_id``.
    """

    tool_call_id: str
    """Stable per-invocation id (the upstream's function-call id). Use
    this to correlate the ``tool-call`` / ``tool-dispatch-started`` /
    ``tool-result`` triple for one invocation. Distinct from the
    message-level ``id``."""
    name: str
    """Name of the tool being invoked."""


class ToolDispatchStartedEvent(BaseModel):
    """Server-side handler for the tool call began executing."""

    tool_call_id: str
    """Correlates with the ``tool-call`` that opened this invocation."""
    name: str
    """Name of the tool that started executing."""


class ToolResultEvent(BaseModel):
    """Server-side tool finished. ``summary`` is a short human-readable line."""

    tool_call_id: str
    """Correlates with the ``tool-call`` that opened this invocation."""
    ok: bool
    """Whether the tool succeeded."""
    summary: str | None = None
    """Short human-readable line about the outcome, for display."""


ToolInvocationOrigin = Literal["realtime", "server"]
"""Who asked for the tool call carried by :class:`ToolInvocationEvent`.
``"realtime"`` is the live model on this session; ``"server"`` is a
server-side agent working on the session's behalf and reaching the same
client tool. Both run the same tool with the same arguments — the origin is
there so a UI can attribute the call."""


class ToolInvocationEvent(BaseModel):
    """Server asks the connected client to run a tool locally.

    Sent only for tools declared via :class:`ClientTool` specs at session
    start. Surfaced as an observability event.
    """

    request_id: str
    """Identifies this notification. Minted fresh for the event and
    unrelated to the call's own transport-level request, so it is not a
    handle to reply on — client tools are invoked and answered over the
    transport's RPC channel, and this event only mirrors that."""
    tool_call_id: str
    """The model's own id for the call, shared with the ``tool-call``
    lifecycle."""
    name: str
    """Name of the client tool to run."""
    args: dict[str, Any] = Field(default_factory=dict)
    """Arguments the model produced, matching the tool's declared
    schema."""
    origin: ToolInvocationOrigin = "realtime"
    """Who asked: ``realtime`` for the live model, ``server`` for a
    server-side runtime reaching the same tool."""
    executable: bool = True
    """Whether the recipient should run the tool. ``False`` marks an
    informational mirror of a call executed elsewhere."""


class ReconnectingEvent(BaseModel):
    """Server is transparently rotating the upstream session. The transport
    and session state survive the swap."""

    seconds_remaining: float | None = None
    """Rough seconds until the swap completes, when the upstream reports
    it. ``None`` when it does not."""


class SessionEndingSoonEvent(BaseModel):
    """The server will end this session shortly (e.g. the max-duration cap
    is about to fire). Clients may show a countdown or have the agent wrap
    up; the session keeps running until ``session-ended``."""

    seconds_remaining: float
    """Seconds until the session is cut, for a countdown."""
    reason: str
    """Stable slug for why the session is ending (e.g.
    ``"max_session_duration"``). The vocabulary is additive: match the
    slugs you know and treat an unfamiliar one as a plain end."""


class SessionEndedEvent(BaseModel):
    """Terminal ``session-ended`` — the session is over and no further events
    follow.

    Dual role. The server publishes this frame best-effort just before a
    deliberate teardown (clean end, user end, duration or silence timeout);
    the SDK latches its ``reason`` and never surfaces the frame mid-stream.
    The SDK then synthesizes the single terminal instance the event stream
    yields at teardown, carrying the latched reason when one arrived.
    """

    reason: str | None = None
    """Why the session ended. A server teardown carries its stable slug
    (e.g. ``"max_session_duration"``), sharing ``SessionEndingSoonEvent``'s
    vocabulary; an ending the SDK synthesizes carries a short description of
    the disconnect instead. The vocabulary is additive: match the slugs you
    know and treat anything else as a plain end rather than parsing it."""


class ErrorEvent(BaseModel):
    """Recoverable or terminal error. ``fatal=True`` signals the session is
    dead; ``fatal=False`` means this turn failed but the session continues."""

    code: ErrorCode
    """Stable code to switch on for recovery. Match this, not
    ``message``.

    The set is the server's, not this SDK's, so a deployment newer than your
    package can send a code this version does not name. It arrives as a
    member carrying the raw string rather than failing the event — an
    unrecognized code would otherwise cost you the whole error, which is the
    surface you need most when something has already gone wrong. Both kinds
    are :class:`ErrorCode`, so ``isinstance`` does not separate them;
    ``code in list(ErrorCode)`` does."""
    message: str
    """Human-readable explanation, for logs and display."""
    fatal: bool = False
    """``true`` means the session is dead and must be torn down;
    ``false`` means only this turn failed."""


class UsageEvent(BaseModel):
    """Cumulative token usage for the live session, split by direction and
    modality.

    Every field is a running total for the session so far, not a per-turn
    delta — the newest event supersedes the previous one. Emitted whenever the
    upstream provider reports usage; a provider that reports none
    yields no usage events at all, so absence is not zero usage.
    """

    input_text_tokens: int = 0
    """Text tokens sent to the model so far this session."""
    input_image_tokens: int = 0
    """Image tokens sent to the model so far this session."""
    input_audio_tokens: int = 0
    """Audio tokens sent to the model so far this session."""
    input_cached_tokens: int = 0
    """Input tokens served from the provider's cache, already counted in
    the input totals above."""
    output_text_tokens: int = 0
    """Text tokens the model produced so far this session."""
    output_audio_tokens: int = 0
    """Audio tokens the model produced so far this session."""
    total_tokens: int = 0
    """Every token counted above, as the provider reports the total."""


class SessionStateWriteEvent(BaseModel):
    """Live session state after the agent wrote to it with ``set_state``.

    ``state`` is the full canonical state rather than a delta, so the newest
    event supersedes the previous one; ``updated_keys`` names just the keys
    this write touched. ``stage`` is hoisted out of ``state["stage"]`` for
    convenience, and ``warnings`` are the advisory schema findings the model
    saw in its own tool result.
    """

    state: dict[str, Any] = Field(default_factory=dict)
    """The whole state after the write, so the newest event supersedes
    the previous one."""
    updated_keys: list[str] = Field(default_factory=list)
    """Just the keys this write touched, for highlighting what changed."""
    warnings: list[str] = Field(default_factory=list)
    """Advisory schema findings from the write. The model saw these too;
    they did not block it."""
    stage: str | None = None
    """``state["stage"]``, lifted out for clients that render call
    progress. ``None`` when the state carries no stage."""


class PongEvent(BaseModel):
    """Reply to ``ClientPing``."""



class ServerEnvelope(BaseModel):
    """Generic chunked carrier for any oversized server message. The SDK
    buffers by ``envelope_id``, base64-decodes + concatenates in ``seq``
    order, and re-dispatches the inner message — chunks never surface as
    events."""

    envelope_id: str
    """Groups the chunks of one message, so concurrent envelopes do not
    interleave."""
    seq: int
    """Position of this chunk, ``0`` to ``total - 1``."""
    total: int
    """How many chunks the message was split into."""
    data: str
    """This chunk's slice of the inner message, base64-encoded."""


class UnknownEvent(BaseModel):
    """Forward-compatibility variant for unrecognized or undecodable frames.

    ``raw_type`` carries the wire ``type`` the SDK could not handle, or
    ``None`` when the frame was not decodable JSON at all (``raw_text`` then
    carries the frame verbatim). Never terminal — the stream continues.
    """

    raw_type: str | None
    """The wire ``type`` this SDK does not handle. ``None`` when the frame
    carried no string ``type`` to read — whether it failed to decode, or
    decoded into something without one."""
    payload: dict[str, Any] | None = None
    """The decoded frame, when it parsed as a JSON object."""
    raw_text: str | None = None
    """The frame verbatim. Present whenever the bytes decoded as UTF-8, so a
    frame that is not valid JSON and one that is valid JSON without a
    ``type`` both carry it; absent only when the bytes were not UTF-8."""


RealtimeSessionEvent = Union[
    ReadyEvent,
    TranscriptDeltaEvent,
    TranscriptUpdatedEvent,
    ModelTextEvent,
    TurnCompleteEvent,
    UserStartedSpeakingEvent,
    UserStoppedSpeakingEvent,
    BotStartedSpeakingEvent,
    BotStoppedSpeakingEvent,
    BotLlmStartedEvent,
    BotLlmStoppedEvent,
    BotTtsStartedEvent,
    BotTtsStoppedEvent,
    ToolCallEvent,
    ToolDispatchStartedEvent,
    ToolResultEvent,
    ToolInvocationEvent,
    ReconnectingEvent,
    SessionEndingSoonEvent,
    SessionEndedEvent,
    ErrorEvent,
    PongEvent,
    SessionStateWriteEvent,
    UsageEvent,
    UserSpeechTimeoutEvent,
    DelegationCreatedEvent,
    UnknownEvent,
]
"""Everything ``async for event in session`` can yield. ``SessionEndedEvent``
is always the final item.

Iteration is how a session is observed, so this union is what a handler
dispatches on — match the event's class (``isinstance``, or ``match`` on the
class pattern) and read its fields. Every member is documented on its own
class.

The union is open in practice: a server frame this SDK does not recognize
arrives as :class:`UnknownEvent` rather than raising, and the session keeps
running. A handler that dispatches on the members it knows and ignores the
rest stays correct against a newer backend."""


# ─────────────────────────────────────────────────────────────────────────────
# Session-start REST response
# ─────────────────────────────────────────────────────────────────────────────


class SessionResponse(BaseModel):
    """Join credentials returned by POST ``session/start``."""

    livekit_url: str
    """Media room URL to connect to."""
    token: str
    """Short-lived participant join token."""
    room_name: str
    """Name of the room the session runs in."""
    session_id: str
    """Server-minted session identifier."""
    timings: SessionStartTimings | None = None
    """Server-side session-start phase breakdown, in milliseconds. ``None``
    on a backend that does not report it."""


class WsSessionStart(BaseModel):
    """Where to open the socket for a session on a self-hosted server's
    websocket transport (POST ``session/ws-start``).

    Not part of the published Cosmo wire contract, and deliberately not
    pinned to the spec: Cosmo's managed deployment answers a room and a join
    token, and only ``cosmo-server`` in websocket mode answers this. It
    carries ``room_name`` and ``timings`` as ``None`` so the session start
    reads the same shape either way.
    """

    session_id: str
    """Server-minted session identifier."""
    ws_url: str
    """Socket URL to open for this session."""
    ws_subprotocol: str
    """Subprotocol to request on the handshake; it carries the credential,
    since a browser cannot set headers on a websocket."""
    room_name: str | None = None
    """Always ``None`` on this transport — there is no room to name."""
    timings: SessionStartTimings | None = None
    """The server's start-phase breakdown when it reports one, and ``None``
    when it does not — a server answering this transport may report only the
    phases it actually has."""


class MintedToken(BaseModel):
    """End-user token returned by ``RealtimeClient.mint_token`` (POST
    ``auth/token``): a short-lived JWT scoped to one external user, safe to
    hand to a browser/device, usable as the ``token`` credential.

    ``token_id`` is the server-side revocation handle
    (``DELETE auth/token/{token_id}``) — keep it on your server; the device
    only needs ``jwt``. Cosmo always returns it; it is optional here because
    this model doubles as the ``TokenSource`` fetch shape, whose contract is
    any backend returning ``{jwt, expires_at}``."""

    jwt: str
    """The token itself. This is the only part a browser or device needs."""
    expires_at: datetime
    """When the token stops being accepted. A :class:`TokenSource` refreshes
    ahead of this by itself."""
    token_id: str | None = None
    """Revocation handle — keep it server-side and pass it to
    ``DELETE auth/token/{token_id}`` to kill the token early. ``None`` only
    when a custom token backend omitted it."""


_RFC3339 = re.compile(
    r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$"
)


def parse_minted_token(body: object) -> MintedToken | None:
    """Read a ``{jwt, expires_at}`` body into a :class:`MintedToken`, or
    ``None`` when it is not one.

    Stricter than ``MintedToken.model_validate`` on purpose, and shared by
    the mint call and the token endpoint so the two cannot disagree about
    which bodies are usable: ``jwt`` must be a non-empty string and
    ``expires_at`` a timestamp matching the grammar every SDK enforces —
    full date, ``T``, full time, and an offset. Pydantic alone would read an
    epoch number, a bare date, and an offsetless time as datetimes; the
    last is the one that silently disagrees, since a JavaScript ``Date``
    reads it as local time and lands hours away
    (``contract/mint-vectors.json``).
    """
    if not isinstance(body, dict):
        return None
    jwt = body.get("jwt")
    expires_at = body.get("expires_at")
    if not isinstance(jwt, str) or not jwt:
        return None
    if not isinstance(expires_at, str) or not _RFC3339.match(expires_at):
        return None
    try:
        return MintedToken.model_validate(body)
    except ValidationError:
        return None


class CredentialKind(str, Enum):
    """Which of the two realtime credentials the server saw."""

    API_KEY = "api_key"
    """A workspace key (``cosmo_…``), held by the workspace's own developer.
    Minting end-user tokens requires one, but not every key is scoped for
    it — read ``scopes`` rather than assuming."""
    USER_TOKEN = "user_token"
    """A minted end-user JWT, bound to one ``external_user_id`` and safe to
    hand to a browser or device. Cannot mint further tokens."""

    @classmethod
    def _missing_(cls, value: object) -> "CredentialKind | None":
        # The server authors this set, so a deployment newer than this package
        # can name a value it does not. Keep it as a member carrying the raw
        # string rather than raising: rejecting would cost the whole payload,
        # not just this field. Openness lives on the type so no field can be
        # widened and no use site can forget — the same place TypeScript and
        # Swift put it.
        if isinstance(value, str):
            member = str.__new__(cls, value)
            member._name_ = value.upper()
            member._value_ = value
            return member
        return None


class WorkspaceInfo(BaseModel):
    """The workspace a credential is bound to."""

    name: str
    """Human-readable workspace name."""
    slug: str
    """URL-safe workspace identifier."""


class CredentialInfo(BaseModel):
    """What :meth:`RealtimeClient.verify` learned about this credential (GET
    ``realtime/verify``). Returning at all means the credential authenticated
    against this deployment; the fields say what it can do from here."""

    credential: CredentialKind
    """Which credential kind the server saw.

    The set is the server's, not this SDK's, so a deployment newer than your
    package can name a kind this version does not. It arrives as a member
    carrying the raw string rather than failing the response — an
    unrecognized kind would otherwise cost the whole ``verify`` result,
    including the scopes and capability flags the caller asked for."""
    workspace: WorkspaceInfo | None = None
    """The workspace the credential is bound to. Present for an API key, which
    the workspace's own developer holds; ``None`` for a minted token, which is
    held by an end user."""

    scopes: list[str]
    """Scopes granted to this credential, e.g. ``realtime:use``."""
    can_start_sessions: bool
    """Whether the credential carries the scope a session start needs.
    ``False`` means it authenticated but is under-scoped."""
    realtime_voice_available: bool
    """Whether this deployment has the default voice stack configured. A
    floor, not a per-session guarantee — a session requesting an opt-in
    provider is checked against that provider instead."""
    external_user_id: str | None = None
    """The end user a minted token is bound to; ``None`` for an API key."""


class DialResult(BaseModel):
    """Outcome of :meth:`RealtimeSession.dial` (POST ``session/{id}/dial``):
    the dial was queued. The call rings asynchronously — observe progress via
    session events, not this return value. ``dial_id`` is the handle to
    correlate the call (e.g. with server-side dial status)."""

    dial_id: UUID
    """Handle for this dial, to correlate the call with server-side dial
    status."""


class SessionStatus(str, Enum):
    """Lifecycle state of a voice session."""

    ACTIVE = "active"
    """Still running."""
    COMPLETED = "completed"
    """Ended normally."""
    ERROR = "error"
    """Ended on a failure."""

    @classmethod
    def _missing_(cls, value: object) -> "SessionStatus | None":
        # The server authors this set, so a deployment newer than this package
        # can name a value it does not. Keep it as a member carrying the raw
        # string rather than raising: rejecting would cost the whole payload,
        # not just this field. Openness lives on the type so no field can be
        # widened and no use site can forget — the same place TypeScript and
        # Swift put it.
        if isinstance(value, str):
            member = str.__new__(cls, value)
            member._name_ = value.upper()
            member._value_ = value
            return member
        return None


class UsageStatus(str, Enum):
    """Whether a session's detailed usage summary is available.

    ``PENDING`` while the session runs and for a short window after it
    ends, before the summary is written. ``RECORDED`` once it is there
    and the numbers are final. ``UNAVAILABLE`` once that window has
    passed without one arriving: a session with no turn or speech
    activity records none, and neither does one torn down abnormally.
    """

    PENDING = "pending"
    """No summary yet — poll again shortly."""
    RECORDED = "recorded"
    """The summary is written and the numbers are final."""
    UNAVAILABLE = "unavailable"
    """No summary will arrive; stop polling."""

    @classmethod
    def _missing_(cls, value: object) -> "UsageStatus | None":
        # The server authors this set, so a deployment newer than this package
        # can name a value it does not. Keep it as a member carrying the raw
        # string rather than raising: rejecting would cost the whole payload,
        # not just this field. Openness lives on the type so no field can be
        # widened and no use site can forget — the same place TypeScript and
        # Swift put it.
        if isinstance(value, str):
            member = str.__new__(cls, value)
            member._name_ = value.upper()
            member._value_ = value
            return member
        return None


class SessionTokenUsage(BaseModel):
    """Token usage reported by the session's model provider, split by
    direction and modality. The live ``cosmo.usage`` event
    (:class:`UsageEvent`) counters plus the input and output totals, with
    the same cumulative semantics."""

    input_tokens: int = 0
    """Every input token, across all modalities."""
    output_tokens: int = 0
    """Every output token, across all modalities."""
    total_tokens: int = 0
    """Input plus output, as the provider reports it."""
    input_audio_tokens: int = 0
    """Audio the model was given."""
    input_text_tokens: int = 0
    """Text the model was given."""
    input_image_tokens: int = 0
    """Images the model was given."""
    input_cached_tokens: int = 0
    """Input served from the provider's cache. Already counted in
    ``input_tokens`` — a subset, not an addition."""
    output_audio_tokens: int = 0
    """Audio the model produced. On a session running ``audio.output=False``
    this depends on the provider: one with a native text-only mode produces
    none, while one without keeps generating speech that is discarded, and
    those tokens still accrue."""
    output_text_tokens: int = 0
    """Text the model produced."""


class SessionUsage(BaseModel):
    """Usage summary for one session, in provider-reported units.

    ``duration_seconds`` is set once the session ends. The rest of the
    detail arrives with the summary, so it is present only while
    ``usage_status`` is :attr:`UsageStatus.RECORDED`, at which point the
    numbers are final. ``tokens`` is ``None`` when the provider reports
    none.

    ``status`` and ``usage_status`` carry a value this SDK version predates
    as a member holding the raw string, so a new server state reads rather
    than raising."""

    status: SessionStatus
    """Where the session itself ended up — see :class:`SessionStatus`."""
    usage_status: UsageStatus
    """Whether the usage summary exists yet. Poll while this is
    :attr:`UsageStatus.PENDING`; stop on :attr:`UsageStatus.UNAVAILABLE`."""
    duration_seconds: float | None = None
    """Wall-clock length of the session, set once it ends."""
    turn_count: int | None = None
    """How many turns the conversation took."""
    user_speaking_seconds: float | None = None
    """How long the user was speaking."""
    agent_speaking_seconds: float | None = None
    """How long the agent was speaking."""
    provider: str | None = None
    """Which model provider actually ran the session, after the server
    resolved ``model``."""
    model: str | None = None
    """The concrete model id that ran, which a family alias resolves to."""
    tokens: SessionTokenUsage | None = None
    """The token breakdown. ``None`` when the provider reported none — that
    is absence of reporting, not zero usage."""
