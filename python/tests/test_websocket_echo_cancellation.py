"""Echo cancellation on the websocket transport.

The room transport gets it from WebRTC's device module; this lane runs the
same canceller in-process. What is pinned here is the wiring: the capture is
processed in exact 10 ms frames before it reaches the socket, the agent audio
being played out feeds the reverse stream without itself being altered, and a
caller who turns echo cancellation off gets a raw capture path with no APM at
all.
"""

from __future__ import annotations

import asyncio
import json
from typing import Any

import pytest
import structlog.testing

from cosmo_ai.audio import AGENT_AUDIO_SAMPLE_RATE, MicrophoneCapture, _sounddevice
from cosmo_ai.audio import _apm
from cosmo_ai.audio._apm import _STREAM_DELAY_MS, EchoCanceller, _TenMsChunker
from cosmo_ai.audio._pcm import PcmAudioSource, PcmMicSource
from cosmo_ai.session._websocket import WebSocketTransport

from .test_websocket_transport import (
    AUDIO_FORMAT,
    FakeSocket,
    Recorder,
    connected,
    settle,
)


AUDIO_FORMAT_22050 = json.dumps(
    {
        "type": "ws-audio-format",
        "input_sample_rate_hz": 22050,
        "output_sample_rate_hz": 24000,
        "num_channels": 1,
    }
)


def _inverted(data: bytes) -> bytes:
    return bytes(b ^ 0xFF for b in data)


class FakeApm:
    """Stands in for livekit's AudioProcessingModule: records every frame it
    is fed and rewrites each in place — inverting the capture, zeroing the
    reverse — so the assertions can tell processed audio from raw."""

    def __init__(self) -> None:
        self.stream_frames: list[tuple[bytes, int, int]] = []
        self.reverse_frames: list[tuple[bytes, int, int]] = []
        self.delays: list[int] = []

    def set_stream_delay_ms(self, delay_ms: int) -> None:
        self.delays.append(delay_ms)

    def process_stream(self, frame: Any) -> None:
        data = bytes(frame.data)
        self.stream_frames.append((data, frame.sample_rate, frame.samples_per_channel))
        frame._data = bytearray(_inverted(data))

    def process_reverse_stream(self, frame: Any) -> None:
        data = bytes(frame.data)
        self.reverse_frames.append((data, frame.sample_rate, frame.samples_per_channel))
        frame._data = bytearray(len(data))


@pytest.fixture()
def fake_apm(monkeypatch: pytest.MonkeyPatch) -> FakeApm:
    apm = FakeApm()
    monkeypatch.setattr(_apm, "_new_apm", lambda: apm)
    return apm


class _IdleStream:
    def start(self) -> None:
        return None

    def stop(self) -> None:
        return None

    def close(self) -> None:
        return None


def _fake_sounddevice(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(
        _sounddevice,
        "ensure_sounddevice",
        lambda: type(
            "sd", (), {"RawInputStream": staticmethod(lambda **kw: _IdleStream())}
        ),
    )


async def _published_mic(
    transport: WebSocketTransport,
    monkeypatch: pytest.MonkeyPatch,
    capture: MicrophoneCapture | None = None,
) -> PcmMicSource:
    _fake_sounddevice(monkeypatch)
    mic = transport.create_mic_source(capture)
    assert isinstance(mic, PcmMicSource)
    await mic.start()
    await transport.publish_audio_source(mic)
    return mic


def test_mic_capture_is_processed_in_ten_ms_frames_before_the_socket(
    fake_apm: FakeApm, monkeypatch: pytest.MonkeyPatch
) -> None:
    async def scenario() -> None:
        socket = FakeSocket([AUDIO_FORMAT])
        transport = await connected(socket, Recorder(), monkeypatch)
        mic = await _published_mic(transport, monkeypatch)
        # 30 ms of capture at the provider's 16 kHz, in one PortAudio block.
        captured = bytes(i % 251 for i in range(480 * 2))
        mic._on_captured(captured, 480, None, None)
        await settle()
        # Exactly 10 ms per APM frame: 160 samples at 16 kHz.
        assert [(rate, samples) for _, rate, samples in fake_apm.stream_frames] == [
            (16000, 160)
        ] * 3
        assert b"".join(raw for raw, _, _ in fake_apm.stream_frames) == captured
        # The socket carries the processed samples, in the unchanged 20 ms
        # send chunks: one full chunk is ready, the trailing 10 ms pends.
        assert socket.binary_frames() == [_inverted(captured[:640])]
        assert fake_apm.delays == [_STREAM_DELAY_MS]
        await transport.disconnect()

    asyncio.run(scenario())


def test_agent_audio_feeds_the_reverse_stream_without_being_altered(
    fake_apm: FakeApm, monkeypatch: pytest.MonkeyPatch
) -> None:
    async def scenario() -> None:
        socket = FakeSocket([AUDIO_FORMAT])
        recorder = Recorder()
        transport = await connected(socket, recorder, monkeypatch)
        transport.set_agent_audio_sink(recorder)
        await _published_mic(transport, monkeypatch)
        # 50 ms at the provider's 24 kHz, resampled to 48 kHz on delivery.
        socket.push(b"\x11\x22" * 1200)
        await settle()
        delivered = b"".join(frame.data for frame in recorder.audio)
        # Exactly 10 ms per reverse frame: 480 samples at 48 kHz, covering
        # everything delivered so far but the sub-frame tail.
        expected_frames = (len(delivered) // 2) // 480
        assert expected_frames >= 4
        assert [(rate, samples) for _, rate, samples in fake_apm.reverse_frames] == [
            (AGENT_AUDIO_SAMPLE_RATE, 480)
        ] * expected_frames
        # The reference fed to the canceller is the audio being played, and
        # the played audio is not what the canceller wrote back (the fake
        # zeroes its frames; the delivery kept the signal).
        assert b"".join(raw for raw, _, _ in fake_apm.reverse_frames) == delivered[
            : expected_frames * 960
        ]
        assert any(b != 0 for b in delivered)
        await transport.disconnect()

    asyncio.run(scenario())


def test_unpublishing_the_microphone_disengages_the_canceller(
    fake_apm: FakeApm, monkeypatch: pytest.MonkeyPatch
) -> None:
    async def scenario() -> None:
        socket = FakeSocket([AUDIO_FORMAT])
        recorder = Recorder()
        transport = await connected(socket, recorder, monkeypatch)
        transport.set_agent_audio_sink(recorder)
        mic = await _published_mic(transport, monkeypatch)
        socket.push(b"\x11\x22" * 480)
        await settle()
        assert len(fake_apm.reverse_frames) > 0
        fed = len(fake_apm.reverse_frames)
        await transport.unpublish_track(mic)
        socket.push(b"\x11\x22" * 2400)
        await settle()
        assert len(fake_apm.reverse_frames) == fed
        await transport.disconnect()

    asyncio.run(scenario())


class RaisingApm:
    """An APM whose native half has died: every process call raises."""

    def set_stream_delay_ms(self, delay_ms: int) -> None:
        return None

    def process_stream(self, frame: Any) -> None:
        raise RuntimeError("native fault")

    def process_reverse_stream(self, frame: Any) -> None:
        raise RuntimeError("native fault")


def test_a_faulting_canceller_disengages_and_capture_flows_raw(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """An AEC fault must cost the echo cancellation, never the call: the
    canceller disengages with one logged exception and the raw capture keeps
    reaching the socket."""

    async def scenario() -> None:
        monkeypatch.setattr(_apm, "_new_apm", lambda: RaisingApm())
        socket = FakeSocket([AUDIO_FORMAT])
        recorder = Recorder()
        transport = await connected(socket, recorder, monkeypatch)
        mic = await _published_mic(transport, monkeypatch)
        captured = bytes(i % 251 for i in range(640 * 2))
        with structlog.testing.capture_logs() as logs:
            mic._on_captured(captured[:640], 320, None, None)
            await settle()
            mic._on_captured(captured[640:], 320, None, None)
            await settle()
        assert socket.binary_frames() == [captured[:640], captured[640:]]
        faults = [
            log
            for log in logs
            if log["event"] == "realtime.echo_cancellation_disengaged"
        ]
        assert [(log["direction"], log["log_level"]) for log in faults] == [
            ("capture", "error")
        ]
        assert recorder.closes == []
        assert transport.is_connected() is True
        await transport.disconnect()

    asyncio.run(scenario())


def test_a_faulting_reverse_stream_disengages_without_dropping_playback(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    async def scenario() -> None:
        monkeypatch.setattr(_apm, "_new_apm", lambda: RaisingApm())
        socket = FakeSocket([AUDIO_FORMAT])
        recorder = Recorder()
        transport = await connected(socket, recorder, monkeypatch)
        transport.set_agent_audio_sink(recorder)
        await _published_mic(transport, monkeypatch)
        with structlog.testing.capture_logs() as logs:
            socket.push(b"\x11\x22" * 480)
            await settle()
            socket.push(b"\x11\x22" * 480)
            await settle()
        assert len(recorder.audio) == 2
        assert all(any(b != 0 for b in frame.data) for frame in recorder.audio)
        faults = [
            log
            for log in logs
            if log["event"] == "realtime.echo_cancellation_disengaged"
        ]
        assert [log["direction"] for log in faults] == ["playback"]
        assert recorder.closes == []
        await transport.disconnect()

    asyncio.run(scenario())


def test_an_unsupported_input_rate_warns_and_captures_raw(
    fake_apm: FakeApm, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A rate with no whole 10 ms frame is NS/AGC's kind of unavailable, not
    a reason to refuse the publish: warn once and run the raw path."""

    async def scenario() -> None:
        socket = FakeSocket([AUDIO_FORMAT_22050])
        transport = await connected(socket, Recorder(), monkeypatch)
        with structlog.testing.capture_logs() as logs:
            mic = await _published_mic(transport, monkeypatch)
        warned = [
            log
            for log in logs
            if log["event"] == "realtime.echo_cancellation_unavailable"
        ]
        assert [log["input_sample_rate"] for log in warned] == [22050]
        # 20 ms at 22050 Hz: one send chunk, straight through.
        captured = bytes(i % 251 for i in range(441 * 2))
        mic._on_captured(captured, 441, None, None)
        await settle()
        assert socket.binary_frames() == [captured]
        assert fake_apm.delays == [] and fake_apm.stream_frames == []
        await transport.disconnect()

    asyncio.run(scenario())


def test_a_caller_who_disables_echo_cancellation_gets_a_raw_capture_path(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    def no_apm() -> Any:
        raise AssertionError("no APM may be engaged when the caller said no")

    async def scenario() -> None:
        monkeypatch.setattr(_apm, "_new_apm", no_apm)
        socket = FakeSocket([AUDIO_FORMAT])
        transport = await connected(socket, Recorder(), monkeypatch)
        mic = await _published_mic(
            transport,
            monkeypatch,
            MicrophoneCapture(
                echo_cancellation=False,
                noise_suppression=False,
                auto_gain_control=False,
            ),
        )
        captured = bytes(i % 251 for i in range(640 * 2))
        mic._on_captured(captured, 640, None, None)
        await settle()
        assert socket.binary_frames() == [captured[:640], captured[640:]]
        await transport.disconnect()

    asyncio.run(scenario())


def test_a_caller_owned_stream_is_never_echo_cancelled(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The canceller needs the OS speaker/mic loop; a synthetic source has
    neither, and its samples must reach the socket byte-for-byte."""

    def no_apm() -> Any:
        raise AssertionError("no APM may be engaged for a caller-owned source")

    class Frame:
        def __init__(self, data: bytes) -> None:
            self.data = data
            self.sample_rate = 16000
            self.num_channels = 1

    async def scenario() -> None:
        monkeypatch.setattr(_apm, "_new_apm", no_apm)
        socket = FakeSocket([AUDIO_FORMAT])
        transport = await connected(socket, Recorder(), monkeypatch)
        source = PcmAudioSource(16000, 1)
        await transport.publish_audio_source(source)
        payload = bytes(i % 251 for i in range(320 * 2))
        await source.capture_frame(Frame(payload))
        await settle()
        assert socket.binary_frames() == [payload]
        await transport.disconnect()

    asyncio.run(scenario())


# ── The 10 ms re-chunker ───────────────────────────────────────────


def test_the_rechunker_neither_drops_nor_reorders_samples() -> None:
    chunker = _TenMsChunker(sample_rate=16000)
    payload = bytes(i % 256 for i in range(2 * 1000))  # 1000 samples, not 10 ms aligned
    slices = [1, 3, 50, 319, 320, 321, 640, 346]
    assert sum(slices) == len(payload)
    frames: list[bytes] = []
    position = 0
    for size in slices:
        frames.extend(chunker.push(payload[position : position + size]))
        position += size
    assert all(len(frame) == 320 for frame in frames)
    joined = b"".join(frames)
    assert joined == payload[: len(joined)]
    held = len(payload) - len(joined)
    assert 0 < held < 320
    # Topping the tail up to a whole frame flushes it, byte for byte.
    frames.extend(chunker.push(b"\x00" * (320 - held)))
    assert b"".join(frames) == payload + b"\x00" * (320 - held)


def test_a_rate_with_no_whole_ten_ms_frame_is_refused() -> None:
    with pytest.raises(ValueError, match="10 ms"):
        _TenMsChunker(sample_rate=22050)


# ── The capture-start warning ──────────────────────────────────────


def test_the_unavailable_warning_no_longer_names_echo_cancellation(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _fake_sounddevice(monkeypatch)

    async def scenario() -> None:
        mic = PcmMicSource(sample_rate=16000)  # the default policy asks for all three
        with structlog.testing.capture_logs() as logs:
            await mic.start()
        await mic.stop()
        warned = [
            log["requested"]
            for log in logs
            if log["event"] == "realtime.mic_capture_processors_unavailable"
        ]
        assert warned == [["noise_suppression", "auto_gain_control"]]

    asyncio.run(scenario())


def test_an_aec_only_policy_starts_without_a_warning(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _fake_sounddevice(monkeypatch)

    async def scenario() -> None:
        mic = PcmMicSource(
            MicrophoneCapture(noise_suppression=False, auto_gain_control=False),
            sample_rate=16000,
        )
        with structlog.testing.capture_logs() as logs:
            await mic.start()
        await mic.stop()
        assert [
            log
            for log in logs
            if log["event"] == "realtime.mic_capture_processors_unavailable"
        ] == []

    asyncio.run(scenario())


# ── The real module ────────────────────────────────────────────────


def test_the_real_apm_accepts_the_lane_geometry() -> None:
    """livekit's native module takes the exact frames this lane feeds it —
    10 ms forward at the provider's 16 kHz, 10 ms reverse at 48 kHz — and
    hands the capture back at its size."""
    canceller = EchoCanceller(
        capture_rate=16000, playback_rate=AGENT_AUDIO_SAMPLE_RATE
    )
    canceller.analyze_playback(b"\x10\x00" * 480)
    processed = canceller.process_capture(b"\x08\x00" * 160)
    assert len(processed) == 160 * 2
