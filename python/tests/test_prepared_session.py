"""``agent.prepare_session()``: the reserved room, its refresh, and every
fallback to the ordinary start."""

from __future__ import annotations

import asyncio
import json
import time
from typing import Any
from unittest import mock

import httpx
import pytest
from cosmo_ai import SessionStartErrorCode
from cosmo_ai import (
    PreparedSession,
    RealtimeClient,
    SessionHandle,
    SessionStartError,
)
from cosmo_ai._internal.prepared_room import PREPARED_ROOM_MAX_AGE_S, PreparedRoom
from cosmo_ai._internal.protocol import ClientTool
from cosmo_ai.hooks import PreToolUseContext, PreToolUseResult, pre_tool_use
from cosmo_ai.session._engine import RealtimeSession, SessionStateKind

from tests.fakes import (
    PREPARE_ROOM_RESPONSE_JSON,
    START_RESPONSE_JSON,
    FakeRpcInvocation,
    FakeSessionHarness,
    FakeTransport,
    start_fake_session,
)


def _prepared(**overrides: Any) -> PreparedRoom:
    values: dict[str, Any] = {
        "livekit_url": "wss://test.invalid",
        "token": "prep-token",
        "room_name": "room-prep",
        "room_grant": "grant-prep",
    }
    values.update(overrides)
    return PreparedRoom(**values)


def _honoring(request: httpx.Request) -> httpx.Response:
    if request.url.path.endswith("/prepare-room"):
        return httpx.Response(200, json=PREPARE_ROOM_RESPONSE_JSON)
    return httpx.Response(200, json={**START_RESPONSE_JSON, "room_name": "room-prep"})


def _start_headers(harness: FakeSessionHarness) -> list[dict[str, str]]:
    return [
        harness.start_headers[i]
        for i, url in enumerate(harness.start_urls)
        if url.endswith("/start")
    ]


def _client_with(respond: Any) -> RealtimeClient:
    client = RealtimeClient(api_key="k")
    client._http_client = httpx.AsyncClient(transport=httpx.MockTransport(respond))
    return client


def test_prepare_session_rejects_the_websocket_transport() -> None:
    async def scenario() -> None:
        client = RealtimeClient(api_key="k", transport="websocket")
        with pytest.raises(ValueError, match="webrtc"):
            client.agent().prepare_session()

    asyncio.run(scenario())


def test_prepare_session_needs_a_running_event_loop() -> None:
    with pytest.raises(RuntimeError, match="event loop"):
        RealtimeClient(api_key="k").agent().prepare_session()


def test_prepared_start_joins_the_reserved_room_and_sends_the_grant() -> None:
    async def scenario() -> None:
        harness = await start_fake_session(
            prepared=True, respond=_honoring, instructions="hi"
        )
        assert harness.transport.prepared_joins == ["room-prep"]
        assert harness.transport.connects == []
        headers = _start_headers(harness)[0]
        assert headers["x-cosmo-prepared-room-name"] == "room-prep"
        assert headers["x-cosmo-prepared-room-grant"] == "grant-prep"
        assert harness.session is not None
        assert harness.session.state.kind is SessionStateKind.CONNECTED
        await harness.session.close()

    asyncio.run(scenario())


def test_unhonored_reserved_room_falls_back_to_the_dispatched_room() -> None:
    async def scenario() -> None:
        # Default start response names "room-test", not the reserved
        # "room-prep": the response is the truth and the start still succeeds.
        harness = await start_fake_session(prepared=True, instructions="hi")
        assert harness.transport.prepared_joins == ["room-prep"]
        assert harness.transport.connects == ["room-test"]
        assert harness.session is not None
        assert harness.session.state.kind is SessionStateKind.CONNECTED
        await harness.session.close()

    asyncio.run(scenario())


def test_declined_reservation_leaves_the_start_ordinary() -> None:
    def respond(request: httpx.Request) -> httpx.Response:
        if request.url.path.endswith("/prepare-room"):
            return httpx.Response(429, json={"error": {"message": "busy"}})
        return httpx.Response(200, json=START_RESPONSE_JSON)

    async def scenario() -> None:
        harness = await start_fake_session(
            prepared=True, respond=respond, instructions="hi"
        )
        assert harness.transport.prepared_joins == []
        assert harness.transport.connects == ["room-test"]
        assert "x-cosmo-prepared-room-name" not in _start_headers(harness)[0]
        assert harness.session is not None
        assert harness.session.state.kind is SessionStateKind.CONNECTED
        await harness.session.close()

    asyncio.run(scenario())


def test_start_is_single_use() -> None:
    async def scenario() -> None:
        client = _client_with(_honoring)
        prepared = client.agent().prepare_session()
        prepared.start()
        with pytest.raises(RuntimeError, match="single-use"):
            prepared.start()
        await prepared.close()
        await client.aclose()

    asyncio.run(scenario())


def test_start_waits_for_a_reservation_still_in_flight() -> None:
    """Prepare immediately followed by start still joins the reserved room."""
    gate = asyncio.Event()

    async def respond(request: httpx.Request) -> httpx.Response:
        if request.url.path.endswith("/prepare-room"):
            await gate.wait()
            return httpx.Response(200, json=PREPARE_ROOM_RESPONSE_JSON)
        return httpx.Response(
            200, json={**START_RESPONSE_JSON, "room_name": "room-prep"}
        )

    async def scenario() -> None:
        client = _client_with(respond)
        transport = FakeTransport([])
        with mock.patch.object(RealtimeSession, "_make_transport", lambda self: transport):
            prepared = client.agent().prepare_session()
            assert not prepared._inflight.done()
            start = asyncio.ensure_future(prepared.start())
            await asyncio.sleep(0.05)
            assert transport.prepared_joins == []
            gate.set()
            session = await start
        assert transport.prepared_joins == ["room-prep"]
        # The wait for the reservation is time the caller spent waiting.
        assert (session.connect_timings.total_ms or 0) >= 50
        await session.close()
        await client.aclose()

    asyncio.run(scenario())


def test_stale_reserved_room_is_dropped() -> None:
    async def scenario() -> None:
        client = _client_with(_honoring)
        prepared = client.agent().prepare_session()
        await prepared._inflight
        # A renewal the server declined leaves the old room in place; by the
        # time it is taken it has lapsed.
        declined: asyncio.Future[PreparedRoom | None] = asyncio.get_running_loop().create_future()
        declined.set_result(None)
        prepared._inflight = declined
        prepared._room = _prepared(
            prepared_at=time.monotonic() - PREPARED_ROOM_MAX_AGE_S - 1
        )
        assert await prepared._take() is None
        await client.aclose()

    asyncio.run(scenario())


def test_reservation_is_refreshed_until_taken() -> None:
    prepares = 0

    def respond(request: httpx.Request) -> httpx.Response:
        nonlocal prepares
        if request.url.path.endswith("/prepare-room"):
            prepares += 1
            return httpx.Response(
                200, json={**PREPARE_ROOM_RESPONSE_JSON, "room_name": f"room-{prepares}"}
            )
        return httpx.Response(200, json=START_RESPONSE_JSON)

    async def scenario() -> None:
        client = _client_with(respond)
        with mock.patch("cosmo_ai.client.PREPARED_ROOM_REFRESH_S", 0.01):
            prepared = client.agent().prepare_session()
            await asyncio.sleep(0.05)
        assert prepares >= 2
        prepared.start()
        taken = await prepared._take()
        assert taken is not None and taken.room_name == f"room-{prepares}"
        await asyncio.sleep(0.05)
        assert prepares == int(taken.room_name.removeprefix("room-"))
        await client.aclose()

    asyncio.run(scenario())


def test_close_cancels_the_reservation_and_the_refresh() -> None:
    async def scenario() -> None:
        client = _client_with(_honoring)
        prepared = client.agent().prepare_session()
        await prepared.close()
        assert prepared._refresh.cancelled() or prepared._refresh.done()
        assert prepared._inflight.done()
        assert prepared._room is None
        with pytest.raises(RuntimeError, match="single-use"):
            prepared.start()
        await client.aclose()

    asyncio.run(scenario())


def test_ordinary_start_never_reserves_or_sends_headers() -> None:
    async def scenario() -> None:
        harness = await start_fake_session(instructions="hi")
        assert all(not url.endswith("/prepare-room") for url in harness.start_urls)
        assert "x-cosmo-prepared-room-name" not in harness.start_headers[0]
        assert harness.transport.prepared_joins == []
        assert harness.session is not None
        await harness.session.close()

    asyncio.run(scenario())


@pre_tool_use
def _deny(ctx: PreToolUseContext) -> PreToolUseResult:
    return PreToolUseResult(permission="deny", reason="blocked")


def _guarded_tool(calls: list[dict[str, Any]]) -> ClientTool:
    async def handler(args: dict[str, Any]) -> dict[str, Any]:
        calls.append(args)
        return {}

    return ClientTool(
        name="guarded",
        description="guarded tool",
        parameters={"type": "object", "properties": {}},
        handler=handler,
    )


def test_prepared_start_runs_tool_hooks() -> None:
    """The prepared path registers tools before the start mints the session
    id; PreToolUse must still gate invocations once it exists."""
    calls: list[dict[str, Any]] = []

    async def scenario() -> None:
        harness = await start_fake_session(
            prepared=True,
            respond=_honoring,
            tools=[_guarded_tool(calls)],
            hooks=[_deny],
        )
        assert harness.transport.prepared_joins == ["room-prep"]
        reply = await harness.transport.rpc_methods["guarded"](
            FakeRpcInvocation(payload=json.dumps({}), caller_identity="agent")
        )
        envelope = json.loads(reply)
        assert envelope["ok"] is False and envelope["error"] == "blocked"
        assert calls == []
        assert harness.session is not None
        await harness.session.close()

    asyncio.run(scenario())


def test_tool_hooks_see_the_session_id_while_the_join_finishes() -> None:
    """An invocation that lands after the start response but before the
    prepared join completes is still gated."""
    calls: list[dict[str, Any]] = []
    replies: list[dict[str, Any]] = []
    sessions: list[RealtimeSession] = []

    class Recording(RealtimeSession):
        def __init__(self, **kwargs: Any) -> None:
            super().__init__(**kwargs)
            sessions.append(self)

    class InvokesDuringJoin(FakeTransport):
        async def connect_prepared(self, prepared: Any, callbacks: Any) -> None:
            await super().connect_prepared(prepared, callbacks)
            while sessions[0]._response is None:
                await asyncio.sleep(0)
            reply = await self.rpc_methods["guarded"](
                FakeRpcInvocation(payload=json.dumps({}), caller_identity="agent")
            )
            replies.append(json.loads(reply))

    async def scenario() -> None:
        harness = FakeSessionHarness(transport_cls=InvokesDuringJoin)
        with mock.patch("cosmo_ai.client.RealtimeSession", Recording):
            harness = await start_fake_session(
                harness=harness,
                prepared=True,
                respond=_honoring,
                tools=[_guarded_tool(calls)],
                hooks=[_deny],
            )
        assert [(r["ok"], r["error"]) for r in replies] == [(False, "blocked")]
        assert calls == []
        assert harness.session is not None
        await harness.session.close()

    asyncio.run(scenario())


def test_rejected_prepared_start_retries_without_the_ref() -> None:
    """A rejection may be about the ref itself (identity changed since
    prepare); the ordinary start must not inherit it."""

    def respond(request: httpx.Request) -> httpx.Response:
        if request.url.path.endswith("/prepare-room"):
            return httpx.Response(200, json=PREPARE_ROOM_RESPONSE_JSON)
        if "x-cosmo-prepared-room-name" in request.headers:
            return httpx.Response(
                403,
                json={"detail": {"code": "forbidden", "message": "not yours"}},
            )
        return httpx.Response(200, json=START_RESPONSE_JSON)

    async def scenario() -> None:
        harness = await start_fake_session(
            prepared=True, respond=respond, instructions="hi"
        )
        starts = _start_headers(harness)
        assert len(starts) == 2
        assert "x-cosmo-prepared-room-name" in starts[0]
        assert "x-cosmo-prepared-room-name" not in starts[1]
        assert harness.transport.connects == ["room-test"]
        assert harness.session is not None
        assert harness.session.state.kind is SessionStateKind.CONNECTED
        await harness.session.close()

    asyncio.run(scenario())


def test_unreadable_start_response_is_not_retried() -> None:
    """A 200 the SDK cannot parse may have opened a session; re-posting the
    start could open a second one."""

    def respond(request: httpx.Request) -> httpx.Response:
        if request.url.path.endswith("/prepare-room"):
            return httpx.Response(200, json=PREPARE_ROOM_RESPONSE_JSON)
        return httpx.Response(200, json={"unexpected": True})

    async def scenario() -> None:
        harness = FakeSessionHarness()
        with pytest.raises(SessionStartError) as excinfo:
            await start_fake_session(
                harness=harness, prepared=True, respond=respond, instructions="hi"
            )
        # Unreadable 2xx: a session may already exist, which is exactly why
        # it is not retried.
        assert excinfo.value.code is SessionStartErrorCode.INVALID_RESPONSE
        assert len(_start_headers(harness)) == 1
        assert harness.transport.disconnected

    asyncio.run(scenario())


def test_prepared_session_is_exported() -> None:
    assert PreparedSession.__module__ == "cosmo_ai.client"


def test_gateway_error_on_a_prepared_start_is_not_retried() -> None:
    """A 5xx is not the server refusing the ref: the start may have landed."""

    def respond(request: httpx.Request) -> httpx.Response:
        if request.url.path.endswith("/prepare-room"):
            return httpx.Response(200, json=PREPARE_ROOM_RESPONSE_JSON)
        return httpx.Response(502, text="bad gateway")

    async def scenario() -> None:
        harness = FakeSessionHarness()
        with pytest.raises(SessionStartError) as excinfo:
            await start_fake_session(
                harness=harness, prepared=True, respond=respond, instructions="hi"
            )
        assert excinfo.value.status == 502
        assert len(_start_headers(harness)) == 1
        assert harness.transport.disconnected

    asyncio.run(scenario())


def test_the_returned_handle_is_single_use_too() -> None:
    async def scenario() -> None:
        client = _client_with(_honoring)
        transport = FakeTransport([])
        with mock.patch.object(RealtimeSession, "_make_transport", lambda self: transport):
            handle = client.agent().prepare_session().start()
            session = await handle
            with pytest.raises(RuntimeError, match="single-use"):
                await handle
        assert transport.prepared_joins == ["room-prep"]
        await session.close()
        await client.aclose()

    asyncio.run(scenario())


def test_refresh_stops_when_setup_fails_before_the_take() -> None:
    async def scenario() -> None:
        client = _client_with(_honoring)
        prepared = client.agent().prepare_session()
        await prepared._inflight
        with mock.patch.object(SessionHandle, "_open", side_effect=RuntimeError("mcp down")):
            with pytest.raises(RuntimeError, match="mcp down"):
                await prepared.start()
        await asyncio.sleep(0)
        assert prepared._refresh.cancelled()
        await client.aclose()

    asyncio.run(scenario())


def test_close_after_start_leaves_the_start_alone() -> None:
    gate = asyncio.Event()

    async def respond(request: httpx.Request) -> httpx.Response:
        if request.url.path.endswith("/prepare-room"):
            await gate.wait()
            return httpx.Response(200, json=PREPARE_ROOM_RESPONSE_JSON)
        return httpx.Response(200, json={**START_RESPONSE_JSON, "room_name": "room-prep"})

    async def scenario() -> None:
        client = _client_with(respond)
        transport = FakeTransport([])
        with mock.patch.object(RealtimeSession, "_make_transport", lambda self: transport):
            prepared = client.agent().prepare_session()
            start = asyncio.ensure_future(prepared.start())
            await asyncio.sleep(0)
            await prepared.close()
            gate.set()
            session = await start
        assert transport.prepared_joins == ["room-prep"]
        await session.close()
        await client.aclose()

    asyncio.run(scenario())


def test_prepared_room_closing_before_the_start_lands_fails_the_start() -> None:
    class ClosesAfterJoin(FakeTransport):
        async def connect_prepared(self, prepared: Any, callbacks: Any) -> None:
            await super().connect_prepared(prepared, callbacks)
            self.simulate_closed("room reclaimed")
            for _ in range(3):
                await asyncio.sleep(0)

    async def scenario() -> None:
        harness = FakeSessionHarness(transport_cls=ClosesAfterJoin)
        with pytest.raises(SessionStartError) as excinfo:
            await start_fake_session(harness=harness, prepared=True, instructions="hi")
        assert excinfo.value.code is SessionStartErrorCode.HANDSHAKE_FAILED
        assert harness.transport.connects == []

    asyncio.run(scenario())


def test_version_mismatch_and_transport_unsupported_carry_their_status() -> None:
    def mismatch(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            426, json={"detail": {"code": "version_mismatch", "message": "old"}}
        )

    async def scenario() -> None:
        with pytest.raises(SessionStartError) as excinfo:
            await start_fake_session(respond=mismatch, instructions="hi")
        assert excinfo.value.status == 426
        client = RealtimeClient(api_key="k", transport="websocket")
        client._http_client = httpx.AsyncClient(
            transport=httpx.MockTransport(lambda r: httpx.Response(404))
        )
        with pytest.raises(SessionStartError) as unsupported:
            await client.agent().start()
        assert unsupported.value.code is SessionStartErrorCode.CONFIG
        assert unsupported.value.status == 404
        # No server slug: a 404 on the websocket route is the SDK's own
        # reading, not something the server named.
        assert unsupported.value.server_code is None
        await client.aclose()

    asyncio.run(scenario())


def test_session_ended_during_the_fallback_join_fails_closed() -> None:
    """A close latched while the fallback join runs must not yield a zombie
    CONNECTED session; the fresh room is released and the start fails."""

    class FailsThenClosesOnFallback(FakeTransport):
        async def connect_prepared(self, prepared: Any, callbacks: Any) -> None:
            raise RuntimeError("ice failed")

        async def connect(self, started: Any, callbacks: Any) -> None:
            await super().connect(started, callbacks)
            self.simulate_closed("room reclaimed")
            for _ in range(3):
                await asyncio.sleep(0)

    async def scenario() -> None:
        harness = FakeSessionHarness(transport_cls=FailsThenClosesOnFallback)
        with pytest.raises(SessionStartError) as excinfo:
            await start_fake_session(
                harness=harness, prepared=True, respond=_honoring, instructions="hi"
            )
        assert excinfo.value.code is SessionStartErrorCode.HANDSHAKE_FAILED
        assert harness.transport.connects == ["room-prep"]
        assert harness.transport.disconnected

    asyncio.run(scenario())


def test_an_abandoned_prepared_join_is_drained_not_cancelled() -> None:
    """The not-honored response lands while the prepared join is still in
    flight; the join finishes and its room is released before the fallback."""
    release = asyncio.Event()

    class SlowJoin(FakeTransport):
        async def connect_prepared(self, prepared: Any, callbacks: Any) -> None:
            await release.wait()
            await super().connect_prepared(prepared, callbacks)

    async def scenario() -> None:
        harness = FakeSessionHarness(transport_cls=SlowJoin)
        start = asyncio.ensure_future(
            start_fake_session(harness=harness, prepared=True, instructions="hi")
        )
        for _ in range(20):
            await asyncio.sleep(0)
        # The start has been judged (not honored) and is waiting on the join.
        assert harness.transport.prepared_joins == []
        assert harness.transport.connects == []
        release.set()
        harness = await start
        assert harness.transport.prepared_joins == ["room-prep"]
        assert harness.transport.connects == ["room-test"]
        assert harness.session is not None
        assert harness.session.state.kind is SessionStateKind.CONNECTED
        await harness.session.close()

    asyncio.run(scenario())
