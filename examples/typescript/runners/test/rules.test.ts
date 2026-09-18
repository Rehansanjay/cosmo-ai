import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  bank,
  type Dice,
  enumerateOptions,
  HEIGHT,
  initialPosition,
  type Position,
  winner,
} from '../src/game/rules';
import { GameStore } from '../src/game/state';

/** Options rendered as sorted "sums" strings, for order-free comparison. */
function shapes(dice: Dice, position: Position, player: 'p1' | 'p2' = 'p1'): string[] {
  return enumerateOptions(dice, position, player)
    .map((o) => [...o.sums].sort((a, b) => a - b).join('+'))
    .sort();
}

function withRunners(entries: [number, number][], base = initialPosition()): Position {
  return { ...base, runners: new Map(entries) };
}

test('both halves of a playable pairing are forced together', () => {
  // 1-2-3-4 splits into 3|7, 4|6 and 5|5. With every runner free, each split
  // plays in full, so no single-sum option is offered.
  const found = shapes([1, 2, 3, 4], initialPosition());
  assert.deepEqual(found, ['3+7', '4+6', '5+5']);
});

test('doubles advance the same column twice', () => {
  const options = enumerateOptions([1, 4, 2, 3], initialPosition(), 'p1');
  const five = options.find((o) => o.sums.join('+') === '5+5');
  assert.ok(five, 'expected a 5+5 option');
  assert.equal(five.runners.get(5), 2);
  assert.equal(five.runners.size, 1, 'both fives share one runner');
});

test('with one runner left, two new columns become separate choices', () => {
  // The case a naive sequential model gets wrong: 3 and 7 are both legal on
  // their own but cannot both be taken, so the player picks — the engine must
  // not silently apply them in array order.
  const position = withRunners([
    [6, 1],
    [8, 1],
  ]);
  assert.deepEqual(shapes([1, 2, 3, 4], position), ['3', '4+6', '5+5', '7']);
});

test('a runner on the top square cannot advance', () => {
  // Column 2 is three tall; a runner already there is stuck.
  const position = withRunners([[2, HEIGHT[2]]]);
  const options = enumerateOptions([1, 1, 1, 1], position, 'p1');
  assert.deepEqual(options, [], 'only 2s available, and 2 is topped out');
});

test('a claimed column is closed to everyone', () => {
  const base = initialPosition();
  const position = { ...base, claims: { 2: 'p2' as const } };
  assert.deepEqual(enumerateOptions([1, 1, 1, 1], position, 'p1'), []);
});

test('a fresh runner starts from that player banked progress', () => {
  const base = initialPosition();
  base.progress.p1[2] = 1;
  const options = enumerateOptions([1, 1, 1, 1], base, 'p1');
  assert.equal(options.length, 1);
  assert.equal(options[0].runners.get(2), 3, '1 banked + two 2s this roll');
});

test('busting is an empty option list, not an exception', () => {
  // Three runners parked on the outside columns, and a roll that only makes 7s.
  const position = withRunners([
    [2, 1],
    [3, 1],
    [12, 1],
  ]);
  assert.deepEqual(enumerateOptions([3, 4, 3, 4], position, 'p1'), []);
});

test('banking writes runners in and closes a topped column', () => {
  const position = withRunners([
    [2, HEIGHT[2]],
    [7, 4],
  ]);
  const after = bank(position, 'p1');
  assert.equal(after.claims[2], 'p1');
  assert.equal(after.progress.p1[2], HEIGHT[2]);
  assert.equal(after.progress.p1[7], 4);
  assert.equal(after.claims[7], undefined, 'mid-column progress claims nothing');
  assert.equal(after.runners.size, 0);
});

test('three columns wins', () => {
  assert.equal(winner({ 2: 'p2', 3: 'p2' }), null);
  assert.equal(winner({ 2: 'p2', 3: 'p2', 12: 'p2' }), 'p2');
  assert.equal(winner({ 2: 'p2', 3: 'p1', 12: 'p2' }), null);
});

test('the store refuses a second roll while dice are on the table', () => {
  const store = new GameStore();
  const first = store.roll('p1');
  assert.equal(first.ok, true);
  if (first.ok && !first.bust) {
    const second = store.roll('p1');
    assert.equal(second.ok, false);
  }
});

test('the store refuses stopping with an unplayed roll', () => {
  const store = new GameStore();
  const rolled = store.roll('p1');
  if (rolled.ok && !rolled.bust) {
    // Advance once so there is something to bank, then roll again and try to
    // stop without playing the new dice.
    store.choose('p1', 0);
    const again = store.roll('p1');
    if (again.ok && !again.bust) {
      const stopped = store.stop('p1');
      assert.equal(stopped.ok, false);
      assert.match(stopped.reason, /before you stop/);
    }
  }
});

test('the store refuses stopping before advancing at all', () => {
  const store = new GameStore();
  const stopped = store.stop('p1');
  assert.equal(stopped.ok, false);
});

test('the store refuses a roll out of turn', () => {
  const store = new GameStore();
  assert.equal(store.roll('p2').ok, false, 'human moves first');
});

test('a bust clears runners and passes the turn in one transition', () => {
  const store = new GameStore();
  // Drive a whole turn until it busts, then check the state it landed in.
  for (let i = 0; i < 400; i++) {
    const rolled = store.roll('p1');
    if (!rolled.ok) break;
    if (rolled.bust) {
      const state = store.getState();
      assert.equal(state.position.runners.size, 0);
      assert.equal(state.phase.kind, 'awaiting_roll');
      assert.equal(store.turn(), 'p2', 'the turn passes on a bust');
      assert.equal(store.canStop('p1'), false);
      return;
    }
    store.choose('p1', 0);
  }
  assert.fail('never busted in 400 rolls — the engine is not ending turns');
});
