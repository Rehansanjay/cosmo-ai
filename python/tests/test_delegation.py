from __future__ import annotations

import asyncio
import json

from cosmo_ai import DelegationCreatedEvent

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
