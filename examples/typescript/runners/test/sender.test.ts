import assert from 'node:assert/strict';
import { beforeEach, afterEach, mock, test } from 'node:test';

import type { RealtimeSession } from 'cosmo-ai';

import { Sender } from '../src/sender';

/** Just enough session: the one event it listens to, and what went where. */
class FakeSession {
  readonly texts: string[] = [];
  readonly contexts: string[] = [];
  private handlers = new Set<(payload: unknown) => void>();

  on(_event: string, handler: (payload: never) => void): () => void {
    const h = handler as (payload: unknown) => void;
    this.handlers.add(h);
    return () => this.handlers.delete(h);
  }

  async sendText(content: string): Promise<void> {
    this.texts.push(content);
  }

  async sendContext(content: string): Promise<void> {
    this.contexts.push(content);
  }

  private state(s: unknown): void {
    for (const h of this.handlers) h(s);
  }

  speaks(): void {
    this.state('speaking');
  }

  stopsSpeaking(): void {
    this.state('listening');
  }

  userAsks(): void {
    for (const h of this.handlers) h({ role: 'user', text: 'what now?', isFinal: true });
  }

  userMurmurs(): void {
    for (const h of this.handlers) h({ role: 'user', text: 'uh', isFinal: false });
  }
}

function rig(onBeatDue?: () => void) {
  const fake = new FakeSession();
  const sender = new Sender(fake as unknown as RealtimeSession, { onBeatDue });
  return { fake, sender };
}

beforeEach(() => mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] }));
afterEach(() => mock.timers.reset());

test('state is silent and never becomes a turn', () => {
  const { fake, sender } = rig();
  fake.speaks();
  sender.sendState('board: runners on 6, 7, 8');
  assert.deepEqual(fake.contexts, ['board: runners on 6, 7, 8']);
  assert.deepEqual(fake.texts, [], 'context cannot interrupt, so it needs no gate');
});

test('an unchanged board is not sent again', () => {
  const { fake, sender } = rig();
  sender.sendState('board: A');
  sender.sendState('board: A');
  sender.sendState('board: B');
  assert.deepEqual(fake.contexts, ['board: A', 'board: B']);
});

test('notes accumulate silently until something asks for them', () => {
  const { fake, sender } = rig();
  sender.note('They rolled 5-1-6-4.');
  sender.note('They advanced 6 and 8.');
  assert.deepEqual(fake.texts, []);
  assert.equal(sender.pending(), 2);
});

test('speaking covers everything noted, in one turn', () => {
  const { fake, sender } = rig();
  sender.note('They rolled 5-1-6-4.');
  sender.note('They advanced 6 and 8.');
  sender.speak();
  assert.deepEqual(fake.texts, ['They rolled 5-1-6-4. They advanced 6 and 8.']);
  assert.equal(sender.pending(), 0, 'and the delta resets');
});

test('nothing is said while the agent is talking, not even a bust', () => {
  // A sent line ends whoever holds the floor. A bust that arrives a second
  // late is better than one that clips the sentence in progress.
  const { fake, sender } = rig();
  fake.speaks();
  sender.note('The Engine busted.');
  sender.speak();
  mock.timers.tick(2_000); // under the ceiling, so still holding
  assert.deepEqual(fake.texts, [], 'held while it talks');

  fake.stopsSpeaking();
  mock.timers.tick(500);
  assert.deepEqual(fake.texts, ['The Engine busted.'], 'and lands as soon as it stops');
});

test('the delta keeps growing while it waits', () => {
  const { fake, sender } = rig();
  fake.speaks();
  sender.note('a.');
  sender.speak();
  sender.note('b.');
  sender.note('c.');
  fake.stopsSpeaking();
  mock.timers.tick(500);
  assert.deepEqual(fake.texts, ['a. b. c.'], 'one line covering all of it');
});

test('there is nothing to say when nothing was noted', () => {
  const { fake, sender } = rig();
  sender.speak();
  assert.deepEqual(fake.texts, []);
});

test('the beat can speak with instructions and no news', () => {
  const { fake, sender } = rig();
  sender.speak('Call the state of play.');
  assert.deepEqual(fake.texts, ['Call the state of play.']);
});

test('the beat is skipped while the agent is talking', () => {
  // Unlike an event, an unprompted remark is not worth interrupting for.
  let beats = 0;
  const { fake } = rig(() => { beats += 1; });
  fake.speaks();
  mock.timers.tick(12_000);
  assert.equal(beats, 0, 'three beats passed, all skipped');
  fake.stopsSpeaking();
  mock.timers.tick(4_500);
  assert.equal(beats, 1);
});

test('reacting with nothing to react to sends nothing', () => {
  // The standing frame alone is "react to what just happened" with no what.
  const { fake, sender } = rig();
  sender.note('The Engine busted.');
  sender.speak();
  assert.equal(fake.texts.length, 1);
  sender.speak();
  assert.equal(fake.texts.length, 1, 'the delta is spent; nothing more to say');
});

test('a question of yours is answered before the game gets a word in', () => {
  // Otherwise the event becomes the turn your question earned, and the model
  // answers the game instead of you.
  const fake = new FakeSession();
  const sender = new Sender(fake as unknown as RealtimeSession);
  fake.userAsks();
  sender.note('The Engine busted.');
  sender.speak();

  mock.timers.tick(2_000); // under the ceiling, so still holding
  assert.deepEqual(fake.texts, [], 'still owed a reply');

  fake.speaks();
  fake.stopsSpeaking();
  mock.timers.tick(500);
  assert.deepEqual(fake.texts, ['The Engine busted.']);
});

test('an unanswered question does not mute the game for good', () => {
  const fake = new FakeSession();
  const sender = new Sender(fake as unknown as RealtimeSession);
  fake.userAsks();
  sender.note('The Engine busted.');
  sender.speak();
  mock.timers.tick(13_000);
  assert.deepEqual(fake.texts, ['The Engine busted.']);
});

test('news is framed as news, even after a beat was held', () => {
  // A held beat used to keep its question, so the next event went out asking
  // for "the state of play" instead of a reaction to what just happened.
  const fake = new FakeSession();
  const sender = new Sender(fake as unknown as RealtimeSession, { frame: 'REACT.' });
  fake.speaks();
  sender.speak('CALL THE STATE.');
  sender.note('The Engine busted.');
  sender.speak();
  fake.stopsSpeaking();
  mock.timers.tick(500);
  assert.deepEqual(fake.texts, ['The Engine busted. REACT.']);
});

test('a half-heard fragment does not count as a question', () => {
  // A hot mic emits interim fragments constantly; treating each as something
  // owed an answer mutes the game until the agent replies to the room.
  const fake = new FakeSession();
  const sender = new Sender(fake as unknown as RealtimeSession);
  fake.userMurmurs();
  sender.note('The Engine busted.');
  sender.speak();
  mock.timers.tick(2_000);
  assert.deepEqual(fake.texts, ['The Engine busted.'], 'held for the tail, then sent');
});

test('a noisy room cannot mute the game forever', () => {
  // Interims arriving faster than the tail clears meant `busy()` never went
  // false, so held commentary was never delivered at all.
  const fake = new FakeSession();
  const sender = new Sender(fake as unknown as RealtimeSession);
  sender.note('The Engine busted.');
  sender.speak();
  for (let i = 0; i < 20; i++) {
    fake.userMurmurs();
    mock.timers.tick(500); // noise every 500ms, tail is 1200ms
  }
  assert.equal(fake.texts.length, 1, 'forced through once the wait got absurd');
});

test('a note raised while disconnected is delivered on reconnect', () => {
  const sender = new Sender(null);
  sender.note('The Engine busted.');
  sender.speak();

  const fake = new FakeSession();
  sender.attach(fake as unknown as RealtimeSession);
  mock.timers.tick(500);
  assert.deepEqual(fake.texts, ['The Engine busted.']);
});

test('a failed send puts the line back rather than eating it', async () => {
  const fake = new FakeSession();
  let fail = true;
  fake.sendText = async (content: string) => {
    if (fail) throw new Error('transport gone');
    fake.texts.push(content);
  };
  const sender = new Sender(fake as unknown as RealtimeSession);
  sender.note('You just won.');
  sender.speak();
  await Promise.resolve();
  assert.deepEqual(fake.texts, []);
  assert.equal(sender.pending(), 1, 'kept, not dropped');

  fail = false;
  mock.timers.tick(1_000);
  await Promise.resolve();
  assert.deepEqual(fake.texts, ['You just won.']);
});

test('a second line cannot overtake one already sent', () => {
  const { fake, sender } = rig();
  sender.note('first.');
  sender.speak();
  assert.equal(fake.texts.length, 1);
  sender.note('second.');
  sender.speak();
  mock.timers.tick(1_000);
  assert.equal(fake.texts.length, 1, 'held until the agent reacts');
  fake.speaks();
  fake.stopsSpeaking();
  mock.timers.tick(500);
  assert.deepEqual(fake.texts, ['first.', 'second.']);
});

test('a line already in progress is not an answer to what you just said', () => {
  // Barging in marks a reply owed, but the sentence it was already speaking
  // ends a moment later — counting that as the answer let a queued line take
  // the turn the question earned.
  const fake = new FakeSession();
  const sender = new Sender(fake as unknown as RealtimeSession);
  fake.speaks();               // already talking
  sender.note('The Engine busted.');
  sender.speak();              // queued behind it
  fake.userAsks();             // you cut in
  fake.stopsSpeaking();        // that older line finishes

  mock.timers.tick(2_000);
  assert.deepEqual(fake.texts, [], 'still owed a real answer');

  fake.speaks();               // now it actually replies to you
  fake.stopsSpeaking();
  mock.timers.tick(500);
  assert.deepEqual(fake.texts, ['The Engine busted.']);
});

test('the wait is bounded, so waiting is never what you notice', () => {
  // In a room where the mic keeps hearing things, the ceiling is not a rare
  // fallback — it is the normal path, and so it is the latency people feel.
  const { fake, sender } = rig();
  fake.speaks();
  sender.note('The Engine busted.');
  sender.speak();
  mock.timers.tick(3_000);
  assert.equal(fake.texts.length, 1, 'out inside a few seconds, not eight');
});

test('the board is refreshed when someone starts speaking, once per utterance', () => {
  // A question is probably coming, and it should be answerable from the real
  // board — but once, not once per syllable.
  const fake = new FakeSession();
  let refreshes = 0;
  const sender = new Sender(fake as unknown as RealtimeSession, {
    onUserSpeaks: () => { refreshes += 1; },
  });
  fake.userMurmurs();
  fake.userMurmurs();
  fake.userMurmurs();
  assert.equal(refreshes, 1, 'leading edge only');

  mock.timers.tick(2_000); // the tail lapses
  fake.userMurmurs();
  assert.equal(refreshes, 2, 'a fresh utterance refreshes again');
  assert.equal(sender.pending(), 0);
});
