"""Session-owned transcript state: folding semantics of
``RealtimeSession.transcript`` / ``TranscriptUpdatedEvent`` over the wire
stream — growth, barge-in interleaving, retraction, silent-session chunked
finals, dangling-line close, send_text echo, and teardown. TypeScript's
``transcript_state.test.ts`` is the cross-SDK spec."""

import asyncio
import json
from typing import Any

from cosmo_ai import (
    RealtimeSession,
    SessionEndedEvent,
    TranscriptItem,
    TranscriptRole,
    TranscriptUpdatedEvent,
)

from .fakes import start_fake_session


async def _inject(session: RealtimeSession, *frames: dict[str, Any]) -> None:
    for frame in frames:
        await session._handle_payload(json.dumps(frame).encode("utf-8"))


def _delta(role: str, text: str, is_final: bool) -> dict[str, Any]:
    return {"type": "transcript", "role": role, "text": text, "is_final": is_final}


def _turn_complete(role: str) -> dict[str, Any]:
    return {"type": "turn-complete", "role": role}


def _bare(items: tuple[TranscriptItem, ...]) -> list[tuple[str, str, bool]]:
    return [(item.role.value, item.text, item.is_final) for item in items]


async def _session() -> RealtimeSession:
    harness = await start_fake_session()
    assert harness.session is not None
    return harness.session


def test_deltas_grow_the_open_bubble_and_the_final_replaces() -> None:
    async def scenario() -> None:
        session = await _session()
        await _inject(
            session,
            _delta("ASSISTANT", "Hel", False),
            _delta("ASSISTANT", "lo th", False),
        )
        assert _bare(session.transcript) == [("assistant", "Hello th", False)]
        # The final is authoritative and can correct a reworded prefix.
        await _inject(session, _delta("ASSISTANT", "Hello there.", True))
        assert _bare(session.transcript) == [("assistant", "Hello there.", True)]

    asyncio.run(scenario())


def test_item_id_is_stable_from_open_to_close() -> None:
    async def scenario() -> None:
        session = await _session()
        await _inject(session, _delta("USER", "partial", False))
        open_id = session.transcript[0].id
        await _inject(session, _delta("USER", "partial and final", True))
        assert session.transcript[0].id == open_id

    asyncio.run(scenario())


def test_barge_in_interleaving_holds_turns_together() -> None:
    async def scenario() -> None:
        session = await _session()
        # Wire order under barge-in: user partial → assistant delta → user final.
        await _inject(
            session,
            _delta("USER", "Wait, ", False),
            _delta("ASSISTANT", "As I was say", False),
            _delta("USER", "Wait, stop.", True),
        )
        assert _bare(session.transcript) == [
            ("user", "Wait, stop.", True),
            ("assistant", "As I was say", False),
        ]

    asyncio.run(scenario())


def test_empty_final_retracts_the_open_bubble() -> None:
    async def scenario() -> None:
        session = await _session()
        await _inject(session, _delta("ASSISTANT", "user\n2969", False))
        assert len(session.transcript) == 1
        # The server force-closes a leaked garbled line with an empty final:
        # the streamed partials must not stand.
        await _inject(session, _delta("ASSISTANT", "", True))
        assert session.transcript == ()

    asyncio.run(scenario())


def test_blank_deltas_never_open_a_bubble() -> None:
    async def scenario() -> None:
        session = await _session()
        await _inject(
            session,
            _delta("ASSISTANT", "", True),
            _delta("USER", "   ", False),
        )
        assert session.transcript == ()

    asyncio.run(scenario())


def test_final_with_no_open_bubble_lands_as_its_own_closed_item() -> None:
    async def scenario() -> None:
        session = await _session()
        # Silent-session shape: the endpoint commits a chunk, the model's late
        # final carries only the remaining suffix — each is a complete final.
        await _inject(
            session,
            _delta("USER", "Schedule the meeting", True),
            _delta("USER", "for tomorrow at nine.", True),
        )
        assert _bare(session.transcript) == [
            ("user", "Schedule the meeting", True),
            ("user", "for tomorrow at nine.", True),
        ]

    asyncio.run(scenario())


def test_turn_complete_closes_a_dangling_open_bubble() -> None:
    async def scenario() -> None:
        session = await _session()
        await _inject(
            session,
            _delta("ASSISTANT", "What the caller heard", False),
            _turn_complete("ASSISTANT"),
        )
        assert _bare(session.transcript) == [("assistant", "What the caller heard", True)]

    asyncio.run(scenario())


def test_stream_yields_transcript_updated_after_each_fold() -> None:
    async def scenario() -> None:
        session = await _session()
        await _inject(session, _delta("USER", "One", False))
        delta = await asyncio.wait_for(session.__anext__(), timeout=1)
        updated = await asyncio.wait_for(session.__anext__(), timeout=1)
        assert delta.text == "One"
        assert isinstance(updated, TranscriptUpdatedEvent)
        assert updated.items == session.transcript
        assert _bare(updated.items) == [("user", "One", False)]

    asyncio.run(scenario())


def test_send_text_echo_folds_in_and_transcript_false_keeps_it_out() -> None:
    async def scenario() -> None:
        session = await _session()
        await session.send_text("typed question")
        await session.send_text("off the record", transcript=False)
        assert _bare(session.transcript) == [("user", "typed question", True)]
        assert session.transcript[0].role is TranscriptRole.USER

    asyncio.run(scenario())


def test_send_text_lands_as_its_own_turn_and_never_touches_open_speech() -> None:
    async def scenario() -> None:
        session = await _session()
        # The mic is live: the user's speech transcription is still open.
        await _inject(session, _delta("USER", "I was saying something", False))
        await session.send_text("typed question")
        assert _bare(session.transcript) == [
            ("user", "I was saying something", False),
            ("user", "typed question", True),
        ]
        # The speech turn's real final still closes its own bubble, in
        # place — chronological order by turn start, no duplicate item.
        await _inject(session, _delta("USER", "I was saying something important", True))
        assert _bare(session.transcript) == [
            ("user", "I was saying something important", True),
            ("user", "typed question", True),
        ]

    asyncio.run(scenario())


def test_deltas_keep_folding_into_the_open_bubble_behind_a_typed_turn() -> None:
    async def scenario() -> None:
        session = await _session()
        await _inject(session, _delta("USER", "Hel", False))
        await session.send_text("typed")
        await _inject(session, _delta("USER", "lo there", False))
        assert _bare(session.transcript) == [
            ("user", "Hello there", False),
            ("user", "typed", True),
        ]
        await _inject(session, _turn_complete("USER"))
        assert _bare(session.transcript) == [
            ("user", "Hello there", True),
            ("user", "typed", True),
        ]

    asyncio.run(scenario())


def test_end_closes_open_bubbles_and_transcript_survives() -> None:
    async def scenario() -> None:
        session = await _session()
        await _inject(session, _delta("ASSISTANT", "Goodbye th", False))
        await session.end()
        events = [event async for event in session]
        # The closing update lands before the terminal ended event.
        assert isinstance(events[-1], SessionEndedEvent)
        closing = events[-2]
        assert isinstance(closing, TranscriptUpdatedEvent)
        assert _bare(closing.items) == [("assistant", "Goodbye th", True)]
        assert _bare(session.transcript) == [("assistant", "Goodbye th", True)]

    asyncio.run(scenario())
