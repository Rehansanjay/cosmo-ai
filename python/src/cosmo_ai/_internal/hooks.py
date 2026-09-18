"""Hooks for the realtime SDK: in-process lifecycle callbacks fired by the
session at four seams (SessionStart, PreToolUse, PostToolUse, SessionEnd).

Every seam hangs off something this process does, which is what makes it a
seam rather than a notification: SessionStart rewrites the config before it
is sent, PreToolUse gates a local handler, PostToolUse reads that handler's
outcome, and SessionEnd fires even when the socket dropped and no frame ever
arrived. Anything the SERVER did arrives as an event on the session's event
stream — ``UserSpeechTimeoutEvent`` for a fired silence hook — never as a
hook.

Declare a hook with the seam's decorator — the decorated name becomes a
:class:`Hook` — and attach with ``hooks=[...]`` on
:meth:`RealtimeClient.agent`; list order is fold order::

    from cosmo_ai import hooks

    @hooks.session_start
    def add_context(ctx) -> SessionStartResult:
        return SessionStartResult(additional_context="Be concise.")

    @hooks.pre_tool_use(matcher="delete_*")
    def block_deletes(ctx) -> PreToolUseResult:
        return PreToolUseResult(permission="deny", reason="disabled")

    agent = client.agent(..., hooks=[add_context, block_deletes])

Observer-grade by default; the two client-controlled seams honor overrides —
``SessionStart`` may inject ``additional_context`` into an inline agent's
instructions (a catalog agent drops it) and
``PreToolUse`` may deny or rewrite a local client-tool call. A throwing hook is
isolated and never breaks the session. A malformed matcher raises at
decoration, not at session start.
"""

from __future__ import annotations

import time
from collections.abc import Sequence
from dataclasses import dataclass
from enum import Enum
from fnmatch import fnmatchcase
from inspect import isawaitable
from types import MappingProxyType
from typing import TYPE_CHECKING, Any, Awaitable, Callable, Literal, Union, overload

import structlog

from cosmo_ai._internal.logging import get_logger
from cosmo_ai.errors import HookError, HookErrorCode
from cosmo_ai._internal.protocol import ServerHook

if TYPE_CHECKING:
    pass

logger: structlog.stdlib.BoundLogger = get_logger(__name__)


class DisconnectReason(str, Enum):
    """Why the session reached ``DISCONNECTED``. Defined here (not in the
    session engine) because the SessionEnd hook context carries it; the
    ``session`` facade re-exports it."""

    CLIENT_ENDED = "client_ended"
    """This side called :meth:`RealtimeSession.end` — a graceful end that
    told the server to tear down."""
    CLIENT_CLOSED = "client_closed"
    """This side dropped the local half without telling the server — either
    :meth:`RealtimeSession.close`, or a start that was cancelled before it
    finished."""
    HANDSHAKE_FAILED = "handshake_failed"
    """The start was refused rather than dropped — the server rejected the
    session-start request, or a local pre-flight check did."""
    SERVER_ENDED = "server_ended"
    """The server ended it — a duration or silence cap, or its own teardown."""
    TRANSPORT_ERROR = "transport_error"
    """The media connection failed — either it dropped underneath a live
    session, or the join never succeeded and the start raised. Do not read
    ``session_id`` as the discriminator between the two: a prepared start
    can already hold one when its join fails."""

HookEventName = Literal["SessionStart", "PreToolUse", "PostToolUse", "SessionEnd"]
"""The four points a hook can run at, and the name a hook registers under.
``SessionStart`` and ``SessionEnd`` bracket the session; ``PreToolUse`` can
deny or rewrite a tool call before it runs, and ``PostToolUse`` observes the
outcome after. The same four names, spelled identically, exist in every Cosmo
SDK."""

# A hook runs in-process on the session's hot path (SessionStart blocks session
# establishment; PreToolUse/PostToolUse are awaited inline in the tool-call RPC
# reply during a live voice turn — see design doc §7). Nothing bounds a hook's
# runtime, so a slow hook (e.g. a network call) stalls that path; this only
# warns, it never cancels or times out a hook.
_SLOW_HOOK_WARN_THRESHOLD_S = 0.2


# ── Tool outcome (what PostToolUse observes) ───────────────────────────


@dataclass(frozen=True)
class ToolOk:
    result: dict[str, Any] | None
    """What the handler returned, or ``None`` if it returned nothing."""


@dataclass(frozen=True)
class ToolError:
    message: str
    """The exception text from the handler that raised."""


@dataclass(frozen=True)
class ToolDenied:
    reason: str
    """Why a ``PreToolUse`` hook refused the call. The handler never ran."""


ToolOutcome = Union[ToolOk, ToolError, ToolDenied]
"""How a tool call finished, as ``PostToolUse`` sees it: :class:`ToolOk` with
the handler's result, :class:`ToolError` when the handler raised, or
:class:`ToolDenied` when a ``PreToolUse`` hook refused it and the handler never
ran. Match on the class — a denial is not an error."""


# ── Per-event contexts ─────────────────────────────────────────────────


@dataclass(frozen=True)
class SessionStartContext:
    # session_id does not exist until the handshake completes; read ReadyEvent
    # off the event stream for the started id.
    event: Literal["SessionStart"] = "SessionStart"
    """Names the seam, so one callback can serve several events."""


@dataclass(frozen=True)
class PreToolUseContext:
    tool_name: str
    """The tool about to run — what a ``matcher`` is tested against."""
    arguments: "MappingProxyType[str, Any]"  # read-only; rewrite via PreToolUseResult
    """The model's arguments, read-only. Rewrite them by returning
    :attr:`PreToolUseResult.updated_arguments`, not by mutating this."""
    session_id: str
    """The session the call belongs to."""
    event: Literal["PreToolUse"] = "PreToolUse"
    """Names the seam, so one callback can serve several events."""


@dataclass(frozen=True)
class PostToolUseContext:
    tool_name: str
    """The tool that ran."""
    arguments: dict[str, Any]
    """The arguments it ran with, after any ``PreToolUse`` rewrite."""
    outcome: ToolOutcome
    """How it finished — match on the class; a denial is not an error."""
    session_id: str
    """The session the call belonged to."""
    event: Literal["PostToolUse"] = "PostToolUse"
    """Names the seam, so one callback can serve several events."""


@dataclass(frozen=True)
class SessionEndContext:
    reason: DisconnectReason
    """Why the session ended — who ended it, and whether cleanly."""
    detail: str | None
    """Extra context on the ending when the server or transport supplied
    any."""
    session_id: str | None
    """The session that ended, or ``None`` if it never became live."""
    event: Literal["SessionEnd"] = "SessionEnd"
    """Names the seam, so one callback can serve several events."""


HookContext = Union[
    SessionStartContext,
    PreToolUseContext,
    PostToolUseContext,
    SessionEndContext,
]


# ── Per-event results (only override-capable events) ───────────────────


@dataclass(frozen=True)
class SessionStartResult:
    additional_context: str | None = None
    """Text to add to the model's instructions before the session opens.
    Several hooks returning context are concatenated in registration order.

    Applies to an inline agent only. A catalog agent runs its stored config
    verbatim, so context returned here is dropped with a warning rather than
    injected."""


@dataclass(frozen=True)
class PreToolUseResult:
    permission: Literal["allow", "deny"] | None = None
    """``"deny"`` blocks the call; ``"allow"`` states no objection. ``None``
    abstains and leaves the decision to the other hooks. Any deny wins."""
    reason: str | None = None
    """Why it was denied — surfaced to the model so it can say something
    useful instead of retrying blindly."""
    updated_arguments: dict[str, Any] | None = None
    """Replacement arguments for the call. ``None`` leaves them untouched;
    the last hook to rewrite wins."""


@dataclass(frozen=True)
class PreToolUseOutcome:
    """Folded result of all PreToolUse hooks for one tool call."""

    denied: bool
    reason: str | None
    arguments: dict[str, Any]


HookCallback = Callable[[Any], Union[Awaitable[Any], Any]]


@dataclass(frozen=True)
class Hook:
    """One declared hook: the seam it fires on, the callback, and (for the
    tool seams) the matcher. Produced by the seam decorators; attach with
    ``hooks=[...]`` — list order is fold order."""

    event: HookEventName
    """Which seam this hook fires on."""
    callback: HookCallback
    """What runs. It receives that event's context object and may be sync or
    async; it runs inline on the session's hot path, so keep it quick."""
    matcher: str | None = None
    """Which tools it applies to, for the tool-use events — a pattern tested
    against ``tool_name``. ``None`` matches every tool, and the field is
    meaningless on the session events."""


def tool_name_matches(tool_name: str, pattern: str) -> bool:
    """Normative matcher grammar, shared with the Swift SDK via
    ``hook-matcher-vectors.json``: glob-style
    ``*`` ``?`` ``[seq]`` ``[!seq]``, case-sensitive, matched against the full
    tool name, no path semantics. ``fnmatchcase`` because plain ``fnmatch`` is
    case-insensitive on Windows. A malformed pattern is rejected at
    decoration (:func:`_validate_matcher`) rather than reaching this
    function, so every pattern seen here is well-formed."""
    return fnmatchcase(tool_name, pattern)


def _validate_matcher(pattern: str) -> None:
    """Reject an unterminated ``[...]`` group at decoration time.

    ``fnmatch`` never raises on a malformed pattern — it treats a stray ``[``
    as a literal character (mirrors ``fnmatch.translate``'s own bracket scan),
    so e.g. ``matcher="[delete_*"`` would silently never match any real tool
    name instead of erroring. For a ``PreToolUse`` deny matcher that is a
    silent fail-open (the guard never fires), so this fails loud instead."""
    i, n = 0, len(pattern)
    while i < n:
        if pattern[i] == "[":
            j = i + 1
            if j < n and pattern[j] == "!":
                j += 1
            if j < n and pattern[j] == "]":
                j += 1
            while j < n and pattern[j] != "]":
                j += 1
            if j >= n:
                raise HookError(
                    code=HookErrorCode.MALFORMED_MATCHER,
                    message=f"malformed hook matcher {pattern!r}: "
                    f"unterminated '[' at index {i}",
                )
            i = j + 1
        else:
            i += 1


# ── Seam decorators ────────────────────────────────────────────────────


def _seam(
    event: HookEventName, fn: HookCallback | None, matcher: str | None = None
) -> Any:
    if matcher is not None:
        _validate_matcher(matcher)
    if fn is None:
        return lambda f: Hook(event, f, matcher)
    return Hook(event, fn, matcher)


@overload
def session_start(fn: HookCallback) -> Hook: ...
@overload
def session_start(fn: None = None) -> Callable[[HookCallback], Hook]: ...
def session_start(fn: HookCallback | None = None) -> Any:
    """Declare a ``SessionStart`` hook — may return a
    :class:`SessionStartResult` to inject ``additional_context`` into an
    inline agent's instructions. A catalog agent drops it."""
    return _seam("SessionStart", fn)


@overload
def pre_tool_use(fn: HookCallback) -> Hook: ...
@overload
def pre_tool_use(*, matcher: str | None = None) -> Callable[[HookCallback], Hook]: ...
def pre_tool_use(
    fn: HookCallback | None = None, *, matcher: str | None = None
) -> Any:
    """Declare a ``PreToolUse`` hook — may return a :class:`PreToolUseResult`
    to deny or rewrite a local client-tool call. ``matcher`` restricts it to
    matching tool names; bare form matches every tool."""
    return _seam("PreToolUse", fn, matcher)


@overload
def post_tool_use(fn: HookCallback) -> Hook: ...
@overload
def post_tool_use(*, matcher: str | None = None) -> Callable[[HookCallback], Hook]: ...
def post_tool_use(
    fn: HookCallback | None = None, *, matcher: str | None = None
) -> Any:
    """Declare a ``PostToolUse`` observer, fired with the final
    :data:`ToolOutcome` of each local client-tool call."""
    return _seam("PostToolUse", fn, matcher)


@overload
def session_end(fn: HookCallback) -> Hook: ...
@overload
def session_end(fn: None = None) -> Callable[[HookCallback], Hook]: ...
def session_end(fn: HookCallback | None = None) -> Any:
    """Declare a ``SessionEnd`` observer, fired exactly once at teardown."""
    return _seam("SessionEnd", fn)


def resolve_hooks(
    hooks: Sequence[Hook | ServerHook] | None, *, server_allowed: bool = True
) -> tuple[Hook | ServerHook, ...] | None:
    """Snapshot the agent's ``hooks`` argument. Elements are :class:`Hook`
    (client callbacks, from the seam decorators) or :data:`ServerHook` kinds
    (wire config the server executes). A catalog launch passes
    ``server_allowed=False``: its stored config governs server behavior, so
    server hooks are rejected there."""
    if hooks is None:
        return None
    for hook in hooks:
        if isinstance(hook, ServerHook):
            if not server_allowed:
                raise HookError(
                    code=HookErrorCode.SERVER_HOOK_NOT_ALLOWED,
                    message="a catalog agent runs its stored config verbatim — "
                    "server hooks cannot ride along",
                )
        elif not isinstance(hook, Hook):
            raise HookError(
                code=HookErrorCode.INVALID_HOOK,
                message="hooks elements must be Hook (declare with the seam "
                "decorators) or a server hook such as SilenceTimeout, "
                f"got {type(hook).__name__}",
            )
    return tuple(hooks)


# ── Dispatch engine ────────────────────────────────────────────────────


class HookEngine:
    """Dispatch over an ordered hook tuple. Fold semantics are pinned by
    ``hook-engine-vectors.json``, shared with the
    TS and Swift SDKs."""

    def __init__(self, hooks: Sequence[Hook]) -> None:
        self._by_event: dict[HookEventName, list[Hook]] = {
            "SessionStart": [],
            "PreToolUse": [],
            "PostToolUse": [],
            "SessionEnd": [],
        }
        for hook in hooks:
            self._by_event[hook.event].append(hook)

    async def _call(self, hook: Hook, ctx: HookContext) -> Any:
        start = time.monotonic()
        try:
            out = hook.callback(ctx)
            if isawaitable(out):
                out = await out
            return out
        except Exception:
            logger.exception(
                "realtime.hook_failed", hook_event=ctx.event, stack_info=True
            )
            return None
        finally:
            elapsed_s = time.monotonic() - start
            if elapsed_s > _SLOW_HOOK_WARN_THRESHOLD_S:
                logger.warning(
                    "realtime.hook_slow",
                    hook_event=ctx.event,
                    elapsed_ms=round(elapsed_s * 1000, 1),
                )

    async def run_session_start(self, ctx: SessionStartContext) -> str | None:
        chunks: list[str] = []
        for hook in self._by_event["SessionStart"]:
            out = await self._call(hook, ctx)
            if isinstance(out, SessionStartResult) and out.additional_context:
                chunks.append(out.additional_context)
        return "\n\n".join(chunks) if chunks else None

    async def run_pre_tool_use(
        self, *, tool_name: str, arguments: dict[str, Any], session_id: str
    ) -> PreToolUseOutcome:
        current = dict(arguments)
        for hook in self._by_event["PreToolUse"]:
            if hook.matcher is not None and not tool_name_matches(
                tool_name, hook.matcher
            ):
                continue
            ctx = PreToolUseContext(
                tool_name=tool_name,
                arguments=MappingProxyType(current),
                session_id=session_id,
            )
            out = await self._call(hook, ctx)
            if not isinstance(out, PreToolUseResult):
                continue
            if out.permission == "deny":
                logger.info(
                    "realtime.hook_denied_tool", tool=tool_name, reason=out.reason
                )
                return PreToolUseOutcome(
                    denied=True, reason=out.reason or "denied by hook", arguments=current
                )
            if out.updated_arguments is not None:
                current = dict(out.updated_arguments)
        return PreToolUseOutcome(denied=False, reason=None, arguments=current)

    async def run_post_tool_use(self, ctx: PostToolUseContext) -> None:
        for hook in self._by_event["PostToolUse"]:
            if hook.matcher is not None and not tool_name_matches(
                ctx.tool_name, hook.matcher
            ):
                continue
            await self._call(hook, ctx)

    async def run_session_end(self, ctx: SessionEndContext) -> None:
        for hook in self._by_event["SessionEnd"]:
            await self._call(hook, ctx)
