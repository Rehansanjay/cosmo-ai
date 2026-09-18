/** The folded transcript reaches the stream, after the frame that produced it.
 *
 *  Python enqueues a synthesized ``TranscriptUpdatedEvent`` and Swift yields
 *  ``.transcriptUpdated`` from the same place, each right after the event it
 *  folded — so a consumer draining the stream sees the turn and then the
 *  conversation it belongs to. TypeScript's stream carried wire frames only,
 *  so the folded value reached callbacks and never the iterator. */

import { describe, expect, it, vi } from 'vitest';
import { TextEncoder as NodeTextEncoder, TextDecoder as NodeTextDecoder } from 'util';

if (typeof global.TextEncoder === 'undefined') {
  global.TextEncoder = NodeTextEncoder as typeof global.TextEncoder;
}
if (typeof global.TextDecoder === 'undefined') {
  global.TextDecoder = NodeTextDecoder as typeof global.TextDecoder;
}

import { RealtimeClient } from '../realtime_client';
import { collect, drain, makeFakeTransport, transcriptFrame } from './test_helpers';

vi.mock('livekit-client', () => {
  class Room {
    localParticipant = { setMicrophoneEnabled: vi.fn() };
    on() {
      return this;
    }
    async connect() {}
    async disconnect() {}
  }
  return {
    Room,
    RoomEvent: {
      DataReceived: 'dataReceived',
      TrackSubscribed: 'trackSubscribed',
      Disconnected: 'disconnected',
      Reconnecting: 'reconnecting',
      Reconnected: 'reconnected',
    },
    Track: { Kind: { Audio: 'audio' }, Source: { Microphone: 'microphone' } },
    ConnectionState: { Connected: 'connected' },
    LocalVideoTrack: class {},
    RemoteTrack: class {},
  };
});

describe('transcript_updated on the stream', () => {
  it('follows the delta that produced it, carrying the folded turn', async () => {
    const fake = makeFakeTransport();
    const client = new RealtimeClient({ apiKey: 'test-key', transportFactory: () => fake });
    const session = await client.agent().start();

    fake.emitMessage(transcriptFrame('Hello there.'));

    // ready, then the delta, then the fold — the order Python and Swift yield.
    const [, delta, updated] = await collect(session, 3);
    expect(delta?.type).toBe('transcript');
    expect(updated?.type).toBe('transcript_updated');
    if (updated?.type !== 'transcript_updated') throw new Error('wrong arm');
    expect(updated.items).toHaveLength(1);
    expect(updated.items[0]).toMatchObject({
      role: 'assistant',
      text: 'Hello there.',
      isFinal: true,
    });
    await session.end();
  });

  it('reaches the stream for a fold no frame produced', async () => {
    const fake = makeFakeTransport();
    const client = new RealtimeClient({ apiKey: 'test-key', transportFactory: () => fake });
    const session = await client.agent().start();
    fake.emitMessage({ type: 'ready', session_id: 'sess-fake' });

    // The echo of a typed turn folds without any inbound frame behind it.
    await session.sendText('typed turn');
    await session.end();

    const events = await drain(session);
    const updates = events.filter((e) => e.type === 'transcript_updated');
    expect(updates).toHaveLength(1);
    const [only] = updates;
    if (only?.type !== 'transcript_updated') throw new Error('wrong arm');
    expect(only.items[0]).toMatchObject({ role: 'user', text: 'typed turn' });
  });

  it('yields one update per fold, not one per frame', async () => {
    const fake = makeFakeTransport();
    const client = new RealtimeClient({ apiKey: 'test-key', transportFactory: () => fake });
    const session = await client.agent().start();

    fake.emitMessage(transcriptFrame('one'));
    fake.emitMessage(transcriptFrame('two'));
    await session.end();

    const events = await drain(session);
    expect(events.filter((e) => e.type === 'transcript').length).toBe(2);
    expect(events.filter((e) => e.type === 'transcript_updated').length).toBe(2);
  });

  it('settles a turn left open, before the terminal item', async () => {
    const fake = makeFakeTransport();
    const client = new RealtimeClient({ apiKey: 'test-key', transportFactory: () => fake });
    const session = await client.agent().start();

    // An open bubble: a non-final delta no turn-complete ever closes.
    fake.emitMessage({
      type: 'transcript',
      role: 'USER',
      text: 'still talking',
      is_final: false,
    } as never);
    await session.end();

    const events = await drain(session);
    const updates = events.filter((e) => e.type === 'transcript_updated');
    const last = updates[updates.length - 1];
    if (last?.type !== 'transcript_updated') throw new Error('no closing update');

    // The stream's last word on the transcript agrees with `session.transcript`
    // and with what Python and Swift yield: the turn is closed.
    expect(last.items[0]).toMatchObject({ text: 'still talking', isFinal: true });
    expect(session.transcript[0]).toMatchObject({ isFinal: true });

    // And it lands before the terminal item, which stays last.
    const lastIdx = events.lastIndexOf(last);
    const endedIdx = events.findIndex((e) => e.type === 'session_ended');
    expect(lastIdx).toBeLessThan(endedIdx);
    expect(events[events.length - 1]?.type).toBe('session_ended');
  });

  it('keeps one update per fold when two land in the same turn', async () => {
    const fake = makeFakeTransport();
    const client = new RealtimeClient({ apiKey: 'test-key', transportFactory: () => fake });
    const session = await client.agent().start();

    // Both echoes fold before either flush runs, so a single pending slot
    // would drop the first and yield only the later snapshot.
    await Promise.all([session.sendText('first'), session.sendText('second')]);
    await session.end();

    const events = await drain(session);
    const updates = events.filter((e) => e.type === 'transcript_updated');
    expect(updates).toHaveLength(2);
    const texts = updates.map((u) =>
      u.type === 'transcript_updated' ? u.items.map((i) => i.text) : [],
    );
    expect(texts[0]).toEqual(['first']);
    expect(texts[1]).toEqual(['first', 'second']);
  });
});
