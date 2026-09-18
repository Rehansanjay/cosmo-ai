/**
 * The opponent engine. Plain code, no model: it decides instantly, plays a
 * consistent game, and never stalls — which is what frees the agent to do
 * nothing but commentate.
 *
 * Bust odds are computed exactly against the live position rather than read
 * off a table, so closed columns and topped-out runners are accounted for as
 * the board changes.
 */

import {
  COLUMNS,
  COLUMNS_TO_WIN,
  columnsWon,
  type Dice,
  enumerateOptions,
  HEIGHT,
  MAX_RUNNERS,
  type PlayerId,
  type PlayOption,
  type Position,
} from './rules';

/** Every distinct roll of four dice, enumerated once. */
const ALL_ROLLS: Dice[] = (() => {
  const rolls: Dice[] = [];
  for (let a = 1; a <= 6; a++)
    for (let b = 1; b <= 6; b++)
      for (let c = 1; c <= 6; c++) for (let d = 1; d <= 6; d++) rolls.push([a, b, c, d]);
  return rolls;
})();

/**
 * Exact probability that the next roll has no legal play in this position.
 * Brute force over all 1296 rolls — cheap, and exact beats a heuristic table
 * that cannot see which columns are already closed.
 */
export function bustProbability(position: Position, player: PlayerId): number {
  let bust = 0;
  for (const dice of ALL_ROLLS) {
    if (enumerateOptions(dice, position, player).length === 0) bust++;
  }
  return bust / ALL_ROLLS.length;
}

/** Squares climbed above what is already banked — what a bust would cost. */
export function atRisk(position: Position, player: PlayerId): number {
  let risk = 0;
  for (const [col, height] of position.runners) {
    risk += height - (position.progress[player][col] ?? 0);
  }
  return risk;
}

/** How often a roll offers a given sum at all — 7 is common, 2 is rare. */
const REACH: Readonly<Record<number, number>> = (() => {
  const hits: Record<number, number> = {};
  for (const col of COLUMNS) hits[col] = 0;
  for (const dice of ALL_ROLLS) {
    const sums = new Set<number>();
    for (const [i, j, k, l] of [
      [0, 1, 2, 3],
      [0, 2, 1, 3],
      [0, 3, 1, 2],
    ]) {
      sums.add(dice[i] + dice[j]);
      sums.add(dice[k] + dice[l]);
    }
    for (const s of sums) if (hits[s] !== undefined) hits[s]++;
  }
  const reach: Record<number, number> = {};
  for (const col of COLUMNS) reach[col] = hits[col] / ALL_ROLLS.length;
  return reach;
})();

/**
 * What one square is worth. Every column is worth the same when finished, so
 * a square is a fraction of it — but a square you may never get the chance to
 * take again is worth less, not more, which is why this is scaled by how
 * often the sum comes up at all. Without that, the outside columns look like
 * bargains and the engine walks into 2-11-12 and busts.
 */
function columnWeight(col: number): number {
  return (13 / HEIGHT[col]) * REACH[col];
}

/**
 * Score a candidate play: squares gained at their column's worth, a large
 * bonus for topping a column, and a penalty for committing the last runner,
 * which fixes the bust odds for the rest of the turn.
 */
function scoreOption(option: PlayOption, position: Position, player: PlayerId): number {
  let score = 0;
  for (const [col, height] of option.runners) {
    const from = position.runners.get(col) ?? position.progress[player][col] ?? 0;
    const gained = height - from;
    if (gained > 0) score += gained * columnWeight(col);
    if (height >= HEIGHT[col]) score += 12;
  }
  const opened = option.runners.size - position.runners.size;
  if (opened > 0 && option.runners.size === MAX_RUNNERS) score -= 1.5;
  return score;
}

/** Which option to take. Ties break toward the more central runner set. */
export function chooseOption(
  options: PlayOption[],
  position: Position,
  player: PlayerId,
): number {
  let best = 0;
  let bestScore = -Infinity;
  options.forEach((option, i) => {
    const after = { ...position, runners: option.runners };
    // A play that leaves a safer board is worth real points; measuring it
    // needs the full position, so it happens here rather than in scoreOption.
    const safety = (1 - bustProbability(after, player)) * 4;
    const score = scoreOption(option, position, player) + safety;
    if (score > bestScore) {
      bestScore = score;
      best = i;
    }
  });
  return best;
}

/**
 * Whether to roll again. Compares what another roll is worth against what
 * busting would throw away, and overrides that arithmetic when stopping wins
 * the game outright or the opponent is one turn from doing so.
 */
export function shouldRollAgain(position: Position, player: PlayerId): boolean {
  if (position.runners.size === 0) return true;

  // Stopping now would take a third column — never gamble that away.
  const closing = [...position.runners.entries()].filter(([col, h]) => h >= HEIGHT[col]).length;
  const held = columnsWon(position.claims, player).length;
  if (held + closing >= COLUMNS_TO_WIN) return false;

  // Runners not all out yet: the turn has barely started and the downside is
  // still small, so keep placing them.
  if (position.runners.size < MAX_RUNNERS) return true;

  const bust = bustProbability(position, player);
  const risk = atRisk(position, player);
  // A surviving roll advances roughly two squares, weighted like the ones
  // already climbed.
  const gain = 2;
  const expected = (1 - bust) * gain - bust * risk;

  // Behind and running out of road: take worse odds rather than lose slowly.
  const opponent: PlayerId = player === 'p1' ? 'p2' : 'p1';
  const desperate = columnsWon(position.claims, opponent).length >= COLUMNS_TO_WIN - 1;
  return expected > (desperate ? -1.5 : 0);
}
