"""Session-owned coalesced transcript.

The session folds its normalized transcript stream into a list of turn
items so consumers read state (:attr:`RealtimeSession.transcript` /
:class:`TranscriptUpdatedEvent`) instead of implementing the wire's
folding rules. Folding here, with the whole event stream in view, is what
makes the carve-outs handleable at all: an empty final retracts a leaked
turn, a ``turn-complete`` closes a line whose final was skipped
server-side, and a final arriving with no open bubble (a silent session's
committed chunk, a ``send_text`` echo) lands as its own closed item.

Coalescing is by the most recent still-open bubble for the delta's role —
robust to barge-in interleaving and to turn boundaries landing between a
turn's partials and its final. There is at most one open bubble per role
at a time. TypeScript's ``core/transcript_state.ts`` and Swift's
``TranscriptStore`` mirror these semantics.
"""

from __future__ import annotations

from uuid import uuid4

from cosmo_ai._internal.protocol import TranscriptItem, TranscriptRole


def _is_blank(text: str) -> bool:
    return not text.strip()


class TranscriptStore:
    def __init__(self) -> None:
        self._items: list[TranscriptItem] = []
        self._snapshot: tuple[TranscriptItem, ...] = ()

    @property
    def current(self) -> tuple[TranscriptItem, ...]:
        return self._snapshot

    def _open_index(self, role: TranscriptRole) -> int:
        """Index of the role's open bubble, or -1 when none. At most one open
        bubble per role exists, but it is not necessarily the role's most
        recent item — a ``send_text`` echo lands as a closed item after a
        still-transcribing speech turn — so closed items are skipped, not
        treated as "that turn is done, stop looking"."""
        for i in range(len(self._items) - 1, -1, -1):
            item = self._items[i]
            if item.role != role or item.is_final:
                continue
            return i
        return -1

    def _publish(self) -> None:
        self._snapshot = tuple(self._items)

    def apply_delta(self, role: TranscriptRole, text: str, is_final: bool) -> bool:
        """Fold one transcript delta. Returns whether the transcript changed."""
        idx = self._open_index(role)
        if idx != -1:
            entry = self._items[idx]
            if is_final:
                # The final is the authoritative turn text: replace the
                # accumulation. An empty final retracts the turn — the server
                # sends one only when streamed partials must not stand (a
                # suppressed/garbled line).
                if _is_blank(text):
                    del self._items[idx]
                else:
                    self._items[idx] = entry.model_copy(
                        update={"text": text, "is_final": True}
                    )
            else:
                if not text:
                    return False
                self._items[idx] = entry.model_copy(update={"text": entry.text + text})
            self._publish()
            return True
        # No open bubble. A blank delta must not open one (it would render as
        # an empty bubble); a non-blank final with no open bubble is a
        # complete turn in one event and lands closed.
        if _is_blank(text):
            return False
        self._items.append(
            TranscriptItem(id=str(uuid4()), role=role, text=text, is_final=is_final)
        )
        self._publish()
        return True

    def append_closed(self, role: TranscriptRole, text: str) -> bool:
        """Append a complete turn of its own — the ``send_text`` echo. Never
        folds into or closes an open bubble: typed text is not part of an
        in-progress speech turn, whose deltas keep folding into their own
        bubble. Returns whether the transcript changed."""
        if _is_blank(text):
            return False
        self._items.append(
            TranscriptItem(id=str(uuid4()), role=role, text=text, is_final=True)
        )
        self._publish()
        return True

    def apply_turn_complete(self, role: TranscriptRole) -> bool:
        """Close the role's dangling open bubble, if any. The normal path
        closes bubbles on their final; this catches a line whose final the
        server skipped (already-committed silent-session text), which would
        otherwise merge into the next turn."""
        idx = self._open_index(role)
        if idx == -1:
            return False
        entry = self._items[idx]
        if _is_blank(entry.text):
            del self._items[idx]
        else:
            self._items[idx] = entry.model_copy(update={"is_final": True})
        self._publish()
        return True

    def close_open(self) -> bool:
        """Close every still-open bubble; runs at session teardown so the
        surviving transcript holds no forever-open turns."""
        changed = False
        for i in range(len(self._items) - 1, -1, -1):
            item = self._items[i]
            if item.is_final:
                continue
            if _is_blank(item.text):
                del self._items[i]
            else:
                self._items[i] = item.model_copy(update={"is_final": True})
            changed = True
        if changed:
            self._publish()
        return changed
