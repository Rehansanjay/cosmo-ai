from __future__ import annotations

import asyncio
import json

from cosmo_ai import DelegationCreatedEvent, TranscriptItem, TranscriptRole
from cosmo_ai.session._delegation import DelegationTranscripts

from .fakes import start_fake_session


def test_append_commentary_publishes_a_delegation_append_frame() -> None:
    async def scenario() -> None:
        harness = await start_fake_session()
        session = harness.session
        assert session is not None
        await session.append_commentary("Found three matches.", delegation_id="dlg-1")
        (frame,) = harness.frames
        assert frame == {
            "type": "delegation-append",
            "channel": "commentary",
            "content": "Found three matches.",
            "delegation_id": "dlg-1",
        }

    asyncio.run(scenario())


def test_append_instructions_without_delegation_omits_the_id() -> None:
    async def scenario() -> None:
        harness = await start_fake_session()
        session = harness.session
        assert session is not None
        await session.append_instructions("Keep answers under two sentences.")
        (frame,) = harness.frames
        assert frame == {
            "type": "delegation-append",
            "channel": "instructions",
            "content": "Keep answers under two sentences.",
        }

    asyncio.run(scenario())


def test_delegation_created_frame_lands_on_the_event_stream() -> None:
    async def scenario() -> None:
        harness = await start_fake_session()
        session = harness.session
        assert session is not None
        frame = {
            "type": "delegation-created",
            "delegation_id": "dlg-1",
            "transcript": "What's on my calendar tomorrow?",
        }
        await session._handle_payload(json.dumps(frame).encode("utf-8"))

        event = await asyncio.wait_for(session.__anext__(), timeout=1)
        assert isinstance(event, DelegationCreatedEvent)
        assert event.delegation_id == "dlg-1"
        assert event.transcript == "What's on my calendar tomorrow?"

    asyncio.run(scenario())


def test_a_blank_hand_off_arrives_with_the_last_user_turn() -> None:
    async def scenario() -> None:
        harness = await start_fake_session()
        session = harness.session
        assert session is not None
        for frame in (
            {"type": "transcript", "role": "user", "text": "option B", "is_final": True},
            {"type": "delegation-created", "delegation_id": "dlg-1", "transcript": ""},
            {"type": "delegation-created", "delegation_id": "dlg-2", "transcript": ""},
        ):
            await session._handle_payload(json.dumps(frame).encode("utf-8"))

        handed_off = []
        while len(handed_off) < 2:
            event = await asyncio.wait_for(session.__anext__(), timeout=1)
            if isinstance(event, DelegationCreatedEvent):
                handed_off.append(event.transcript)
        # The turn that stood in for the first hand-off does not stand in again.
        assert handed_off == ["option B", ""]

    asyncio.run(scenario())


class TestBlankHandoffTranscript:
    """GPT Live hands off mid-turn without attaching what the user said."""

    def _items(self, *turns: tuple[TranscriptRole, str]) -> tuple[TranscriptItem, ...]:
        return tuple(
            TranscriptItem(id=f"t{index}", role=role, text=text, is_final=True)
            for index, (role, text) in enumerate(turns)
        )

    def test_keeps_what_the_provider_sent(self) -> None:
        resolver = DelegationTranscripts()

        assert (
            resolver.resolve("d1", "where is my order", self._items((TranscriptRole.USER, "hi")))
            == "where is my order"
        )

    def test_stands_in_the_last_user_turn(self) -> None:
        resolver = DelegationTranscripts()
        items = self._items(
            (TranscriptRole.USER, "lets begin"),
            (TranscriptRole.ASSISTANT, "Question one…"),
            (TranscriptRole.USER, "option B"),
        )

        assert resolver.resolve("d1", "", items) == "option B"

    def test_one_hand_off_resolves_once(self) -> None:
        resolver = DelegationTranscripts()
        items = self._items((TranscriptRole.USER, "option B"))

        assert resolver.resolve("d1", "", items) == "option B"
        assert (
            resolver.resolve("d1", "", items + self._items((TranscriptRole.USER, "lock it")))
            == "option B"
        )

    def test_a_turn_never_stands_in_twice(self) -> None:
        resolver = DelegationTranscripts()
        items = self._items((TranscriptRole.USER, "option B"))

        assert resolver.resolve("d1", "", items) == "option B"
        assert resolver.resolve("d2", "", items) == ""

    def test_never_stands_in_a_turn_the_provider_named(self) -> None:
        resolver = DelegationTranscripts()
        items = self._items((TranscriptRole.USER, "option B"))

        assert resolver.resolve("d1", "option B", items) == "option B"
        assert resolver.resolve("d2", "", items) == ""

    def test_nothing_to_offer_before_the_user_spoke(self) -> None:
        resolver = DelegationTranscripts()

        assert resolver.resolve("d1", "", self._items((TranscriptRole.ASSISTANT, "Welcome!"))) == ""
        assert resolver.resolve("d2", "   ", ()) == ""
