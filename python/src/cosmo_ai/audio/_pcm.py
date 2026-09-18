"""Raw PCM plumbing for the websocket transport.

The LiveKit transport never sees a sample: WebRTC's device module captures,
encodes and decodes, and the SDK hands it opaque source objects. A websocket
carries PCM, so the samples cross into Python and something has to own the
capture, the rate conversion, and the queueing. That is this module.

Rates are fixed by the two ends and rarely agree with each other: the
provider wants 16 kHz in and sends 24 kHz back, a caller publishes whatever
their file or generator produces, and the SDK's decoded-frame contract is a
fixed 48 kHz. So every hop resamples, which for speech-band PCM16 is linear
interpolation with the fractional read position carried across chunks —
without that carry a per-chunk resampler clicks at every boundary.
"""

from __future__ import annotations

import asyncio
from array import array
from typing import Any, Protocol

import structlog

from cosmo_ai._internal.logging import get_logger
from cosmo_ai.audio import MicrophoneCapture
from cosmo_ai.errors import AudioUnavailableError

logger: structlog.stdlib.BoundLogger = get_logger(__name__)

_INT16_BYTES = 2

# Roughly a second of 16 kHz mono at the queue's chunk sizes. A transport
# that stops draining is a transport that is going away; holding more of the
# past would only delay what it eventually sends.
_CAPTURE_QUEUE_MAX_CHUNKS = 64


class PcmFrame(Protocol):
    """What :meth:`PcmAudioSource.capture_frame` accepts.

    Structural on purpose: ``livekit.rtc.AudioFrame`` satisfies it, so a
    caller already building those keeps building those, and so does anything
    else that can name its own geometry.
    """

    @property
    def data(self) -> Any: ...

    @property
    def sample_rate(self) -> int: ...

    @property
    def num_channels(self) -> int: ...


class Resampler:
    """Linear resampling of mono PCM16, continuous across chunks."""

    def __init__(self, *, source_rate: int, target_rate: int) -> None:
        if source_rate <= 0 or target_rate <= 0:
            raise ValueError(
                f"sample rates must be positive, got {source_rate} -> {target_rate}"
            )
        self._source_rate = source_rate
        self._target_rate = target_rate
        self._position = 0.0
        self._previous: int | None = None

    def __call__(self, data: bytes) -> bytes:
        if self._source_rate == self._target_rate or not data:
            return data
        samples = array("h")
        samples.frombytes(data)
        if not samples:
            return b""
        # The previous chunk's last sample leads this one, so a read position
        # landing between chunks interpolates across the seam. Without it a
        # resampler restarts at zero every chunk and clicks at each boundary.
        if self._previous is None:
            window = samples
        else:
            window = array("h", [self._previous])
            window.extend(samples)
        step = self._source_rate / self._target_rate
        position = self._position
        out = array("h")
        limit = len(window) - 1
        while position < limit:
            index = int(position)
            fraction = position - index
            left = window[index]
            right = window[index + 1]
            out.append(int(left + (right - left) * fraction))
            position += step
        self._previous = samples[-1]
        # Index 0 of the next window is index ``limit`` of this one.
        self._position = position - limit
        return out.tobytes()


def mono_pcm16(frame: PcmFrame) -> bytes:
    """One frame's samples as mono PCM16, averaging any extra channels."""
    data = bytes(frame.data)
    if frame.num_channels <= 1:
        return data
    samples = array("h")
    samples.frombytes(data)
    channels = frame.num_channels
    mixed = array(
        "h",
        (
            sum(samples[i : i + channels]) // channels
            for i in range(0, len(samples) - channels + 1, channels)
        ),
    )
    return mixed.tobytes()


class PcmAudioSource:
    """A caller-owned audio source that publishes on either transport.

    Take one when the SDK cannot capture the audio itself — a synthetic
    generator, WAV replay, a load generator, a host with no input device —
    and keep it fed with :meth:`capture_frame`. For the operating system's
    microphone use :meth:`~cosmo_ai.RealtimeSession.set_microphone_enabled`
    instead.

    The frames go wherever the session's transport needs them: straight onto
    the socket as PCM, or into a WebRTC source for the LiveKit lane. Which
    one is in use is not something a caller has to know.
    """

    def __init__(self, sample_rate: int, num_channels: int = 1) -> None:
        # Checked here rather than at the first frame: a zero rate reaches the
        # resampler inside a background task, where it would spin the loop
        # instead of raising anywhere the caller can see.
        if sample_rate <= 0:
            raise ValueError(f"sample_rate must be positive, got {sample_rate}")
        if num_channels <= 0:
            raise ValueError(f"num_channels must be positive, got {num_channels}")
        self.sample_rate = sample_rate
        self.num_channels = num_channels
        self._queue: asyncio.Queue[bytes] | None = None
        self._livekit_source: Any = None
        self._overflow_warned = False

    async def capture_frame(self, frame: PcmFrame) -> None:
        """Publish one frame. Feed these at the pace they would play: the
        provider's turn detection reads a continuous stream, and a burst
        reaching it faster than real time is heard as one long utterance."""
        # The open queue wins. A source that published through a room once
        # keeps its WebRTC source cached, and a later socket session would
        # otherwise keep feeding the room nobody is in and send the socket
        # silence.
        if self._queue is None:
            if self._livekit_source is not None:
                await self._livekit_source.capture_frame(_as_livekit_frame(frame))
            return
        if self._queue.full() and not self._overflow_warned:
            self._overflow_warned = True
            logger.warning(
                "realtime.audio_source_lagging",
                queue_max_chunks=_CAPTURE_QUEUE_MAX_CHUNKS,
            )
        # The oldest frame goes, not this one. After a stall the queue holds
        # about a second of audio that is already too late to be worth
        # sending, and keeping it would mean speaking the past over the
        # present until the backlog drains.
        _put_dropping_oldest(self._queue, mono_pcm16(frame))

    # ── Transport-facing ───────────────────────────────────────────

    def open_pcm_queue(self) -> "asyncio.Queue[bytes]":
        """Take the captured samples as mono PCM16 at :attr:`sample_rate`."""
        self._queue = asyncio.Queue(maxsize=_CAPTURE_QUEUE_MAX_CHUNKS)
        return self._queue

    def livekit_source(self) -> Any:
        """A WebRTC source fed by this one, created on first use so a
        websocket session never constructs one."""
        if self._livekit_source is None:
            from cosmo_ai.session._livekit import _import_livekit_rtc

            rtc = _import_livekit_rtc("PcmAudioSource")
            self._livekit_source = rtc.AudioSource(
                self.sample_rate, self.num_channels
            )
        return self._livekit_source

    def close(self) -> None:
        """Stop publishing on the socket transport. The source stays reusable
        for a later session on either transport.

        Deliberately leaves the WebRTC source alone: releasing that one needs
        an await, and erasing the handle here would leave :meth:`aclose` with
        nothing to close and the native resource held until collection."""
        self._queue = None

    async def aclose(self) -> None:
        """Release the WebRTC source built for the room transport.

        It holds a native handle and its own queue, and this object created
        it, so this object closes it. Nothing here touches a caller-supplied
        source — that one is never wrapped."""
        source, self._livekit_source = self._livekit_source, None
        if source is not None:
            try:
                await source.aclose()
            except Exception:
                logger.exception("realtime.audio_source_close_failed", stack_info=True)
        self._queue = None


class PcmMicSource:
    """The default input device, captured as PCM at the provider's rate.

    The room transport's microphone lives inside WebRTC's device module,
    which also runs the processors :class:`MicrophoneCapture` selects. Here
    the samples come straight from PortAudio, so the transport runs echo
    cancellation itself (``_apm``) whenever the policy asks for it — without
    it the agent hears itself through the speakers and interrupts itself.
    Noise suppression and gain control have no implementation on this
    transport; asking for them is logged once when capture starts.
    """

    def __init__(
        self, capture: MicrophoneCapture | None = None, *, sample_rate: int
    ) -> None:
        if sample_rate <= 0:
            raise ValueError(f"sample_rate must be positive, got {sample_rate}")
        self._capture = capture or MicrophoneCapture()
        self.sample_rate = sample_rate
        self._stream: Any = None
        self._queue: asyncio.Queue[bytes] | None = None
        self._loop: asyncio.AbstractEventLoop | None = None
        self.level = 0.0

    @property
    def audio_source(self) -> "PcmMicSource":
        """This object is what the transport publishes; there is no separate
        source handle the way the WebRTC path has one."""
        return self

    @property
    def capture(self) -> MicrophoneCapture:
        """The processor policy this microphone was opened with."""
        return self._capture

    async def start(self) -> None:
        if self._stream is not None:
            return
        from cosmo_ai.audio import _sounddevice

        sd = _sounddevice.ensure_sounddevice()
        # Say plainly what was asked for and is not happening. Echo
        # cancellation runs in the transport (``_apm``); these two have no
        # implementation on this lane, so a caller relying on the defaults
        # would otherwise never learn that.
        unavailable = [
            name
            for name, wanted in (
                ("noise_suppression", self._capture.noise_suppression),
                ("auto_gain_control", self._capture.auto_gain_control),
            )
            if wanted
        ]
        if unavailable:
            logger.warning(
                "realtime.mic_capture_processors_unavailable",
                requested=unavailable,
                transport="websocket",
            )
        self._loop = asyncio.get_running_loop()
        self._queue = asyncio.Queue(maxsize=_CAPTURE_QUEUE_MAX_CHUNKS)
        stream: Any = None
        try:
            stream = sd.RawInputStream(
                samplerate=self.sample_rate,
                channels=1,
                dtype="int16",
                callback=self._on_captured,
            )
            stream.start()
        except Exception as exc:
            self._queue = None
            # ``start`` can fail on a stream that opened, and this one is not
            # reachable from ``stop`` yet — closing it here is what keeps the
            # device free for the retry.
            if stream is not None:
                try:
                    stream.close()
                except Exception:
                    logger.exception(
                        "realtime.mic_stream_close_failed", stack_info=True
                    )
            raise AudioUnavailableError(
                f"could not open an input device for capture: {exc}"
            ) from exc
        self._stream = stream

    def open_pcm_queue(self) -> "asyncio.Queue[bytes]":
        if self._queue is None:
            raise RuntimeError("PcmMicSource.start() must run before publishing")
        return self._queue

    def set_level_source(self, track: Any) -> None:
        """No-op: the level is measured from the samples themselves, so
        there is no published track to name."""

    async def read_level(self) -> float:
        return self.level

    async def stop(self) -> None:
        stream, self._stream = self._stream, None
        self._queue = None
        self.level = 0.0
        if stream is not None:
            try:
                stream.stop()
            except Exception:
                logger.exception("realtime.mic_stream_stop_failed", stack_info=True)
            try:
                # Separately, and after a failed stop: this is what actually
                # hands the device back, and skipping it makes the next
                # microphone open fail as busy.
                stream.close()
            except Exception:
                logger.exception("realtime.mic_stream_close_failed", stack_info=True)

    def _on_captured(
        self, indata: Any, frames: int, time_info: object, status: Any
    ) -> None:
        """PortAudio callback, on its own thread: hand the samples to the
        loop that owns the queue."""
        chunk = bytes(indata)
        self.level = _rms_int16(chunk)
        loop, queue = self._loop, self._queue
        if loop is None or queue is None:
            return
        loop.call_soon_threadsafe(_put_dropping_oldest, queue, chunk)


def _as_livekit_frame(frame: PcmFrame) -> Any:
    """A frame WebRTC will accept.

    :class:`PcmFrame` is structural, and the websocket lane only ever reads
    its three fields — but WebRTC's capture reaches for ``samples_per_channel``
    and a protobuf view, so anything that is not already an ``rtc.AudioFrame``
    is rebuilt as one here. That is what lets one source publish on either
    transport."""
    from cosmo_ai.session._livekit import _import_livekit_rtc

    rtc = _import_livekit_rtc("PcmAudioSource")
    if isinstance(frame, rtc.AudioFrame):
        return frame
    data = bytes(frame.data)
    channels = max(frame.num_channels, 1)
    return rtc.AudioFrame(
        data,
        frame.sample_rate,
        channels,
        len(data) // _INT16_BYTES // channels,
    )


def _put_dropping_oldest(queue: "asyncio.Queue[bytes]", chunk: bytes) -> None:
    while True:
        try:
            queue.put_nowait(chunk)
            return
        except asyncio.QueueFull:
            try:
                queue.get_nowait()
            except asyncio.QueueEmpty:
                return


def _rms_int16(data: bytes) -> float:
    if not data:
        return 0.0
    samples = array("h")
    samples.frombytes(data)
    total: int = sum(sample * sample for sample in samples)
    return float((total / len(samples)) ** 0.5 / 32768.0)
