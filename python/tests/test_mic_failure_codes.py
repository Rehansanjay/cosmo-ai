"""Which capture failure ``AudioUnavailableError`` attributes.

The slugs are the vocabulary the TypeScript SDK publishes as ``ErrorCode``
members, so the same situation is named the same thing in both.
"""

from __future__ import annotations

from typing import Any

import pytest

from cosmo_ai.audio._mic import MicAudioSource, _capture_failure_code
from cosmo_ai.errors import AudioUnavailableError


class _Platform:
    """Stands in for ``rtc.PlatformAudio``: enumeration answers, opening does not."""

    def __init__(self, devices: list[str] | Exception) -> None:
        self._devices = devices
        self.closed = False

    def recording_devices(self) -> list[str]:
        if isinstance(self._devices, Exception):
            raise self._devices
        return self._devices

    def create_audio_source(self, _options: Any) -> Any:
        raise OSError("device could not be opened")

    def close(self) -> None:
        self.closed = True


def test_no_input_device_is_named_mic_not_found() -> None:
    assert _capture_failure_code(_Platform([])) == "mic_not_found"


def test_a_device_that_will_not_open_is_not_diagnosed() -> None:
    # A refused permission and a device another process holds are
    # indistinguishable here, so neither is claimed.
    assert _capture_failure_code(_Platform(["Built-in Microphone"])) == "audio_unavailable"


def test_enumeration_failure_attributes_nothing() -> None:
    assert _capture_failure_code(_Platform(RuntimeError("ADM is gone"))) == "audio_unavailable"


def test_no_platform_attributes_nothing() -> None:
    assert _capture_failure_code(None) == "audio_unavailable"


def test_the_error_carries_the_code_and_closes_the_platform(monkeypatch: Any) -> None:
    platform = _Platform([])
    monkeypatch.setattr("cosmo_ai.audio._mic.rtc.PlatformAudio", lambda: platform)

    source = MicAudioSource()
    with pytest.raises(AudioUnavailableError) as raised:
        import asyncio

        asyncio.run(source.start())

    assert raised.value.code == "mic_not_found"
    # The device handle is released on the failure path, not left to the GC.
    assert platform.closed is True


def test_the_default_code_is_the_unattributed_one() -> None:
    assert AudioUnavailableError("portaudio is missing").code == "audio_unavailable"
