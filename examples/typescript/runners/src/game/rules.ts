/**
 * The rules engine: pure functions over a position, no React and no SDK.
 * Everything that decides what is legal lives here, so the tools, the guard
 * and the board all reason from one implementation.
 */

export const COLUMNS = [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12] as const;

/** Squares in each column — the classic pyramid, longest at 7. */
export const HEIGHT: Readonly<Record<number, number>> = {
  2: 3,
  3: 5,
  4: 7,
  5: 9,
  6: 11,
  7: 13,
  8: 11,
  9: 9,
  10: 7,
  11: 5,
  12: 3,
};

export const MAX_RUNNERS = 3;
export const COLUMNS_TO_WIN = 3;

export type PlayerId = 'p1' | 'p2';

/** How far each player has permanently climbed, per column. */
export type Progress = Record<number, number>;

/** Column number to the player who closed it. */
export type Claims = Record<number, PlayerId | undefined>;

/** The three neutral markers: column to the square they stand on. */
export type Runners = ReadonlyMap<number, number>;

export type Position = {
  progress: Record<PlayerId, Progress>;
  claims: Claims;
  runners: Runners;
};

export type Dice = readonly [number, number, number, number];

/**
 * One legal way to play the roll: the sums to advance, in order, and the
 * runners that result. `sums` has two entries when both halves of a pairing
 * are playable together — that combination is forced over either half alone.
 */
export type PlayOption = {
  sums: readonly number[];
  runners: Runners;
};

export function emptyProgress(): Progress {
  return Object.fromEntries(COLUMNS.map((c) => [c, 0]));
}

export function initialPosition(): Position {
  return {
    progress: { p1: emptyProgress(), p2: emptyProgress() },
    claims: {},
    runners: new Map(),
  };
}

export function rollDice(): Dice {
  const d = () => 1 + Math.floor(Math.random() * 6);
  return [d(), d(), d(), d()];
}

/** The three ways to split four dice into two pairs. */
const PAIRINGS: readonly (readonly [number, number, number, number])[] = [
  [0, 1, 2, 3],
  [0, 2, 1, 3],
  [0, 3, 1, 2],
];

/**
 * Where a runner would stand if `player` put one on `sum` right now: their
 * permanent progress is the floor a fresh runner starts from.
 */
function currentHeight(runners: Runners, progress: Progress, sum: number): number {
  const standing = runners.get(sum);
  return standing === undefined ? (progress[sum] ?? 0) : standing;
}

/**
 * Advance one sum, or return null when it cannot be played: the column is
 * closed, all three runners are committed elsewhere, or this one is already
 * on the top square.
 */
function advance(
  runners: Runners,
  progress: Progress,
  claims: Claims,
  sum: number,
): Runners | null {
  if (claims[sum] !== undefined) return null;
  const standing = runners.has(sum);
  if (!standing && runners.size >= MAX_RUNNERS) return null;
  const from = currentHeight(runners, progress, sum);
  if (from >= HEIGHT[sum]) return null;
  const next = new Map(runners);
  next.set(sum, from + 1);
  return next;
}

/** A stable identity for a resulting runner layout, for de-duplication. */
function signature(runners: Runners): string {
  return [...runners.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([col, h]) => `${col}:${h}`)
    .join(',');
}

/**
 * Every distinct legal play for this roll. A pairing whose two sums both fit
 * yields exactly one option that plays both — you may not decline half of a
 * playable pair. When they do not both fit (typically the last free runner),
 * each half that fits on its own stands as its own option and the player
 * picks. An empty result is a bust.
 */
export function enumerateOptions(
  dice: Dice,
  position: Position,
  player: PlayerId,
): PlayOption[] {
  const { runners, claims } = position;
  const progress = position.progress[player];
  const options: PlayOption[] = [];
  const seen = new Set<string>();

  const offer = (sums: readonly number[], result: Runners): void => {
    const key = `${sums.length}|${signature(result)}`;
    if (seen.has(key)) return;
    seen.add(key);
    options.push({ sums, runners: result });
  };

  for (const [i, j, k, l] of PAIRINGS) {
    const a = dice[i] + dice[j];
    const b = dice[k] + dice[l];

    // Both halves together, when the pair survives being played in sequence.
    const first = advance(runners, progress, claims, a);
    const both = first === null ? null : advance(first, progress, claims, b);
    if (both !== null) {
      offer([a, b], both);
      continue;
    }

    // Otherwise each half that stands alone is a separate choice.
    for (const sum of a === b ? [a] : [a, b]) {
      const single = advance(runners, progress, claims, sum);
      if (single !== null) offer([sum], single);
    }
  }

  return options;
}

/**
 * Commit the runners: each becomes permanent progress, and one standing on a
 * column's top square closes it.
 */
export function bank(position: Position, player: PlayerId): Position {
  const progress = { ...position.progress[player] };
  const claims = { ...position.claims };
  for (const [col, height] of position.runners) {
    progress[col] = height;
    if (height >= HEIGHT[col]) claims[col] = player;
  }
  return {
    progress: { ...position.progress, [player]: progress },
    claims,
    runners: new Map(),
  };
}

/** Drop the runners — a busted turn banks nothing. */
export function clearRunners(position: Position): Position {
  return { ...position, runners: new Map() };
}

export function columnsWon(claims: Claims, player: PlayerId): number[] {
  return COLUMNS.filter((c) => claims[c] === player);
}

export function winner(claims: Claims): PlayerId | null {
  for (const player of ['p1', 'p2'] as const) {
    if (columnsWon(claims, player).length >= COLUMNS_TO_WIN) return player;
  }
  return null;
}

/** How the option reads to a person: "6 and 8", or "7 twice". */
export function describeOption(option: PlayOption): string {
  const [a, b] = option.sums;
  if (b === undefined) return `${a}`;
  return a === b ? `${a} twice` : `${a} and ${b}`;
}
