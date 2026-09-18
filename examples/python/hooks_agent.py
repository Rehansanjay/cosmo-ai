"""Hooks example: deny a destructive tool and log every tool outcome.

Run against a backend:
    python examples/python/hooks_agent.py   # after `pipx install cosmo-cli && cosmo login`, or with COSMO_API_KEY set

The SDK targets https://platform.askcosmo.ai by default; set COSMO_BASE_URL to point
at another backend for local development.
"""

from __future__ import annotations

import asyncio

import structlog

from typing_extensions import assert_never

from cosmo_ai import RealtimeClient, hooks
from cosmo_ai.hooks import (
    PostToolUseContext,
    PreToolUseContext,
    PreToolUseResult,
    SessionStartContext,
    SessionStartResult,
    SessionEndContext,
    ToolDenied,
    ToolError,
    ToolOk,
    ToolOutcome,
)

logger = structlog.get_logger(__name__)


@hooks.session_start
def add_context(ctx: SessionStartContext) -> SessionStartResult:
    return SessionStartResult(additional_context="Be concise and warm.")


@hooks.pre_tool_use(matcher="delete_*")
def block_deletes(ctx: PreToolUseContext) -> PreToolUseResult:
    return PreToolUseResult(permission="deny", reason="destructive tools are disabled")


def describe(outcome: ToolOutcome) -> str:
    """Narrow the outcome to its case, the way Swift's ``switch`` and
    TypeScript's ``kind`` do. ``assert_never`` is what makes it exhaustive:
    add a fourth case to the union and this stops type-checking."""
    match outcome:
        case ToolOk(result=result):
            return f"ok result={result}"
        case ToolError(message=message):
            return f"error {message}"
        case ToolDenied(reason=reason):
            return f"denied {reason}"
        case _:
            assert_never(outcome)


@hooks.post_tool_use
def log_outcome(ctx: PostToolUseContext) -> None:
    logger.info("tool.done", tool=ctx.tool_name, outcome=describe(ctx.outcome))


@hooks.session_end
def on_session_end(ctx: SessionEndContext) -> None:
    logger.info("session.stopped", reason=ctx.reason.value)


async def main() -> None:
    client = RealtimeClient()
    agent = client.agent(
        instructions="You are Alex.",
        hooks=[add_context, block_deletes, log_outcome, on_session_end],
    )
    async with agent.start() as session:
        async for event in session:
            logger.info("event", type=type(event).__name__)


if __name__ == "__main__":
    asyncio.run(main())
