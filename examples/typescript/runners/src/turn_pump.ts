import type { RealtimeSession } from 'cosmo-ai';

import type { GameStore } from './game/state';
import { Sender, type SenderEvent } from './sender';

/** A burst of clicks should read as one moment, not six interruptions. */
const SETTLE_MS = 1_100;
/** A turn ending is the beat worth reacting to — do not sit on it. */
const NOW_MS = 250;

/**
 * The game's half of the commentary loop: what happened, and whether it is
 * worth a word. `Sender` owns how it reaches the model.
 *
 * The position streams silently on every change, so the agent can always
 * answer "where am I?" from the real board. Speech is asked for on turn
 * endings, and otherwise left to the beat.
 */
export class TurnPump {
  private readonly sender: Sender;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;
  /** The position as of the last line it volunteered. */
  private lastCalled = '';

  constructor(
    private readonly store: GameStore,
    onEvent?: (event: SenderEvent) => void,
  ) {
    this.sender = new Sender(null, {
      onEvent,
      onBeatDue: () => this.callTheState(),
      // A question is probably coming; make sure it can be answered from the
      // real board. Silent, so it costs nobody the floor, and once per
      // utterance rather than once per move — which is what made a streamed
      // board pile up and go stale.
      onUserSpeaks: () => this.sender.sendState(`[board] ${this.store.situation()}`),
    });
  }

  attach(session: RealtimeSession | null): void {
    // No opening line from here: `greeting` on the agent config already makes
    // it introduce itself, and asking as well got the table greeted twice.
    this.sender.attach(session);
  }

  /** Record what happened. `beat` marks a turn ending — worth speaking for. */
  note(text: string, beat = false): void {
    if (this.stopped) return;
    this.sender.note(text);
    this.schedule(beat ? NOW_MS : SETTLE_MS);
  }

  dispose(): void {
    this.stopped = true;
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    this.sender.dispose();
  }

  private schedule(ms: number): void {
    if (this.stopped) return;
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      if (this.stopped) return;
      this.lastCalled = this.store.situation();
      // One line of board, not the whole position: the silent channel is
      // buffered while the agent talks, so the news has to carry enough to
      // answer "what should I take?" — but a full dump drowns the news.
      this.sender.speak(
        `Board: ${this.store.brief()} That is the table reporting what just ` +
          'happened — nobody spoke to you. If a BUST is mentioned, that is ' +
          'the story: lead with it. React in ONE sentence, ten words or ' +
          'fewer. Only use numbers written above.',
      );
    }, ms);
  }

  /**
   * The commentator's own turn to talk, with the position inline rather than
   * relying on it having remembered the silent channel. Only when the board
   * has actually moved — the beat is permission to speak, not an obligation,
   * and an idle game must not be narrated every few seconds.
   */
  private callTheState(): void {
    if (this.stopped) return;
    // News outranks filler. Something has happened and is about to be said
    // properly; the beat must not swallow it and deliver it as scenery.
    if (this.sender.pending() > 0) return;
    const { phase } = this.store.getState();
    if (phase.kind === 'game_over') return;
    const situation = this.store.situation();
    if (situation === this.lastCalled) return;
    this.lastCalled = situation;
    this.sender.speak(
      `Where things stand: ${situation} Nobody asked you anything. Call the ` +
        'state of play in ONE sentence, ten words or fewer — the single thing ' +
        'worth noticing. Only use numbers written above.',
    );
  }
}
