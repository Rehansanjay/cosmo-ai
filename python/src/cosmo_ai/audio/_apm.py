"""In-process echo cancellation for the websocket transport's PCM paths.

The room transport captures inside WebRTC's device module, which runs the
capture processors before a sample ever reaches Python. The websocket lane
captures raw PortAudio samples (``_pcm``), so echo cancellation runs here
instead, through livekit's ``AudioProcessingModule`` — the same WebRTC DSP
without the device module. Only the echo canceller is engaged: noise
suppression and gain control duck the user's level during double-talk, far
enough that barge-in stops registering, so this lane leaves them off and
reports them unavailable when asked for.

The module accepts exactly 10 ms of audio per call in both directions, so
each direction regroups its stream into 10 ms frames before processing.
"""

from __future__ import annotations

from typing import Any

_INT16_BYTES = 2
_APM_FRAME_MS = 10

# Between feeding a far-end frame and hearing its echo in the capture: the
# server paces agent audio up to ~300 ms ahead of its playout clock (audio
# that sits in the speaker buffer here), shrinking to near zero at the start
# of a turn, plus tens of milliseconds of device latency each way. One number
# cannot track that swing; WebRTC's own delay estimator adapts around this
# midpoint hint.
_STREAM_DELAY_MS = 200


def _new_apm() -> Any:
    from livekit.rtc import apm

    return apm.AudioProcessingModule(echo_cancellation=True)


class _TenMsChunker:
    """Regroups arbitrarily-sized mono PCM16 chunks into exact 10 ms frames.

    The remainder carries across calls, so no sample is dropped: what does
    not yet fill a frame waits for the next chunk."""

    def __init__(self, *, sample_rate: int) -> None:
        if sample_rate * _APM_FRAME_MS % 1000:
            raise ValueError(
                f"sample rate {sample_rate} has no whole number of samples "
                f"per {_APM_FRAME_MS} ms frame"
            )
        self._frame_bytes = (sample_rate * _APM_FRAME_MS // 1000) * _INT16_BYTES
        self._pending = bytearray()

    def push(self, data: bytes) -> list[bytearray]:
        self._pending.extend(data)
        frames: list[bytearray] = []
        while len(self._pending) >= self._frame_bytes:
            frames.append(self._pending[: self._frame_bytes])
            del self._pending[: self._frame_bytes]
        return frames


class EchoCanceller:
    """WebRTC's echo canceller across the socket lane's two PCM directions.

    :meth:`process_capture` returns the microphone samples with the agent's
    echo removed; :meth:`analyze_playback` feeds the agent audio being played
    out as the far-end reference and leaves the caller's samples untouched —
    the reverse pass is analysis, never playback processing."""

    def __init__(self, *, capture_rate: int, playback_rate: int) -> None:
        from cosmo_ai.session._livekit import _import_livekit_rtc

        # Chunkers first: an unsupported rate must be refused before a native
        # module exists to leak.
        self._capture_frames = _TenMsChunker(sample_rate=capture_rate)
        self._playback_frames = _TenMsChunker(sample_rate=playback_rate)
        self._capture_rate = capture_rate
        self._playback_rate = playback_rate
        self._rtc = _import_livekit_rtc("EchoCanceller")
        self._apm = _new_apm()
        self._apm.set_stream_delay_ms(_STREAM_DELAY_MS)

    def process_capture(self, data: bytes) -> bytes:
        processed = bytearray()
        for chunk in self._capture_frames.push(data):
            frame = self._frame(chunk, self._capture_rate)
            self._apm.process_stream(frame)
            processed.extend(bytes(frame.data))
        return bytes(processed)

    def analyze_playback(self, data: bytes) -> None:
        for chunk in self._playback_frames.push(data):
            self._apm.process_reverse_stream(self._frame(chunk, self._playback_rate))

    def _frame(self, chunk: bytearray, sample_rate: int) -> Any:
        return self._rtc.AudioFrame(
            chunk, sample_rate, 1, len(chunk) // _INT16_BYTES
        )
