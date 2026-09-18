"""First-class client-tool builder: the ``@tool`` decorator.

The decorated function's first parameter annotation — a Pydantic
``BaseModel`` subclass — drives the model-facing JSON Schema, runtime
validation, and the typed arguments the handler receives::

    class WeatherInput(BaseModel):
        city: str = Field(description="City name")
        unit: Literal["c", "f"] = "c"

    @tool  # or @tool(name=..., description=..., background=False)
    async def get_weather(input: WeatherInput) -> dict[str, Any]:
        \"\"\"Current weather for a city.\"\"\"
        return {"temp_c": await lookup(input.city)}

    agent = client.agent(tools=[get_weather])  # the decorated name IS the ClientTool

The decorator lowers to the existing spec types
(:class:`~cosmo_ai._internal.protocol.ClientTool` /
:class:`~cosmo_ai._internal.protocol.BackgroundClientTool`); hand-written raw
``parameters`` remain the advanced escape hatch. The emitted schema is
checked against the backend's restricted dialect when the tool is
constructed, so a schema the server would reject fails at import/startup
instead of surfacing as a ``ready.rejected_tools`` entry at connect.

A malformed model call raises :class:`~cosmo_ai.errors.ToolInputValidationError`
inside the synthesized handler before user code runs; the dispatch layer
turns it into the ``{ok: false, error}`` envelope so the model can
self-correct. PreToolUse hooks still see (and may rewrite) raw args —
validation applies to the post-hook args.
"""

from __future__ import annotations

import inspect
import re
from typing import Any, Awaitable, Callable, Literal, TypeVar, get_type_hints, overload

from pydantic import BaseModel, ValidationError

from cosmo_ai.errors import (
    ToolDefinitionError,
    ToolDefinitionErrorCode,
    ToolInputIssue,
    ToolInputValidationError,
)
from cosmo_ai._internal.protocol import (
    AgentTool,
    _CLIENT_TOOL_MAX_DESCRIPTION_LEN,
    BackgroundClientTool,
    BackgroundClientToolHandler,
    ClientTool,
    ClientToolHandler,
)
from cosmo_ai.tools._jobs import ClientToolJob
from cosmo_ai.tools._sdk_tools import SDK_TOOL_NAME_PREFIX, reserved_name_error
from cosmo_ai._internal.schema import (
    build_tool_parameters,
    emit_model_schema,
    text_violation,
)

_NAME_RE = re.compile(r"^[a-z][a-z0-9_]{2,63}$")

_MAX_ISSUE_LINES = 5
_MAX_MESSAGE_BYTES = 1024

# Pydantic error-context keys safe to echo: each is a schema-derived
# constraint (the declared bound or the allowed values), never the submitted
# value. Anything outside this allowlist is dropped so a payload can't leak.
_SAFE_CTX_KEYS = frozenset(
    {"expected", "ge", "gt", "le", "lt", "min_length", "max_length", "actual_length"}
)

_TYPE_WORDS = {
    "string": "a string",
    "int": "an integer",
    "float": "a number",
    "decimal": "a number",
    "bool": "a boolean",
    "list": "an array",
    "dict": "an object",
    "model": "an object",
    "none": "null",
}

_ModelT = TypeVar("_ModelT", bound=BaseModel)
_InlineFn = Callable[[Any], Awaitable[Any]]
_BackgroundFn = Callable[[Any, ClientToolJob], Awaitable[None]]


def _sanitize_issues(exc: ValidationError) -> list[ToolInputIssue]:
    """Structured issues with submitted values redacted: path + constraint
    kind + allowlisted expected-shape context only."""
    issues: list[ToolInputIssue] = []
    for err in exc.errors(include_input=False, include_url=False):
        raw: dict[str, Any] = {"loc": list(err["loc"]), "type": err["type"]}
        ctx = err.get("ctx") or {}
        safe_ctx = {
            key: value if isinstance(value, (str, int, float, bool)) else str(value)
            for key, value in ctx.items()
            if key in _SAFE_CTX_KEYS
        }
        if safe_ctx:
            raw["ctx"] = safe_ctx
        issues.append(
            ToolInputIssue(
                path=_issue_path(raw["loc"]),
                code=err["type"],
                constraint=_issue_constraint(raw),
            )
        )
    return issues


def _issue_path(loc: list[Any]) -> str:
    parts: list[str] = []
    for item in loc:
        if isinstance(item, int):
            parts.append(f"[{item}]")
        elif parts:
            parts.append(f".{item}")
        else:
            parts.append(str(item))
    return "".join(parts) or "(root)"


def _issue_constraint(issue: dict[str, Any]) -> str:
    kind = issue["type"]
    ctx = issue.get("ctx") or {}
    if kind == "missing":
        return "required"
    if kind in ("literal_error", "enum"):
        expected = ctx.get("expected")
        return f"expected one of {expected}" if expected else "not an allowed value"
    if kind == "extra_forbidden":
        return "unexpected"
    if kind.endswith("_type"):
        word = _TYPE_WORDS.get(kind.removesuffix("_type"))
        return f"expected {word}" if word else f"invalid ({kind})"
    if kind in ("string_too_short", "string_too_long"):
        bound = ctx.get("min_length") if kind == "string_too_short" else ctx.get("max_length")
        word = "at least" if kind == "string_too_short" else "at most"
        return f"must be {word} {bound} characters"
    if kind in ("too_short", "too_long"):
        bound = ctx.get("min_length") if kind == "too_short" else ctx.get("max_length")
        word = "at least" if kind == "too_short" else "at most"
        return f"must have {word} {bound} items"
    if kind == "greater_than":
        return f"must be > {ctx.get('gt')}"
    if kind == "greater_than_equal":
        return f"must be >= {ctx.get('ge')}"
    if kind == "less_than":
        return f"must be < {ctx.get('lt')}"
    if kind == "less_than_equal":
        return f"must be <= {ctx.get('le')}"
    return f"invalid ({kind})"


def _format_invalid_input(tool_name: str, issues: list[ToolInputIssue]) -> str:
    header = f"INVALID_INPUT: {tool_name} rejected parameters:"
    footer = "Fix the input and retry."
    shown = min(len(issues), _MAX_ISSUE_LINES)
    while True:
        lines = [
            f"- {issue.path}: {issue.constraint}"
            for issue in issues[:shown]
        ]
        hidden = len(issues) - shown
        if hidden:
            lines.append(f"- … and {hidden} more")
        message = "\n".join([header, *lines, footer])
        if len(message.encode("utf-8")) <= _MAX_MESSAGE_BYTES or shown == 0:
            return message
        shown -= 1


def _checked_result(result: Any, *, tool_name: str) -> dict[str, Any] | None:
    """Fail closed on a handler return the wire cannot carry. The reply
    envelope's ``result`` slot is ``object | null`` across the cross-SDK
    contract, so a non-``dict``/non-``None`` return would ship a malformed
    envelope. ``None`` maps to a null result and is left to the dispatch
    layer; anything else is a handler bug surfaced as a tool error."""
    if result is None or isinstance(result, dict):
        return result
    raise TypeError(
        f"@tool handler {tool_name!r} returned {type(result).__name__}; a "
        f"client tool result must be a dict (serialized as the JSON object "
        f"the model receives) or None"
    )


def _validate_args(
    model: type[BaseModel], args: dict[str, Any], *, tool_name: str
) -> BaseModel:
    try:
        return model.model_validate(args)
    except ValidationError as exc:
        issues = _sanitize_issues(exc)
        # ``from None`` — the ValidationError's own repr embeds the submitted
        # values, so it must not chain into the dispatch layer's logging.
        raise ToolInputValidationError(
            _format_invalid_input(tool_name, issues), issues=issues
        ) from None


def _resolved_hints(fn: Callable[..., Any]) -> dict[str, Any]:
    try:
        return get_type_hints(fn)
    except NameError as exc:
        raise TypeError(
            f"@tool handler {fn.__name__!r}: could not resolve annotation "
            f"({exc}). Under `from __future__ import annotations`, the input "
            f"model must be resolvable from module scope — define it at module "
            f"level or drop the future import."
        ) from exc


def _infer_input_model(fn: Callable[..., Any], first_param: str) -> type[BaseModel]:
    hints = _resolved_hints(fn)
    annotation = hints.get(first_param)
    if not (isinstance(annotation, type) and issubclass(annotation, BaseModel)):
        raise TypeError(
            f"@tool handler {fn.__name__!r}: first parameter {first_param!r} "
            f"must be annotated with a BaseModel subclass, got {annotation!r}"
        )
    if annotation is BaseModel:
        raise TypeError(
            f"@tool handler {fn.__name__!r}: annotate the first parameter with "
            f"a BaseModel subclass (an empty subclass for a no-argument tool), "
            f"not BaseModel itself"
        )
    return annotation


def _checked_signature(
    fn: Callable[..., Any], *, background: bool
) -> list[inspect.Parameter]:
    if not inspect.iscoroutinefunction(fn):
        raise TypeError(f"@tool handler {fn.__name__!r} must be `async def`")
    params = list(inspect.signature(fn).parameters.values())
    for param in params:
        if param.kind in (
            inspect.Parameter.VAR_POSITIONAL,
            inspect.Parameter.VAR_KEYWORD,
        ):
            raise TypeError(
                f"@tool handler {fn.__name__!r} must not use *args/**kwargs"
            )
        if param.kind == inspect.Parameter.KEYWORD_ONLY:
            raise TypeError(
                f"@tool handler {fn.__name__!r} must accept its arguments "
                f"positionally"
            )
    if background and len(params) != 2:
        raise TypeError(
            f"@tool(background=True) handler {fn.__name__!r} must accept exactly "
            f"two parameters: the input model, then the ClientToolJob"
        )
    if not background and len(params) != 1:
        raise TypeError(
            f"@tool handler {fn.__name__!r} must accept exactly one parameter "
            f"(the input model); use @tool(background=True) for an "
            f"(input, job) handler"
        )
    return params


def _resolve_description(
    fn: Callable[..., Any], description: str | None, *, tool_name: str
) -> str:
    resolved = (
        description
        if description is not None
        else inspect.cleandoc(fn.__doc__ or "").strip()
    )
    if not resolved:
        raise ToolDefinitionError(
            code=ToolDefinitionErrorCode.MISSING_DESCRIPTION,
            message=f"@tool {tool_name!r} has no description: add a docstring or pass "
            f"description=... — the description is model-facing and required",
        )
    if len(resolved) > _CLIENT_TOOL_MAX_DESCRIPTION_LEN:
        raise ToolDefinitionError(
            code=ToolDefinitionErrorCode.DESCRIPTION_TOO_LONG,
            message=f"@tool {tool_name!r} description is {len(resolved)} characters; "
            f"the protocol limit is {_CLIENT_TOOL_MAX_DESCRIPTION_LEN}",
        )
    reason = text_violation(resolved, allow_newlines=True)
    if reason is not None:
        raise ToolDefinitionError(
            code=ToolDefinitionErrorCode.INVALID_TEXT,
            message=f"@tool {tool_name!r} description {reason}",
        )
    return resolved


def _build_tool(
    fn: Callable[..., Any],
    *,
    name: str | None,
    description: str | None,
    background: bool,
) -> ClientTool | BackgroundClientTool:
    params = _checked_signature(fn, background=background)
    model = _infer_input_model(fn, params[0].name)
    if background:
        job_annotation = _resolved_hints(fn).get(params[1].name)
        if job_annotation is not None and job_annotation is not ClientToolJob:
            raise TypeError(
                f"@tool(background=True) handler {fn.__name__!r}: second "
                f"parameter must be a ClientToolJob, got {job_annotation!r}"
            )
    tool_name = name if name is not None else fn.__name__
    if not _NAME_RE.fullmatch(tool_name):
        raise ToolDefinitionError(
            code=ToolDefinitionErrorCode.INVALID_TOOL_NAME,
            message=f"tool name {tool_name!r} must match {_NAME_RE.pattern}; pass "
            f"name=... to override the function name",
        )
    # The friendlier, earlier half of the reservation; session-config assembly
    # re-checks it so a hand-built spec cannot slip past.
    if tool_name.startswith(SDK_TOOL_NAME_PREFIX):
        raise reserved_name_error(tool_name)
    resolved_description = _resolve_description(fn, description, tool_name=tool_name)
    parameters = emit_model_schema(model, tool_name=tool_name)

    if background:

        async def background_handler(args: dict[str, Any], job: ClientToolJob) -> None:
            await fn(_validate_args(model, args, tool_name=tool_name), job)

        return BackgroundClientTool(
            name=tool_name,
            description=resolved_description,
            parameters=parameters,
            handler=background_handler,
        )

    async def handler(args: dict[str, Any]) -> dict[str, Any] | None:
        result = await fn(_validate_args(model, args, tool_name=tool_name))
        return _checked_result(result, tool_name=tool_name)

    return ClientTool(
        name=tool_name,
        description=resolved_description,
        parameters=parameters,
        handler=handler,
    )


@overload
def tool(fn: _InlineFn, /) -> AgentTool: ...


@overload
def tool(
    *,
    name: str | None = None,
    description: str | None = None,
    background: Literal[False] = False,
) -> Callable[[_InlineFn], AgentTool]: ...


@overload
def tool(
    *,
    name: str | None = None,
    description: str | None = None,
    background: Literal[True],
) -> Callable[[_BackgroundFn], AgentTool]: ...


def tool(
    fn: Callable[..., Any] | None = None,
    *,
    name: str | None = None,
    description: str | None = None,
    background: bool = False,
) -> Any:
    """Build a :class:`ClientTool` (or :class:`BackgroundClientTool`) from an
    async function whose first parameter is annotated with a Pydantic input
    model.

    Applies bare or with options::

        @tool
        async def get_weather(input: WeatherInput) -> dict[str, Any]: ...

        @tool(name="weather_now", description="Look up current weather.")
        async def whatever(input: WeatherInput) -> dict[str, Any]: ...

        @tool(background=True)
        async def export(input: ExportInput, job: ClientToolJob) -> None: ...

    ``name`` defaults to the function name; ``description`` defaults to the
    docstring (dedented). A ``background=True`` handler takes
    ``(input, job: ClientToolJob)`` and follows the unchanged job contract
    (``ack`` / ``complete`` / ``fail``). Every check — signature shape,
    name/description limits, schema dialect — runs at decoration, so a tool
    the server would reject fails here rather than at session connect.
    """
    if fn is not None:
        return _build_tool(fn, name=name, description=description, background=background)

    def decorate(inner: Callable[..., Any]) -> ClientTool | BackgroundClientTool:
        return _build_tool(
            inner, name=name, description=description, background=background
        )

    return decorate


def _checked_raw_parameters(
    *, name: str, description: str, parameters: dict[str, Any]
) -> dict[str, Any]:
    """The checks ``@tool`` runs, for a hand-written declaration.

    Without these a bad name, an empty description or an off-dialect schema
    would construct fine and be refused at session start instead, which is
    exactly what the raw path exists to avoid.
    """
    if not _NAME_RE.fullmatch(name):
        raise ToolDefinitionError(
            code=ToolDefinitionErrorCode.INVALID_TOOL_NAME,
            message=f"tool name {name!r} must match {_NAME_RE.pattern}",
        )
    if name.startswith(SDK_TOOL_NAME_PREFIX):
        raise reserved_name_error(name)
    if not description.strip():
        raise ToolDefinitionError(
            code=ToolDefinitionErrorCode.MISSING_DESCRIPTION,
            message=f"tool {name!r} has no description",
        )
    if len(description) > _CLIENT_TOOL_MAX_DESCRIPTION_LEN:
        raise ToolDefinitionError(
            code=ToolDefinitionErrorCode.DESCRIPTION_TOO_LONG,
            message=f"tool {name!r} description is {len(description)} characters; "
            f"the protocol limit is {_CLIENT_TOOL_MAX_DESCRIPTION_LEN}",
        )
    reason = text_violation(description, allow_newlines=True)
    if reason is not None:
        raise ToolDefinitionError(
            code=ToolDefinitionErrorCode.INVALID_TEXT,
            message=f"tool {name!r} description: {reason}",
        )
    return build_tool_parameters(parameters, tool_name=name)


def _input_form(
    *, name: str, description: str, input: type[BaseModel]
) -> tuple[str, dict[str, Any]]:
    """The checks and schema emission ``@tool`` runs, for a model passed by
    value rather than read off a decorated function's annotation."""
    if not _NAME_RE.fullmatch(name):
        raise ToolDefinitionError(
            code=ToolDefinitionErrorCode.INVALID_TOOL_NAME,
            message=f"tool name {name!r} must match {_NAME_RE.pattern}",
        )
    if name.startswith(SDK_TOOL_NAME_PREFIX):
        raise reserved_name_error(name)
    if not (description or "").strip():
        raise ToolDefinitionError(
            code=ToolDefinitionErrorCode.MISSING_DESCRIPTION,
            message=f"tool {name!r} has no description",
        )
    if len(description) > _CLIENT_TOOL_MAX_DESCRIPTION_LEN:
        raise ToolDefinitionError(
            code=ToolDefinitionErrorCode.DESCRIPTION_TOO_LONG,
            message=f"tool {name!r} description is {len(description)} characters; "
            f"the protocol limit is {_CLIENT_TOOL_MAX_DESCRIPTION_LEN}",
        )
    reason = text_violation(description, allow_newlines=True)
    if reason is not None:
        raise ToolDefinitionError(
            code=ToolDefinitionErrorCode.INVALID_TEXT,
            message=f"tool {name!r} description: {reason}",
        )
    if not (isinstance(input, type) and issubclass(input, BaseModel)):
        raise TypeError(
            f"tool {name!r}: input= takes a Pydantic model class, got {input!r}; "
            f"pass a hand-written schema as parameters= instead"
        )
    if input is BaseModel:
        raise TypeError(
            f"tool {name!r}: input= takes a BaseModel subclass (an empty one "
            f"for a no-argument tool), not BaseModel itself"
        )
    return description, emit_model_schema(input, tool_name=name)


def _one_input_form(name: str, input: object, parameters: object) -> None:
    if (input is None) == (parameters is None):
        raise TypeError(
            f"tool {name!r}: pass exactly one of input= (a Pydantic model) or "
            f"parameters= (a hand-written JSON Schema)"
        )


@overload
def client_tool(
    *,
    name: str,
    description: str,
    input: type[_ModelT],
    handler: Callable[[_ModelT], Awaitable[dict[str, Any] | None]],
) -> AgentTool: ...


@overload
def client_tool(
    *,
    name: str,
    description: str,
    parameters: dict[str, Any],
    handler: ClientToolHandler,
) -> AgentTool: ...


def client_tool(
    *,
    name: str,
    description: str,
    input: type[BaseModel] | None = None,
    parameters: dict[str, Any] | None = None,
    handler: Callable[..., Any],
) -> AgentTool:
    """Declare a client tool, from a Pydantic model or a hand-written schema.

    ``input=`` is the typed form :func:`tool` applies to a decorated function,
    for the cases a decorator cannot reach — a closure, a bound method, or a
    tool built in a loop. The handler receives the validated model instance.

    ``parameters=`` is the escape hatch, for a schema no model expresses; the
    handler receives the raw argument dict. Either way the schema is checked
    against the restricted dialect here, so one the server would refuse fails
    at the call rather than as a ``ready.rejected_tools`` entry at connect.
    """
    _one_input_form(name, input, parameters)
    if input is not None:
        description, emitted = _input_form(
            name=name, description=description, input=input
        )
        model = input

        async def typed_handler(args: dict[str, Any]) -> dict[str, Any] | None:
            result = await handler(_validate_args(model, args, tool_name=name))
            return _checked_result(result, tool_name=name)

        return ClientTool(
            name=name, description=description, parameters=emitted, handler=typed_handler
        )
    return ClientTool(
        name=name,
        description=description,
        parameters=_checked_raw_parameters(
            name=name, description=description, parameters=parameters or {}
        ),
        handler=handler,
    )


@overload
def background_client_tool(
    *,
    name: str,
    description: str,
    input: type[_ModelT],
    handler: Callable[[_ModelT, ClientToolJob], Awaitable[None]],
) -> AgentTool: ...


@overload
def background_client_tool(
    *,
    name: str,
    description: str,
    parameters: dict[str, Any],
    handler: BackgroundClientToolHandler,
) -> AgentTool: ...


def background_client_tool(
    *,
    name: str,
    description: str,
    input: type[BaseModel] | None = None,
    parameters: dict[str, Any] | None = None,
    handler: Callable[..., Any],
) -> AgentTool:
    """Declare a background client tool, from a Pydantic model or a schema.

    Same two forms as :func:`client_tool`; the handler additionally receives a
    :class:`~cosmo_ai.tools.ClientToolJob` and delivers its result after the
    ack rather than by returning it.
    """
    _one_input_form(name, input, parameters)
    if input is not None:
        description, emitted = _input_form(
            name=name, description=description, input=input
        )
        model = input

        async def typed_handler(args: dict[str, Any], job: ClientToolJob) -> None:
            await handler(_validate_args(model, args, tool_name=name), job)

        return BackgroundClientTool(
            name=name, description=description, parameters=emitted, handler=typed_handler
        )
    return BackgroundClientTool(
        name=name,
        description=description,
        parameters=_checked_raw_parameters(
            name=name, description=description, parameters=parameters or {}
        ),
        handler=handler,
    )
