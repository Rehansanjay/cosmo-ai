import type { TranscriptItem } from './events';

/** What a hand-off was about, when the provider did not say.
 *
 *  GPT Live raises a hand-off mid-turn and does not always attach the user's
 *  words: measured on a live session, 3 of 15 carried an empty transcript.
 *  An application whose backend is handed only that string has nothing to act
 *  on, so the session's own transcript stands in — the last user turn is the
 *  one the hand-off is about.
 *
 *  Two rules keep the substitution honest. A hand-off resolves once, so both
 *  the callback and the stream see the same text for it. And a user turn
 *  stands in for at most one hand-off, so two blank hand-offs in a row never
 *  replay the same instruction. */
export class DelegationTranscripts {
  private readonly resolved = new Map<string, string>();
  private readonly spent = new Set<string>();

  resolve(
    delegationId: string,
    wireTranscript: string,
    items: readonly TranscriptItem[],
  ): string {
    const already = this.resolved.get(delegationId);
    if (already !== undefined) return already;
    // Every hand-off spends the turn it was about, whether the provider named
    // it or this did: otherwise a blank hand-off following one the provider
    // filled would stand the same turn in again and act on it twice.
    const latest = this.latestUserTurn(items);
    const fresh = latest !== null && !this.spent.has(latest.id);
    if (latest !== null) this.spent.add(latest.id);
    const transcript =
      wireTranscript.trim() === '' ? (fresh ? latest!.text : '') : wireTranscript;
    this.resolved.set(delegationId, transcript);
    return transcript;
  }

  private latestUserTurn(items: readonly TranscriptItem[]): TranscriptItem | null {
    for (let index = items.length - 1; index >= 0; index -= 1) {
      const item = items[index];
      if (item.role === 'user' && item.text.trim() !== '') return item;
    }
    return null;
  }
}
