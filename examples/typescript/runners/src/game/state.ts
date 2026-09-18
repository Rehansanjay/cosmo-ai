/**
 * Canonical game state, owned by the page. The agent's tools mutate it, the
 * board renders it, and the PreToolUse guard reads it. Every mutator
 * revalidates the phase itself and returns a failure rather than throwing,
 * so an illegal call is refused identically whether or not a guard caught it.
 */

import { atRisk, bustProbability } from './bot';
import {
  bank,
  clearRunners,
  describeOption,
  HEIGHT,
  columnsWon,
  COLUMNS_TO_WIN,
  type Dice,
  enumerateOptions,
  initialPosition,
  type PlayerId,
  type PlayOption,
  type Position,
  rollDice,
  winner,
} from './rules';

/**
 * `awaiting_roll` — the dice are free and, with runners out, so is stopping.
 * `awaiting_choice` — a roll is on the table and must be resolved first.
 */
export type Phase =
  | { kind: 'awaiting_roll'; turn: PlayerId }
  | { kind: 'awaiting_choice'; turn: PlayerId; dice: Dice; options: PlayOption[] }
  | { kind: 'game_over'; winner: PlayerId };

export type GameState = {
  position: Position;
  phase: Phase;
  /** Newest first, for the sidebar. */
  log: string[];
};

export type RollResult =
  | { ok: false; reason: string }
  | { ok: true; dice: Dice; bust: true }
  | { ok: true; dice: Dice; bust: false; options: PlayOption[] };

export type ChooseResult =
  | { ok: false; reason: string }
  | { ok: true; sums: readonly number[] };

export type StopResult =
  | { ok: false; reason: string }
  | { ok: true; columnsClosed: number[]; won: boolean };

const OTHER: Record<PlayerId, PlayerId> = { p1: 'p2', p2: 'p1' };

/** Who fills a seat. The agent only ever commentates, so it is not one. */
export type Controller = 'human' | 'bot';

export type Seats = Record<PlayerId, { label: string; by: Controller }>;

export const DEFAULT_SEATS: Seats = {
  p1: { label: 'You', by: 'human' },
  p2: { label: 'Cosmo', by: 'bot' },
};

export class GameStore {
  private state: GameState = {
    position: initialPosition(),
    phase: { kind: 'awaiting_roll', turn: 'p1' },
    log: [],
  };
  private listeners = new Set<() => void>();

  constructor(readonly seats: Seats = DEFAULT_SEATS) {}

  label(player: PlayerId): string {
    return this.seats[player].label;
  }

  controller(player: PlayerId): Controller {
    return this.seats[player].by;
  }

  getState(): GameState {
    return this.state;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Whose turn it is, or null once someone has won. */
  turn(): PlayerId | null {
    return this.state.phase.kind === 'game_over' ? null : this.state.phase.turn;
  }

  canStop(player: PlayerId): boolean {
    const { phase, position } = this.state;
    return phase.kind === 'awaiting_roll' && phase.turn === player && position.runners.size > 0;
  }

  /**
   * Roll four dice for `player`. A roll with no legal play is a bust: the
   * runners come off and the turn passes in the same transition, so there is
   * no intermediate state in which a busted turn can still be banked.
   */
  roll(player: PlayerId): RollResult {
    const { phase, position } = this.state;
    if (phase.kind === 'game_over') return { ok: false, reason: 'The game is over.' };
    if (phase.turn !== player) return { ok: false, reason: 'It is not your turn.' };
    if (phase.kind === 'awaiting_choice') {
      return { ok: false, reason: 'You already have dice on the table — play them first.' };
    }

    const dice = rollDice();
    const options = enumerateOptions(dice, position, player);

    if (options.length === 0) {
      const lost = [...position.runners.keys()].sort((a, b) => a - b);
      this.set({
        ...this.state,
        position: clearRunners(position),
        phase: { kind: 'awaiting_roll', turn: OTHER[player] },
        log: this.entry(
          `${this.label(player)} busted on ${dice.join('-')}${
            lost.length > 0 ? `, losing ${lost.join(', ')}` : ''
          }.`,
        ),
      });
      return { ok: true, dice, bust: true };
    }

    this.set({
      ...this.state,
      phase: { kind: 'awaiting_choice', turn: player, dice, options },
      log: this.entry(`${this.label(player)} rolled ${dice.join('-')}.`),
    });
    return { ok: true, dice, bust: false, options };
  }

  /** Take one of the options the current roll offered, by zero-based index. */
  choose(player: PlayerId, index: number): ChooseResult {
    const { phase } = this.state;
    if (phase.kind !== 'awaiting_choice' || phase.turn !== player) {
      return { ok: false, reason: 'There is no roll of yours waiting to be played.' };
    }
    const option = phase.options[index];
    if (option === undefined) {
      return {
        ok: false,
        reason: `This roll offers options 1–${phase.options.length}.`,
      };
    }
    this.set({
      ...this.state,
      position: { ...this.state.position, runners: option.runners },
      phase: { kind: 'awaiting_roll', turn: player },
      log: this.entry(`${this.label(player)} advanced ${option.sums.join(' and ')}.`),
    });
    return { ok: true, sums: option.sums };
  }

  /** Bank the runners and pass the turn. */
  stop(player: PlayerId): StopResult {
    if (!this.canStop(player)) {
      const { phase } = this.state;
      if (phase.kind === 'awaiting_choice' && phase.turn === player) {
        return { ok: false, reason: 'Play the dice on the table before you stop.' };
      }
      return {
        ok: false,
        reason: 'You have nothing to bank — you must advance at least once first.',
      };
    }

    const before = this.state.position;
    const position = bank(before, player);
    const closed = columnsWon(position.claims, player).filter(
      (c) => before.claims[c] === undefined,
    );
    const champion = winner(position.claims);

    this.set({
      position,
      phase:
        champion === null
          ? { kind: 'awaiting_roll', turn: OTHER[player] }
          : { kind: 'game_over', winner: champion },
      log: this.entry(
        `${this.label(player)} stopped${closed.length > 0 ? `, closing ${closed.join(', ')}` : ''}.` +
          (champion === null ? '' : ` ${this.label(champion)} wins!`),
      ),
    });
    return { ok: true, columnsClosed: closed, won: champion === player };
  }

  /** A compact position summary the agent can be handed as context. */
  summary(): string {
    const { position } = this.state;
    const line = (player: PlayerId): string => {
      const won = columnsWon(position.claims, player);
      const climbed = Object.entries(position.progress[player])
        .filter(([, h]) => h > 0)
        .map(([col, h]) => `${col}@${h}`);
      return (
        `${this.label(player)}: ${won.length}/${COLUMNS_TO_WIN} columns` +
        `${won.length > 0 ? ` (${won.join(', ')})` : ''}` +
        `${climbed.length > 0 ? `, progress ${climbed.join(' ')}` : ''}`
      );
    };
    const runners = [...position.runners.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([col, h]) => `${col}@${h}`);
    return (
      `${line('p1')}. ${line('p2')}.` +
      ` Runners: ${runners.length > 0 ? runners.join(' ') : 'none'}.`
    );
  }

  /**
   * The position in one line — enough to answer "what should I take?" without
   * burying the news it rides with. The full `situation()` goes on the silent
   * channel; this is what an event carries.
   */
  brief(): string {
    const { phase, position } = this.state;
    if (phase.kind === 'game_over') return `${this.label(phase.winner)} has won.`;

    const runners = [...position.runners.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([col, h]) => `${col}@${h}`)
      .join(' ');
    const parts = [`${this.label(phase.turn)} to play.`];
    parts.push(runners === '' ? 'No runners out.' : `Runners ${runners}.`);
    if (position.runners.size > 0) {
      parts.push(`${Math.round(bustProbability(position, phase.turn) * 100)}% to bust.`);
    }
    if (phase.kind === 'awaiting_choice') {
      parts.push(
        `Dice ${phase.dice.join('-')} unplayed — options: ` +
          `${phase.options.map(describeOption).join(' / ')}.`,
      );
    }
    return parts.join(' ');
  }

  /**
   * The whole position in words, including the dice still on the table and
   * what each unplayed option would do. Pushed as context rather than as a
   * turn, so it is simply *there* when someone asks "where am I?" — the agent
   * answers from the live board instead of from whatever it last overheard.
   */
  situation(): string {
    const { phase, position } = this.state;
    if (phase.kind === 'game_over') {
      return `The game is over. ${this.label(phase.winner)} won. ${this.summary()}`;
    }

    const who = this.label(phase.turn);
    const lines = [`It is ${who} to play.`, this.summary()];

    if (position.runners.size > 0) {
      const risk = atRisk(position, phase.turn);
      const bust = Math.round(bustProbability(position, phase.turn) * 100);
      const closing = [...position.runners.entries()]
        .filter(([col, h]) => h >= HEIGHT[col])
        .map(([col]) => col);
      // Phrased around the seat label rather than after it: the label may be
      // "You", and "You has 2 squares" is what the model would otherwise read.
      lines.push(
        `Riding on this turn for ${who}: ${risk} square${risk === 1 ? '' : 's'}, ` +
          `busting on ${bust}% of rolls from here.` +
          (closing.length > 0
            ? ` Stopping now would close column ${closing.join(', ')}.`
            : ' Stopping now banks the runners where they stand.'),
      );
    } else {
      lines.push(`Nothing at risk yet for ${who}, and a roll is required before stopping.`);
    }

    if (phase.kind === 'awaiting_choice') {
      const choices = phase.options.map((option, i) => {
        const lands = [...option.runners.entries()]
          .sort((a, b) => a[0] - b[0])
          .map(([col, h]) => `${col} at ${h}/${HEIGHT[col]}`)
          .join(', ');
        return `${i + 1}) play ${describeOption(option)} — runners would be ${lands}`;
      });
      lines.push(
        `The dice are ${phase.dice.join('-')}, not yet played. Options open to ${who}: ` +
          `${choices.join('; ')}.`,
      );
    } else {
      lines.push(`No dice are on the table; ${who} may roll or stop.`);
    }

    return lines.join(' ');
  }

  private entry(message: string): string[] {
    return [message, ...this.state.log].slice(0, 40);
  }

  private set(next: GameState): void {
    this.state = next;
    for (const listener of this.listeners) listener();
  }
}
