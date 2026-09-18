"""MCP tool source for the realtime SDK: local (stdio) MCP servers whose tools
are exposed to the model as ClientTools, each call proxied to the live MCP
session.

Attach servers with the ``mcp`` argument on :meth:`RealtimeClient.agent` — a
``.mcp.json`` config file (the Claude Code format; one file describes many
servers), or a list whose elements are config files and/or inline
:class:`McpStdioServer` objects (a path element expands, in place, to that
file's servers)::

    agent = client.agent(mcp="./mcp.json")
    agent = client.agent(mcp=[McpStdioServer(name=..., command=..., args=...)])
    agent = client.agent(mcp=[*BUILTIN_SERVERS, "./mcp.json"])

A missing or malformed file and duplicate server names raise
:class:`McpError` when the agent is built, not mid-call; ``code`` names which
failure it was. A connection or tool failure mid-call raises the same type,
coded ``connection_failed``, ``invalid_response``, ``server_error`` or
``tool_error``. Remote
(``http``/``sse``) entries are skipped with a warning — the file stays
shareable with harnesses that support them; v1 is stdio-only. The ``mcp``
package is imported lazily at connect so importing this module (and
cosmo_ai) never requires the [mcp] extra.
"""

from __future__ import annotations

import asyncio
import json
import os
import re
from collections.abc import Sequence
from contextlib import AsyncExitStack
from dataclasses import dataclass, field
from enum import Enum
from pathlib import Path
from typing import Any, Awaitable, Callable, Union

import structlog
from pydantic import ValidationError

from cosmo_ai._internal.logging import get_logger
from cosmo_ai._internal.schema import (
    sanitize_schema_permissive,
    schema_bound_violation,
)
from cosmo_ai._internal.protocol import (
    _CLIENT_TOOL_MAX_DESCRIPTION_LEN,
    _CLIENT_TOOL_MAX_NAME_LEN,
    _TOOL_SPECS_MAX_COUNT,
    ClientTool,
)
from cosmo_ai.errors import RealtimeError

logger: structlog.stdlib.BoundLogger = get_logger(__name__)


class McpErrorCode(str, Enum):
    """Stable codes clients match on to tell one MCP failure from another.

    The set is closed: every one is raised by this SDK, never by the server,
    so it changes only when the SDK does."""

    NOT_A_FILE = "not_a_file"
    """The config path does not point at a file."""
    CANNOT_READ = "cannot_read"
    """The config file exists but could not be read or decoded as UTF-8."""
    INVALID_JSON = "invalid_json"
    """The config file is not valid JSON."""
    MISSING_SERVERS = "missing_servers"
    """The config has no ``mcpServers`` object."""
    INVALID_SERVER_ENTRY = "invalid_server_entry"
    """A server entry is not an object."""
    MISSING_COMMAND = "missing_command"
    """A stdio server entry has no ``command``."""
    INVALID_ARGS = "invalid_args"
    """``args`` is not an array of strings or whole numbers."""
    INVALID_ENV = "invalid_env"
    """``env`` is not an object of string values."""
    INVALID_CWD = "invalid_cwd"
    """``cwd`` is not a string."""
    DUPLICATE_SERVER_NAME = "duplicate_server_name"
    """Two servers resolved to the same name, so a tool call would be
    ambiguous."""
    EXTRA_NOT_INSTALLED = "extra_not_installed"
    """The ``mcp`` extra is not installed — ``pip install 'cosmo-ai-sdk[mcp]'``.
    The package is imported lazily, so this surfaces at connect, not import."""
    CONNECTION_FAILED = "connection_failed"
    """The server process could not be launched or did not complete the MCP
    handshake."""
    INVALID_RESPONSE = "invalid_response"
    """The server answered in a shape this SDK could not read."""
    SERVER_ERROR = "server_error"
    """The server reported a protocol-level error."""
    TOOL_ERROR = "tool_error"
    """A tool call reached the server and the tool itself failed."""


class McpError(RealtimeError):
    """An MCP server could not be configured, reached, or called: the config
    path is not a file, the ``.mcp.json`` document is malformed, two servers
    share a name, the connection failed, or a tool reported an error.

    ``code`` names which of those it was — match on it rather than on the
    message, which is written for a human and is not part of the contract."""

    def __init__(self, *, code: McpErrorCode, message: str) -> None:
        self.code = code
        self.message = message
        super().__init__(message)


@dataclass(frozen=True)
class McpStdioServer:
    """One local MCP server launched over stdio."""

    name: str
    """How this server is identified. Must be unique across the agent's
    servers, or building it raises."""
    command: str
    """Executable to launch, spoken to over stdio."""
    args: tuple[str, ...] = ()
    """Arguments passed to that executable."""
    env: dict[str, str] | None = None
    """Environment for the server process. ``None`` does not inherit this
    process's environment: the MCP client builds a small allowlisted one
    (``HOME``, ``PATH``, ``SHELL``, ``TERM``, ``USER``, ``LOGNAME``), so a
    credential the server needs has to be passed here explicitly."""
    cwd: str | None = None
    """Working directory to launch in. ``None`` uses this process's."""


_REMOTE_TYPES = frozenset({"http", "sse"})


_INT64_RANGE = range(-(2**63), 2**63)


def _arg_text(value: Any) -> str | None:
    """One argv entry, or None when the value cannot become one.

    An unquoted port is the common case, so a whole number is accepted and
    written in decimal. Nothing else numeric is: ``true`` would invent an
    argument nobody wrote, and a fractional or out-of-Int64 number has no
    spelling both SDKs agree on — Swift's decoder reads ``1.0`` as ``1`` and
    renders a larger integer in scientific notation. Quote it and the text
    passes through untouched.
    """
    if isinstance(value, str):
        return value
    if isinstance(value, bool):
        return None
    if isinstance(value, int):
        return str(value) if value in _INT64_RANGE else None
    if isinstance(value, float):
        if value.is_integer() and int(value) in _INT64_RANGE:
            return str(int(value))
        return None
    return None


def parse_mcp_config(text: str) -> tuple[list[McpStdioServer], list[str]]:
    """Parse a Claude-Code ``.mcp.json`` document. Returns ``(stdio servers,
    names of remote entries skipped in v1)``.

    Remote (``http``/``sse``) entries are reported rather than raised — the
    file stays shareable with harnesses that support them."""
    try:
        data = json.loads(text)
    except json.JSONDecodeError as exc:
        raise McpError(
            code=McpErrorCode.INVALID_JSON,
            message=f"`.mcp.json` is not valid JSON: {exc}",
        ) from None
    raw = data.get("mcpServers") if isinstance(data, dict) else None
    if not isinstance(raw, dict):
        raise McpError(
            code=McpErrorCode.MISSING_SERVERS,
            message="`.mcp.json` must contain an object 'mcpServers'",
        )
    servers: list[McpStdioServer] = []
    skipped_remote: list[str] = []
    # Sorted, not document order: Swift decodes into a dictionary and has no
    # document order to follow, so this is what both can agree on — it fixes
    # the resulting server order and which malformed entry is reported first.
    for name in sorted(raw):
        entry = raw[name]
        if not isinstance(entry, dict):
            raise McpError(
                code=McpErrorCode.INVALID_SERVER_ENTRY,
                message=f"server {name!r} must be an object",
            )
        url = entry.get("url")
        if (isinstance(url, str) and url) or entry.get("type") in _REMOTE_TYPES:
            skipped_remote.append(name)
            continue
        command = entry.get("command")
        if not isinstance(command, str) or not command:
            raise McpError(
                code=McpErrorCode.MISSING_COMMAND,
                message=f"server {name!r} must include a 'command'",
            )
        # An explicit null means absent, as it already does for env and cwd.
        raw_args = entry.get("args")
        if raw_args is None:
            raw_args = []
        args: list[str] | None = None
        if isinstance(raw_args, list):
            converted = [_arg_text(a) for a in raw_args]
            if all(a is not None for a in converted):
                args = [a for a in converted if a is not None]
        if args is None:
            raise McpError(
                code=McpErrorCode.INVALID_ARGS,
                message=(
                    f"server {name!r} 'args' must be an array of strings or "
                    "whole numbers"
                ),
            )
        env = entry.get("env")
        if env is not None and (
            not isinstance(env, dict)
            or not all(isinstance(v, str) for v in env.values())
        ):
            raise McpError(
                code=McpErrorCode.INVALID_ENV,
                message=f"server {name!r} 'env' must be an object of string values",
            )
        cwd = entry.get("cwd")
        if cwd is not None and not isinstance(cwd, str):
            raise McpError(
                code=McpErrorCode.INVALID_CWD,
                message=f"server {name!r} 'cwd' must be a string",
            )
        servers.append(
            McpStdioServer(
                name=name,
                command=command,
                args=tuple(args),
                env=dict(env) if env is not None else None,
                cwd=cwd,
            )
        )
    return servers, skipped_remote


McpInput = Union[
    str, "os.PathLike[str]", Sequence[Union[str, "os.PathLike[str]", McpStdioServer]]
]
"""What the agent's ``mcp=`` parameter accepts: a path to one ``.mcp.json``
config file, or a sequence mixing such paths with :class:`McpStdioServer`
values. A single server goes in a sequence of one; only the path form is
allowed bare. Each path expands in place to the servers that file declares, so
paths and explicit servers compose. Duplicate server names raise."""


def _servers_from_file(path: Path) -> list[McpStdioServer]:
    """The path arm: one ``.mcp.json`` config file describing many servers.
    Remote entries are skipped with a warning; zero resulting servers warns."""
    # ``Path.is_file`` only swallows ENOENT, ENOTDIR, EBADF and ELOOP, so an
    # unreadable path raises straight out of the probe — it belongs inside the
    # guard with the read, not before it. ``UnicodeDecodeError`` is a
    # ValueError rather than an OSError, so bytes that are not UTF-8 need
    # naming here too or they escape the error family entirely.
    try:
        is_file = path.is_file()
        text = path.read_text(encoding="utf-8") if is_file else ""
    except (OSError, UnicodeDecodeError) as exc:
        raise McpError(
            code=McpErrorCode.CANNOT_READ, message=f"{path}: cannot read: {exc}"
        ) from None
    if not is_file:
        raise McpError(
            code=McpErrorCode.NOT_A_FILE,
            message=f"mcp config path is not a file: {path}",
        )
    try:
        servers, skipped_remote = parse_mcp_config(text)
    except McpError as exc:
        raise McpError(code=exc.code, message=f"{path}: {exc.message}") from None
    for name in skipped_remote:
        logger.warning("realtime.mcp.remote_server_skipped", server=name)
    if not servers:
        logger.warning("realtime.mcp.none_found", path=str(path))
    return servers


def resolve_mcp(mcp: McpInput | None) -> tuple[McpStdioServer, ...] | None:
    """Normalize the ``mcp`` argument to a tuple of servers — the single
    internal form every input arm converges to. A path element expands, in
    place, to that config file's servers. Duplicate names raise."""
    if mcp is None:
        return None
    items: Sequence[str | os.PathLike[str] | McpStdioServer]
    if isinstance(mcp, (str, os.PathLike)):
        items = [mcp]
    else:
        items = list(mcp)
    resolved: list[McpStdioServer] = []
    for item in items:
        if isinstance(item, McpStdioServer):
            resolved.append(item)
        elif isinstance(item, (str, os.PathLike)):
            resolved.extend(_servers_from_file(Path(item).expanduser()))
        else:
            raise TypeError(
                f"mcp elements must be McpStdioServer or a path, got {type(item).__name__}"
            )
    seen: set[str] = set()
    for server in resolved:
        if server.name in seen:
            raise McpError(
                code=McpErrorCode.DUPLICATE_SERVER_NAME,
                message=f"duplicate MCP server name: {server.name!r}",
            )
        seen.add(server.name)
    return tuple(resolved)


async def connect_mcp(
    servers: Sequence[McpStdioServer],
    *,
    reserved_names: frozenset[str] = frozenset(),
    reserved_count: int = 0,
) -> ConnectedMcp:
    """Open every server (sequentially), list + build tools, and return a
    cleanup-safe handle. A server that fails to start is skipped; any
    failure or cancellation before returning tears down all opened
    subprocesses so nothing leaks."""
    parent = AsyncExitStack()
    try:
        connected: list[_ConnectedServer] = []
        for server in servers:
            child = AsyncExitStack()
            try:
                cs = await _open_stdio_server(server, child)
            except McpError as exc:
                await child.aclose()
                # A missing extra is not one server failing to start — no
                # server can start — so it propagates instead of being skipped.
                if exc.code is McpErrorCode.EXTRA_NOT_INSTALLED:
                    raise
                logger.exception(
                    "realtime.mcp.server_connect_failed",
                    server=server.name,
                    stack_info=True,
                )
                continue
            except asyncio.CancelledError:
                await child.aclose()
                raise
            except Exception:
                logger.exception(
                    "realtime.mcp.server_connect_failed",
                    server=server.name,
                    stack_info=True,
                )
                await child.aclose()
                continue
            await parent.enter_async_context(child)
            connected.append(cs)
        tools, skipped = build_mcp_tools(
            connected,
            reserved_names=set(reserved_names),
            reserved_count=reserved_count,
        )
        for sk in skipped:
            logger.warning(
                "realtime.mcp.tool_skipped", server=sk.server, tool=sk.tool, reason=sk.reason
            )
        return ConnectedMcp(tools, skipped, parent)
    except BaseException:
        await parent.aclose()
        raise


CallTool = Callable[[str, dict[str, Any]], Awaitable[Any]]

_VALID_REASONS = (
    "name_overflow",
    "name_collision",
    "invalid_schema",
    "schema_overflow",
    "count_overflow",
)


@dataclass(frozen=True)
class SkippedTool:
    """A tool dropped during build, surfaced on ConnectedMcp.skipped."""

    server: str
    tool: str
    reason: str  # one of _VALID_REASONS

    def __post_init__(self) -> None:
        if self.reason not in _VALID_REASONS:
            raise ValueError(
                f"SkippedTool.reason {self.reason!r} is not one of {_VALID_REASONS}"
            )


@dataclass
class _ConnectedServer:
    """A live MCP server: its listed tools plus a bound call function and a
    per-server lock (one ClientSession is not assumed concurrency-safe)."""

    name: str
    tools: list[Any]  # mcp.types.Tool-like: .name, .description, .inputSchema
    call_tool: CallTool
    lock: asyncio.Lock = field(default_factory=asyncio.Lock)


_NAME_UNSAFE = re.compile(r"[^A-Za-z0-9_]+")


def _exposed_name(server: str, tool: str) -> str:
    return _NAME_UNSAFE.sub("_", f"mcp__{server}__{tool}")


def _normalize_schema(input_schema: Any) -> dict[str, Any] | None:
    """Return the JSON-Schema dict reduced to the backend gate's allowed
    dialect if it is a top-level object, else None.

    Deliberately permissive, unlike the ``@tool`` builder pipeline: MCP
    servers routinely emit extra keys — ``$schema``, ``additionalProperties``,
    ``title`` — and the gate rejects the whole declaration on the first
    unknown key. Foreign servers' schemas can't be fixed by the author, so
    unknown keys are dropped instead of rejected.
    """
    if not isinstance(input_schema, dict):
        return None
    if input_schema.get("type") != "object":
        return None
    sanitized = sanitize_schema_permissive(input_schema)
    assert isinstance(sanitized, dict)
    return sanitized


def _build_proxy_tool(
    server: _ConnectedServer, mcp_tool: Any, exposed: str, schema: dict[str, Any]
) -> ClientTool:
    original = mcp_tool.name
    description = (getattr(mcp_tool, "description", None) or original)[
        :_CLIENT_TOOL_MAX_DESCRIPTION_LEN
    ]
    call_tool = server.call_tool
    lock = server.lock
    server_name = server.name

    async def handler(args: dict[str, Any]) -> dict[str, Any]:
        try:
            async with lock:
                result = await call_tool(original, args)
        except Exception:
            logger.exception(
                "realtime.mcp.tool_call_failed",
                server=server_name,
                tool=original,
                stack_info=True,
            )
            raise
        return _map_tool_result(result)

    return ClientTool(
        name=exposed, description=description, parameters=schema, handler=handler
    )


def build_mcp_tools(
    servers: Sequence[_ConnectedServer],
    *,
    reserved_names: set[str],
    reserved_count: int,
) -> tuple[list[ClientTool], list[SkippedTool]]:
    """Build proxy ClientTools across all servers, validating against the
    merged tool set: name overflow, collision (vs reserved + each other),
    invalid schema, and the session's total tool-count cap."""
    tools: list[ClientTool] = []
    skipped: list[SkippedTool] = []
    used = set(reserved_names)
    budget = _TOOL_SPECS_MAX_COUNT - reserved_count
    for server in servers:
        for mcp_tool in server.tools:
            name = _exposed_name(server.name, mcp_tool.name)
            if len(name) > _CLIENT_TOOL_MAX_NAME_LEN:
                skipped.append(SkippedTool(server.name, mcp_tool.name, "name_overflow"))
                continue
            if name in used:
                skipped.append(SkippedTool(server.name, mcp_tool.name, "name_collision"))
                continue
            schema = _normalize_schema(getattr(mcp_tool, "inputSchema", None))
            if schema is None:
                skipped.append(SkippedTool(server.name, mcp_tool.name, "invalid_schema"))
                continue
            if schema_bound_violation(schema) is not None:
                skipped.append(
                    SkippedTool(server.name, mcp_tool.name, "schema_overflow")
                )
                continue
            if len(tools) >= budget:
                skipped.append(SkippedTool(server.name, mcp_tool.name, "count_overflow"))
                continue
            used.add(name)
            tools.append(_build_proxy_tool(server, mcp_tool, name, schema))
    return tools, skipped


def _collect_text(result: Any) -> str:
    blocks = getattr(result, "content", None) or []
    parts = [
        b.text
        for b in blocks
        if getattr(b, "type", None) == "text" and getattr(b, "text", None)
    ]
    return "\n".join(parts)


def _map_tool_result(result: Any) -> dict[str, Any]:
    """Map an MCP CallToolResult to the dict a ClientTool handler returns.
    Raises :class:`McpError` when the tool reports an error."""
    if getattr(result, "isError", False):
        raise McpError(
            code=McpErrorCode.TOOL_ERROR,
            message=_collect_text(result) or "MCP tool reported an error",
        )
    out: dict[str, Any] = {}
    structured = getattr(result, "structuredContent", None)
    if structured is not None:
        out["structured"] = structured
    text = _collect_text(result)
    if text:
        out["text"] = text
    non_text = [
        b.type
        for b in (getattr(result, "content", None) or [])
        if getattr(b, "type", None) != "text"
    ]
    if non_text:
        out["non_text"] = non_text
    return out or {"text": ""}


_EXTRA_HINT = (
    "MCP support requires the 'mcp' extra. Install with: "
    "pip install 'cosmo-ai-sdk[mcp]'"
)


def _call_failure_code(exc: Exception, protocol_error: type[Exception]) -> McpErrorCode:
    """Which failure a live call hit, from the exception the ``mcp`` package
    raised.

    The three are distinguishable and mean different things to a caller: the
    server answered with a JSON-RPC error, the server answered with something
    undecodable, or the server is not there to answer — a subprocess that has
    died reads as a closed stream, not as a server-returned error.
    """
    if isinstance(exc, protocol_error):
        return McpErrorCode.SERVER_ERROR
    if isinstance(exc, ValidationError):
        return McpErrorCode.INVALID_RESPONSE
    return McpErrorCode.CONNECTION_FAILED


async def _open_stdio_server(
    server: McpStdioServer, stack: AsyncExitStack
) -> _ConnectedServer:
    """Spawn one stdio MCP server, initialize, and list its tools. Transport +
    session are entered into `stack`, which owns their teardown."""
    try:
        from mcp import ClientSession, StdioServerParameters
        from mcp.client.stdio import stdio_client
        from mcp.shared.exceptions import McpError as _ProtocolError
    except ImportError as exc:
        raise McpError(
            code=McpErrorCode.EXTRA_NOT_INSTALLED, message=_EXTRA_HINT
        ) from exc

    params = StdioServerParameters(
        command=server.command,
        args=list(server.args),
        env=dict(server.env) if server.env else None,
        cwd=server.cwd,
    )
    try:
        read, write = await stack.enter_async_context(stdio_client(params))
        session = await stack.enter_async_context(ClientSession(read, write))
        await session.initialize()
        listed = await session.list_tools()
    except asyncio.CancelledError:
        raise
    except Exception as exc:
        raise McpError(
            code=_call_failure_code(exc, _ProtocolError),
            message=f"MCP server {server.name!r}: {exc}",
        ) from exc

    async def call_tool(tool_name: str, args: dict[str, Any]) -> Any:
        try:
            return await session.call_tool(tool_name, args)
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            raise McpError(
                code=_call_failure_code(exc, _ProtocolError),
                message=f"MCP server {server.name!r}: tool {tool_name!r} failed: {exc}",
            ) from exc

    return _ConnectedServer(
        name=server.name, tools=list(listed.tools), call_tool=call_tool
    )


class ConnectedMcp:
    """A per-session live MCP handle: the proxy tools, the build diagnostics,
    and idempotent teardown of every server subprocess."""

    def __init__(
        self,
        tools: list[ClientTool],
        skipped: list[SkippedTool],
        stack: AsyncExitStack,
    ) -> None:
        self.tools = tools
        self.skipped = skipped
        self._stack = stack
        self._closed = False

    async def aclose(self) -> None:
        if self._closed:
            return
        self._closed = True
        await self._stack.aclose()
