// @vitest-environment jsdom
/**
 * ``agent.prepareSession()``: the reserved room, its refresh, the prepared
 * join racing the start POST, and every fallback to the ordinary path.
 */
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { TextEncoder as NodeTextEncoder, TextDecoder as NodeTextDecoder } from 'util';

if (typeof global.TextEncoder === 'undefined') {
  global.TextEncoder = NodeTextEncoder as typeof global.TextEncoder;
}
if (typeof global.TextDecoder === 'undefined') {
  global.TextDecoder = NodeTextDecoder as typeof global.TextDecoder;
}

import { LiveKitTransport } from '../livekit_transport';
import type { PreparedConnectOptions } from '../prepared_room';
import { RealtimeClient } from '../../core/realtime_client';
import { SessionEngine } from '../../core/session_engine';
import type { SessionConfig } from '../../protocol';
import { SDK_NAME, SDK_VERSION } from '../../constants';

const { setMic, roomConnect, publishData, mockHandlers } = vi.hoisted(() => ({
  setMic: vi.fn().mockResolvedValue(undefined),
  roomConnect: vi.fn().mockResolvedValue(undefined),
  publishData: vi.fn().mockResolvedValue(undefined),
  mockHandlers: {} as Record<string, (...args: unknown[]) => void>,
}));

vi.mock('livekit-client', () => {
  class Room {
    state = 'connected';
    localParticipant = { setMicrophoneEnabled: setMic, publishData };
    on(event: string, cb: (...args: unknown[]) => void) {
      mockHandlers[event] = cb;
      return this;
    }
    connect = roomConnect;
    removeAllListeners() {}
    async disconnect() {}
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
    },
    Track: { Kind: { Audio: 'audio' }, Source: { Microphone: 'microphone' } },
    ConnectionState: { Connected: 'connected' },
    LocalVideoTrack: class {},
    RemoteTrack: class {},
  };
});

const START_URL = 'https://api.example.com/api/v1/external/realtime/session/start';
const PREPARE_URL =
  'https://api.example.com/api/v1/external/realtime/session/prepare-room';

const CONFIG: SessionConfig = {
  sdk: { name: SDK_NAME, version: SDK_VERSION },
  type: 'session-config',
  agent: { type: 'inline' },
};

const PREPARED = {
  roomName: 'room-prep',
  roomGrant: 'grant-prep',
  token: 'prep-jwt',
  livekitUrl: 'wss://prep.example',
  preparedAt: Date.now(),
};

const PREPARE_RESPONSE = {
  livekit_url: 'wss://prep.example',
  token: 'prep-jwt',
  room_name: 'room-prep',
  room_grant: 'grant-prep',
};

const SESSION_RESPONSE = {
  livekit_url: 'wss://lk.example',
  token: 'lk-jwt',
  room_name: 'room-1',
  session_id: 'sess-1',
};

function okResponse(body: unknown): Response {
  return { ok: true, status: 200, json: async () => body } as unknown as Response;
}

function rejectedResponse(status: number): Response {
  return {
    ok: false,
    status,
    statusText: 'Rejected',
    headers: { get: () => null },
    json: async () => ({ detail: { code: 'rejected', message: 'no' } }),
    text: async () => '',
  } as unknown as Response;
}

let fetchMock: Mock;

function routeFetch(startBody: unknown): void {
  fetchMock = vi.fn().mockImplementation(async (url: string) => {
    if (url.endsWith('/prepare-room')) return okResponse(PREPARE_RESPONSE);
    return okResponse(startBody);
  });
  global.fetch = fetchMock as unknown as typeof fetch;
}

function startCalls(): [string, RequestInit][] {
  return fetchMock.mock.calls.filter(([url]) =>
    (url as string).endsWith('/start'),
  ) as [string, RequestInit][];
}

function prepareCalls(): [string, RequestInit][] {
  return fetchMock.mock.calls.filter(([url]) =>
    (url as string).endsWith('/prepare-room'),
  ) as [string, RequestInit][];
}

/** The ``prepared`` ref the engine was handed, once ``start`` ran. */
function spyEngineStart(): Mock {
  return vi.spyOn(SessionEngine.prototype, 'start').mockResolvedValue(undefined) as Mock;
}

function preparedRoomHandedTo(started: Mock): string | undefined {
  const options = started.mock.calls[0][0] as { prepared?: { roomName: string } };
  return options.prepared?.roomName;
}

beforeEach(() => {
  setMic.mockClear();
  setMic.mockResolvedValue(undefined);
  roomConnect.mockClear();
  roomConnect.mockResolvedValue(undefined);
  publishData.mockClear();
  for (const key of Object.keys(mockHandlers)) delete mockHandlers[key];
  routeFetch(SESSION_RESPONSE);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('agent.prepareSession()', () => {
  it('rejects the websocket transport', () => {
    const client = new RealtimeClient({ apiKey: 'k', transport: 'websocket' });
    expect(() => client.agent().prepareSession()).toThrow(/webrtc/);
  });

  it('rejects a custom transportFactory', () => {
    const client = new RealtimeClient({
      apiKey: 'k',
      transportFactory: () => new LiveKitTransport(),
    });
    expect(() => client.agent().prepareSession()).toThrow(/webrtc/);
  });

  it('reserves a room immediately, with auth headers', async () => {
    const prepared = new RealtimeClient({ apiKey: 'sk-test' }).agent().prepareSession();
    await vi.waitFor(() => expect(prepareCalls()).toHaveLength(1));
    const [url, init] = prepareCalls()[0];
    expect(url).toBe(PREPARE_URL);
    expect(init.method).toBe('POST');
    expect(init.body).toBe('{}');
    expect(init.headers).toMatchObject({ Authorization: 'Bearer sk-test' });
    prepared.close();
  });

  it('hands the reserved room to the start and is single-use', async () => {
    const prepared = new RealtimeClient({ apiKey: 'sk-test' })
      .agent()
      .prepareSession({ publishMicrophone: false });
    await vi.waitFor(() => expect(prepareCalls()).toHaveLength(1));
    const started = spyEngineStart();
    await prepared.start();
    expect(started).toHaveBeenCalledTimes(1);
    expect(preparedRoomHandedTo(started)).toBe('room-prep');
    const options = started.mock.calls[0][0] as { publishMicrophone?: boolean };
    expect(options.publishMicrophone).toBe(false);
    await expect(prepared.start()).rejects.toThrow(/single-use/);
    expect(prepareCalls()).toHaveLength(1);
  });

  it('waits for a reservation still in flight', async () => {
    let releasePrepare: (response: Response) => void = () => {};
    fetchMock = vi.fn().mockImplementation((url: string) => {
      if (url.endsWith('/prepare-room')) {
        return new Promise<Response>((resolve) => {
          releasePrepare = resolve;
        });
      }
      return Promise.resolve(okResponse(SESSION_RESPONSE));
    });
    global.fetch = fetchMock as unknown as typeof fetch;
    const started = spyEngineStart();
    const prepared = new RealtimeClient({ apiKey: 'sk-test' }).agent().prepareSession();
    const start = prepared.start();
    await vi.waitFor(() => expect(prepareCalls()).toHaveLength(1));
    expect(started).not.toHaveBeenCalled();
    await new Promise((resolve) => setTimeout(resolve, 30));
    releasePrepare(okResponse(PREPARE_RESPONSE));
    await start;
    expect(preparedRoomHandedTo(started)).toBe('room-prep');
    // The wait for the reservation is time the caller spent waiting.
    const options = started.mock.calls[0][0] as { connectStartedAt?: number };
    expect(performance.now() - (options.connectStartedAt ?? performance.now())).toBeGreaterThanOrEqual(30);
  });

  it('starts unprepared when the reservation was declined', async () => {
    fetchMock = vi.fn().mockImplementation(async (url: string) => {
      if (url.endsWith('/prepare-room')) return rejectedResponse(429);
      return okResponse(SESSION_RESPONSE);
    });
    global.fetch = fetchMock as unknown as typeof fetch;
    const prepared = new RealtimeClient({ apiKey: 'sk-test' }).agent().prepareSession();
    await vi.waitFor(() => expect(prepareCalls()).toHaveLength(1));
    const started = spyEngineStart();
    await prepared.start();
    expect(preparedRoomHandedTo(started)).toBeUndefined();
  });

  it('renews the reservation until started or closed', async () => {
    vi.useFakeTimers();
    const prepared = new RealtimeClient({ apiKey: 'sk-test' }).agent().prepareSession();
    await vi.advanceTimersByTimeAsync(0);
    expect(prepareCalls()).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(25 * 60 * 1000);
    expect(prepareCalls()).toHaveLength(2);
    prepared.close();
    await vi.advanceTimersByTimeAsync(25 * 60 * 1000);
    expect(prepareCalls()).toHaveLength(2);
  });

  it('starts unprepared when the reservation request stalls past its timeout', async () => {
    vi.useFakeTimers();
    fetchMock = vi.fn().mockImplementation((url: string, init?: RequestInit) => {
      if (url.endsWith('/prepare-room')) {
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
        });
      }
      return Promise.resolve(okResponse(SESSION_RESPONSE));
    });
    global.fetch = fetchMock as unknown as typeof fetch;
    const started = spyEngineStart();
    const prepared = new RealtimeClient({ apiKey: 'sk-test' }).agent().prepareSession();
    const start = prepared.start();
    await vi.advanceTimersByTimeAsync(40_000);
    await start;
    expect(preparedRoomHandedTo(started)).toBeUndefined();
  });

  it('starts unprepared once a room lapses after a declined renewal', async () => {
    vi.useFakeTimers();
    let prepares = 0;
    fetchMock = vi.fn().mockImplementation(async (url: string) => {
      if (url.endsWith('/prepare-room')) {
        prepares += 1;
        return prepares === 1 ? okResponse(PREPARE_RESPONSE) : rejectedResponse(429);
      }
      return okResponse(SESSION_RESPONSE);
    });
    global.fetch = fetchMock as unknown as typeof fetch;
    const prepared = new RealtimeClient({ apiKey: 'sk-test' }).agent().prepareSession();
    await vi.advanceTimersByTimeAsync(27 * 60 * 1000);
    expect(prepareCalls()).toHaveLength(2);
    const started = spyEngineStart();
    await prepared.start();
    expect(preparedRoomHandedTo(started)).toBeUndefined();
  });
});

describe('LiveKitTransport prepared connect', () => {
  it('joins the prepared room while the start carries the grant headers', async () => {
    routeFetch({ ...SESSION_RESPONSE, room_name: 'room-prep' });
    const t = new LiveKitTransport();
    await t.connect({
      config: CONFIG,
      sessionStartUrl: START_URL,
      prepared: PREPARED,
    } as PreparedConnectOptions);

    expect(roomConnect).toHaveBeenCalledTimes(1);
    expect(roomConnect).toHaveBeenCalledWith('wss://prep.example', 'prep-jwt');
    const [, init] = startCalls()[0];
    expect(init.headers).toMatchObject({
      'x-cosmo-prepared-room-name': 'room-prep',
      'x-cosmo-prepared-room-grant': 'grant-prep',
    });
  });

  it('falls back to the dispatched room when the prepared one is not honored', async () => {
    routeFetch(SESSION_RESPONSE); // names room-1, not room-prep
    const t = new LiveKitTransport();
    await t.connect({
      config: CONFIG,
      sessionStartUrl: START_URL,
      prepared: PREPARED,
    } as PreparedConnectOptions);

    expect(roomConnect).toHaveBeenCalledTimes(2);
    expect(roomConnect).toHaveBeenNthCalledWith(1, 'wss://prep.example', 'prep-jwt');
    expect(roomConnect).toHaveBeenNthCalledWith(2, 'wss://lk.example', 'lk-jwt');
    expect(setMic).toHaveBeenCalledWith(true);
  });

  it('falls back to the dispatched credentials when the prepared join fails', async () => {
    routeFetch({ ...SESSION_RESPONSE, room_name: 'room-prep' });
    // livekit-client emits Disconnected before a failed connect() rejects.
    roomConnect
      .mockImplementationOnce(async () => {
        mockHandlers['disconnected']?.(undefined);
        throw new Error('ice failed');
      })
      .mockResolvedValueOnce(undefined);
    const t = new LiveKitTransport();
    const closed = vi.fn();
    t.onClose(closed);
    await t.connect({
      config: CONFIG,
      sessionStartUrl: START_URL,
      prepared: PREPARED,
    } as PreparedConnectOptions);

    expect(roomConnect).toHaveBeenCalledTimes(2);
    expect(roomConnect).toHaveBeenNthCalledWith(2, 'wss://lk.example', 'lk-jwt');
    // The failed shell's Disconnected is the join's failure, not a session close.
    expect(closed).not.toHaveBeenCalled();
  });

  it('sends no prepared headers on an unprepared connect', async () => {
    const t = new LiveKitTransport();
    await t.connect({ config: CONFIG, sessionStartUrl: START_URL });
    const [, init] = startCalls()[0];
    expect(init.headers).not.toHaveProperty('x-cosmo-prepared-room-name');
    expect(roomConnect).toHaveBeenCalledWith('wss://lk.example', 'lk-jwt');
  });

  it('times the mic publish from its own start, not from the join', async () => {
    fetchMock = vi.fn().mockImplementation(async (url: string) => {
      if (url.endsWith('/prepare-room')) return okResponse(PREPARE_RESPONSE);
      await new Promise((resolve) => setTimeout(resolve, 60));
      return okResponse({ ...SESSION_RESPONSE, room_name: 'room-prep' });
    });
    global.fetch = fetchMock as unknown as typeof fetch;
    setMic.mockImplementation(
      () => new Promise<void>((resolve) => setTimeout(resolve, 5)),
    );
    const t = new LiveKitTransport();
    let timings: { wsMs: number; micMs: number } | null = null;
    await t.connect({
      config: CONFIG,
      sessionStartUrl: START_URL,
      prepared: PREPARED,
      onConnectTimings: (reported) => {
        timings = reported;
      },
    } as PreparedConnectOptions);
    expect(timings).not.toBeNull();
    // The join finished under the POST's shadow; the mic leg starts only
    // after the POST, so it must not absorb the wait for it.
    expect(timings!.micMs).toBeLessThan(timings!.wsMs);
  });

  it('fails the connect when the prepared room is lost while the start is pending', async () => {
    let releaseStart: (response: Response) => void = () => {};
    fetchMock = vi.fn().mockImplementation((url: string) => {
      if (url.endsWith('/prepare-room')) return Promise.resolve(okResponse(PREPARE_RESPONSE));
      return new Promise<Response>((resolve) => {
        releaseStart = resolve;
      });
    });
    global.fetch = fetchMock as unknown as typeof fetch;
    const t = new LiveKitTransport();
    const closed = vi.fn();
    t.onClose(closed);
    const connect = t.connect({
      config: CONFIG,
      sessionStartUrl: START_URL,
      prepared: PREPARED,
    } as PreparedConnectOptions);
    await vi.waitFor(() => expect(roomConnect).toHaveBeenCalledTimes(1));
    // Let the (instant) join resolve: only a room that joined counts as lost.
    await new Promise((resolve) => setTimeout(resolve, 0));
    mockHandlers['disconnected']?.(undefined);
    releaseStart(okResponse({ ...SESSION_RESPONSE, room_name: 'room-prep' }));
    await expect(connect).rejects.toThrow(/lost before its connect completed/);
    expect(closed).toHaveBeenCalledTimes(1);
    expect(roomConnect).toHaveBeenCalledTimes(1);
    expect(setMic).not.toHaveBeenCalled();
  });

  it('does not build a fresh room once disconnected mid-connect', async () => {
    let releaseStart: (response: Response) => void = () => {};
    fetchMock = vi.fn().mockImplementation((url: string) => {
      if (url.endsWith('/prepare-room')) return Promise.resolve(okResponse(PREPARE_RESPONSE));
      return new Promise<Response>((resolve) => {
        releaseStart = resolve;
      });
    });
    global.fetch = fetchMock as unknown as typeof fetch;
    const t = new LiveKitTransport();
    const connect = t.connect({
      config: CONFIG,
      sessionStartUrl: START_URL,
      prepared: PREPARED,
    } as PreparedConnectOptions);
    await Promise.resolve();
    await t.disconnect();
    // Not honored: the fallback would otherwise join a second room.
    releaseStart(okResponse(SESSION_RESPONSE));
    await expect(connect).rejects.toThrow(/closed before its connect completed/);
    expect(roomConnect).toHaveBeenCalledTimes(1);
    expect(setMic).not.toHaveBeenCalled();
  });
});

describe('LiveKitTransport prepared start rejection', () => {
  it('does not retry once disconnected mid-start', async () => {
    let releaseStart: (response: Response) => void = () => {};
    fetchMock = vi.fn().mockImplementation((url: string) => {
      if (url.endsWith('/prepare-room')) return Promise.resolve(okResponse(PREPARE_RESPONSE));
      return new Promise<Response>((resolve) => {
        releaseStart = resolve;
      });
    });
    global.fetch = fetchMock as unknown as typeof fetch;
    const t = new LiveKitTransport();
    const connect = t.connect({ config: CONFIG, sessionStartUrl: START_URL, prepared: PREPARED } as PreparedConnectOptions);
    await vi.waitFor(() => expect(startCalls()).toHaveLength(1));
    await t.disconnect();
    releaseStart(rejectedResponse(403));
    await expect(connect).rejects.toThrow(/closed before its connect completed/);
    expect(startCalls()).toHaveLength(1);
  });

  it('does not retry a version mismatch, whatever its status', async () => {
    fetchMock = vi.fn().mockImplementation(async (url: string) => {
      if (url.endsWith('/prepare-room')) return okResponse(PREPARE_RESPONSE);
      return {
        ok: false,
        status: 403,
        statusText: 'Forbidden',
        headers: { get: () => null },
        json: async () => ({ detail: { code: 'version_mismatch', message: 'upgrade' } }),
        text: async () => '',
      } as unknown as Response;
    });
    global.fetch = fetchMock as unknown as typeof fetch;
    const t = new LiveKitTransport();
    await expect(
      t.connect({ config: CONFIG, sessionStartUrl: START_URL, prepared: PREPARED } as PreparedConnectOptions),
    ).rejects.toMatchObject({ name: 'SessionStartError' });
    expect(startCalls()).toHaveLength(1);
  });

  it('does not retry a gateway error — the start may already have landed', async () => {
    fetchMock = vi.fn().mockImplementation(async (url: string) => {
      if (url.endsWith('/prepare-room')) return okResponse(PREPARE_RESPONSE);
      return rejectedResponse(502);
    });
    global.fetch = fetchMock as unknown as typeof fetch;
    const t = new LiveKitTransport();
    await expect(
      t.connect({ config: CONFIG, sessionStartUrl: START_URL, prepared: PREPARED } as PreparedConnectOptions),
    ).rejects.toMatchObject({ status: 502 });
    expect(startCalls()).toHaveLength(1);
    expect(setMic).not.toHaveBeenCalled();
  });

  it('retries the start without the ref when the server rejects it', async () => {
    fetchMock = vi.fn().mockImplementation(async (url: string, init?: RequestInit) => {
      if ((url as string).endsWith('/prepare-room')) return okResponse(PREPARE_RESPONSE);
      const headers = (init?.headers ?? {}) as Record<string, string>;
      if ('x-cosmo-prepared-room-name' in headers) {
        return {
          ok: false,
          status: 403,
          statusText: 'Forbidden',
          headers: { get: () => null },
          json: async () => ({ detail: { code: 'forbidden', message: 'not yours' } }),
          text: async () => '',
        } as unknown as Response;
      }
      return okResponse(SESSION_RESPONSE);
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    const t = new LiveKitTransport();
    await t.connect({
      config: CONFIG,
      sessionStartUrl: START_URL,
      prepared: PREPARED,
    } as PreparedConnectOptions);

    const starts = startCalls();
    expect(starts).toHaveLength(2);
    expect(starts[0][1].headers).toMatchObject({
      'x-cosmo-prepared-room-name': 'room-prep',
    });
    expect(starts[1][1].headers).not.toHaveProperty('x-cosmo-prepared-room-name');
    expect(roomConnect).toHaveBeenLastCalledWith('wss://lk.example', 'lk-jwt');
  });
});
