import { atRisk, bustProbability, chooseOption, shouldRollAgain } from './game/bot';
import { HEIGHT, type PlayerId } from './game/rules';
import type { GameStore } from './game/state';
import type { TurnPump } from './turn_pump';

/** Slow enough to watch a runner move; fast enough not to be a wait. */
const ROLL_MS = 850;
const CHOOSE_MS = 650;

/**
 * Drives the seats no person is holding. The engine decides instantly — the
 * delays exist purely so a human can follow what happened, not because
 * anything is being waited on.
 */
export class Match {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;

  constructor(
    private readonly store: GameStore,
    private readonly pump: TurnPump,
  ) {}

  /** Called after every board change; a no-op unless a bot is on the clock. */
  tick(): void {
    if (this.stopped || this.timer !== null) return;
    const turn = this.store.turn();
    if (turn === null || this.store.controller(turn) !== 'bot') return;

    const { phase } = this.store.getState();
    this.timer = setTimeout(
      () => {
        this.timer = null;
        this.step(turn);
      },
      phase.kind === 'awaiting_choice' ? CHOOSE_MS : ROLL_MS,
    );
  }

  dispose(): void {
    this.stopped = true;
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
  }

  private step(player: PlayerId): void {
    if (this.stopped || this.store.turn() !== player) return;
    const { phase, position } = this.store.getState();
    const who = this.store.label(player);

    if (phase.kind === 'awaiting_choice') {
      const index = chooseOption(phase.options, position, player);
      const result = this.store.choose(player, index);
      if (result.ok) {
        const topped = [...this.store.getState().position.runners.entries()]
          .filter(([col, h]) => h === HEIGHT[col] && result.sums.includes(col))
          .map(([col]) => col);
        const after = this.store.getState().position;
        const risk = Math.round(bustProbability(after, player) * 100);
        this.pump.note(
          `${who} took ${result.sums.join(' and ')} and is ${risk}% to bust from here.` +
            (topped.length > 0 ? ` A runner is on top of column ${topped.join(', ')}.` : ''),
        );
      }
      this.tick();
      return;
    }

    if (phase.kind !== 'awaiting_roll') return;

    if (!shouldRollAgain(position, player) && this.store.canStop(player)) {
      const result = this.store.stop(player);
      if (result.ok) {
        this.pump.note(
          `${who} stopped` +
            (result.columnsClosed.length > 0
              ? ` and closed column ${result.columnsClosed.join(', ')}`
              : '') +
            '.',
          true,
        );
      }
      this.tick();
      return;
    }

    const lost = atRisk(position, player);
    const result = this.store.roll(player);
    if (result.ok && !result.bust) {
      this.pump.note(`${who} rolled ${result.dice.join('-')}.`);
    }
    if (result.ok && result.bust) {
      this.pump.note(
        `BUST — ${who} pushed once too often, ${lost} square${lost === 1 ? '' : 's'} gone.`,
        true,
      );
    }
    this.tick();
  }
}
