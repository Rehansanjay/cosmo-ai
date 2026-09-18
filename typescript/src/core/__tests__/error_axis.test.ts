/** The session's ``error`` axis carries the error itself.
 *
 *  Every intake bubbles what the failure already produced — the typed error
 *  ``start()`` rejected with, or the server's error event with its own code
 *  and ``fatal``. Nothing is collapsed into a second vocabulary on the way. */

import { describe, expect, it, vi } from 'vitest';
import { TextEncoder as NodeTextEncoder, TextDecoder as NodeTextDecoder } from 'util';

if (typeof global.TextEncoder === 'undefined') {
  global.TextEncoder = NodeTextEncoder as typeof global.TextEncoder;
}
if (typeof global.TextDecoder === 'undefined') {
  global.TextDecoder = NodeTextDecoder as typeof global.TextDecoder;
}

import { RealtimeClient } from '../realtime_client';
import { RealtimeError } from '../errors';
import { SessionStartError, sessionStartErrorFrom } from '../../transport/session_start_error';
import { sessionStartRejectionFrom } from '../../transport/session_start_error';
import type { ErrorEvent as WireErrorFrame } from '../../wire/types.gen';
import type { ErrorEvent } from '../types';
import type { RealtimeSnapshot } from '../state';
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

/** What the server puts on the wire. */
const SERVER_FRAME: WireErrorFrame = {
  type: 'error',
  code: 'upstream_disconnect',
  message: 'The model provider dropped the connection.',
  fatal: true,
};

/** What a consumer receives: the same error, without the frame tag the
 *  session already used to route it. */
const SERVER_ERROR: ErrorEvent = {
  code: 'upstream_disconnect',
  message: 'The model provider dropped the connection.',
  fatal: true,
};

describe('the error axis carries the error object', () => {
  it('reads code and message off any arm without narrowing', () => {
    // What the examples' banners do: every arm carries both, so a consumer
    // that only renders does not have to discriminate first.
    const render = (err: NonNullable<RealtimeSnapshot['error']>): string =>
      `[${err.code}] ${err.message}`;

    expect(render(SERVER_ERROR)).toBe(
      '[upstream_disconnect] The model provider dropped the connection.',
    );
    expect(
      render(new SessionStartError({ code: 'busy', message: 'at the limit' })),
    ).toBe('[busy] at the limit');
  });

  it('delivers a server error frame with its wire code and fatal intact', async () => {
    const fake = makeFakeTransport();
    const client = new RealtimeClient({ apiKey: 'test-key', transportFactory: () => fake });
    const session = await client.agent().start();
    const seen: RealtimeSnapshot['error'][] = [];
    session.on('error', (err) => seen.push(err));

    fake.emitMessage(SERVER_FRAME);

    // The server's own code survives — not a client bucket standing in for
    // it — and so does the frame's fatality.
    expect(seen).toHaveLength(1);
    const latched = session.getSnapshot().error;
    expect(latched).toEqual(SERVER_ERROR);
    expect(latched).not.toBeInstanceOf(RealtimeError);
    if (latched === null || latched instanceof RealtimeError) throw new Error('wrong arm');
    expect(latched.code).toBe('upstream_disconnect');
    expect(latched.fatal).toBe(true);
    await session.end();
  });

  it('leaves a live transport alone for a non-fatal server error', async () => {
    const fake = makeFakeTransport();
    const client = new RealtimeClient({ apiKey: 'test-key', transportFactory: () => fake });
    const session = await client.agent().start();

    fake.emitMessage({ ...SERVER_FRAME, fatal: false, code: 'internal_error' });

    // A turn that failed is not a session that died: the error latches, the
    // transport stays where it was.
    expect(session.getSnapshot().transportState).toBe('ready');
    expect(session.getSnapshot().error?.code).toBe('internal_error');
    await session.end();
  });

  it('latches the same SessionStartError that start() rejects with', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const rejection = sessionStartErrorFrom(
      429,
      'Too Many Requests',
      sessionStartRejectionFrom({
        code: 'concurrent_session_limit',
        message: 'workspace is at its session limit',
        limit: 4,
        active: 4,
      }),
      30,
    );
    const fake: FakeTransport = makeFakeTransport({ connectError: rejection });
    const client = new RealtimeClient({ apiKey: 'test-key', transportFactory: () => fake });

    let latched: RealtimeSnapshot['error'] = null;
    let thrown: unknown;
    try {
      await client.agent().start({
        onSession: (session) => {
          session.on('error', (err) => {
            latched = err;
          });
        },
      });
    } catch (err) {
      thrown = err;
    }

    // One object reaches both surfaces, so a banner and a catch block never
    // disagree about what happened.
    expect(thrown).toBeInstanceOf(SessionStartError);
    expect(latched).toBe(thrown);
    expect((thrown as SessionStartError).code).toBe('busy');
    expect((thrown as SessionStartError).retryAfterSeconds).toBe(30);
    expect((thrown as SessionStartError).detail?.limit).toBe(4);
  });

  it('settles a pre-ready close as one error on both surfaces', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const fake = makeFakeTransport({ readyOnConnect: false });
    const client = new RealtimeClient({ apiKey: 'test-key', transportFactory: () => fake });
    const seen: RealtimeSnapshot['error'][] = [];
    let thrown: unknown;

    const started = client
      .agent()
      .start({ onSession: (s) => s.on('error', (err) => seen.push(err)) })
      .catch((err: unknown) => {
        thrown = err;
        return null;
      });
    await new Promise((resolve) => setTimeout(resolve, 10));
    fake.emitClose({ reason: 'livekit:room closed' });
    expect(await started).toBeNull();

    // The close already settled the ready waiters with the window's typed
    // failure; the catch must not mint a second one whose message quotes
    // the first.
    expect(seen).toEqual([thrown]);
    expect((thrown as SessionStartError).code).toBe('handshake_failed');
    expect((thrown as SessionStartError).message).toBe(
      'The session ended before ready: room closed',
    );
  });

  it('does not leak a latched error into the next session', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const fakes: FakeTransport[] = [];
    const client = new RealtimeClient({
      apiKey: 'test-key',
      transportFactory: () => {
        const fake = makeFakeTransport();
        fakes.push(fake);
        return fake;
      },
    });

    const first = await client.agent().start();
    fakes[0]?.emitMessage(SERVER_FRAME);
    expect(first.getSnapshot().error).toEqual(SERVER_ERROR);

    // Each start gets its own engine, so the banner a new session drives
    // starts clean while the ended one keeps its last error for a
    // post-mortem read.
    const second = await client.agent().start();
    expect(second.getSnapshot().error).toBeNull();
    expect(first.getSnapshot().error).toEqual(SERVER_ERROR);

    await first.end();
    await second.end();
  });
});
