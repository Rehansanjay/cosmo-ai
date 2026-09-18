"""The error-hierarchy contract: every public SDK error is catchable as
:class:`RealtimeError`, and the compat bases (``ValueError`` for config
errors, ``ImportError`` for missing extras) are preserved."""

from __future__ import annotations

import httpx
import pytest
from cosmo_ai import SessionStartErrorCode
from cosmo_ai import (
    ApiError,
    AudioUnavailableError,
    RealtimeError,
    DialError,
    DialErrorCode,
    MintTokenError,
    MintTokenErrorCode,
    SessionStartError,
    VerifyError,
    UsageError,
    TokenSourceError,
    SessionStateError,
    SessionStateErrorCode,
)
from cosmo_ai.client import _parse_error_detail
from cosmo_ai.mcp import McpError
from cosmo_ai.skills import SkillError
from cosmo_ai.tools import ToolDefinitionError, ToolDefinitionErrorCode


@pytest.mark.parametrize(
    "err_cls",
    [
        AudioUnavailableError,
        DialError,
            McpError,
        MintTokenError,
        SessionStateError,
        SessionStartError,
        SessionStateError,
        SkillError,
        ToolDefinitionError,
        SessionStartError,
    ],
)
def test_every_public_error_is_catchable_as_cosmo_ai_error(
    err_cls: type[Exception],
) -> None:
    assert issubclass(err_cls, RealtimeError)


@pytest.mark.parametrize(
    ("err", "expected_message", "expected_str"),
    [
        (RealtimeError("plain"), "plain", "plain"),
        (AudioUnavailableError("no input device"), "no input device", "no input device"),
        (
            SessionStateError(
                code=SessionStateErrorCode.NOT_CONNECTED, message="not connected"
            ),
            "not connected",
            "not connected",
        ),
        (
            MintTokenError(code=MintTokenErrorCode.MISSING_API_KEY, message="no key"),
            "no key",
            "no key",
        ),
        (
            DialError(code=DialErrorCode.INVALID_REQUEST, message="bad number"),
            "bad number",
            "invalid_request: bad number",
        ),
        (
            SessionStartError(
                code=SessionStartErrorCode.REJECTED,
                message="unavailable",
                server_code="http_503",
            ),
            "unavailable",
            "rejected: unavailable",
        ),
        (
            ToolDefinitionError(
                code=ToolDefinitionErrorCode.FORBIDDEN_KEY,
                message="$ref is not allowed",
            ),
            "$ref is not allowed",
            "forbidden_key: $ref is not allowed",
        ),
    ],
)
def test_message_is_the_raw_one_whatever_str_renders(
    err: RealtimeError, expected_message: str, expected_str: str
) -> None:
    # Several errors render ``str(e)`` as ``"code: message"`` for logs while
    # ``message`` stays the prose alone. Both are public; neither may drift
    # into the other.
    assert err.message == expected_message
    assert str(err) == expected_str


@pytest.mark.parametrize(
    "err_cls",
    [DialError, MintTokenError, TokenSourceError, UsageError, VerifyError],
)
def test_every_backend_call_error_is_catchable_as_api_error(
    err_cls: type[Exception],
) -> None:
    # The headline of the ApiError base: one catch covers any backend call.
    assert issubclass(err_cls, ApiError)
    assert issubclass(err_cls, RealtimeError)


def test_config_errors_keep_value_error_compat() -> None:
    assert issubclass(SkillError, ValueError)
    # McpError is deliberately not one: it spans connection and tool-call
    # failures as well as config, and a dead subprocess is no ValueError.
    assert not issubclass(McpError, ValueError)


def test_request_validation_array_names_the_offending_fields() -> None:
    # The shape a client newer than its backend gets: pydantic's
    # ``extra="forbid"`` on a field that backend has no model for. Without a
    # branch for it the message is the raw payload, truncated.
    response = httpx.Response(
        422,
        json={
            "detail": [
                {
                    "type": "extra_forbidden",
                    "loc": ["body", "agent", "inline", "audio"],
                    "msg": "Extra inputs are not permitted",
                }
            ]
        },
    )
    code, message = _parse_error_detail(response)
    assert code == "invalid_session_config"
    assert message == "agent.inline.audio: Extra inputs are not permitted"


def test_request_validation_array_caps_rendered_entries() -> None:
    response = httpx.Response(
        422,
        json={
            "detail": [
                {"loc": ["body", "agent", f"f{i}"], "msg": "nope"} for i in range(7)
            ]
        },
    )
    _, message = _parse_error_detail(response)
    assert "agent.f4: nope" in message
    assert "agent.f5" not in message
    assert "(+2 more)" in message
