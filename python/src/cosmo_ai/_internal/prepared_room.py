"""The reserved room behind ``PreparedSession``.

``POST session/prepare-room`` mints a room and join token ahead of any
session; the start joins the reserved room on its held token while its own
request is still in flight, and echoes the grant so the backend dispatches
the agent onto that room instead of allocating one.
"""

from __future__ import annotations

import time
from dataclasses import dataclass, field
from typing import Protocol, runtime_checkable

from cosmo_ai._internal.transport import TransportCallbacks

# The server's prepared join token and room both live 30 minutes; a room
# older than this is presumed lapsed and discarded rather than risking a join
# against a reclaimed room. Matches the Swift SDK's guard. A held reservation
# is renewed a minute before that, so the replacement lands while the old
# room is still good.
PREPARED_ROOM_MAX_AGE_S = 26 * 60
PREPARED_ROOM_REFRESH_S = PREPARED_ROOM_MAX_AGE_S - 60


@dataclass(frozen=True)
class PreparedRoom:
    """A room and join token minted before any session start."""

    livekit_url: str
    token: str
    room_name: str
    room_grant: str
    prepared_at: float = field(default_factory=time.monotonic)

    def is_stale(self) -> bool:
        return time.monotonic() - self.prepared_at > PREPARED_ROOM_MAX_AGE_S


@runtime_checkable
class PreparedJoinTransport(Protocol):
    """A transport that can join a room minted before the session start."""

    async def connect_prepared(
        self, prepared: PreparedRoom, callbacks: TransportCallbacks
    ) -> None: ...
