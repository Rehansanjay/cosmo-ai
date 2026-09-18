/** ``client.agent({...}).start({...})`` → what the transport receives:
 *  the wire ``session-config`` body plus the mic-publish flag, and defaults
 *  resolution from ``RealtimeClientOptions.defaults``. Python's
 *  ``tests/test_agent.py`` is the cross-SDK reference. */

import { describe, expect, it, vi } from 'vitest';
import { SessionStateError } from '../errors';
import { TextEncoder as NodeTextEncoder, TextDecoder as NodeTextDecoder } from 'util';

if (typeof global.TextEncoder === 'undefined') {
  global.TextEncoder = NodeTextEncoder as typeof global.TextEncoder;
}
if (typeof global.TextDecoder === 'undefined') {
  global.TextDecoder = NodeTextDecoder as typeof global.TextDecoder;
}

import { GeminiModel, GrokModel, OpenAILiveModel, OpenAIMiniModel, OpenAIModel } from '../agent';
import { setLogLevel } from '../logger';
import { RealtimeClient } from '../realtime_client';
import type { RealtimeSession } from '../session';
import type { SessionState } from '../state';
import { SessionStartError } from '../../transport/session_start_error';
import {
  inlineAgent,
  makeFakeTransport,
  fakeSessionResponse,
  type FakeTransport,
} from './test_helpers';

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

describe('RealtimeAgent.start → session-config body', () => {
  it('omits the session block entirely when nothing sets it', async () => {
    const fake = makeFakeTransport();
    const client = new RealtimeClient({ apiKey: 'test-key', transportFactory: () => fake });

    await client.agent({ voice: 'Breezy' }).start();

    const config = fake.lastConfig();
    expect(config?.agent).toEqual({
      type: 'inline',
      voice: { name: 'Breezy' },
    });
    expect(config?.session).toBeUndefined();
    expect(fake.lastPublishMicrophone()).toBe(true);
  });

  it('suppresses mic publish for a silent-observer session (publishMicrophone: false)', async () => {
    const fake = makeFakeTransport();
    const client = new RealtimeClient({ apiKey: 'test-key', transportFactory: () => fake });

    await client.agent().start({
      publishMicrophone: false,
    });

    expect(fake.lastPublishMicrophone()).toBe(false);
  });

  it('surfaces transport-owned autoplay blocking through media state', async () => {
    const fake = makeFakeTransport();
    const client = new RealtimeClient({ apiKey: 'test-key', transportFactory: () => fake });
    const session = await client.agent().start();

    fake.emitOutputBlocked(true);
    expect(session.getSnapshot().mediaState.output).toBe('blocked');

    fake.emitOutputBlocked(false);
    expect(session.getSnapshot().mediaState.output).toBe('silent');
  });

  it('preserves an early muted state when connect finishes', async () => {
    let releaseConnect!: () => void;
    const connectGate = new Promise<void>((resolve) => { releaseConnect = resolve; });
    const fake = makeFakeTransport({ connectGate });
    const client = new RealtimeClient({ apiKey: 'test-key', transportFactory: () => fake });
    let earlySession: RealtimeSession | null = null;
    const starting = client.agent().start({ onSession: (session) => { earlySession = session; } });
    await vi.waitFor(() => expect(fake.lastConfig()).toBeDefined());
    fake.emitMessage({ type: 'ready', session_id: 'sess-fake' });
    const sessionBeforeConnect = earlySession as RealtimeSession | null;
    if (sessionBeforeConnect === null) throw new Error('onSession was not called');

    await sessionBeforeConnect.setMuted(true);
    releaseConnect();
    const session = await starting;

    expect(session.getSnapshot().mediaState.mic).toBe('muted');
  });

  it('routes persona greeting/noise cancellation and the per-run resume', async () => {
    const fake = makeFakeTransport();
    const client = new RealtimeClient({ apiKey: 'test-key', transportFactory: () => fake });

    await client
      .agent({ greeting: 'Welcome back!', audio: { noiseCancellation: 'voice_focus' } })
      .start({ resumeSessionId: 'sess-prior' });

    const config = fake.lastConfig();
    expect(config?.agent).toEqual({
      type: 'inline',
      greeting: 'Welcome back!',
      audio: { noise_cancellation: 'voice_focus' },
    });
    expect(config?.session).toEqual({
      experimental: { resume_session_id: 'sess-prior' },
    });
  });

  it('carries greeting and noise cancellation like any persona field', async () => {
    const fake = makeFakeTransport();
    const client = new RealtimeClient({ apiKey: 'test-key', transportFactory: () => fake });

    await client
      .agent({
        instructions: 'persona',
        voice: 'Puck',
        greeting: 'Hello!',
        audio: { noiseCancellation: 'voice_focus' },
      })
      .start();

    const agent = inlineAgent(fake.lastConfig());
    expect(agent?.instructions).toBe('persona');
    expect(agent?.voice).toEqual({ name: 'Puck' });
    expect(agent?.greeting).toBe('Hello!');
    expect(agent?.audio).toEqual({ noise_cancellation: 'voice_focus' });
  });

  it('routes a catalog-agent name and inputs onto the tagged agent block', async () => {
    const fake = makeFakeTransport();
    const client = new RealtimeClient({ apiKey: 'test-key', transportFactory: () => fake });

    await client.catalogAgent('driver-pay', { inputs: { caller_name: 'Sam' } }).start();

    expect(fake.lastConfig()?.agent).toEqual({
      type: 'catalog',
      name: 'driver-pay',
      inputs: { caller_name: 'Sam' },
    });
  });

  it('parses the resolved-agent echo off the ready frame', async () => {
    const fake = makeFakeTransport({
      readyFrame: {
        type: 'ready',
        session_id: 'sess-1',
        agent: { name: 'driver-pay', tools: ['cosmo.web_search', 'lookup'] },
      },
    });
    const client = new RealtimeClient({ apiKey: 'test-key', transportFactory: () => fake });
    const session = await client.catalogAgent('driver-pay').start();
    const readyEvents: unknown[] = [];
    session.on('ready', (e) => readyEvents.push(e));

    expect(readyEvents).toHaveLength(1);
    expect((readyEvents[0] as { agent: unknown }).agent).toEqual({
      name: 'driver-pay',
      tools: ['cosmo.web_search', 'lookup'],
    });
  });

  it('reports a null resolved agent for an inline-agent ready frame', async () => {
    const fake = makeFakeTransport();
    const client = new RealtimeClient({ apiKey: 'test-key', transportFactory: () => fake });
    const session = await client.agent({ voice: 'Puck' }).start();
    const readyEvents: unknown[] = [];
    session.on('ready', (e) => readyEvents.push(e));

    fake.emitMessage({ type: 'ready', session_id: 'sess-1' });

    expect(readyEvents).toHaveLength(1);
    expect((readyEvents[0] as { agent: unknown }).agent).toBeNull();
  });

  it('sends an explicit noise-cancellation opt-out on the wire', async () => {
    const fake = makeFakeTransport();
    const client = new RealtimeClient({ apiKey: 'test-key', transportFactory: () => fake });

    await client.agent({ audio: { noiseCancellation: 'off' } }).start();

    expect(inlineAgent(fake.lastConfig())?.audio).toEqual({
      noise_cancellation: 'off',
    });
  });

  it('carries a shared-microphone denoise mode through to the wire', async () => {
    const fake = makeFakeTransport();
    const client = new RealtimeClient({ apiKey: 'test-key', transportFactory: () => fake });

    await client.agent({ audio: { noiseCancellation: 'denoise' } }).start();

    expect(inlineAgent(fake.lastConfig())?.audio).toEqual({
      noise_cancellation: 'denoise',
    });
  });

  it('exposes the session id and connect timings once started', async () => {
    const fake = makeFakeTransport({
      sessionResponse: fakeSessionResponse('sess-7', {
        room_name: 'room-7',
        timings: {
          version_check_ms: 1,
          project_check_ms: 2,
          provider_resolve_ms: 3,
          db_insert_ms: 4,
          mint_tokens_ms: 5,
          dispatch_ms: 6,
          total_ms: 7,
        },
      }),
    });
    const client = new RealtimeClient({ apiKey: 'test-key', transportFactory: () => fake });

    const session = await client.agent().start();

    expect(session.sessionId).toBe('sess-7');
    const timings = session.connectTimings;
    expect(timings?.serverTimings?.total_ms).toBe(7);
    expect(timings?.serverTimings?.version_check_ms).toBe(1);
    // Absent on a backend predating the resolved flow, even when the
    // sibling phases are present.
    expect(timings?.serverTimings?.resolve_ms).toBeUndefined();
    // The real phase computation is pinned in the transport's own suite
    // (``transport/__tests__/session_start.test.ts``); these values come from
    // the fake, so only the plumbing is under test here.
  });

  it('times the marks for a transport that reports neither them nor an origin', async () => {
    // The fake calls ``onConnectTimings`` the way a transport written before
    // the post-connect marks does — the five-field value, one argument — so
    // the engine's own connect origin has to carry the marks.
    const fake = makeFakeTransport({ sessionResponse: fakeSessionResponse('sess-9') });
    const client = new RealtimeClient({ apiKey: 'test-key', transportFactory: () => fake });

    const session = await client.agent().start();

    expect(session.connectTimings?.readyMs).toBeGreaterThanOrEqual(0);
    expect(fake.sent.filter((m) => m.type === 'connect-timings')).toHaveLength(1);
  });

  it('reports the connect-latency breakdown at debug level', async () => {
    const fake = makeFakeTransport({ sessionResponse: fakeSessionResponse('sess-8') });
    const client = new RealtimeClient({ apiKey: 'test-key', transportFactory: () => fake });
    const debug = vi.spyOn(console, 'debug').mockImplementation(() => {});
    setLogLevel('debug');

    try {
      await client.agent().start();
    } finally {
      setLogLevel('warn');
    }

    // One grep-able line: a developer reading stderr needs every leg beside
    // its label, not a value they have to reassemble from an object dump.
    expect(debug).toHaveBeenCalledWith(
      expect.stringContaining('cosmo connect timings ws_ms=1 room_ms=2 mic_ms=3 total_ms=6'),
    );
    debug.mockRestore();
  });

  it('freezes the resolved persona', () => {
    const client = new RealtimeClient({ apiKey: 'test-key', transportFactory: () => makeFakeTransport() });
    const agent = client.agent({ instructions: 'be helpful', voice: 'Puck' });

    expect(agent.instructions).toBe('be helpful');
    expect(agent.voice).toBe('Puck');
    expect(Object.isFrozen(agent)).toBe(true);
  });

  it('rejects cross-variant fields at the type level', () => {
    const client = new RealtimeClient({ apiKey: 'test-key', transportFactory: () => makeFakeTransport() });
    // @ts-expect-error — CatalogAgentOptions has no persona parameters
    // (voice is the one sanctioned per-run override; instructions is not)
    void (() => client.catalogAgent('driver-pay', { instructions: 'be terse' }));
    // @ts-expect-error — AgentConfig has no catalog-launch parameters
    void (() => client.agent({ name: 'driver-pay' }));
    // @ts-expect-error — a catalog launch requires the name argument
    void (() => client.catalogAgent());
  });

  it('agents open independent sessions differing in a persona knob', async () => {
    const fakes: FakeTransport[] = [];
    const client = new RealtimeClient({
      apiKey: 'test-key',
      transportFactory: () => {
        const fake = makeFakeTransport();
        fakes.push(fake);
        return fake;
      },
    });
    const quiet = await client
      .agent({ instructions: 'shared persona', audio: { noiseCancellation: 'voice_focus' } })
      .start();
    await quiet.end();
    await client
      .agent({ instructions: 'shared persona', audio: { noiseCancellation: 'off' } })
      .start();

    expect(fakes).toHaveLength(2);
    expect(inlineAgent(fakes[0]?.lastConfig())?.instructions).toBe('shared persona');
    expect(inlineAgent(fakes[1]?.lastConfig())?.instructions).toBe('shared persona');
    expect(inlineAgent(fakes[0]?.lastConfig())?.audio).toEqual({
      noise_cancellation: 'voice_focus',
    });
    expect(inlineAgent(fakes[1]?.lastConfig())?.audio).toEqual({
      noise_cancellation: 'off',
    });
  });

  it('runs a second concurrent session instead of rejecting it', async () => {
    const fakes: FakeTransport[] = [];
    const client = new RealtimeClient({
      apiKey: 'test-key',
      transportFactory: () => {
        const fake = makeFakeTransport();
        fakes.push(fake);
        return fake;
      },
    });
    const agent = client.agent();

    const first = await agent.start();
    const second = await agent.start();

    expect(fakes).toHaveLength(2);
    expect(first.state.kind).toBe('connected');
    expect(second.state.kind).toBe('connected');

    await first.end();
    expect(first.state.kind).toBe('disconnected');
    expect(second.state.kind).toBe('connected');
    await second.end();
  });
});

describe('parity primitives on the session-config body', () => {
  it('routes the model block into the agent block', async () => {
    const fake = makeFakeTransport();
    const client = new RealtimeClient({ apiKey: 'test-key', transportFactory: () => fake });

    await client
      .agent({
        model: {
          provider: 'gemini',
          temperature: 0.4,
          maxOutputTokens: 2048,
        },
      })
      .start();

    const agent = inlineAgent(fake.lastConfig());
    expect(agent?.model).toEqual({
      provider: 'gemini',
      temperature: 0.4,
      max_output_tokens: 2048,
    });
  });

  it('the block constructors stamp the provider tag the caller never types', async () => {
    expect(GeminiModel()).toEqual({ provider: 'gemini' });
    expect(OpenAIModel({ turnDetection: 'semantic_vad', eagerness: 'high' })).toEqual({
      provider: 'openai',
      turnDetection: 'semantic_vad',
      eagerness: 'high',
    });
    expect(OpenAIMiniModel({ modelId: 'mini-live' })).toEqual({
      provider: 'openai_mini',
      modelId: 'mini-live',
    });
    expect(GrokModel({ silenceDurationMs: 200 })).toEqual({
      provider: 'grok',
      silenceDurationMs: 200,
    });
    expect(OpenAILiveModel({ responsesModel: 'gpt-5.6-luna', reasoningEffort: 'low' })).toEqual({
      provider: 'openai_live',
      responsesModel: 'gpt-5.6-luna',
      reasoningEffort: 'low',
    });

    const liveFake = makeFakeTransport();
    const liveClient = new RealtimeClient({
      apiKey: 'test-key',
      transportFactory: () => liveFake,
    });
    await liveClient
      .agent({
        model: OpenAILiveModel({
          responsesInstructions: 'drive the board',
          verbosity: 'low',
          toolChoice: 'required',
          parallelToolCalls: true,
          maxOutputTokens: 512,
          serviceTier: 'priority',
        }),
      })
      .start();
    expect(inlineAgent(liveFake.lastConfig())?.model).toEqual({
      provider: 'openai_live',
      responses_instructions: 'drive the board',
      verbosity: 'low',
      tool_choice: 'required',
      parallel_tool_calls: true,
      max_output_tokens: 512,
      service_tier: 'priority',
    });

    const fake = makeFakeTransport();
    const client = new RealtimeClient({ apiKey: 'test-key', transportFactory: () => fake });
    await client
      .agent({ model: GeminiModel({ temperature: 0.4, maxOutputTokens: 2048 }) })
      .start();
    expect(inlineAgent(fake.lastConfig())?.model).toEqual({
      provider: 'gemini',
      temperature: 0.4,
      max_output_tokens: 2048,
    });
  });

  it('the constructors keep detector-scoped knobs a type error', () => {
    // @ts-expect-error cosmo_vad cannot ride server_vad's silence window
    GeminiModel({ turnDetection: 'cosmo_vad', silenceDurationMs: 200 });
    // @ts-expect-error eagerness belongs to semantic_vad, not server_vad
    OpenAIModel({ turnDetection: 'server_vad', eagerness: 'high' });
    // @ts-expect-error the tag is stamped, never passed
    GeminiModel({ provider: 'gemini' });
    // @ts-expect-error Grok has no eagerness knob
    GrokModel({ eagerness: 'high' });
  });

  it('sends the string form of the model unchanged', async () => {
    const fake = makeFakeTransport();
    const client = new RealtimeClient({ apiKey: 'test-key', transportFactory: () => fake });

    await client.agent({ model: 'gemini' }).start();

    expect(inlineAgent(fake.lastConfig())?.model).toBe('gemini');
  });

  it('routes server hooks into the agent block', async () => {
    const fake = makeFakeTransport();
    const client = new RealtimeClient({ apiKey: 'test-key', transportFactory: () => fake });

    await client
      .agent({
        hooks: [
          {
            trigger: 'user.speech.timeout',
            timeout_seconds: 10,
            action: { type: 'say', text: 'Still there?' },
            max_count: 2,
          },
        ],
      })
      .start();

    const agent = inlineAgent(fake.lastConfig());
    expect(agent?.hooks).toEqual([
      {
        trigger: 'user.speech.timeout',
        timeout_seconds: 10,
        action: { type: 'say', text: 'Still there?' },
        max_count: 2,
      },
    ]);
  });
});

describe('sendActivityEnd', () => {
  it('sends the activity-end frame on a live session', async () => {
    const fake = makeFakeTransport();
    const client = new RealtimeClient({ apiKey: 'test-key', transportFactory: () => fake });
    const session = await client.agent().start();
    fake.emitMessage({ type: 'ready', session_id: 'sess-1' });

    await session.sendActivityEnd();

    expect(fake.sent).toContainEqual({ type: 'activity-end' });
  });

  it('rejects when the session is not live', async () => {
    const fake = makeFakeTransport();
    const client = new RealtimeClient({ apiKey: 'test-key', transportFactory: () => fake });
    const session = await client.agent().start();
    await session.end();

    await expect(session.sendActivityEnd()).rejects.toBeInstanceOf(SessionStateError);
  });
});

describe('start resolves at ready', () => {
  it('start() stays pending until the ready handshake lands', async () => {
    const fake = makeFakeTransport({ readyOnConnect: false });
    const client = new RealtimeClient({ apiKey: 'test-key', transportFactory: () => fake });
    let resolved = false;
    const startPromise = client
      .agent()
      .start()
      .then((session) => {
        resolved = true;
        return session;
      });

    while (!fake.hasMessageListener()) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(resolved).toBe(false);

    fake.emitMessage({ type: 'ready', session_id: 'sess-fake' });
    const session = await startPromise;
    expect(session.getSnapshot().transportState).toBe('ready');
    await session.sendText('usable immediately');
    expect(fake.sent).toContainEqual({ type: 'send-text', content: 'usable immediately' });
  });

  it('start() rejects with SessionStartError when ready never arrives', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.useFakeTimers();
    try {
      const fake = makeFakeTransport({ readyOnConnect: false });
      const client = new RealtimeClient({ apiKey: 'test-key', transportFactory: () => fake });

      const startPromise = client.agent().start();
      const expectation = expect(startPromise).rejects.toSatisfy(
        (err: unknown) =>
          err instanceof SessionStartError && err.code === 'ready_timeout',
      );
      // Flush the connect's microtasks so the ready timer is armed, then
      // run it out.
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(40_000);
      await expectation;

      // Torn down, not left half-open: the transport was disconnected.
      expect(fake.lastDisconnectOpts()).not.toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it('a pre-ready error frame enriches the rejection the close delivers', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const fake = makeFakeTransport({ readyOnConnect: false });
    const client = new RealtimeClient({ apiKey: 'test-key', transportFactory: () => fake });

    const startPromise = client.agent().start();
    const expectation = expect(startPromise).rejects.toSatisfy(
      (err: unknown) =>
        err instanceof SessionStartError &&
        err.message === 'model exploded' &&
        err.detail?.code === 'internal_error',
    );
    while (!fake.hasMessageListener()) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    fake.emitMessage({
      type: 'error',
      code: 'internal_error',
      message: 'model exploded',
      fatal: true,
    });
    fake.emitClose({ reason: 'livekit:ROOM_DELETED' });

    await expectation;
  });

  it('a transport recovery during the wait does not forge readiness', async () => {
    const fake = makeFakeTransport({ readyOnConnect: false });
    const client = new RealtimeClient({ apiKey: 'test-key', transportFactory: () => fake });
    let resolved = false;
    const startPromise = client
      .agent()
      .start()
      .then((session) => {
        resolved = true;
        return session;
      });
    while (!fake.hasMessageListener()) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }

    fake.emitReconnecting();
    fake.emitReconnected();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(resolved).toBe(false);

    fake.emitMessage({ type: 'ready', session_id: 'sess-fake' });
    const session = await startPromise;
    expect(session.getSnapshot().transportState).toBe('ready');
    // A recovery after ready restores ready, not connecting.
    fake.emitReconnecting();
    fake.emitReconnected();
    expect(session.getSnapshot().transportState).toBe('ready');
  });

  it('a pre-ready error frame alone settles nothing — ready can still follow', async () => {
    const fake = makeFakeTransport({ readyOnConnect: false });
    const client = new RealtimeClient({ apiKey: 'test-key', transportFactory: () => fake });
    let resolved = false;
    const startPromise = client
      .agent()
      .start()
      .then((session) => {
        resolved = true;
        return session;
      });
    while (!fake.hasMessageListener()) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }

    fake.emitMessage({
      type: 'error',
      code: 'internal_error',
      message: 'transient hiccup',
      fatal: true,
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(resolved).toBe(false);

    fake.emitMessage({ type: 'ready', session_id: 'sess-fake' });
    const session = await startPromise;
    expect(session.getSnapshot().transportState).toBe('ready');
  });

  it('a room deleted before the join resolves rejects with the enriched handshake failure', async () => {
    // The boot failed fast: the server sent its error frame and deleted the
    // room while the join was still negotiating, so the join fails on its own
    // timeout. The window's typed close exit must win over that raw
    // transport error, carrying the server's enrichment.
    vi.spyOn(console, 'error').mockImplementation(() => {});
    let failJoin!: (err: Error) => void;
    const connectGate = new Promise<void>((_resolve, reject) => {
      failJoin = reject;
    });
    const fake = makeFakeTransport({ readyOnConnect: false, connectGate });
    const client = new RealtimeClient({ apiKey: 'test-key', transportFactory: () => fake });

    const startPromise = client.agent().start();
    const expectation = expect(startPromise).rejects.toSatisfy(
      (err: unknown) =>
        err instanceof SessionStartError &&
        err.message === 'boot failed: no model credentials' &&
        err.detail?.code === 'internal_error',
    );
    while (!fake.hasMessageListener()) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    fake.emitMessage({
      type: 'error',
      code: 'internal_error',
      message: 'boot failed: no model credentials',
      fatal: true,
    });
    fake.emitClose({ reason: 'livekit:ROOM_DELETED' });
    failJoin(new Error('LiveKit room connect timed out'));

    await expectation;
  });

  it('a room deleted before the join resolves rejects typed even with no error frame', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    let failJoin!: (err: Error) => void;
    const connectGate = new Promise<void>((_resolve, reject) => {
      failJoin = reject;
    });
    const fake = makeFakeTransport({ readyOnConnect: false, connectGate });
    const client = new RealtimeClient({ apiKey: 'test-key', transportFactory: () => fake });

    const startPromise = client.agent().start();
    const expectation = expect(startPromise).rejects.toSatisfy(
      // A close with no error frame carries no server verdict: the code says
      // the handshake failed, and `serverCode` stays absent rather than
      // reporting a slug the server never sent.
      (err: unknown) =>
        err instanceof SessionStartError &&
        err.code === 'handshake_failed' &&
        err.serverCode === undefined &&
        err.status === null,
    );
    while (!fake.hasMessageListener()) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    fake.emitClose({ reason: 'livekit:ROOM_DELETED' });
    failJoin(new Error('LiveKit room connect timed out'));

    await expectation;
  });

  it('the terminal reason agrees with what start() rejects with', async () => {
    // One ending, one reason: the state onStateChange reports, the stream's
    // terminal item, and the rejection all say handshake failure — even for
    // a close LiveKit labels a deliberate server end, which pre-ready is a
    // failed boot rather than a hangup.
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const fake = makeFakeTransport({ readyOnConnect: false });
    const client = new RealtimeClient({ apiKey: 'test-key', transportFactory: () => fake });
    const states: SessionState[] = [];
    let early: RealtimeSession | null = null;

    const startPromise = client.agent().start({
      onStateChange: (state) => states.push(state),
      onSession: (session) => {
        early = session;
      },
    });
    const expectation = expect(startPromise).rejects.toSatisfy(
      (err: unknown) =>
        err instanceof SessionStartError && err.code === 'handshake_failed',
    );
    while (!fake.hasMessageListener()) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    fake.emitClose({ reason: 'livekit:ROOM_DELETED' });
    await expectation;

    expect(states[states.length - 1]).toMatchObject({
      kind: 'disconnected',
      disconnectReason: 'handshake_failed',
    });
    const session = early as RealtimeSession | null;
    expect(session?.state).toMatchObject({
      kind: 'disconnected',
      disconnectReason: 'handshake_failed',
    });
  });

  it('an unsolicited transport close before ready rejects start() with SessionStartError', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const fake = makeFakeTransport({ readyOnConnect: false });
    const client = new RealtimeClient({ apiKey: 'test-key', transportFactory: () => fake });

    const startPromise = client.agent().start();
    const expectation = expect(startPromise).rejects.toSatisfy(
      (err: unknown) =>
        err instanceof SessionStartError && err.code === 'handshake_failed',
    );
    while (!fake.hasMessageListener()) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    fake.emitClose({ reason: 'livekit:ROOM_DELETED' });

    await expectation;
  });
});
