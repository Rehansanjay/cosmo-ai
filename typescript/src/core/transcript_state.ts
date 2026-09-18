/**
 * Session-owned coalesced transcript.
 *
 * The engine folds the normalized transcript stream into a list of turn
 * items so consumers read state (``RealtimeSession.transcript`` /
 * ``transcript_updated``) instead of implementing the wire's folding
 * rules. Folding here, with the whole event stream in view, is what makes
 * the carve-outs handleable at all: an empty final retracts a leaked
 * turn, a ``turn-complete`` closes a line whose final was skipped
 * server-side, and a final arriving with no open bubble (a silent
 * session's committed chunk, a ``sendText`` echo) lands as its own
 * closed item.
 *
 * Coalescing is by the most recent still-open bubble for the delta's
 * role — robust to barge-in interleaving and to turn boundaries landing
 * between a turn's partials and its final. There is at most one open
 * bubble per role at a time.
 */

import type { TranscriptItem } from './events';

function mintId(): string {
  return typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `t-${Math.random().toString(36).slice(2)}-${Date.now().toString(36)}`;
}

function isBlank(text: string): boolean {
  return text.trim().length === 0;
}

export class TranscriptStore {
  private items: TranscriptItem[] = [];
  /** Snapshot handed to consumers; a fresh array per change so the
   *  reference is stable between changes and never aliases the
   *  internal working array. */
  private snapshot: readonly TranscriptItem[] = [];

  get current(): readonly TranscriptItem[] {
    return this.snapshot;
  }

  /** Index of the role's open bubble, or -1 when none. At most one open
   *  bubble per role exists, but it is not necessarily the role's most
   *  recent item — a ``sendText`` echo lands as a closed item after a
   *  still-transcribing speech turn — so closed items are skipped, not
   *  treated as "that turn is done, stop looking". */
  private openIndex(role: TranscriptItem['role']): number {
    for (let i = this.items.length - 1; i >= 0; i--) {
      const item = this.items[i];
      if (item === undefined || item.role !== role || item.isFinal) continue;
      return i;
    }
    return -1;
  }

  private publish(): void {
    this.snapshot = [...this.items];
  }

  /** Fold one transcript delta. Returns whether the transcript changed. */
  applyDelta(role: TranscriptItem['role'], text: string, isFinal: boolean): boolean {
    const idx = this.openIndex(role);
    const entry = idx === -1 ? undefined : this.items[idx];
    if (entry !== undefined) {
      if (isFinal) {
        // The final is the authoritative turn text: replace the
        // accumulation. An empty final retracts the turn — the server
        // sends one only when streamed partials must not stand (a
        // suppressed/garbled line).
        if (isBlank(text)) this.items.splice(idx, 1);
        else this.items[idx] = { ...entry, text, isFinal: true };
      } else {
        if (text.length === 0) return false;
        this.items[idx] = { ...entry, text: entry.text + text };
      }
      this.publish();
      return true;
    }
    // No open bubble. A blank delta must not open one (it would render
    // as an empty bubble); a non-blank final with no open bubble is a
    // complete turn in one event and lands closed.
    if (isBlank(text)) return false;
    this.items.push({ id: mintId(), role, text, isFinal });
    this.publish();
    return true;
  }

  /** Append a complete turn of its own — the ``sendText`` echo. Never
   *  folds into or closes an open bubble: typed text is not part of an
   *  in-progress speech turn, whose deltas keep folding into their own
   *  bubble. Returns whether the transcript changed. */
  appendClosed(role: TranscriptItem['role'], text: string): boolean {
    if (isBlank(text)) return false;
    this.items.push({ id: mintId(), role, text, isFinal: true });
    this.publish();
    return true;
  }

  /** Close the role's dangling open bubble, if any. The normal path
   *  closes bubbles on their final; this catches a line whose final the
   *  server skipped (already-committed silent-session text), which would
   *  otherwise merge into the next turn. */
  applyTurnComplete(role: TranscriptItem['role']): boolean {
    const idx = this.openIndex(role);
    if (idx === -1) return false;
    const entry = this.items[idx];
    if (entry === undefined) return false;
    if (isBlank(entry.text)) this.items.splice(idx, 1);
    else this.items[idx] = { ...entry, isFinal: true };
    this.publish();
    return true;
  }

  /** Close every still-open bubble; runs at session teardown so the
   *  surviving transcript holds no forever-open turns. */
  closeOpen(): boolean {
    let changed = false;
    for (let i = this.items.length - 1; i >= 0; i--) {
      const item = this.items[i];
      if (item === undefined || item.isFinal) continue;
      if (isBlank(item.text)) this.items.splice(i, 1);
      else this.items[i] = { ...item, isFinal: true };
      changed = true;
    }
    if (changed) this.publish();
    return changed;
  }
}
