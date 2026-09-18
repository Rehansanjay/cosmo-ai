"""Shared test fakes: scripted HTTP session-start + an in-memory transport."""

from __future__ import annotations

import asyncio
import json
from dataclasses import dataclass
from typing import Any, Awaitable, Callable, Literal, TypeVar
from unittest import mock

import httpx
from cosmo_ai import RealtimeClient, RealtimeSession
from cosmo_ai._internal.transport import (
    RpcHandler,
    RpcInvocation,
    TransportCallbacks,
    TransportClose,
)
from cosmo_ai._internal.transport import StartedSession
from cosmo_ai.session._engine import OnStateChange

_T = TypeVar("_T")


def run_awaitable(awaitable: Awaitable[_T]) -> _T:
    """``asyncio.run`` for a bare awaitable (e.g. a handler invocation) —
    ``asyncio.run`` itself requires a coroutine."""

    async def caller() -> _T:
        return await awaitable

    return asyncio.run(caller())


START_RESPONSE_JSON: dict[str, Any] = {
    "livekit_url": "wss://test.invalid",
    "token": "test-token",
    "room_name": "room-test",
    "session_id": "sess-test",
}

PREPARE_ROOM_RESPONSE_JSON: dict[str, Any] = {
    "livekit_url": "wss://test.invalid",
    "token": "prep-token",
    "room_name": "room-prep",
    "room_grant": "grant-prep",
}


@dataclass(frozen=True)
class FakeRpcInvocation(RpcInvocation):
    """The vendor-free ``RpcInvocation`` a registered RPC handler receives,
    with ``caller_is_agent`` (what the agent-only guard reads; the real
    transport resolves it from the participant kind) defaulting to the agent
    so tests only spell out the rejection cases."""

    caller_is_agent: bool = True


@dataclass
class FakePublication:
    """Opaque publication handle a transport returns from
    ``publish_audio_source``; the SDK only round-trips it to ``unpublish_track``."""

    sid: str


class FakeTransport:
    """In-memory :class:`~cosmo_ai._internal.transport.Transport`: records outbound
    frames, RPC registrations, and media calls, and drives inbound frames /
    lifecycle through the session's callbacks (the ``simulate_*`` methods)."""

    def __init__(
        self, sent: list[dict[str, Any]], *, ready_on_connect: bool = True
    ) -> None:
        self._sent = sent
        #: ``start()`` resolves at ready, so the fake mirrors a healthy
        #: worker and lands the handshake as part of ``connect``. Pass
        #: ``False`` only where the test drives the whole start itself —
        #: a start with no ready blocks until the ready timeout.
        self.ready_on_connect = ready_on_connect
        #: Payload for the auto-emitted ``ready``; defaults to a minimal
        #: frame carrying the started session's id.
        self.ready_frame: dict[str, Any] | None = None
        self.rpc_methods: dict[str, RpcHandler] = {}
        self.connected = False
        self.disconnected = False
        self.connects: list[str] = []
        self.prepared_joins: list[str] = []
        self._callbacks: TransportCallbacks | None = None
        self.published_sources: list[tuple[Any, str]] = []
        self.unpublished: list[Any] = []
        self.screen_share_active = False
        self.screen_share_frames: list[Any] = []
        self.video_streams: list[str] = []
        self.video_frames: list[tuple[str, Any]] = []
        self._video_stream_count = 0
        self.agent_audio_sink: Any = None
        self.agent_audio_sink_history: list[Any] = []
        self.byte_streams: list[tuple[bytes, str]] = []

    async def connect(
        self, started: StartedSession, callbacks: TransportCallbacks
    ) -> None:
        self._callbacks = callbacks
        self.connected = True
        self.disconnected = False
        self.connects.append(started.room_name)
        if self.ready_on_connect:
            self._emit_ready(str(getattr(started, "session_id", "sess-fake")))

    async def connect_prepared(
        self, prepared: Any, callbacks: TransportCallbacks
    ) -> None:
        self._callbacks = callbacks
        self.connected = True
        self.disconnected = False
        self.prepared_joins.append(prepared.room_name)
        if self.ready_on_connect:
            self._emit_ready("sess-fake")

    def _emit_ready(self, session_id: str) -> None:
        frame = self.ready_frame or {"type": "ready", "session_id": session_id}
        self.simulate_frame(json.dumps(frame).encode("utf-8"))

    def is_connected(self) -> bool:
        return self.connected and not self.disconnected

    async def disconnect(self) -> None:
        self.disconnected = True
        self.connected = False

    async def send_frame(self, payload: bytes) -> None:
        self._sent.append(json.loads(payload.decode("utf-8")))

    async def send_bytes(self, data: bytes, topic: str) -> None:
        self.byte_streams.append((data, topic))

    def register_rpc_method(self, name: str, handler: RpcHandler) -> None:
        self.rpc_methods[name] = handler

    def create_mic_source(self, capture: Any) -> Any:
        # The WebRTC capture path, like the LiveKit transport builds: these
        # tests pin what happens when that device will not open.
        from cosmo_ai.audio._mic import MicAudioSource

        return MicAudioSource(capture)

    async def publish_audio_source(
        self, source: Any, *, track_name: str = "mic"
    ) -> Any:
        publication = FakePublication(sid=f"pub-{len(self.published_sources)}")
        self.published_sources.append((source, track_name))
        return publication

    async def unpublish_track(self, publication: Any) -> None:
        self.unpublished.append(publication)

    def set_agent_audio_sink(self, sink: Any) -> None:
        self.agent_audio_sink = sink
        self.agent_audio_sink_history.append(sink)

    async def start_screen_share(self, *, width: int, height: int) -> None:
        self.screen_share_active = True

    def push_screen_share_frame(self, frame: Any) -> None:
        self.screen_share_frames.append(frame)

    async def stop_screen_share(self) -> None:
        self.screen_share_active = False

    async def add_video_stream(self, *, width: int, height: int) -> str:
        # Monotonic, like the real transport's uuid: a removed stream's id is
        # never handed out again.
        self._video_stream_count += 1
        stream_id = f"stream-{self._video_stream_count}"
        self.video_streams.append(stream_id)
        return stream_id

    def push_video_frame(self, stream_id: str, frame: Any) -> None:
        self.video_frames.append((stream_id, frame))

    async def remove_video_stream(self, stream_id: str) -> None:
        if stream_id in self.video_streams:
            self.video_streams.remove(stream_id)

    # ── Test drivers: simulate transport-side events ───────────────

    def _cb(self) -> TransportCallbacks:
        assert self._callbacks is not None, "transport not connected"
        return self._callbacks

    def simulate_frame(self, payload: bytes) -> None:
        self._cb().on_frame(payload)

    def simulate_closed(
        self,
        detail: str | None = None,
        *,
        kind: Literal["server_ended", "transport_error"] = "transport_error",
    ) -> None:
        self._cb().on_closed(TransportClose(kind=kind, detail=detail))

    def simulate_agent_audio(self, frame: Any) -> None:
        assert self.agent_audio_sink is not None, "no agent-audio sink attached"
        self.agent_audio_sink.deliver(frame)

    def simulate_reconnecting(self) -> None:
        self._cb().on_reconnecting()

    def simulate_reconnected(self) -> None:
        self._cb().on_reconnected()


class FakeSessionHarness:
    """A started ``RealtimeSession`` wired to a fake transport, plus everything
    the client sent (HTTP start bodies and data-channel frames). Pass a
    ``FakeTransport`` subclass (and the harness itself into
    ``start_fake_session``) to fault-inject the transport while keeping it
    inspectable when the start raises."""

    def __init__(self, transport_cls: type[FakeTransport] = FakeTransport) -> None:
        self.start_bodies: list[dict[str, Any]] = []
        self.start_urls: list[str] = []
        self.start_headers: list[dict[str, str]] = []
        self.frames: list[dict[str, Any]] = []
        self.transport = transport_cls(self.frames)
        self.session: RealtimeSession | None = None


_PERSONA_KEYS = frozenset(
    {
        "name",
        "inputs",
        "instructions",
        "model",
        "voice",
        "tools",
        "interruption_sensitivity",
        "greeting",
        "audio",
        "skills",
        "hooks",
    }
)


def start_body(**session_kwargs: Any) -> dict[str, Any]:
    """Start a fake session and return the single HTTP start body it sent."""

    async def scenario() -> dict[str, Any]:
        harness = await start_fake_session(**session_kwargs)
        assert len(harness.start_bodies) == 1
        return harness.start_bodies[0]

    return asyncio.run(scenario())


async def start_fake_session(
    *,
    respond: Callable[[httpx.Request], httpx.Response] | None = None,
    on_state_change: OnStateChange | None = None,
    harness: FakeSessionHarness | None = None,
    prepared: bool = False,
    ready_frame: dict[str, Any] | None = None,
    settle_connect: bool = True,
    client_transport: str = "webrtc",
    **session_kwargs: Any,
) -> FakeSessionHarness:
    """Start a session over the fake transport.

    ``start()`` resolves at ready, so the transport lands the handshake as
    part of ``connect``. By default the harness then settles the connect —
    draining that leading ``ReadyEvent`` and the fire-and-forget
    connect-timings report — so the stream and ``frames`` begin where these
    tests have always begun. ``ready_frame`` shapes the handshake payload;
    ``settle_connect=False`` leaves the connect's own stream items and
    frames in place for tests that assert on them."""
    harness = harness or FakeSessionHarness()
    harness.transport.ready_frame = ready_frame

    def default_respond(request: httpx.Request) -> httpx.Response:
        if request.url.path.endswith("/prepare-room"):
            return httpx.Response(200, json=PREPARE_ROOM_RESPONSE_JSON)
        return httpx.Response(200, json=START_RESPONSE_JSON)

    def record_and_respond(request: httpx.Request) -> httpx.Response:
        harness.start_bodies.append(json.loads(request.content))
        harness.start_urls.append(str(request.url))
        harness.start_headers.append(dict(request.headers))
        return (respond or default_respond)(request)

    http = httpx.AsyncClient(transport=httpx.MockTransport(record_and_respond))
    client = RealtimeClient(api_key="test-key", transport=client_transport)  # type: ignore[arg-type]
    client._http_client = http  # internal seam: inject the mock transport
    try:
        with mock.patch.object(
            RealtimeSession, "_make_transport", lambda self: harness.transport
        ):
            persona = {k: v for k, v in session_kwargs.items() if k in _PERSONA_KEYS}
            run = {k: v for k, v in session_kwargs.items() if k not in _PERSONA_KEYS}
            if "name" in persona:
                agent = client.catalog_agent(persona.pop("name"), **persona)
            else:
                agent = client.agent(**persona)
            if prepared:
                prepared_session = agent.prepare_session(
                    on_state_change=on_state_change, **run
                )
                # Deterministic: the reservation lands before the start that
                # consumes it.
                await prepared_session._inflight
                handle = prepared_session.start()
            else:
                handle = agent.start(on_state_change=on_state_change, **run)
            harness.session = await handle
            if settle_connect:
                await asyncio.wait_for(harness.session.__anext__(), timeout=1)
                # Let the fire-and-forget connect-timings report land, then
                # drop it: ``frames`` records what the test itself sent, not
                # the connect's own traffic.
                for _ in range(5):
                    await asyncio.sleep(0)
                harness.frames.clear()
    finally:
        await http.aclose()
    return harness
