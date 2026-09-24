/** Session-owned transcript state: folding semantics of
 *  ``RealtimeSession.transcript`` / ``transcript_updated`` over the wire
 *  stream — growth, barge-in interleaving, retraction, silent-session
 *  chunked finals, dangling-line close, sendText echo, and teardown. */

import { describe, expect, it, vi } from 'vitest';
import { TextEncoder as NodeTextEncoder, TextDecoder as NodeTextDecoder } from 'util';

if (typeof global.TextEncoder === 'undefined') {
  global.TextEncoder = NodeTextEncoder as typeof global.TextEncoder;
}
if (typeof global.TextDecoder === 'undefined') {
  global.TextDecoder = NodeTextDecoder as typeof global.TextDecoder;
}

import { RealtimeClient } from '../realtime_client';
import type { RealtimeSession } from '../session';
import type { RealtimeServerMessage } from '../../transport/envelope';
import type { TranscriptItem } from '../events';
import { makeFakeTransport, type FakeTransport } from './test_helpers';

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

function delta(
  role: 'USER' | 'ASSISTANT',
  text: string,
  isFinal: boolean,
): RealtimeServerMessage {
  return { type: 'transcript', role, text, is_final: isFinal };
}

function turnComplete(role: 'USER' | 'ASSISTANT'): RealtimeServerMessage {
  return { type: 'turn-complete', role } as RealtimeServerMessage;
}

async function startSession(): Promise<{ session: RealtimeSession; fake: FakeTransport }> {
  const fake = makeFakeTransport();
  const client = new RealtimeClient({ apiKey: 'test-key', transportFactory: () => fake });
  const session = await client.agent().start();
  return { session, fake };
}

function bare(items: readonly TranscriptItem[]): Array<Omit<TranscriptItem, 'id'>> {
  return items.map(({ role, text, isFinal }) => ({ role, text, isFinal }));
}

describe('session-owned transcript', () => {
  it('grows the open bubble on deltas and replaces on the final', async () => {
    const { session, fake } = await startSession();
    fake.emitMessage(delta('ASSISTANT', 'Hel', false));
    fake.emitMessage(delta('ASSISTANT', 'lo th', false));
    expect(bare(session.transcript)).toEqual([
      { role: 'assistant', text: 'Hello th', isFinal: false },
    ]);
    // The final is authoritative and can correct a reworded prefix.
    fake.emitMessage(delta('ASSISTANT', 'Hello there.', true));
    expect(bare(session.transcript)).toEqual([
      { role: 'assistant', text: 'Hello there.', isFinal: true },
    ]);
  });

  it('keeps the item id stable from open to close', async () => {
    const { session, fake } = await startSession();
    fake.emitMessage(delta('USER', 'partial', false));
    const openId = session.transcript[0]?.id;
    fake.emitMessage(delta('USER', 'partial and final', true));
    expect(session.transcript[0]?.id).toBe(openId);
  });

  it('holds turns together under barge-in interleaving', async () => {
    const { session, fake } = await startSession();
    // Wire order under barge-in: user partial → assistant deltas → user final.
    fake.emitMessage(delta('USER', 'Wait, ', false));
    fake.emitMessage(delta('ASSISTANT', 'As I was say', false));
    fake.emitMessage(delta('USER', 'Wait, stop.', true));
    expect(bare(session.transcript)).toEqual([
      { role: 'user', text: 'Wait, stop.', isFinal: true },
      { role: 'assistant', text: 'As I was say', isFinal: false },
    ]);
  });

  it('retracts the open bubble on an empty final', async () => {
    const { session, fake } = await startSession();
    fake.emitMessage(delta('ASSISTANT', 'user\n2969', false));
    expect(session.transcript).toHaveLength(1);
    // The server force-closes a leaked garbled line with an empty final:
    // the streamed partials must not stand.
    fake.emitMessage(delta('ASSISTANT', '', true));
    expect(session.transcript).toEqual([]);
  });

  it('never opens a bubble for a blank delta', async () => {
    const { session, fake } = await startSession();
    fake.emitMessage(delta('ASSISTANT', '', true));
    fake.emitMessage(delta('USER', '   ', false));
    expect(session.transcript).toEqual([]);
  });

  it('lands a final with no open bubble as its own closed item', async () => {
    const { session, fake } = await startSession();
    // Silent-session shape: the endpoint commits a chunk, the model's late
    // final carries only the remaining suffix — each is a complete final.
    fake.emitMessage(delta('USER', 'Schedule the meeting', true));
    fake.emitMessage(delta('USER', 'for tomorrow at nine.', true));
    expect(bare(session.transcript)).toEqual([
      { role: 'user', text: 'Schedule the meeting', isFinal: true },
      { role: 'user', text: 'for tomorrow at nine.', isFinal: true },
    ]);
  });

  it('closes a dangling open bubble on turn-complete', async () => {
    const { session, fake } = await startSession();
    fake.emitMessage(delta('ASSISTANT', 'What the caller heard', false));
    fake.emitMessage(turnComplete('ASSISTANT'));
    expect(bare(session.transcript)).toEqual([
      { role: 'assistant', text: 'What the caller heard', isFinal: true },
    ]);
  });

  it('emits transcript_updated with the full items and replays to late subscribers', async () => {
    const { session, fake } = await startSession();
    const seen: Array<readonly TranscriptItem[]> = [];
    session.on('transcript_updated', ({ items }) => seen.push(items));
    // Replay on subscribe: current (empty) state arrives synchronously.
    expect(seen).toEqual([[]]);
    fake.emitMessage(delta('USER', 'One', false));
    fake.emitMessage(delta('USER', 'One two', true));
    expect(seen).toHaveLength(3);
    expect(bare(seen[2] ?? [])).toEqual([{ role: 'user', text: 'One two', isFinal: true }]);

    const late: Array<readonly TranscriptItem[]> = [];
    session.on('transcript_updated', ({ items }) => late.push(items));
    expect(late).toHaveLength(1);
    expect(late[0]).toBe(session.transcript);
  });

  it('keeps the array reference stable between changes', async () => {
    const { session, fake } = await startSession();
    fake.emitMessage(delta('USER', 'hello', true));
    const first = session.transcript;
    expect(session.transcript).toBe(first);
    fake.emitMessage(delta('ASSISTANT', 'hi', true));
    expect(session.transcript).not.toBe(first);
  });

  it('folds the sendText echo in, and keeps it out with transcript: false', async () => {
    const { session, fake } = await startSession();
    fake.emitMessage({ type: 'ready', session_id: 'sess-1' });
    await session.sendText('typed question');
    await session.sendText('off the record', { transcript: false });
    expect(bare(session.transcript)).toEqual([
      { role: 'user', text: 'typed question', isFinal: true },
    ]);
  });

  it('sendText lands as its own turn and never touches an open speech bubble', async () => {
    const { session, fake } = await startSession();
    fake.emitMessage({ type: 'ready', session_id: 'sess-1' });
    // The mic is live: the user's speech transcription is still open.
    fake.emitMessage(delta('USER', 'I was saying something', false));
    await session.sendText('typed question');
    // The speech partial survives, open, before the typed turn.
    expect(bare(session.transcript)).toEqual([
      { role: 'user', text: 'I was saying something', isFinal: false },
      { role: 'user', text: 'typed question', isFinal: true },
    ]);
    // The speech turn's real final still closes its own bubble, in place —
    // chronological order by turn start, no duplicate item.
    fake.emitMessage(delta('USER', 'I was saying something important', true));
    expect(bare(session.transcript)).toEqual([
      { role: 'user', text: 'I was saying something important', isFinal: true },
      { role: 'user', text: 'typed question', isFinal: true },
    ]);
  });

  it('deltas keep folding into the open bubble behind a typed turn', async () => {
    const { session, fake } = await startSession();
    fake.emitMessage({ type: 'ready', session_id: 'sess-1' });
    fake.emitMessage(delta('USER', 'Hel', false));
    await session.sendText('typed');
    fake.emitMessage(delta('USER', 'lo there', false));
    expect(bare(session.transcript)).toEqual([
      { role: 'user', text: 'Hello there', isFinal: false },
      { role: 'user', text: 'typed', isFinal: true },
    ]);
    // turn-complete also still finds the open bubble behind the typed turn.
    fake.emitMessage(turnComplete('USER'));
    expect(bare(session.transcript)).toEqual([
      { role: 'user', text: 'Hello there', isFinal: true },
      { role: 'user', text: 'typed', isFinal: true },
    ]);
  });

  it('closes open bubbles at session end and stays readable afterwards', async () => {
    const { session, fake } = await startSession();
    fake.emitMessage(delta('ASSISTANT', 'Goodbye th', false));
    const endedSnapshots: Array<readonly TranscriptItem[]> = [];
    session.on('session_ended', () => endedSnapshots.push(session.transcript));
    await session.end();
    // The session_ended handler already saw the closed state.
    expect(bare(endedSnapshots[0] ?? [])).toEqual([
      { role: 'assistant', text: 'Goodbye th', isFinal: true },
    ]);
    expect(bare(session.transcript)).toEqual([
      { role: 'assistant', text: 'Goodbye th', isFinal: true },
    ]);
  });
  it('keeps thinking after an utterance and clears it when model work ends', async () => {
    const { session, fake } = await startSession();
    fake.emitMessage({ type: 'bot-started-speaking' });
    fake.emitMessage(delta('ASSISTANT', 'The lookup is running.', true));
    fake.emitMessage({ type: 'bot-stopped-speaking' });
    fake.emitMessage(turnComplete('ASSISTANT'));
    fake.emitMessage({ type: 'bot-llm-started' });
    expect(session.getSnapshot().agentState).toBe('thinking');
    fake.emitMessage({ type: 'bot-llm-stopped' });
    expect(session.getSnapshot().agentState).toBe('listening');
    fake.emitMessage({ type: 'bot-started-speaking' });
    fake.emitMessage({ type: 'bot-llm-stopped' });
    expect(session.getSnapshot().agentState).toBe('speaking');
    await session.end();
  });

});
