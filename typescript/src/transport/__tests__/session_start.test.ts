// @vitest-environment jsdom
/**
 * LiveKitTransport.connect: the session-start POST (raw ``session-config``
 * body, bearer headers, no cookie credentials) and the ``bind-input``
 * voice-binding frame that follows mic publish.
 */
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { SDK_NAME, SDK_VERSION } from '../../constants';
import { TextEncoder as NodeTextEncoder, TextDecoder as NodeTextDecoder } from 'util';

if (typeof global.TextEncoder === 'undefined') {
  global.TextEncoder = NodeTextEncoder as typeof global.TextEncoder;
}
if (typeof global.TextDecoder === 'undefined') {
  global.TextDecoder = NodeTextDecoder as typeof global.TextDecoder;
}

import { LiveKitTransport } from '../livekit_transport';
import { SessionEngine } from '../../core/session_engine';
import {
  SessionStartError,
} from '../session_start_error';
import type { SessionConfig } from '../../protocol';

const { setMic, roomConnect, publishData, mockHandlers, mockRemoteParticipants } =
  vi.hoisted(() => ({
    setMic: vi.fn().mockResolvedValue(undefined),
    roomConnect: vi.fn().mockResolvedValue(undefined),
    publishData: vi.fn().mockResolvedValue(undefined),
    mockHandlers: {} as Record<string, (...args: unknown[]) => void>,
    mockRemoteParticipants: new Map<string, unknown>(),
  }));

vi.mock('livekit-client', () => {
  class Room {
    state = 'connected';
    localParticipant = { setMicrophoneEnabled: setMic, publishData };
    remoteParticipants = mockRemoteParticipants;
    on(event: string, cb: (...args: unknown[]) => void) {
      mockHandlers[event] = cb;
      return this;
    }
    connect = roomConnect;
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
  timings: {
    version_check_ms: 1,
    project_check_ms: 2,
    provider_resolve_ms: 3,
    db_insert_ms: 4,
    mint_tokens_ms: 5,
    dispatch_ms: 6,
    total_ms: 7,
  },
};

function okResponse(body: unknown): Response {
  return { ok: true, status: 200, json: async () => body } as unknown as Response;
}

type PublishedFrame = { type: string } & Record<string, unknown>;

function publishedFrames(): PublishedFrame[] {
  return publishData.mock.calls.map(
    ([bytes]) => JSON.parse(new TextDecoder().decode(bytes as Uint8Array)) as PublishedFrame,
  );
}

async function flushAsync(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

let fetchMock: Mock;

beforeEach(() => {
  setMic.mockClear();
  roomConnect.mockClear();
  publishData.mockClear();
  mockRemoteParticipants.clear();
  for (const key of Object.keys(mockHandlers)) delete mockHandlers[key];
  fetchMock = vi.fn().mockResolvedValue(okResponse(SESSION_RESPONSE));
  global.fetch = fetchMock as unknown as typeof fetch;
});

describe('LiveKitTransport session-start POST', () => {
  it('POSTs the session-config as the raw JSON body with Content-Type and auth headers', async () => {
    const t = new LiveKitTransport();
    await t.connect({
      config: CONFIG,
      sessionStartUrl: START_URL,
      getAuthHeaders: () => ({ Authorization: 'Bearer end-user-jwt' }),
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(START_URL);
    expect(init.method).toBe('POST');
    expect(init.headers).toMatchObject({
      'Content-Type': 'application/json',
      Authorization: 'Bearer end-user-jwt',
    });
    expect(init.body).toBe(JSON.stringify(CONFIG));
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(body.type).toBe('session-config');
    expect(body).not.toHaveProperty('init');
    // Bearer-authenticated endpoint — the transport must not opt into
    // cookie credentials (would force Access-Control-Allow-Credentials
    // on cross-origin embedders for no benefit).
    expect(init.credentials).toBeUndefined();
  });

  it('resolves the livekit fields and reports the minted session id', async () => {
    const onSessionStarted = vi.fn();
    const t = new LiveKitTransport();
    await t.connect({ config: CONFIG, sessionStartUrl: START_URL, onSessionStarted });

    expect(roomConnect).toHaveBeenCalledWith('wss://lk.example', 'lk-jwt');
    expect(onSessionStarted).toHaveBeenCalledWith('sess-1');
  });

  it('attributes each connect phase to the leg that spent it', async () => {
    // Give each leg a distinguishable cost so a phase attributed to the wrong
    // leg — or a total that does not span the whole connect — fails here.
    const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));
    fetchMock.mockImplementation(async () => {
      await delay(60);
      return okResponse(SESSION_RESPONSE);
    });
    roomConnect.mockImplementation(async () => {
      await delay(30);
    });
    setMic.mockImplementation(async () => {
      await delay(15);
    });

    const onConnectTimings = vi.fn();
    const t = new LiveKitTransport();
    await t.connect({ config: CONFIG, sessionStartUrl: START_URL, onConnectTimings });

    expect(onConnectTimings).toHaveBeenCalledTimes(1);
    const timings = onConnectTimings.mock.calls[0][0];

    // Ordering, not exact values — timers are not precise enough to pin ms.
    expect(timings.wsMs).toBeGreaterThan(timings.roomMs);
    expect(timings.roomMs).toBeGreaterThan(timings.micMs);
    expect(timings.micMs).toBeGreaterThan(0);
    // No prepared-room fast path here, so the phases account for the whole
    // connect with nothing unattributed.
    expect(timings.totalConnectMs).toBeCloseTo(
      timings.wsMs + timings.roomMs + timings.micMs,
      0,
    );
    // The server's own breakdown rides through rather than being dropped at
    // the transport boundary.
    expect(timings.serverTimings).toEqual(SESSION_RESPONSE.timings);
    // A mark that only lands later is unresolved at the connect.
    expect(timings.readyMs).toBeNull();
    // The origin the phases were measured from rides along, so a later mark
    // can be expressed against the same clock.
    const startedAt = onConnectTimings.mock.calls[0][1] as number;
    expect(performance.now() - startedAt).toBeGreaterThanOrEqual(timings.totalConnectMs);
  });

  it('reports a zero mic phase when the session publishes no microphone', async () => {
    const onConnectTimings = vi.fn();
    const t = new LiveKitTransport();
    await t.connect({
      config: CONFIG,
      sessionStartUrl: START_URL,
      publishMicrophone: false,
      onConnectTimings,
    });

    expect(setMic).not.toHaveBeenCalled();
    expect(onConnectTimings.mock.calls[0][0].micMs).toBe(0);
  });

  it('throws SessionStartError carrying the server detail on a rejection', async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 402,
      statusText: 'Payment Required',
      headers: new Headers(),
      json: async () => ({
        error: { type: 'api_error', code: 'free_minutes_exhausted', message: 'Free minutes exhausted.' },
      }),
    } as unknown as Response);
    const t = new LiveKitTransport();

    const err = await t
      .connect({ config: CONFIG, sessionStartUrl: START_URL })
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(SessionStartError);
    expect((err as SessionStartError).status).toBe(402);
    expect((err as SessionStartError).detail).toEqual({
      code: 'free_minutes_exhausted',
      message: 'Free minutes exhausted.',
      extra: {},
    });
    expect(roomConnect).not.toHaveBeenCalled();
  });

  it('throws SessionStartError with the Retry-After delta on a 429', async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 429,
      statusText: 'Too Many Requests',
      headers: new Headers({ 'retry-after': '15' }),
      json: async () => ({
        error: {
          type: 'api_error',
          code: 'concurrent_session_limit',
          message: 'This workspace already has 2 active sessions (limit 2).',
          limit: 2,
          active: 2,
        },
      }),
    } as unknown as Response);
    const t = new LiveKitTransport();

    const err = await t
      .connect({ config: CONFIG, sessionStartUrl: START_URL })
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(SessionStartError);
    expect((err as SessionStartError).retryAfterSeconds).toBe(15);
    expect((err as SessionStartError).detail).toMatchObject({
      code: 'concurrent_session_limit',
      limit: 2,
      active: 2,
    });
    expect(roomConnect).not.toHaveBeenCalled();
  });

  it('wraps a fetch that never reached the server, keeping it off the handshake path', async () => {
    const cause = new TypeError('Failed to fetch');
    fetchMock.mockRejectedValue(cause);
    const t = new LiveKitTransport();

    const err = await t
      .connect({ config: CONFIG, sessionStartUrl: START_URL })
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(SessionStartError);
    expect((err as SessionStartError).code).toBe('transport');
    expect((err as Error).cause).toBe(cause);
    // The page (jsdom's origin) and START_URL differ, so the bare
    // ``Failed to fetch`` is annotated with the cross-origin possibility.
    expect((err as Error).message).toContain('cross-origin');
    expect((err as Error).message).toContain('https://api.example.com');
    // A pre-response failure is NOT a rejection by the server, and the code
    // says so: no status, because nothing answered.
    expect((err as SessionStartError).status).toBeNull();
    expect((err as SessionStartError).serverCode).toBeUndefined();
    expect(roomConnect).not.toHaveBeenCalled();
  });
});

describe('LiveKitTransport bind-input', () => {
  it('publishes a bind-input frame after the mic publish', async () => {
    const t = new LiveKitTransport();
    await t.connect({ config: CONFIG, sessionStartUrl: START_URL });

    expect(setMic).toHaveBeenCalledWith(true);
    const bindFrames = publishedFrames().filter((f) => f.type === 'bind-input');
    expect(bindFrames).toEqual([{ type: 'bind-input' }]);
  });

  it('skips mic publish and bind-input when publishMicrophone is false', async () => {
    const t = new LiveKitTransport();
    await t.connect({ config: CONFIG, sessionStartUrl: START_URL, publishMicrophone: false });

    expect(setMic).not.toHaveBeenCalled();
    expect(publishedFrames().filter((f) => f.type === 'bind-input')).toHaveLength(0);
  });

  it('re-sends bind-input when the room reconnects', async () => {
    const t = new LiveKitTransport();
    await t.connect({ config: CONFIG, sessionStartUrl: START_URL });
    publishData.mockClear();

    mockHandlers['reconnected']?.();
    await flushAsync();

    expect(publishedFrames().filter((f) => f.type === 'bind-input')).toHaveLength(1);
  });

  it('does not re-send bind-input on reconnect when the mic was never published', async () => {
    const t = new LiveKitTransport();
    await t.connect({ config: CONFIG, sessionStartUrl: START_URL, publishMicrophone: false });
    publishData.mockClear();

    mockHandlers['reconnected']?.();
    await flushAsync();

    expect(publishedFrames().filter((f) => f.type === 'bind-input')).toHaveLength(0);
  });
});

/**
 * The client half of the connect waterfall, driven through a real
 * ``SessionEngine`` over the real transport: the transport measures the
 * phases, the engine folds in the marks that land after the connect and
 * reports the whole thing to the worker.
 *
 * ``performance.now`` is stubbed so every phase has an exact, independently
 * chosen duration — a mis-attributed phase or a lost rounding shows as a
 * wrong integer rather than a flaky comparison.
 */
describe('connect-timings report', () => {
  let clock = 0;
  let nowSpy: Mock;

  function advanceEachPhase(): void {
    fetchMock.mockImplementation(async () => {
      clock += 210;
      return okResponse(SESSION_RESPONSE);
    });
    roomConnect.mockImplementation(async () => {
      clock += 430;
    });
    setMic.mockImplementation(async () => {
      clock += 55;
    });
  }

  function makeEngine(): SessionEngine {
    return new SessionEngine({
      createTransport: () => new LiveKitTransport(),
      startUrl: () => START_URL,
      dialUrl: (id) => `${START_URL}/${id}/dial`,
      usageUrl: (id) => `${START_URL}/${id}/usage`,
      resolveAuthHeaders: async () => ({}),
      onStartUnauthorized: () => {},
    });
  }

  function emitServerFrame(frame: Record<string, unknown>): void {
    mockHandlers['dataReceived']?.(
      new TextEncoder().encode(JSON.stringify(frame)),
      undefined,
    );
  }

  function reports(): PublishedFrame[] {
    return publishedFrames().filter((f) => f.type === 'connect-timings');
  }

  beforeEach(() => {
    clock = 0;
    nowSpy = vi.spyOn(performance, 'now').mockImplementation(() => clock) as unknown as Mock;
    advanceEachPhase();
  });

  afterEach(() => {
    nowSpy.mockRestore();
  });

  it('reports the measured phases once the session is ready', async () => {
    const engine = makeEngine();
    const started = engine.start({ config: CONFIG, publishMicrophone: true });
    await flushAsync();

    // Nothing to report until the ready handshake lands.
    expect(reports()).toHaveLength(0);

    clock = 1180;
    emitServerFrame({ type: 'ready', session_id: 'sess-1' });
    await started;
    await flushAsync();

    expect(reports()).toEqual([
      {
        type: 'connect-timings',
        request_ms: 210,
        room_ms: 430,
        mic_ms: 55,
        ready_ms: 1180,
        server: SESSION_RESPONSE.timings,
      },
    ]);
    expect(engine.getConnectTimings()?.readyMs).toBe(1180);
  });

  it('rounds a fractional phase to whole milliseconds', async () => {
    fetchMock.mockImplementation(async () => {
      clock += 210.6;
      return okResponse(SESSION_RESPONSE);
    });
    const engine = makeEngine();
    const started = engine.start({ config: CONFIG, publishMicrophone: true });
    await flushAsync();

    clock = 1180.4;
    emitServerFrame({ type: 'ready', session_id: 'sess-1' });
    await started;
    await flushAsync();

    expect(reports()[0]).toMatchObject({ request_ms: 211, ready_ms: 1180 });
    // The client-side breakdown keeps the unrounded measurement.
    expect(engine.getConnectTimings()?.wsMs).toBeCloseTo(210.6, 5);
  });

  it('omits the server echo when the start response carried no timings', async () => {
    fetchMock.mockImplementation(async () => {
      clock += 210;
      return okResponse({ ...SESSION_RESPONSE, timings: undefined });
    });
    const engine = makeEngine();
    const started = engine.start({ config: CONFIG, publishMicrophone: true });
    await flushAsync();

    clock = 1180;
    emitServerFrame({ type: 'ready', session_id: 'sess-1' });
    await started;
    await flushAsync();

    expect(reports()[0]).not.toHaveProperty('server');
  });

  it('measures ready against the connect start even when it beats the connect', async () => {
    // ``ready`` arrives over the data channel while the mic publish is still
    // pending, so the timings object it would fold into does not exist yet.
    let releaseMic = (): void => {};
    const micPublished = new Promise<void>((resolve) => {
      releaseMic = resolve;
    });
    setMic.mockImplementation(async () => {
      await micPublished;
      clock += 55;
    });

    const engine = makeEngine();
    const started = engine.start({ config: CONFIG, publishMicrophone: true });
    await flushAsync();

    clock = 660;
    emitServerFrame({ type: 'ready', session_id: 'sess-1' });
    await flushAsync();
    // The mark is held, but there is nothing to report it against yet.
    expect(reports()).toHaveLength(0);

    releaseMic();
    await started;
    await flushAsync();

    expect(reports()).toEqual([
      {
        type: 'connect-timings',
        request_ms: 210,
        room_ms: 430,
        mic_ms: 75,
        ready_ms: 660,
        server: SESSION_RESPONSE.timings,
      },
    ]);
    // Ready genuinely landed before the connect finished; the report says so
    // rather than clamping it to the total.
    expect(engine.getConnectTimings()?.totalConnectMs).toBe(715);
  });

  it('does not report again when the agent speaks after ready', async () => {
    const engine = makeEngine();
    const started = engine.start({ config: CONFIG, publishMicrophone: true });
    await flushAsync();

    clock = 1180;
    emitServerFrame({ type: 'ready', session_id: 'sess-1' });
    await started;
    clock = 1900;
    emitServerFrame({ type: 'bot-started-speaking' });
    clock = 4300;
    emitServerFrame({ type: 'bot-started-speaking' });
    await flushAsync();

    expect(reports()).toHaveLength(1);
    expect(reports()[0]?.ready_ms).toBe(1180);
  });

  it('reports once when ready repeats over the session', async () => {
    const engine = makeEngine();
    const started = engine.start({ config: CONFIG, publishMicrophone: true });
    await flushAsync();

    clock = 1180;
    emitServerFrame({ type: 'ready', session_id: 'sess-1' });
    await started;
    clock = 9000;
    emitServerFrame({ type: 'ready', session_id: 'sess-1' });
    await flushAsync();

    expect(reports()).toHaveLength(1);
    expect(reports()[0]?.ready_ms).toBe(1180);
  });

  it('reports nothing while the ready handshake is still pending', async () => {
    const engine = makeEngine();
    const started = engine.start({ config: CONFIG, publishMicrophone: true });
    await flushAsync();
    clock = 9000;
    await flushAsync();

    expect(reports()).toHaveLength(0);
    expect(engine.getConnectTimings()?.readyMs).toBeNull();

    await engine.close();
    await expect(started).rejects.toThrow('ended before reaching ready');
  });

  it('agent speech before ready releases nothing — only the handshake does', async () => {
    // Readiness is room state now (participant attribute + frame), so the
    // report waits for the real handshake instead of inferring it from the
    // agent speaking.
    const engine = makeEngine();
    const started = engine.start({ config: CONFIG, publishMicrophone: true });
    await flushAsync();

    clock = 1900;
    emitServerFrame({ type: 'bot-started-speaking' });
    await flushAsync();
    expect(reports()).toHaveLength(0);

    clock = 2400;
    emitServerFrame({ type: 'ready', session_id: 'sess-1' });
    await started;
    await flushAsync();

    expect(reports()).toHaveLength(1);
    expect(reports()[0]?.ready_ms).toBe(2400);
    expect(engine.getConnectTimings()?.readyMs).toBe(2400);
  });

  it('keeps a failed report out of the session', async () => {
    const engine = makeEngine();
    const started = engine.start({ config: CONFIG, publishMicrophone: true });
    await flushAsync();
    publishData.mockRejectedValueOnce(new Error('data channel closed'));

    clock = 1180;
    emitServerFrame({ type: 'ready', session_id: 'sess-1' });
    await started;
    await flushAsync();

    expect(engine.getSnapshot().error).toBeNull();
    expect(engine.getConnectTimings()?.readyMs).toBe(1180);
  });
});

describe('ready via participant attribute', () => {
  const READY_JSON = JSON.stringify({ type: 'ready', session_id: 'sess-1' });

  function makeEngine(): SessionEngine {
    return new SessionEngine({
      createTransport: () => new LiveKitTransport(),
      startUrl: () => START_URL,
      dialUrl: (id) => `${START_URL}/${id}/dial`,
      usageUrl: (id) => `${START_URL}/${id}/usage`,
      resolveAuthHeaders: async () => ({}),
      onStartUnauthorized: () => {},
    });
  }

  function agentParticipant(attributes: Record<string, string>): {
    identity: string;
    kind: string;
    attributes: Record<string, string>;
  } {
    return { identity: 'agent:sess-1', kind: 'agent', attributes };
  }

  it('synthesizes ready from an attribute already present at join', async () => {
    // The agent came up before this client joined: its one-shot data frame
    // is long gone, but the attribute is room state the join delivers.
    mockRemoteParticipants.set(
      'agent:sess-1',
      agentParticipant({ 'cosmo.ready': READY_JSON }),
    );
    const engine = makeEngine();

    await engine.start({ config: CONFIG, publishMicrophone: true });

    expect(engine.getSnapshot().transportState).toBe('ready');
    expect(engine.getLastReady()?.sessionId).toBe('sess-1');
  });

  it('synthesizes ready when the attribute lands after join, and drops the frame echo', async () => {
    const engine = makeEngine();
    const readies: unknown[] = [];
    engine.on('ready', (event) => readies.push(event));
    const started = engine.start({ config: CONFIG, publishMicrophone: true });
    await flushAsync();
    expect(readies).toHaveLength(0);

    const participant = agentParticipant({ 'cosmo.ready': READY_JSON });
    mockRemoteParticipants.set('agent:sess-1', participant);
    mockHandlers['participantAttributesChanged']?.(
      { 'cosmo.ready': READY_JSON },
      participant,
    );
    await started;
    // The data-channel broadcast still arrives; first delivery won.
    mockHandlers['dataReceived']?.(
      new TextEncoder().encode(READY_JSON),
      undefined,
    );
    await flushAsync();

    expect(readies).toHaveLength(1);
    expect(engine.getSnapshot().transportState).toBe('ready');
  });

  it('re-reads the sign after a reconnect that rebuilt the agent', async () => {
    // A recovery can rebuild participants with attributes already
    // populated, so no attribute-change event fires: the agent became ready
    // during the outage and the rejoin is the only place to learn it.
    const engine = makeEngine();
    const started = engine.start({ config: CONFIG, publishMicrophone: true });
    await flushAsync();
    expect(engine.getSnapshot().transportState).not.toBe('ready');

    mockRemoteParticipants.set(
      'agent:sess-1',
      agentParticipant({ 'cosmo.ready': READY_JSON }),
    );
    mockHandlers['reconnected']?.();
    await started;
    await flushAsync();

    expect(engine.getSnapshot().transportState).toBe('ready');
    expect(engine.getLastReady()?.sessionId).toBe('sess-1');
  });

  it('a reconnect re-scan does not re-emit a sign already seen', async () => {
    mockRemoteParticipants.set(
      'agent:sess-1',
      agentParticipant({ 'cosmo.ready': READY_JSON }),
    );
    const engine = makeEngine();
    const readies: unknown[] = [];
    engine.on('ready', (event) => readies.push(event));
    await engine.start({ config: CONFIG, publishMicrophone: true });

    mockHandlers['reconnected']?.();
    await flushAsync();

    expect(readies).toHaveLength(1);
  });

  it('ignores attributes from a non-agent participant', async () => {
    mockRemoteParticipants.set('user:mallory', {
      identity: 'user:mallory',
      kind: 'standard',
      attributes: { 'cosmo.ready': READY_JSON },
    });
    const engine = makeEngine();
    const started = engine.start({ config: CONFIG, publishMicrophone: true });
    await flushAsync();

    expect(engine.getSnapshot().transportState).not.toBe('ready');

    await engine.close();
    await expect(started).rejects.toThrow('ended before reaching ready');
  });
});
