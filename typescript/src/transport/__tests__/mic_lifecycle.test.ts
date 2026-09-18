// @vitest-environment jsdom
/**
 * The microphone's lifetime inside the join→ready window: every way
 * acquisition fails is classified into the ``MicState`` it leaves behind, and
 * a microphone acquired for a connect nobody is waiting for is handed back
 * rather than left running.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TextEncoder as NodeTextEncoder, TextDecoder as NodeTextDecoder } from 'util';

if (typeof global.TextEncoder === 'undefined') {
  global.TextEncoder = NodeTextEncoder as typeof global.TextEncoder;
}
if (typeof global.TextDecoder === 'undefined') {
  global.TextDecoder = NodeTextDecoder as typeof global.TextDecoder;
}

import { RealtimeClient } from '../../core/realtime_client';
import { LiveKitTransport } from '../livekit_transport';
import type { RealtimeSession } from '../../core/session';
import type { MicState } from '../../core/state';
import { AudioUnavailableError } from '../../core/errors';
import { SessionStartError } from '../session_start_error';
import type { SessionConfig } from '../../protocol';
import { SDK_NAME, SDK_VERSION } from '../../constants';

const {
  setMic,
  roomConnect,
  publishData,
  mockHandlers,
  mockRemoteParticipants,
  micTrack,
  rooms,
} = vi.hoisted(() => ({
    setMic: vi.fn().mockResolvedValue(undefined),
    roomConnect: vi.fn().mockResolvedValue(undefined),
    publishData: vi.fn().mockResolvedValue(undefined),
    mockHandlers: {} as Record<string, (...args: unknown[]) => void>,
    mockRemoteParticipants: new Map<string, unknown>(),
    // The captured device. ``stop()`` is what actually drops the browser's
    // recording indicator, so it is the only honest assertion for "the
    // microphone was released".
    micTrack: { stop: vi.fn(), detach: vi.fn(), mute: vi.fn() },
    rooms: [] as { localParticipant: { trackPublications: Map<string, unknown> } }[],
  }));

vi.mock('livekit-client', () => {
  // Publication bookkeeping and the stop-on-disconnect behaviour mirror the
  // real client: ``Room.disconnect`` defaults ``stopTracks`` to true and calls
  // ``stop()`` on every local publication. Modelling it is what lets a test
  // catch us disabling that default or skipping the disconnect entirely — an
  // inert ``async disconnect() {}`` double would pass either way.
  class Room {
    state = 'connected';
    localParticipant = {
      setMicrophoneEnabled: setMic,
      publishData,
      trackPublications: new Map<string, { track: typeof micTrack }>(),
      // Mirrors ``LocalParticipant``: unpublishing with ``stopOnUnpublish``
      // ends the capture, which muting does not.
      getTrackPublication: (source: string) =>
        source === 'microphone' ? this.localParticipant.trackPublications.get('mic') : undefined,
      unpublishTrack: async (track: typeof micTrack, stopOnUnpublish?: boolean) => {
        this.localParticipant.trackPublications.delete('mic');
        if (stopOnUnpublish !== false) track.stop();
      },
    };
    constructor() {
      rooms.push(this as never);
    }
    remoteParticipants = mockRemoteParticipants;
    on(event: string, cb: (...args: unknown[]) => void) {
      mockHandlers[event] = cb;
      return this;
    }
    connect = roomConnect;
    async disconnect(stopTracks = true) {
      for (const pub of this.localParticipant.trackPublications.values()) {
        if (stopTracks) pub.track.stop();
      }
      this.localParticipant.trackPublications.clear();
    }
  }
  return {
    Room,
    RoomEvent: {
      DataReceived: 'dataReceived',
      TrackSubscribed: 'trackSubscribed',
      TrackUnsubscribed: 'trackUnsubscribed',
      Disconnected: 'disconnected',
      Reconnecting: 'reconnecting',
      Reconnected: 'reconnected',
      ParticipantDisconnected: 'participantDisconnected',
      ParticipantAttributesChanged: 'participantAttributesChanged',
    },
    Track: { Kind: { Audio: 'audio' }, Source: { Microphone: 'microphone' } },
    ConnectionState: { Connected: 'connected' },
    ParticipantKind: { AGENT: 'agent' },
    LocalVideoTrack: class {},
    RemoteTrack: class {},
  };
});

const START_URL = 'https://api.example.com/api/v1/external/realtime/session/start';

const CONFIG: SessionConfig = {
  sdk: { name: SDK_NAME, version: SDK_VERSION },
  type: 'session-config',
  agent: { type: 'inline', voice: { name: 'Breezy' } },
};

const SESSION_RESPONSE = {
  livekit_url: 'wss://lk.example',
  token: 'lk-jwt',
  room_name: 'room-1',
  session_id: 'sess-1',
};

/** A ``DOMException``-shaped rejection, which is all the classifier reads. */
function mediaError(name: string): Error {
  const err = new Error(`${name} from getUserMedia`);
  err.name = name;
  return err;
}

function stubStartFetch(): void {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => SESSION_RESPONSE,
    }),
  );
}

/** Wire ``setMicrophoneEnabled`` to the publication bookkeeping, so a mic that
 *  was actually acquired is one the room can later stop. */
function micPublishes(): void {
  setMic.mockImplementation(async (enabled: boolean) => {
    const pubs = rooms.at(-1)?.localParticipant.trackPublications;
    if (pubs === undefined) return;
    if (enabled) {
      pubs.set('mic', { track: micTrack });
    } else {
      // ``setMicrophoneEnabled(false)`` mutes. The publication and the capture
      // device both survive it — ``stopMicTrackOnMute`` is off — so a double
      // that stopped here would hide exactly the bug this file exists to catch.
      micTrack.mute();
    }
  });
}

beforeEach(() => {
  setMic.mockReset().mockResolvedValue(undefined);
  roomConnect.mockReset().mockResolvedValue(undefined);
  publishData.mockReset().mockResolvedValue(undefined);
  micTrack.stop.mockReset();
  micTrack.detach.mockReset();
  micTrack.mute.mockReset();
  rooms.length = 0;
  mockRemoteParticipants.clear();
  for (const key of Object.keys(mockHandlers)) delete mockHandlers[key];
  stubStartFetch();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('microphone acquisition failures are classified', () => {
  // Each row is a real ``getUserMedia`` rejection, the state it leaves behind,
  // and the slug the thrown error carries — the distinct thing it tells the
  // user: grant permission, plug one in, or quit the other app.
  const CASES: ReadonlyArray<[string, MicState, string]> = [
    ['NotAllowedError', 'denied', 'mic_denied'],
    ['PermissionDeniedError', 'denied', 'mic_denied'],
    ['SecurityError', 'denied', 'mic_denied'],
    ['NotFoundError', 'not-found', 'mic_not_found'],
    ['DevicesNotFoundError', 'not-found', 'mic_not_found'],
    ['OverconstrainedError', 'not-found', 'mic_not_found'],
    ['NotReadableError', 'in-use', 'mic_in_use'],
    ['TrackStartError', 'in-use', 'mic_in_use'],
  ];

  /** ``start()`` rejects, so the session never returns — the window
   *  contract's early ``onSession`` handle is what carries the snapshot out
   *  of a failed start. */
  async function startExpectingFailure(): Promise<{
    session: RealtimeSession;
    thrown: unknown;
  }> {
    const client = new RealtimeClient({ apiKey: 'test-key' });
    let early: RealtimeSession | null = null;
    let thrown: unknown;
    try {
      await client.agent().start({
        onSession: (session) => {
          early = session;
        },
      });
      throw new Error('start was expected to reject');
    } catch (err) {
      thrown = err;
    }
    const session = early as RealtimeSession | null;
    if (session === null) throw new Error('onSession never fired');
    return { session, thrown };
  }

  it.each(CASES)('%s leaves mic %s and throws %s', async (name, micState, code) => {
    setMic.mockRejectedValue(mediaError(name));

    const { session, thrown } = await startExpectingFailure();

    expect(session.getSnapshot().mediaState.mic).toBe(micState);
    // The subcategory rides the typed error, the way Python and Swift carry
    // it — not the session's wire-facing ``ErrorCode``.
    expect(thrown).toBeInstanceOf(AudioUnavailableError);
    expect((thrown as AudioUnavailableError).code).toBe(code);
  });

  it('leaves an unrelated transport failure off the microphone entirely', async () => {
    setMic.mockRejectedValue(new Error('SFU exploded'));

    const { session, thrown } = await startExpectingFailure();
    const snapshot = session.getSnapshot();

    // The point is not which non-failure state the mic is in, but that a
    // failure with nothing to do with the microphone is never dressed up as
    // one — that is what sends a user to check permissions for a dead SFU.
    expect(['denied', 'not-found', 'in-use']).not.toContain(snapshot.mediaState.mic);
    // The join failed after the server accepted the session, so it reaches
    // the caller and the error axis as one ``SessionStartError``, with the
    // transport's own error kept as its ``cause``.
    expect(snapshot.error?.code).toBe('join_failed');
    expect(thrown).not.toBeInstanceOf(AudioUnavailableError);
    expect(thrown).toBeInstanceOf(SessionStartError);
    expect((thrown as SessionStartError).cause).toBeInstanceOf(Error);
  });
});

describe('a microphone acquired for an abandoned connect is handed back', () => {
  it('stops the track when disconnect lands while the prompt is open', async () => {
    // The OS permission dialog is the slow part of a connect and the user can
    // abandon the session while it is up: ``getUserMedia`` then resolves into
    // a session that no longer exists. Without a release the browser keeps
    // recording — the tab's mic indicator stays lit with nothing behind it.
    let grantPermission!: () => void;
    const prompt = new Promise<void>((resolve) => {
      grantPermission = resolve;
    });
    micPublishes();
    const publish = setMic.getMockImplementation()!;
    setMic.mockImplementation(async (enabled: boolean) => {
      // The prompt gates the acquisition; the publication bookkeeping still
      // has to run, or there is no captured track for the release to find.
      if (enabled) await prompt;
      await publish(enabled);
    });

    const transport = new LiveKitTransport();
    const connecting = transport.connect({
      config: CONFIG,
      startUrl: START_URL,
      authHeaders: { Authorization: 'Bearer test' },
      publishMicrophone: true,
      onMessage: () => {},
      onStateChange: () => {},
      onOutputBlocked: () => {},
    } as unknown as Parameters<typeof transport.connect>[0]);

    // Let the start POST and the join settle, so the connect is parked on the
    // permission prompt and nowhere else.
    await vi.waitFor(() => expect(setMic).toHaveBeenCalledWith(true));

    await transport.disconnect();
    grantPermission();

    await expect(connecting).rejects.toThrow(/closed before its connect completed/);
    // The capture ended — muting the publication would leave the browser
    // recording with nothing behind it, which is the whole point here.
    expect(micTrack.stop).toHaveBeenCalled();
  });

  it('leaves the microphone alone on a connect that completes normally', async () => {
    const transport = new LiveKitTransport();
    await transport.connect({
      config: CONFIG,
      startUrl: START_URL,
      authHeaders: { Authorization: 'Bearer test' },
      publishMicrophone: true,
      onMessage: () => {},
      onStateChange: () => {},
      onOutputBlocked: () => {},
    } as unknown as Parameters<typeof transport.connect>[0]);

    expect(setMic).toHaveBeenCalledWith(true);
    expect(micTrack.stop).not.toHaveBeenCalled();
  });
});

describe('every exit from the window releases the microphone', () => {
  // The window has four exits. Exit ① keeps the microphone — that is the
  // whole point of the session. The other three must hand it back, and the
  // mechanism is the room's stop-on-disconnect, which only fires if teardown
  // actually reaches ``room.disconnect()`` without suppressing ``stopTracks``.
  function emitServerFrame(frame: Record<string, unknown>): void {
    mockHandlers['dataReceived']?.(new TextEncoder().encode(JSON.stringify(frame)), undefined);
  }

  /** A start parked in the ready window with the microphone already live. */
  async function startAndReachTheWindow(): Promise<{
    starting: Promise<RealtimeSession>;
    session: RealtimeSession;
  }> {
    micPublishes();
    const client = new RealtimeClient({ apiKey: 'test-key' });
    let early: RealtimeSession | null = null;
    const starting = client.agent().start({
      onSession: (s) => {
        early = s;
      },
    });
    await vi.waitFor(() => expect(setMic).toHaveBeenCalledWith(true));
    const session = early as RealtimeSession | null;
    if (session === null) throw new Error('onSession never fired');
    return { starting, session };
  }

  it('exit ①: a session that reaches ready keeps its microphone', async () => {
    const { starting } = await startAndReachTheWindow();

    emitServerFrame({ type: 'ready', session_id: 'sess-1' });
    await starting;

    expect(micTrack.stop).not.toHaveBeenCalled();
  });

  it('exit ②: a room that closes before ready releases it', async () => {
    const { starting } = await startAndReachTheWindow();

    mockHandlers['disconnected']?.(undefined);

    await expect(starting).rejects.toThrow();
    expect(micTrack.stop).toHaveBeenCalled();
  });

  it('exit ③: a ready handshake that never arrives releases it', async () => {
    vi.useFakeTimers();
    try {
      const { starting } = await startAndReachTheWindow();
      // Swallow the rejection now; the assertion below is what reads it. An
      // unhandled rejection while the timers run would fail the suite instead.
      const settled = starting.catch((err: unknown) => err);

      await vi.advanceTimersByTimeAsync(40_000);

      await expect(settled).resolves.toBeInstanceOf(SessionStartError);
      expect(micTrack.stop).toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('exit ④: a cancelled start releases it', async () => {
    const { starting, session } = await startAndReachTheWindow();

    await session.close();

    await expect(starting).rejects.toThrow();
    expect(micTrack.stop).toHaveBeenCalled();
  });
});
