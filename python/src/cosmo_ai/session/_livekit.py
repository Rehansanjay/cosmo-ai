"""LiveKit implementation of :class:`~cosmo_ai._internal.transport.Transport`.

The only module in the SDK that imports ``livekit.rtc``. It owns the
``rtc.Room``, the reliable data channel, client-tool RPC registration (wrapping
LiveKit's ``RpcInvocationData`` into the vendor-free
:class:`~cosmo_ai._internal.transport.RpcInvocation`), the mic/audio-source publish,
and the screen-share track lifecycle. Everything above it — the session, the
protocol state machine, client-tool dispatch — is vendor-free.
"""

from __future__ import annotations

import asyncio
import json
import logging
import uuid
from dataclasses import dataclass
from typing import Any, Literal, Optional

import structlog

from cosmo_ai._internal.logging import get_logger
from cosmo_ai._internal.prepared_room import PreparedRoom
from cosmo_ai._internal.transport import (
    AgentAudioSink,
    MicSource,
    RpcHandler,
    RpcInvocation,
    RpcMethodError,
    StartedSession,
    TransportCallbacks,
    TransportClose,
)
from cosmo_ai.audio import (
    AGENT_AUDIO_SAMPLE_RATE,
    AgentAudioFrame,
    MicrophoneCapture,
)
from cosmo_ai.audio._pcm import PcmAudioSource
from cosmo_ai.errors import SessionStateError, SessionStateErrorCode
from cosmo_ai._internal.protocol import SessionResponse

logger: structlog.stdlib.BoundLogger = get_logger(__name__)


def _current_loop() -> asyncio.AbstractEventLoop | None:
    """The calling thread's running loop, or ``None`` on a thread that has
    none — which a capture thread pushing frames normally does not."""
    try:
        return asyncio.get_running_loop()
    except RuntimeError:
        return None


@dataclass
class _VideoPublishState:
    """The session's one video publish. A screen share and a camera stream
    are the same machinery under different LiveKit sources, and only one may
    be live, so they share a slot rather than racing for the room."""

    kind: Literal["screen_share", "video_stream"]
    source: Any  # rtc.VideoSource
    track: Any  # rtc.LocalVideoTrack
    stream_id: str = ""
    publication: Any = None  # rtc.LocalTrackPublication | None
    publish_task: asyncio.Task[None] | None = None
    publish_requested: bool = False
    """Set the moment the first frame lands, before the publish is scheduled:
    a capture thread pushing at frame rate must not queue a second publish
    while the first is still hopping to the session's loop."""
    stopped: bool = False


#: Participant attribute on the agent carrying the external ``ready`` frame
#: verbatim — room state every joiner reads, however late, where the
#: one-shot data-channel broadcast can be missed.
READY_ATTRIBUTE = "cosmo.ready"


class LiveKitTransport:
    """Production transport: a LiveKit room for audio and the data channel."""

    def __init__(self) -> None:
        self._room: Any = None  # rtc.Room | None
        #: Set when the room went down while ``connect`` was still in flight.
        #: Read by the session as pre-ready failure evidence.
        self._connect_lost: TransportClose | None = None
        self._ready_attribute_seen = False
        self._callbacks: TransportCallbacks | None = None
        self._video_publish: _VideoPublishState | None = None
        # The WebRTC source this transport built for a PcmAudioSource, with
        # the publication it belongs to. Keyed, because unpublish_track also
        # serves screen share and video streams and must not close audio.
        self._owned_source: PcmAudioSource | None = None
        self._owned_source_sid: str | None = None
        self._agent_audio_sink: AgentAudioSink | None = None
        self._agent_audio_track: Any = None  # rtc.RemoteAudioTrack | None
        self._agent_audio_task: asyncio.Task[None] | None = None
        self._pending_rpc: dict[str, RpcHandler] = {}
        self._loop: asyncio.AbstractEventLoop | None = None

    # ── Lifecycle ──────────────────────────────────────────────────

    async def connect(
        self,
        started: StartedSession,
        callbacks: TransportCallbacks,
    ) -> None:
        if not isinstance(started, SessionResponse):
            raise SessionStateError(
                code=SessionStateErrorCode.NOT_CONNECTED,
                message="this session start carries no room to join; it was answered "
                "by a server running its websocket transport",
            )
        await self._join(started.livekit_url, started.token, callbacks)

    async def connect_prepared(
        self, prepared: PreparedRoom, callbacks: TransportCallbacks
    ) -> None:
        """Join a room minted before the session start, on its held token.

        The start that names this room is still in flight; nothing here reads
        the start response, which is what lets the two run concurrently.
        """
        await self._join(prepared.livekit_url, prepared.token, callbacks)

    async def _join(
        self, livekit_url: str, token: str, callbacks: TransportCallbacks
    ) -> None:
        rtc = _import_livekit_rtc("RealtimeSession")
        _quiet_expected_livekit_streams()
        self._callbacks = callbacks
        self._connect_lost = None
        # Frames may be pushed from a capture thread, which has no loop of its
        # own; the publish they trigger has to run on this one.
        self._loop = asyncio.get_running_loop()
        room = rtc.Room()
        room.on("data_received", self._on_data_received)
        room.on("disconnected", self._on_disconnected)
        room.on("reconnecting", self._on_reconnecting)
        room.on("reconnected", self._on_reconnected)
        room.on("track_subscribed", self._on_track_subscribed)
        room.on(
            "participant_attributes_changed",
            self._on_participant_attributes_changed,
        )
        try:
            await room.connect(livekit_url, token)
        except BaseException:
            # BaseException: a cancelled connect must not leak a half-open room.
            try:
                await asyncio.shield(room.disconnect())
            except Exception:
                logger.exception("realtime.room_disconnect_failed", stack_info=True)
            raise
        self._room = room
        # Bind pre-connect registrations in the same event-loop tick the
        # connect resolves in: livekit-rtc cannot bind handlers before the
        # ``LocalParticipant`` exists, but it buffers inbound room events on
        # its FFI queue and dispatches them only after this coroutine yields —
        # so binding here, with no intervening await, guarantees an RPC
        # invocation that arrived during the join finds its handler when the
        # queue drains instead of "method not found".
        pending, self._pending_rpc = self._pending_rpc, {}
        for name, handler in pending.items():
            self._bind_rpc_method(name, handler)
        # The agent may already be up: its readiness attribute arrives with
        # the join-time participant state, where its one-shot ready frame
        # would already have been missed.
        for participant in room.remote_participants.values():
            self._maybe_emit_ready_attribute(participant)

    def is_connected(self) -> bool:
        return self._room is not None and self._room.isconnected()

    async def disconnect(self) -> None:
        room = self._room
        self._room = None
        self._callbacks = None
        state = self._video_publish
        self._video_publish = None
        self._stop_agent_audio_reader()
        self._agent_audio_track = None
        self._halt_publish(state)
        # Every teardown path lands here, and an ordinary session end never
        # unpublishes first — without this the SDK-built source keeps its
        # native handle for the life of the process.
        owned, self._owned_source = self._owned_source, None
        self._owned_source_sid = None
        if owned is not None:
            await owned.aclose()
        if room is not None:
            try:
                await room.disconnect()
            except Exception:
                logger.exception("realtime.room_disconnect_failed", stack_info=True)

    # ── Outbound ───────────────────────────────────────────────────

    async def send_frame(self, payload: bytes) -> None:
        room = self._require_room()
        await room.local_participant.publish_data(payload, reliable=True)

    async def send_bytes(self, data: bytes, topic: str) -> None:
        room = self._require_room()
        rtc = _import_livekit_rtc("send_bytes")
        agent_identities = [
            participant.identity
            for participant in room.remote_participants.values()
            if participant.kind == rtc.ParticipantKind.PARTICIPANT_KIND_AGENT
        ]
        if not agent_identities:
            raise SessionStateError(
                code=SessionStateErrorCode.NOT_CONNECTED,
                message=f"no agent participant to receive bytes on {topic!r}",
            )
        writer = await room.local_participant.stream_bytes(
            name=topic,
            topic=topic,
            destination_identities=agent_identities,
        )
        try:
            await writer.write(data)
        finally:
            await writer.aclose()

    # ── Client-tool RPC ────────────────────────────────────────────

    def register_rpc_method(self, name: str, handler: RpcHandler) -> None:
        if self._room is None:
            # Pre-connect registration: parked here and bound inside
            # ``connect`` the moment the room resolves, before any inbound
            # invocation can be dispatched.
            self._pending_rpc[name] = handler
            return
        self._bind_rpc_method(name, handler)

    def _bind_rpc_method(self, name: str, handler: RpcHandler) -> None:
        rtc = _import_livekit_rtc("client tools")
        room = self._require_room()

        async def rpc_method(data: Any) -> str:
            invocation = RpcInvocation(
                payload=data.payload,
                caller_identity=data.caller_identity,
                caller_is_agent=self._caller_is_agent(data.caller_identity),
            )
            try:
                return await handler(invocation)
            except RpcMethodError as exc:
                raise rtc.RpcError(code=exc.code, message=exc.message) from exc

        room.local_participant.register_rpc_method(name, rpc_method)

    def _participant_is_agent(self, participant: Any) -> bool:
        """True when ``participant``'s ``kind`` is ``agent``.

        Reads the kind off the participant the event carried, so the answer
        does not depend on a room. ``disconnect`` releases the room first,
        and a frame dispatched after that used to be logged as a stranger's
        for want of a roster to resolve the sender against."""
        rtc = _import_livekit_rtc("participant kind")
        return bool(participant.kind == rtc.ParticipantKind.PARTICIPANT_KIND_AGENT)

    def _caller_is_agent(self, caller_identity: str) -> bool:
        """True when ``caller_identity`` belongs to a remote participant whose
        ``kind`` is ``agent``. The local participant and any human remote are
        not agents."""
        room = self._room
        if room is None:
            return False
        participant = room.remote_participants.get(caller_identity)
        if participant is None:
            return False
        return self._participant_is_agent(participant)

    # ── Audio ──────────────────────────────────────────────────────

    def create_mic_source(self, capture: Optional[MicrophoneCapture]) -> MicSource:
        from cosmo_ai.audio._mic import MicAudioSource

        return MicAudioSource(capture)

    async def publish_audio_source(
        self, source: Any, *, track_name: str = "mic"
    ) -> Any:
        room = self._require_room()
        rtc = _import_livekit_rtc("publish_audio_source")
        if isinstance(source, PcmAudioSource):
            # A portable source publishes here through the WebRTC source it
            # builds on demand, so one caller-owned source works on both
            # lanes without the caller choosing. That inner source is ours,
            # so it is held for closing when the track is unpublished.
            owned = source
            source = source.livekit_source()
        else:
            owned = None
        track = rtc.LocalAudioTrack.create_audio_track(track_name, source)
        options = rtc.TrackPublishOptions(source=rtc.TrackSource.SOURCE_MICROPHONE)
        publication = await room.local_participant.publish_track(track, options)
        if owned is not None:
            self._owned_source = owned
            self._owned_source_sid = getattr(publication, "sid", None)
        return publication

    async def unpublish_track(self, publication: Any) -> None:
        room = self._room
        if room is None or publication is None:
            return
        try:
            await room.local_participant.unpublish_track(publication.sid)
        except Exception:
            logger.exception("realtime.unpublish_track_failed", stack_info=True)
        if (
            self._owned_source is not None
            and self._owned_source_sid == getattr(publication, "sid", None)
        ):
            # Ours to close, and only when this is the publication it backs:
            # a native handle and a queue otherwise held until collection.
            owned, self._owned_source = self._owned_source, None
            self._owned_source_sid = None
            await owned.aclose()

    def set_agent_audio_sink(self, sink: AgentAudioSink | None) -> None:
        self._agent_audio_sink = sink
        if sink is None:
            self._stop_agent_audio_reader()
            return
        if self._agent_audio_track is None:
            self._agent_audio_track = self._find_agent_audio_track()
        self._maybe_start_agent_audio_reader()

    def _find_agent_audio_track(self) -> Any:
        """The already-subscribed agent audio track, for a sink attached after
        the subscription event fired."""
        rtc = _import_livekit_rtc("agent audio")
        room = self._room
        if room is None:
            return None
        for participant in room.remote_participants.values():
            if participant.kind != rtc.ParticipantKind.PARTICIPANT_KIND_AGENT:
                continue
            for publication in participant.track_publications.values():
                if (
                    publication.track is not None
                    and publication.kind == rtc.TrackKind.KIND_AUDIO
                ):
                    return publication.track
        return None

    def _on_track_subscribed(
        self, track: Any, publication: Any, participant: Any
    ) -> None:
        rtc = _import_livekit_rtc("agent audio")
        if participant.kind != rtc.ParticipantKind.PARTICIPANT_KIND_AGENT:
            return
        if track.kind != rtc.TrackKind.KIND_AUDIO:
            return
        self._agent_audio_track = track
        # A reader on a pre-reconnect track drains a dead stream forever;
        # restart onto the fresh one.
        self._stop_agent_audio_reader()
        self._maybe_start_agent_audio_reader()

    def _maybe_start_agent_audio_reader(self) -> None:
        if (
            self._agent_audio_task is not None
            or self._agent_audio_sink is None
            or self._agent_audio_track is None
        ):
            return
        self._agent_audio_task = asyncio.create_task(
            self._read_agent_audio(self._agent_audio_track),
            name="cosmo-realtime-agent-audio",
        )

    def _stop_agent_audio_reader(self) -> None:
        task, self._agent_audio_task = self._agent_audio_task, None
        if task is not None:
            task.cancel()

    async def _read_agent_audio(self, track: Any) -> None:
        rtc = _import_livekit_rtc("agent audio")
        try:
            stream = rtc.AudioStream(
                track, sample_rate=AGENT_AUDIO_SAMPLE_RATE, num_channels=1
            )
            try:
                async for event in stream:
                    sink = self._agent_audio_sink
                    if sink is None:
                        return
                    frame = event.frame
                    sink.deliver(
                        AgentAudioFrame(
                            data=bytes(frame.data),
                            sample_rate=frame.sample_rate,
                            num_channels=frame.num_channels,
                            samples_per_channel=frame.samples_per_channel,
                        )
                    )
            finally:
                await stream.aclose()
        except asyncio.CancelledError:
            raise
        except Exception:
            # A decode failure ends only this reader; the pipeline re-arms on
            # the next track subscription (reconnect) or consumer attach.
            logger.exception("realtime.agent_audio_reader_failed", stack_info=True)
            if self._agent_audio_task is asyncio.current_task():
                self._agent_audio_task = None

    # ── Video publish: screen share and video streams ──────────────

    async def start_screen_share(self, *, width: int, height: int) -> None:
        active = self._video_publish
        if active is not None:
            # Replacing a prior share is the documented idempotence; a live
            # video stream is someone else's publish — refuse rather than
            # silently tearing it down.
            if active.kind != "screen_share":
                raise SessionStateError(
                    code=SessionStateErrorCode.VIDEO_PUBLISH_ALREADY_ACTIVE,
                    message="a video stream is publishing; remove it before sharing a screen",
                )
            await self.stop_screen_share()
        self._video_publish = self._create_publish_state(
            kind="screen_share", name="screen", width=width, height=height
        )

    def push_screen_share_frame(self, frame: Any) -> None:
        self._capture(self._matching(kind="screen_share"), frame)

    async def stop_screen_share(self) -> None:
        await self._stop_publish(self._matching(kind="screen_share"))

    async def add_video_stream(self, *, width: int, height: int) -> str:
        if self._video_publish is not None:
            raise SessionStateError(
                code=SessionStateErrorCode.VIDEO_PUBLISH_ALREADY_ACTIVE,
                message="a video publish is already active; one video track at a time",
            )
        state = self._create_publish_state(
            kind="video_stream", name="camera", width=width, height=height
        )
        state.stream_id = uuid.uuid4().hex
        self._video_publish = state
        return state.stream_id

    def push_video_frame(self, stream_id: str, frame: Any) -> None:
        self._capture(self._matching(kind="video_stream", stream_id=stream_id), frame)

    async def remove_video_stream(self, stream_id: str) -> None:
        await self._stop_publish(
            self._matching(kind="video_stream", stream_id=stream_id)
        )

    def _matching(
        self, *, kind: str, stream_id: str | None = None
    ) -> _VideoPublishState | None:
        """The active publish when it is the one the caller means. A stale
        stream id — already removed, or superseded by a later publish — reads
        as no publish at all, which is what makes removal idempotent and a
        push into a removed stream inert."""
        state = self._video_publish
        if state is None or state.kind != kind:
            return None
        if stream_id is not None and state.stream_id != stream_id:
            return None
        return state

    def _create_publish_state(
        self, *, kind: Literal["screen_share", "video_stream"], name: str,
        width: int, height: int,
    ) -> _VideoPublishState:
        rtc = _import_livekit_rtc("video publish")
        source = rtc.VideoSource(width, height)
        return _VideoPublishState(
            kind=kind,
            source=source,
            track=rtc.LocalVideoTrack.create_video_track(name, source),
        )

    def _capture(self, state: _VideoPublishState | None, frame: Any) -> None:
        if state is None:
            return
        state.source.capture_frame(frame)
        if state.publish_requested or self._room is None or self._loop is None:
            return
        state.publish_requested = True
        if _current_loop() is self._loop:
            self._start_publish(state)
        else:
            self._loop.call_soon_threadsafe(self._start_publish, state)

    def _start_publish(self, state: _VideoPublishState) -> None:
        """Spawn the deferred publish. Always runs on the session's loop —
        ``_capture`` hops here when a capture thread pushed the first frame."""
        if state.stopped:
            return
        state.publish_task = asyncio.create_task(self._publish_track(state))

    def _halt_publish(self, state: _VideoPublishState | None) -> None:
        """Stop a publish starting or continuing.

        Every teardown path goes through here. Cancelling the task is not
        enough on its own: a publish hopping over from a capture thread may
        not have landed yet, and without the flag that queued callback still
        spawns one — against a room that is already gone.
        """
        if state is None:
            return
        state.stopped = True
        if state.publish_task is not None:
            state.publish_task.cancel()

    async def _stop_publish(self, state: _VideoPublishState | None) -> None:
        if state is None:
            return
        self._video_publish = None
        self._halt_publish(state)
        if state.publication is not None:
            await self.unpublish_track(state.publication)

    async def _publish_track(self, state: _VideoPublishState) -> None:
        try:
            rtc = _import_livekit_rtc("video publish")
            # The source is the wire's answer to "what am I looking at": the
            # backend narrates a camera track as a camera feed and a screen
            # share as the user's screen, and the screen tools follow it.
            source = (
                rtc.TrackSource.SOURCE_SCREENSHARE
                if state.kind == "screen_share"
                else rtc.TrackSource.SOURCE_CAMERA
            )
            options = rtc.TrackPublishOptions(source=source)
            pub = await self._room.local_participant.publish_track(
                state.track, options
            )
            # The publish may have been stopped while we awaited; unpublish
            # the orphan.
            if self._video_publish is not state:
                await self.unpublish_track(pub)
            else:
                state.publication = pub
        except asyncio.CancelledError:
            raise
        except Exception:
            logger.exception("realtime.publish_video_track_failed", stack_info=True)

    # ── Transport-event fan-out ────────────────────────────────────

    def _on_data_received(self, data_packet: Any) -> None:
        try:
            payload: bytes = data_packet.data
        except AttributeError:
            payload = data_packet
        # Protocol frames come only from the agent; drop a room peer's packets
        # (a SIP leg, another client). ``participant`` is None for server-API
        # data, which no peer can forge — let it through.
        participant = getattr(data_packet, "participant", None)
        if participant is not None and not self._participant_is_agent(participant):
            logger.warning(
                "realtime.frame_from_non_agent_dropped",
                sender_identity=participant.identity,
            )
            return
        callbacks = self._callbacks
        if callbacks is not None:
            callbacks.on_frame(payload)

    def _on_participant_attributes_changed(self, *args: object) -> None:
        # livekit-rtc emits ``(changed_attributes, participant)``.
        participant = args[1] if len(args) > 1 else None
        self._maybe_emit_ready_attribute(participant)

    def _maybe_emit_ready_attribute(self, participant: Any) -> None:
        """Emit the agent's readiness attribute as an inbound ``ready``
        frame, once. The attribute carries the external frame verbatim, so
        downstream handling is identical to a data-channel delivery (the
        engine drops whichever of the two arrives second)."""
        if self._ready_attribute_seen or participant is None:
            return
        if not self._participant_is_agent(participant):
            return
        value = (getattr(participant, "attributes", None) or {}).get(READY_ATTRIBUTE)
        if not value:
            return
        try:
            frame = json.loads(value)
        except json.JSONDecodeError:
            logger.warning("realtime.ready_attribute_not_json")
            return
        if not isinstance(frame, dict) or frame.get("type") != "ready":
            logger.warning("realtime.ready_attribute_not_a_ready_frame")
            return
        self._ready_attribute_seen = True
        callbacks = self._callbacks
        if callbacks is not None:
            callbacks.on_frame(value.encode("utf-8"))

    def _on_disconnected(self, *args: object) -> None:
        # A room that never joined has nothing to close: livekit reports a
        # failed connect as a disconnect too, and that failure is the
        # caller's to handle (a prepared join falls back on it). The reason
        # is latched even so — a room deleted while ``connect`` is still
        # negotiating is the evidence a failed boot leaves behind, and the
        # join's own error says nothing about why.
        if self._room is None:
            self._connect_lost = _classify_disconnect(args[0] if args else None)
            return
        callbacks = self._callbacks
        if callbacks is not None:
            callbacks.on_closed(_classify_disconnect(args[0] if args else None))

    def _on_reconnecting(self, *args: object) -> None:
        callbacks = self._callbacks
        if callbacks is not None:
            callbacks.on_reconnecting()

    def _on_reconnected(self, *args: object) -> None:
        # Re-read the sign: a recovery rebuilds participants with their
        # attributes already populated, so an agent that became ready during
        # the outage fires no attribute change and would otherwise be missed.
        # Deduped, so a session already ready re-emits nothing.
        room = self._room
        if room is not None:
            for participant in room.remote_participants.values():
                self._maybe_emit_ready_attribute(participant)
        callbacks = self._callbacks
        if callbacks is not None:
            callbacks.on_reconnected()

    def _require_room(self) -> Any:
        if self._room is None:
            raise SessionStateError(code=SessionStateErrorCode.NOT_CONNECTED, message="Session is not connected.")
        return self._room


def _import_livekit_rtc(feature: str) -> Any:
    import livekit.rtc as rtc

    return rtc


# livekit-rtc's Room logs "ignoring text/byte stream with topic '<t>', no
# callback attached" via the *root* logger (bare logging.info, not its named
# "livekit" logger), so its level cannot be tuned in isolation. This SDK does
# not register stream handlers — it consumes its own data-channel protocol
# frames — so the LiveKit-native streams the agent emits (lk.agent.session,
# lk.transcription, …) trip these lines as pure noise. Drop only the known
# lk.* stream-ignore records; genuinely-unexpected topics still surface.
class _IgnoredLivekitStreamFilter(logging.Filter):
    _MESSAGES = (
        "ignoring text stream with topic '%s', no callback attached",
        "ignoring byte stream with topic '%s', no callback attached",
    )

    def filter(self, record: logging.LogRecord) -> bool:
        if record.msg in self._MESSAGES and record.args:
            topic = record.args[0] if isinstance(record.args, tuple) else record.args
            if isinstance(topic, str) and topic.startswith("lk."):
                return False
        return True


_lk_stream_filter_installed = False


def _quiet_expected_livekit_streams() -> None:
    global _lk_stream_filter_installed
    if _lk_stream_filter_installed:
        return
    logging.getLogger().addFilter(_IgnoredLivekitStreamFilter())
    _lk_stream_filter_installed = True

_SERVER_ENDED_REASONS = frozenset({"ROOM_DELETED", "PARTICIPANT_REMOVED", "ROOM_CLOSED"})


def _classify_disconnect(value: object) -> TransportClose:
    """Classify livekit-rtc's ``disconnected`` reason (a proto enum int).

    Deliberate server-side closes map to ``server_ended``; everything else —
    including ``SERVER_SHUTDOWN``, which is infrastructure failure from the
    caller's perspective — stays ``transport_error``. Same mapping as the
    sibling SDKs."""
    name: str | None = None
    if value is not None:
        try:
            from livekit.rtc import DisconnectReason as _LKDisconnectReason

            name = _LKDisconnectReason.Name(value)  # type: ignore[arg-type]
        except Exception:
            name = str(value)
    kind: Literal["server_ended", "transport_error"] = (
        "server_ended" if name in _SERVER_ENDED_REASONS else "transport_error"
    )
    return TransportClose(kind=kind, detail=name)
