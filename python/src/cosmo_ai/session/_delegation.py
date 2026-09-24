"""What a hand-off was about, when the provider did not say.

GPT Live raises a hand-off mid-turn and does not always attach the user's
words: measured on a live session, 3 of 15 carried an empty transcript. An
application whose backend is handed only that string has nothing to act on, so
the session's own transcript stands in — the last user turn is the one the
hand-off is about.

Two rules keep the substitution honest. A hand-off resolves once, so every
surface sees the same text for it. And a user turn stands in for at most one
hand-off, so two blank hand-offs in a row never replay the same instruction.
"""

from collections.abc import Sequence

from cosmo_ai._internal.protocol import TranscriptItem, TranscriptRole


class DelegationTranscripts:
    def __init__(self) -> None:
        self._resolved: dict[str, str] = {}
        self._spent: set[str] = set()

    def resolve(
        self,
        delegation_id: str,
        wire_transcript: str,
        items: Sequence[TranscriptItem],
    ) -> str:
        already = self._resolved.get(delegation_id)
        if already is not None:
            return already
        # Every hand-off spends the turn it was about, whether the provider
        # named it or this did: otherwise a blank hand-off following one the
        # provider filled would stand the same turn in again and act on it
        # twice.
        latest = self._latest_user_turn(items)
        fresh = latest is not None and latest.id not in self._spent
        if latest is not None:
            self._spent.add(latest.id)
        if wire_transcript.strip() == "":
            transcript = latest.text if fresh and latest is not None else ""
        else:
            transcript = wire_transcript
        self._resolved[delegation_id] = transcript
        return transcript

    def _latest_user_turn(self, items: Sequence[TranscriptItem]) -> TranscriptItem | None:
        for item in reversed(items):
            if item.role is TranscriptRole.USER and item.text.strip() != "":
                return item
        return None
