/** A server value this package does not name is data, not a failure.
 *
 *  The enums the server authors — the error code, the usage and session
 *  statuses, the credential kind — are the server's sets, not this SDK's. A
 *  deployment newer than an installed package can send a value it has never
 *  heard of, so that tolerance ships before the server may emit one. */

import { describe, expect, it, vi } from 'vitest';
import { TextEncoder as NodeTextEncoder, TextDecoder as NodeTextDecoder } from 'util';

if (typeof global.TextEncoder === 'undefined') {
  global.TextEncoder = NodeTextEncoder as typeof global.TextEncoder;
}
if (typeof global.TextDecoder === 'undefined') {
  global.TextDecoder = NodeTextDecoder as typeof global.TextDecoder;
}

import { RealtimeClient } from '../realtime_client';
import { makeFakeTransport } from './test_helpers';

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

describe('an unrecognized server error code', () => {
  it('reaches the consumer verbatim, with the event intact', async () => {
    const fake = makeFakeTransport();
    const client = new RealtimeClient({ apiKey: 'test-key', transportFactory: () => fake });
    const session = await client.agent().start();
    const seen: unknown[] = [];
    session.on('error', (err) => seen.push(err));

    // A code added to the server after this package shipped.
    fake.emitMessage({
      type: 'error',
      code: 'quota_exhausted',
      message: 'The workspace ran out of minutes.',
      fatal: true,
    } as never);

    // The whole event survives — not just the code. Before tolerance the
    // closed union made this frame undeliverable in the sibling SDKs.
    expect(seen).toHaveLength(1);
    expect(session.getSnapshot().error).toEqual({
      code: 'quota_exhausted',
      message: 'The workspace ran out of minutes.',
      fatal: true,
    });
    await session.end();
  });

  it('still narrows the codes this package does name', async () => {
    const fake = makeFakeTransport();
    const client = new RealtimeClient({ apiKey: 'test-key', transportFactory: () => fake });
    const session = await client.agent().start();

    fake.emitMessage({
      type: 'error',
      code: 'upstream_disconnect',
      message: 'provider dropped',
      fatal: false,
    } as never);

    const latched = session.getSnapshot().error;
    // A caller branching on a known code keeps working; the widening adds a
    // case to handle, it does not take the known ones away.
    expect(latched?.code === 'upstream_disconnect').toBe(true);
    await session.end();
  });
});
