"""The join→ready window contract.

``start()`` resolves at ready, and the window has exactly four exits: the
sign resolves it, a pre-ready close raises the enriched handshake failure,
silence past the bound raises the timeout, and cancellation tears down and
re-raises. TypeScript's ``agent_start.test.ts`` ("start resolves at ready")
is the sibling suite.
"""

from __future__ import annotations

import asyncio
import json
from typing import Any

import pytest
from cosmo_ai import SessionStartErrorCode
from cosmo_ai import (
    DisconnectReason,
    SessionStartError,
    SessionStateKind,
)
from cosmo_ai._internal.transport import TransportCallbacks, TransportClose
from cosmo_ai._internal.protocol import SessionResponse

from .fakes import FakeSessionHarness, FakeTransport, start_fake_session

READY_FRAME: dict[str, Any] = {"type": "ready", "session_id": "sess-test"}


class _NeverReadyTransport(FakeTransport):
    """Joins the room and then says nothing — the sign never goes up."""

    def __init__(self, sent: list[dict[str, Any]]) -> None:
        super().__init__(sent, ready_on_connect=False)


def test_start_resolves_at_ready_and_the_session_is_usable() -> None:
    async def scenario() -> None:
        harness = await start_fake_session()
        session = harness.session
        assert session is not None
        assert session.state.kind is SessionStateKind.CONNECTED
        # Usable the instant the start returns — no readiness ritual.
        await session.send_text("usable immediately")
        assert harness.frames[-1] == {
            "type": "send-text",
            "content": "usable immediately",
        }

    asyncio.run(scenario())


def test_start_stays_pending_until_the_handshake_lands() -> None:
    async def scenario() -> None:
        harness = FakeSessionHarness(transport_cls=_NeverReadyTransport)
        starting = asyncio.ensure_future(
            start_fake_session(harness=harness, settle_connect=False)
        )
        for _ in range(50):
            if harness.transport.is_connected():
                break
            await asyncio.sleep(0)
        await asyncio.sleep(0)
        assert not starting.done()

        harness.transport.simulate_frame(json.dumps(READY_FRAME).encode("utf-8"))
        await asyncio.wait_for(starting, timeout=1)
        assert harness.session is not None

    asyncio.run(scenario())


def test_a_never_arriving_handshake_times_out_and_tears_down(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    import cosmo_ai.session._engine as engine

    monkeypatch.setattr(engine, "_READY_TIMEOUT_S", 0.05)

    async def scenario() -> None:
        harness = FakeSessionHarness(transport_cls=_NeverReadyTransport)
        with pytest.raises(SessionStartError) as caught:
            await start_fake_session(harness=harness, settle_connect=False)
        assert caught.value.code is SessionStartErrorCode.READY_TIMEOUT
        # Torn down, not left half-open.
        assert harness.transport.disconnected is True

    asyncio.run(scenario())


def test_a_pre_ready_close_raises_the_enriched_handshake_failure() -> None:
    async def scenario() -> None:
        harness = FakeSessionHarness(transport_cls=_NeverReadyTransport)
        starting = asyncio.ensure_future(
            start_fake_session(harness=harness, settle_connect=False)
        )
        for _ in range(50):
            if harness.transport.is_connected():
                break
            await asyncio.sleep(0)

        harness.transport.simulate_frame(
            json.dumps(
                {
                    "type": "error",
                    "code": "internal_error",
                    "message": "boot failed: no model credentials",
                    "fatal": True,
                }
            ).encode("utf-8")
        )
        harness.transport.simulate_closed("ROOM_DELETED", kind="server_ended")

        with pytest.raises(SessionStartError) as caught:
            await asyncio.wait_for(starting, timeout=1)
        # The server's own frame is the enrichment the close delivers.
        assert caught.value.code is SessionStartErrorCode.HANDSHAKE_FAILED
        assert caught.value.server_code == "internal_error"
        assert "no model credentials" in caught.value.message
        # And it stays inside the documented start-failure family.
        assert isinstance(caught.value, SessionStartError)

    asyncio.run(scenario())


def test_a_pre_ready_close_reports_handshake_failed_everywhere() -> None:
    async def scenario() -> None:
        states: list[Any] = []
        harness = FakeSessionHarness(transport_cls=_NeverReadyTransport)
        starting = asyncio.ensure_future(
            start_fake_session(
                harness=harness, settle_connect=False, on_state_change=states.append
            )
        )
        for _ in range(50):
            if harness.transport.is_connected():
                break
            await asyncio.sleep(0)

        # LiveKit labels this a deliberate server end, but pre-ready it is a
        # failed boot: one terminal reason on every surface.
        harness.transport.simulate_closed("ROOM_DELETED", kind="server_ended")
        with pytest.raises(SessionStartError):
            await asyncio.wait_for(starting, timeout=1)

        assert states[-1].kind is SessionStateKind.DISCONNECTED
        assert states[-1].disconnect_reason is DisconnectReason.HANDSHAKE_FAILED


    asyncio.run(scenario())


def test_teardown_completes_before_the_start_raises() -> None:
    async def scenario() -> None:
        # The contract's shared invariant: every exit tears down first, then
        # settles. A caller woken out of the gate must find a session that is
        # fully closed — not one still running its SessionEnd hooks and
        # transport cleanup.
        states: list[Any] = []
        harness = FakeSessionHarness(transport_cls=_NeverReadyTransport)
        starting = asyncio.ensure_future(
            start_fake_session(
                harness=harness, settle_connect=False, on_state_change=states.append
            )
        )
        for _ in range(50):
            if harness.transport.is_connected():
                break
            await asyncio.sleep(0)

        harness.transport.simulate_closed("ROOM_DELETED", kind="server_ended")
        with pytest.raises(SessionStartError):
            await asyncio.wait_for(starting, timeout=1)

        # Everything teardown promises is already done when the raise lands:
        # the transport is released, and the terminal state was published.
        assert harness.transport.disconnected is True
        assert states[-1].kind is SessionStateKind.DISCONNECTED

    asyncio.run(scenario())


def test_a_pre_ready_close_with_no_frame_still_raises_typed() -> None:
    async def scenario() -> None:
        harness = FakeSessionHarness(transport_cls=_NeverReadyTransport)
        starting = asyncio.ensure_future(
            start_fake_session(harness=harness, settle_connect=False)
        )
        for _ in range(50):
            if harness.transport.is_connected():
                break
            await asyncio.sleep(0)

        harness.transport.simulate_closed("ICE failed")

        with pytest.raises(SessionStartError) as caught:
            await asyncio.wait_for(starting, timeout=1)
        assert caught.value.code is SessionStartErrorCode.HANDSHAKE_FAILED

    asyncio.run(scenario())


def test_a_pre_ready_error_frame_alone_settles_nothing() -> None:
    async def scenario() -> None:
        harness = FakeSessionHarness(transport_cls=_NeverReadyTransport)
        starting = asyncio.ensure_future(
            start_fake_session(harness=harness, settle_connect=False)
        )
        for _ in range(50):
            if harness.transport.is_connected():
                break
            await asyncio.sleep(0)

        harness.transport.simulate_frame(
            json.dumps(
                {
                    "type": "error",
                    "code": "internal_error",
                    "message": "transient hiccup",
                    "fatal": True,
                }
            ).encode("utf-8")
        )
        for _ in range(10):
            await asyncio.sleep(0)
        assert not starting.done()

        # The close is the authoritative signal; ready can still arrive.
        harness.transport.simulate_frame(json.dumps(READY_FRAME).encode("utf-8"))
        await asyncio.wait_for(starting, timeout=1)
        assert harness.session is not None

    asyncio.run(scenario())


def test_cancelling_a_pending_start_tears_the_session_down() -> None:
    async def scenario() -> None:
        harness = FakeSessionHarness(transport_cls=_NeverReadyTransport)
        starting = asyncio.ensure_future(
            start_fake_session(harness=harness, settle_connect=False)
        )
        for _ in range(50):
            if harness.transport.is_connected():
                break
            await asyncio.sleep(0)
        await asyncio.sleep(0)

        # asyncio's own cancellation is the abort — no SDK-specific API.
        starting.cancel()
        with pytest.raises(asyncio.CancelledError):
            await starting
        # Cancellation-safe: no live room, no held session slot.
        assert harness.transport.disconnected is True

    asyncio.run(scenario())


class _ReadyAttributeTransport(FakeTransport):
    """The agent was already up at join: no frame, only the sign."""

    def __init__(self, sent: list[dict[str, Any]]) -> None:
        super().__init__(sent, ready_on_connect=False)

    async def connect(
        self, started: SessionResponse, callbacks: TransportCallbacks
    ) -> None:
        await super().connect(started, callbacks)
        # What ``_maybe_emit_ready_attribute`` does with an attribute read
        # off a participant already in the room.
        self.simulate_frame(json.dumps(READY_FRAME).encode("utf-8"))


def test_the_sign_alone_resolves_the_start() -> None:
    async def scenario() -> None:
        harness = FakeSessionHarness(transport_cls=_ReadyAttributeTransport)
        await start_fake_session(harness=harness, settle_connect=False)
        session = harness.session
        assert session is not None
        assert session.state.kind is SessionStateKind.CONNECTED
        assert session.state.disconnect_reason is not DisconnectReason.HANDSHAKE_FAILED

    asyncio.run(scenario())


# ── the join loses the race: the room is gone before it resolves ──────────


class _JoinFailsTransport(FakeTransport):
    """Joins by raising, after letting the test deliver its evidence — the
    shape of a boot that deleted the room mid-negotiation."""

    def __init__(self, sent: list[dict[str, Any]]) -> None:
        super().__init__(sent, ready_on_connect=False)
        self.pre_join_frames: list[bytes] = []
        self.pre_join_close: str | None = None

    async def connect(
        self, started: SessionResponse, callbacks: TransportCallbacks
    ) -> None:
        self._callbacks = callbacks
        for frame in self.pre_join_frames:
            callbacks.on_frame(frame)
        if self.pre_join_close is not None:
            callbacks.on_closed(
                TransportClose(kind="server_ended", detail=self.pre_join_close)
            )
        await asyncio.sleep(0)
        raise RuntimeError("LiveKit room connect timed out")


def test_a_room_deleted_before_the_join_resolves_raises_enriched(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    async def scenario() -> None:
        harness = FakeSessionHarness(transport_cls=_JoinFailsTransport)
        harness.transport.pre_join_frames = [
            json.dumps(
                {
                    "type": "error",
                    "code": "internal_error",
                    "message": "boot failed: no model credentials",
                    "fatal": True,
                }
            ).encode("utf-8")
        ]
        harness.transport.pre_join_close = "ROOM_DELETED"

        with pytest.raises(SessionStartError) as caught:
            await start_fake_session(harness=harness, settle_connect=False)
        # The join's own failure yields to the window's typed close exit.
        assert caught.value.code is SessionStartErrorCode.HANDSHAKE_FAILED
        assert caught.value.server_code == "internal_error"
        assert "no model credentials" in caught.value.message

    asyncio.run(scenario())


def test_a_room_deleted_before_the_join_resolves_raises_typed_without_a_frame() -> None:
    async def scenario() -> None:
        harness = FakeSessionHarness(transport_cls=_JoinFailsTransport)
        harness.transport.pre_join_close = "ROOM_DELETED"

        with pytest.raises(SessionStartError) as caught:
            await start_fake_session(harness=harness, settle_connect=False)
        assert caught.value.code is SessionStartErrorCode.HANDSHAKE_FAILED

    asyncio.run(scenario())


def test_a_join_failure_with_no_evidence_stays_a_room_join_failure() -> None:
    async def scenario() -> None:
        # Nothing said the session ended: an ordinary transport failure keeps
        # its own reporting rather than claiming a handshake verdict.
        harness = FakeSessionHarness(transport_cls=_JoinFailsTransport)

        with pytest.raises(SessionStartError) as caught:
            await start_fake_session(harness=harness, settle_connect=False)
        # A join that failed on its own reports join_failed, not the
        # handshake verdict it never received.
        assert caught.value.code is SessionStartErrorCode.JOIN_FAILED

    asyncio.run(scenario())


class _FallbackJoinFailsTransport(FakeTransport):
    """The prepared join fails, and so does the dispatched-room fallback —
    after the server's evidence has landed."""

    def __init__(self, sent: list[dict[str, Any]]) -> None:
        super().__init__(sent, ready_on_connect=False)

    async def connect_prepared(self, prepared: Any, callbacks: TransportCallbacks) -> None:
        self._callbacks = callbacks
        raise RuntimeError("prepared token rejected")

    async def connect(
        self, started: SessionResponse, callbacks: TransportCallbacks
    ) -> None:
        self._callbacks = callbacks
        callbacks.on_frame(
            json.dumps(
                {
                    "type": "error",
                    "code": "internal_error",
                    "message": "boot failed after the fallback",
                    "fatal": True,
                }
            ).encode("utf-8")
        )
        callbacks.on_closed(
            TransportClose(kind="server_ended", detail="ROOM_DELETED")
        )
        await asyncio.sleep(0)
        raise RuntimeError("LiveKit room connect timed out")


def test_the_dispatched_room_fallback_also_raises_the_enriched_failure() -> None:
    async def scenario() -> None:
        # The prepared path's fallback join is the same window: a failed boot
        # there must not drop the server's enrichment either.
        harness = FakeSessionHarness(transport_cls=_FallbackJoinFailsTransport)

        with pytest.raises(SessionStartError) as caught:
            await start_fake_session(
                harness=harness, prepared=True, settle_connect=False
            )
        assert caught.value.code is SessionStartErrorCode.HANDSHAKE_FAILED
        assert caught.value.server_code == "internal_error"
        assert "after the fallback" in caught.value.message

    asyncio.run(scenario())


class _RoomDeletedDuringJoinTransport(FakeTransport):
    """The room goes down while ``connect`` is still negotiating: livekit
    reports it as a disconnect with no room to report against, so only the
    transport's latch carries the evidence."""

    def __init__(self, sent: list[dict[str, Any]]) -> None:
        super().__init__(sent, ready_on_connect=False)
        self._connect_lost: TransportClose | None = None

    async def connect(
        self, started: SessionResponse, callbacks: TransportCallbacks
    ) -> None:
        self._callbacks = callbacks
        self._connect_lost = TransportClose(
            kind="server_ended", detail="ROOM_DELETED"
        )
        await asyncio.sleep(0)
        raise RuntimeError("LiveKit room connect timed out")


def test_a_room_lost_during_the_join_is_evidence_even_without_a_close() -> None:
    async def scenario() -> None:
        # No ``on_closed`` ever fired and no error frame arrived — the latch
        # is the whole story, and it still has to reach the caller typed.
        harness = FakeSessionHarness(transport_cls=_RoomDeletedDuringJoinTransport)

        with pytest.raises(SessionStartError) as caught:
            await start_fake_session(harness=harness, settle_connect=False)
        assert caught.value.code is SessionStartErrorCode.HANDSHAKE_FAILED
        assert "ROOM_DELETED" in caught.value.message

    asyncio.run(scenario())
