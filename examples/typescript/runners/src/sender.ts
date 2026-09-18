import type { RealtimeSession, Unsubscribe } from 'cosmo-ai';

/**
 * Talking to a live agent, in the two ways the transport allows.
 *
 * - `sendContext` creates a conversation item and stops. The model is never
 *   asked for a reply, so this can fire mid-sentence and interrupts nobody.
 *   Live state goes here, continuously.
 * - `sendText` creates an item *and* asks for a response. It reads as a
 *   finished user utterance, so it ends whoever is talking. Speech is asked
 *   for through this, and only when there is something to say.
 *
 * Sends wait for a gap — the agent finishing, or you finishing — and the delta
 * keeps growing meanwhile, so holding longer just means the eventual line
 * covers more ground. It is a best effort, not a guarantee: `agent_state`
 * arrives after the fact, so a send can still collide with speech that began
 * in between.
 */

export type SenderEvent = {
  kind: 'state' | 'noted' | 'spoke' | 'held' | 'skipped';
  detail: string;
};

export type SenderOptions = {
  /** Every decision, for anyone who wants to watch it work. */
  onEvent?: (event: SenderEvent) => void;
  /**
   * Appended to whatever is said. Notes ride the same channel as the person's
   * voice, so without a line telling the model these are events rather than
   * speech, it answers them as if someone had spoken.
   */
  frame?: string;
  /** The agent may volunteer a line. The caller decides what about. */
  onBeatDue?: () => void;
  /**
   * Someone has started speaking. Fired on the leading edge only, so it is a
   * cue to refresh the agent's picture of the world before the question
   * arrives — not once per syllable.
   */
  onUserSpeaks?: () => void;
};

/** How often the commentator may volunteer something unprompted. */
const BEAT_MS = 4_000;
/** How long one interim transcript keeps the floor yours. `agent_state` says
 *  `listening` both mid-sentence and in silence, so it cannot tell us. */
const USER_TAIL_MS = 1_200;
/** How soon to look again once the floor is busy. */
const RETRY_MS = 300;
/** Longest anything waits for a gap, whatever is holding it.
 *
 *  A quiet room rarely reaches this. A noisy one reaches it every time, because
 *  each stray fragment re-arms the floor faster than it clears — so this is not
 *  a rare fallback, it is the normal latency wherever the microphone hears more
 *  than one person. Long enough to sit through a sentence, short enough that
 *  waiting is not what someone notices. */
const MAX_HOLD_MS = 2_500;
/** How long a sent line holds the floor before `agent_state` catches up. */
const IN_FLIGHT_MS = 3_000;

export class Sender {
  private session: RealtimeSession | null = null;
  private unsubscribe: Unsubscribe | null = null;
  private agentBusy = false;

  /** What has happened since it last spoke. */
  private delta: string[] = [];
  private lastState = '';

  private userUntil = 0;
  /** They asked something and have not been answered. Sending now would take
   *  the turn their question earned and answer the game instead. */
  private owed = false;
  /** When the outstanding question was asked, and when the current speaking
   *  run began. A line already in progress cannot be the answer to something
   *  said after it started. */
  private owedAt = 0;
  private speakingSince = 0;
  private waiting: string | undefined;
  private wants = false;
  private heldSince = 0;
  private inFlightUntil = 0;
  private retry: ReturnType<typeof setTimeout> | null = null;
  private beat: ReturnType<typeof setInterval> | null = null;
  private stopped = false;
  private readonly onEvent: (event: SenderEvent) => void;
  private readonly frame: string;
  private readonly onBeatDue: (() => void) | null;
  private readonly onUserSpeaks: (() => void) | null;

  constructor(session: RealtimeSession | null = null, options: SenderOptions = {}) {
    this.onEvent = options.onEvent ?? (() => {});
    this.frame = options.frame ?? '';
    this.onBeatDue = options.onBeatDue ?? null;
    this.onUserSpeaks = options.onUserSpeaks ?? null;
    this.beat = setInterval(() => this.onBeat(), BEAT_MS);
    this.attach(session);
  }

  attach(session: RealtimeSession | null): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.session = session;
    this.agentBusy = false;
    this.userUntil = 0;
    this.owed = false;
    this.speakingSince = 0;
    this.owedAt = 0;
    this.inFlightUntil = 0;
    // A new session has never been told the board, whatever the old one knew.
    this.lastState = '';
    if (session === null) return;
    // Anything asked for while disconnected is still owed.
    if (this.wants) this.schedule(RETRY_MS);
    const offState = session.on('agent_state', (next) => {
      const was = this.agentBusy;
      this.agentBusy = next === 'speaking' || next === 'thinking';
      // It has reacted, so the floor speaks for itself from here.
      if (this.agentBusy) this.inFlightUntil = 0;
      if (next === 'speaking' && this.speakingSince === 0) {
        this.speakingSince = Date.now();
      }
      if (was && !this.agentBusy) {
        // Only speech that began *after* the question can be its answer. A
        // line already in progress finishing is not them being listened to.
        if (this.speakingSince > this.owedAt) this.owed = false;
        this.speakingSince = 0;
        this.schedule(RETRY_MS);
      }
    });
    const offVoice = session.on('transcript', (ev) => {
      if (ev.role !== 'user') return;
      const now = Date.now();
      // Leading edge only: the start of an utterance is when the agent's
      // picture of the world is worth refreshing, because a question is
      // probably coming.
      if (now >= this.userUntil) this.onUserSpeaks?.();
      // Any fragment means somebody is making noise, so hold briefly.
      this.userUntil = now + USER_TAIL_MS;
      // Only a finished utterance earns a reply. Interim fragments are mostly
      // the room, and treating each as a question mutes the game.
      if (!ev.isFinal) return;
      this.owed = true;
      this.owedAt = now;
    });
    this.unsubscribe = () => {
      offState();
      offVoice();
    };
  }

  /** True while either of them holds the floor, or a question is unanswered. */
  private busy(): boolean {
    if (this.agentBusy) return true;
    const now = Date.now();
    if (now < this.inFlightUntil) return true;
    if (now < this.userUntil) return true;
    if (!this.owed) return false;
    // A question nobody answers must not mute the game for good.
    if (now - this.owedAt >= MAX_HOLD_MS) {
      this.owed = false;
      return false;
    }
    return true;
  }

  /**
   * The current position. Silent and ungated — not a turn, never answered,
   * safe to send straight through a sentence.
   */
  sendState(text: string): void {
    if (this.stopped || this.session === null || text === this.lastState) return;
    const previous = this.lastState;
    this.lastState = text;
    this.onEvent({ kind: 'state', detail: `${text.length} chars` });
    this.session.sendContext(text).catch((err: unknown) => {
      console.error('[runners] state failed', err);
      // Un-dedupe, or a failed push means this board is never sent again.
      if (this.lastState === text) this.lastState = previous;
    });
  }

  /** Something happened. Recorded, not spoken. */
  note(text: string): void {
    this.delta.push(text);
    this.onEvent({ kind: 'noted', detail: `${this.delta.length} since it last spoke` });
  }

  /**
   * Ask for a line about everything noted since it last spoke. `instead`
   * replaces the standing frame — a beat asks a different question from an
   * event.
   */
  speak(instead?: string): void {
    // No session check: a note raised while disconnected is still owed, and
    // dropping it here stranded both the note and every later beat.
    if (this.stopped) return;
    // Reacting needs something to react to. Only a beat, which brings its own
    // question, may speak with nothing noted — otherwise a consumed delta
    // leaves "react to what just happened" with no what.
    if (this.delta.length === 0 && instead === undefined) return;
    if (!this.wants) this.heldSince = Date.now();
    this.wants = true;
    // The newest reason to speak decides the framing. Carrying a held beat's
    // question forward is how a bust got delivered as scenery.
    this.waiting = instead;
    this.flush();
  }

  private flush(): void {
    if (this.stopped || this.session === null || !this.wants) return;
    const forced = Date.now() - this.heldSince >= MAX_HOLD_MS;
    if (this.busy() && !forced) {
      this.onEvent({
        kind: 'held',
        detail: this.agentBusy
          ? 'agent still talking'
          : this.owed
            ? 'you asked something and have not been answered'
            : 'you are still talking',
      });
      this.schedule(RETRY_MS);
      return;
    }

    const frame = this.waiting ?? this.frame;
    const body = this.delta.join(' ');
    const said = frame === '' ? body : `${body} ${frame}`.trim();
    const sent = this.delta;
    this.delta = [];
    this.waiting = undefined;
    this.wants = false;
    if (said === '') return;

    this.inFlightUntil = Date.now() + IN_FLIGHT_MS;
    this.onEvent({
      kind: 'spoke',
      detail: `${said.length} chars${forced ? ' — forced past the wait' : ''}`,
    });
    this.session.sendText(said, { transcript: false }).catch((err: unknown) => {
      console.error('[runners] speak failed', err);
      // Put it back: clearing first means a dropped connection eats the line.
      this.inFlightUntil = 0;
      if (this.stopped) return;
      this.delta = [...sent, ...this.delta];
      this.wants = true;
      this.heldSince = Date.now();
      this.schedule(RETRY_MS);
    });
  }

  private schedule(ms: number): void {
    if (this.stopped) return;
    if (this.retry !== null) clearTimeout(this.retry);
    this.retry = setTimeout(() => {
      this.retry = null;
      this.flush();
    }, ms);
  }

  /** Noted and not yet spoken about. */
  pending(): number {
    return this.delta.length;
  }

  dispose(): void {
    this.stopped = true;
    this.unsubscribe?.();
    this.unsubscribe = null;
    if (this.beat !== null) clearInterval(this.beat);
    if (this.retry !== null) clearTimeout(this.retry);
    this.beat = null;
    this.retry = null;
  }

  /**
   * The commentator's own rhythm. Skipped whenever the floor is busy or news
   * is already queued — an unprompted remark is the first thing to give way.
   */
  private onBeat(): void {
    if (this.stopped || this.session === null || this.onBeatDue === null) return;
    if (this.busy() || this.wants) {
      this.onEvent({ kind: 'skipped', detail: 'floor busy, or news already queued' });
      return;
    }
    this.onBeatDue();
  }
}
