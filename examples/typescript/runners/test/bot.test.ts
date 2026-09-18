import assert from 'node:assert/strict';
import { test } from 'node:test';

import { atRisk, bustProbability, chooseOption, shouldRollAgain } from '../src/game/bot';
import {
  COLUMNS_TO_WIN,
  describeOption,
  enumerateOptions,
  HEIGHT,
  initialPosition,
  type Position,
} from '../src/game/rules';
import { GameStore } from '../src/game/state';

function withRunners(entries: [number, number][], base = initialPosition()): Position {
  return { ...base, runners: new Map(entries) };
}

test('bust odds match the published figures', () => {
  // The classic result: three runners on 6-7-8 bust 8% of the time.
  const central = withRunners([
    [6, 1],
    [7, 1],
    [8, 1],
  ]);
  assert.equal(bustProbability(central, 'p1').toFixed(3), '0.080');

  const outside = withRunners([
    [2, 1],
    [3, 1],
    [12, 1],
  ]);
  assert.equal(bustProbability(outside, 'p1').toFixed(3), '0.562');
});

test('bust odds account for columns that are already closed', () => {
  const base = withRunners([
    [6, 1],
    [7, 1],
    [8, 1],
  ]);
  const open = bustProbability(base, 'p1');
  const narrowed = bustProbability({ ...base, claims: { 7: 'p2' } }, 'p1');
  assert.ok(
    narrowed > open,
    `closing 7 should raise the bust chance, got ${narrowed} vs ${open}`,
  );
});

test('at-risk counts only what is above banked progress', () => {
  const base = initialPosition();
  base.progress.p1[7] = 3;
  assert.equal(atRisk(withRunners([[7, 6]], base), 'p1'), 3);
});

test('it stops when stopping wins the game', () => {
  const base = initialPosition();
  const position = {
    ...base,
    claims: { 2: 'p1' as const, 3: 'p1' as const },
    runners: new Map([[12, HEIGHT[12]]]),
  };
  assert.equal(
    shouldRollAgain(position, 'p1'),
    false,
    'a runner on top of a third column must be banked, never gambled',
  );
});

test('it keeps rolling while runners are still free', () => {
  assert.equal(shouldRollAgain(withRunners([[7, 1]]), 'p1'), true);
  assert.equal(shouldRollAgain(initialPosition(), 'p1'), true);
});

test('it stops on a bad board with a lot at risk', () => {
  const outside = withRunners([
    [2, 2],
    [3, 4],
    [12, 2],
  ]);
  assert.equal(shouldRollAgain(outside, 'p1'), false);
});

test('it prefers the option that tops a column', () => {
  const base = initialPosition();
  base.progress.p1[2] = 2;
  // 1-1-3-4 gives 2|7, 4|5 and 5|4. The 2 completes column 2.
  const position = { ...base, runners: new Map<number, number>() };
  const options = enumerateOptions([1, 1, 3, 4], position, 'p1');
  const picked = options[chooseOption(options, position, 'p1')];
  assert.ok(picked.sums.includes(2), `expected the column-2 finish, got ${picked.sums.join('+')}`);
  assert.equal(picked.runners.get(2), HEIGHT[2]);
});

test('two engines finish a game in a sane number of turns', () => {
  // The real integration check: the policy must actually terminate, and
  // neither seat may deadlock waiting for the other.
  const store = new GameStore({
    p1: { label: 'A', by: 'bot' },
    p2: { label: 'B', by: 'bot' },
  });

  let actions = 0;
  while (store.getState().phase.kind !== 'game_over') {
    if (actions++ > 20000) assert.fail('the engine never finished a game');
    const turn = store.turn();
    assert.notEqual(turn, null);
    const { phase, position } = store.getState();

    if (phase.kind === 'awaiting_choice') {
      store.choose(turn!, chooseOption(phase.options, position, turn!));
      continue;
    }
    if (!shouldRollAgain(position, turn!) && store.canStop(turn!)) {
      store.stop(turn!);
      continue;
    }
    store.roll(turn!);
  }

  const final = store.getState();
  assert.equal(final.phase.kind, 'game_over');
  if (final.phase.kind === 'game_over') {
    const won = Object.values(final.position.claims).filter((c) => c === final.phase.winner);
    assert.equal(won.length, COLUMNS_TO_WIN);
  }
});

test('it opens central columns over the outside ones', () => {
  // Caught in live play: from an empty board the engine took 4 and 11 over
  // 9 and 6, because scarcity alone made short columns look like bargains.
  const position = initialPosition();
  const options = enumerateOptions([3, 5, 6, 1], position, 'p1');
  const picked = options[chooseOption(options, position, 'p1')];
  assert.deepEqual(
    [...picked.sums].sort((a, b) => a - b),
    [6, 9],
    `expected the central pair, got ${picked.sums.join('+')}`,
  );
});

test('the situation snapshot carries the dice still on the table', () => {
  const store = new GameStore({
    p1: { label: 'You', by: 'human' },
    p2: { label: 'The Engine', by: 'bot' },
  });
  const rolled = store.roll('p1');
  if (!rolled.ok || rolled.bust) return; // a first-roll bust is impossible, but narrow the type

  const text = store.situation();
  assert.match(text, /not yet played/, 'must say the dice are unplayed');
  assert.match(text, /Options open to/, 'must list the options');
  for (const option of rolled.options) {
    assert.ok(
      text.includes(describeOption(option)),
      `option ${describeOption(option)} missing from: ${text}`,
    );
  }
  assert.ok(text.length < 4096, 'must fit the context note limit');
});

test('the situation snapshot reports live bust odds once runners are out', () => {
  const store = new GameStore();
  const rolled = store.roll('p1');
  if (!rolled.ok || rolled.bust) return;
  store.choose('p1', 0);
  assert.match(store.situation(), /busting on \d+% of rolls/);
});
