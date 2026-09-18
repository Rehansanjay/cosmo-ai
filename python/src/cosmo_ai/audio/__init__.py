"""Audio: the public payload types, backed by the SDK's audio plumbing.

The types here are needed only when you take audio somewhere yourself. A
small voice app never imports them: ``set_speaker_enabled(True)`` plays the
agent out loud and ``audio_levels()`` yields ready-made samples. Import from
here when you consume :meth:`RealtimeSession.agent_audio` (recording, piping,
a custom player) or annotate handlers for either iterator.

:class:`PcmAudioSource` is here too, and is imported directly rather than
only annotated: it is the audio a caller publishes themselves — a synthetic
generator, WAV replay, a load generator — and it publishes on either
transport, so a session does not need to know which one it is running on.

The machinery is this package's private plumbing: OS-mic capture (``_mic``),
OS-speaker playback (``_speaker``), the agent-audio fan-out (``_broadcast``),
raw PCM for the websocket transport (``_pcm``), and the sounddevice import
gate (``_sounddevice``).
"""

from __future__ import annotations

from dataclasses import dataclass

AGENT_AUDIO_SAMPLE_RATE = 48000
"""The fixed geometry agent audio is decoded at: 48 kHz, mono, 16-bit."""


@dataclass(frozen=True)
class MicrophoneCapture:
    """Which processors run on captured microphone audio before it is encoded
    and sent, for :meth:`RealtimeSession.set_microphone_enabled`.

    Distinct from :class:`AudioConfig`'s ``noise_cancellation``, which asks the
    *server* to run Cosmo's noise cancellation on the received stream. These
    run client-side, on the raw capture, before anything leaves the machine.

    Echo cancellation is the one to leave on whenever the agent is audible on
    speakers: without it the agent's own voice re-enters the microphone and it
    talks over itself. The other two attenuate the speaker's level, which is
    occasionally the wrong trade — noise suppression and gain control can duck
    a person who talks while the agent is talking, far enough that the agent
    stops registering the interruption.

    These three flags are the processors every Cosmo SDK can express
    identically. Which implementation runs them — the platform's voice
    processing unit or in-process DSP — is not settable here, because the
    SDKs do not agree on how finely that can be chosen.
    """

    echo_cancellation: bool = True
    """Remove the agent's own voice from the capture. Leave on whenever the
    agent is audible on speakers, or it talks over itself."""
    noise_suppression: bool = True
    """Attenuate steady background noise. Also attenuates the speaker, so
    turn it off on a quiet headset if the agent mishears soft speech."""
    auto_gain_control: bool = True
    """Normalize capture level. Same trade-off as ``noise_suppression``."""


@dataclass(frozen=True)
class AgentAudioFrame:
    """One decoded frame of the agent's voice: 16-bit little-endian PCM,
    ``num_channels`` interleaved."""

    data: bytes
    """The samples themselves, 16-bit little-endian PCM."""
    sample_rate: int
    """Samples per second per channel."""
    num_channels: int
    """How many channels are interleaved in ``data``."""
    samples_per_channel: int
    """Samples this frame carries per channel — its length in time is this
    over ``sample_rate``."""


@dataclass(frozen=True)
class AudioLevels:
    """One metering sample: RMS (0…1) per direction, ``0.0`` while that
    direction is inactive."""

    mic: float
    """RMS of what the microphone is capturing, ``0.0``–``1.0``. ``0.0``
    while the microphone is off or silent."""
    agent: float
    """RMS of the agent's voice, ``0.0``–``1.0``. ``0.0`` while it is not
    speaking."""


def __getattr__(name: str) -> object:
    """``PcmAudioSource`` on demand: ``_pcm`` imports back into this module,
    so it cannot be imported at the top of it."""
    if name == "PcmAudioSource":
        from cosmo_ai.audio._pcm import PcmAudioSource

        return PcmAudioSource
    raise AttributeError(f"module {__name__!r} has no attribute {name!r}")
