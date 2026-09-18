// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SDK_NAME, SDK_VERSION } from '../../constants';
import { SessionStateError } from '../../core/errors';
import { SessionEngine } from '../../core/session_engine';
import type { SessionConfig } from '../../protocol';
import {
  floatToPcm16,
  Pcm16Resampler,
  pcm16ToFloat,
  WebSocketTransport,
} from '../websocket_transport';

const CONFIG: SessionConfig = {
  type: 'session-config',
  sdk: { name: SDK_NAME, version: SDK_VERSION },
};

const START_URL = 'http://localhost:8080/api/v1/external/realtime/session/ws-start';
const STARTED = {
  session_id: 'session-1',
  ws_url: 'ws://localhost:8080/api/v1/external/realtime/session/session-1/connect',
  ws_subprotocol: 'one-time-capability',
};

const SERVER_TIMINGS = {
  version_check_ms: 1,
  project_check_ms: 2,
  provider_resolve_ms: 3,
  db_insert_ms: 4,
  mint_tokens_ms: 5,
  dispatch_ms: 6,
  total_ms: 7,
};

const AUDIO_FORMAT = JSON.stringify({
  type: 'ws-audio-format',
  input_sample_rate_hz: 16_000,
  output_sample_rate_hz: 24_000,
  num_channels: 1,
});

class FakeWebSocket extends EventTarget {
  static readonly OPEN = 1;
  static instances: FakeWebSocket[] = [];
  readonly sent: Array<string | ArrayBufferLike | ArrayBufferView | Blob> = [];
  binaryType: BinaryType = 'blob';
  readyState = FakeWebSocket.OPEN;

  constructor(
    readonly url: string,
    readonly protocol: string | string[],
  ) {
    super();
    FakeWebSocket.instances.push(this);
  }

  send(data: string | ArrayBufferLike | Blob | ArrayBufferView): void {
    this.sent.push(data);
  }

  close(): void {
    this.readyState = 3;
  }

  message(data: unknown): void {
    this.dispatchEvent(new MessageEvent('message', { data }));
  }

  serverClose(code = 1008, reason = 'refused'): void {
    this.readyState = 3;
    this.dispatchEvent(new CloseEvent('close', { code, reason }));
  }
}

function socket(): FakeWebSocket {
  const instance = FakeWebSocket.instances.at(-1);
  if (instance === undefined) throw new Error('no websocket was created');
  return instance;
}

async function connecting(
  transport: WebSocketTransport,
  overrides: Record<string, unknown> = {},
): Promise<{ started: Promise<void> }> {
  const started = transport.connect({
    config: CONFIG,
    sessionStartUrl: START_URL,
    publishMicrophone: false,
    ...overrides,
  });
  await vi.waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));
  return { started };
}

class InputNode {
  connect(): this { return this; }
  disconnect(): void {}
}

type InputContextPlan = {
  resume?: () => Promise<void>;
  close?: () => Promise<void>;
};

function stubInputContexts(plans: InputContextPlan[]): void {
  class Context {
    private readonly plan = plans.shift() ?? {};
    readonly destination = new InputNode();
    createMediaStreamSource(): InputNode { return new InputNode(); }
    createScriptProcessor(): InputNode & { onaudioprocess: null } {
      return Object.assign(new InputNode(), { onaudioprocess: null });
    }
    createGain(): InputNode & { gain: { value: number } } {
      return Object.assign(new InputNode(), { gain: { value: 1 } });
    }
    resume(): Promise<void> { return this.plan.resume?.() ?? Promise.resolve(); }
    close(): Promise<void> { return this.plan.close?.() ?? Promise.resolve(); }
  }
  vi.stubGlobal('AudioContext', Context);
}

function mediaStream(id: string): MediaStream {
  const track = { id, stop: vi.fn() };
  return {
    id,
    getAudioTracks: () => [track],
    getTracks: () => [track],
  } as unknown as MediaStream;
}

beforeEach(() => {
  FakeWebSocket.instances = [];
  vi.stubGlobal('WebSocket', FakeWebSocket);
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue(
      new Response(JSON.stringify(STARTED), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    ),
  );
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('WebSocketTransport', () => {
  it('posts the private start route and offers the one-time subprotocol', async () => {
    const transport = new WebSocketTransport();
    const onSessionStarted = vi.fn();
    const { started } = await connecting(transport, { onSessionStarted });

    expect(fetch).toHaveBeenCalledWith(
      START_URL,
      expect.objectContaining({ method: 'POST' }),
    );
    expect(socket().url).toBe(STARTED.ws_url);
    expect(socket().protocol).toBe(STARTED.ws_subprotocol);
    expect(onSessionStarted).toHaveBeenCalledWith('session-1');

    socket().message(AUDIO_FORMAT);
    await started;
  });

  it('does not report connected before a valid audio preamble', async () => {
    const transport = new WebSocketTransport();
    let settled = false;
    const { started } = await connecting(transport);
    void started.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );

    await Promise.resolve();
    expect(settled).toBe(false);
    socket().message(JSON.stringify({ type: 'ready', session_id: 'session-1' }));

    await expect(started).rejects.toThrow('audio preamble');
  });

  it('preserves the published connection timing field meanings', async () => {
    vi.spyOn(performance, 'now')
      .mockReturnValueOnce(100)
      .mockReturnValueOnce(110)
      .mockReturnValueOnce(140)
      .mockReturnValueOnce(140);
    const onConnectTimings = vi.fn();
    const transport = new WebSocketTransport();
    const { started } = await connecting(transport, { onConnectTimings });

    socket().message(AUDIO_FORMAT);
    await started;

    expect(onConnectTimings).toHaveBeenCalledWith(
      {
        wsMs: 10,
        roomMs: 0,
        micMs: 0,
        totalConnectMs: 40,
        readyMs: null,
        serverTimings: null,
      },
      100,
    );
  });

  it('hands over the server breakdown and the origin the phases measure from', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ ...STARTED, timings: SERVER_TIMINGS }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      ),
    );
    const onConnectTimings = vi.fn();
    const transport = new WebSocketTransport();
    const { started } = await connecting(transport, { onConnectTimings });

    socket().message(AUDIO_FORMAT);
    await started;

    expect(onConnectTimings).toHaveBeenCalledTimes(1);
    const timings = onConnectTimings.mock.calls[0][0];
    expect(timings.serverTimings).toEqual(SERVER_TIMINGS);
    const startedAt = onConnectTimings.mock.calls[0][1] as number;
    expect(performance.now() - startedAt).toBeGreaterThanOrEqual(timings.totalConnectMs);
  });

  it('times out when the server never sends an audio preamble', async () => {
    vi.useFakeTimers();
    const transport = new WebSocketTransport();
    const { started } = await connecting(transport);
    const timedOut = expect(started).rejects.toThrow('audio preamble timed out');

    await vi.advanceTimersByTimeAsync(30_000);

    await timedOut;
    expect(socket().readyState).toBe(3);
  });

  it('forwards external frames and sends client frames as JSON', async () => {
    const transport = new WebSocketTransport();
    const messages: unknown[] = [];
    transport.onMessage((message) => messages.push(message));
    const { started } = await connecting(transport);
    socket().message(AUDIO_FORMAT);
    await started;

    socket().message(JSON.stringify({ type: 'ready', session_id: 'session-1' }));
    await transport.send({ type: 'send-text', content: 'hello' });

    expect(messages).toEqual([{ type: 'ready', session_id: 'session-1' }]);
    expect(socket().sent.map(String)).toContain(
      JSON.stringify({ type: 'send-text', content: 'hello' }),
    );
  });

  it('runs an ordinary client tool over the socket RPC frames', async () => {
    const transport = new WebSocketTransport();
    transport.registerRpcMethod('clock', async (invocation) => {
      expect(invocation).toEqual(expect.objectContaining({
        payload: '{"timezone":"UTC"}',
        callerIdentity: 'agent',
        callerIsAgent: true,
      }));
      expect(invocation.signal).toBeInstanceOf(AbortSignal);
      return JSON.stringify({ ok: true, result: { time: '12:00' } });
    });
    const { started } = await connecting(transport);
    socket().message(AUDIO_FORMAT);
    await started;

    socket().message(
      JSON.stringify({
        type: 'rpc-request',
        request_id: 'request-1',
        method: 'clock',
        payload: '{"timezone":"UTC"}',
      }),
    );
    await vi.waitFor(() => {
      const frames = socket().sent.filter((item): item is string => typeof item === 'string');
      expect(frames.map((frame) => JSON.parse(frame))).toContainEqual({
        type: 'rpc-response',
        request_id: 'request-1',
        payload: JSON.stringify({ ok: true, result: { time: '12:00' } }),
      });
    });
  });

  it('aborts a client tool when the server withdraws its RPC', async () => {
    const transport = new WebSocketTransport();
    const aborted = vi.fn();
    transport.registerRpcMethod('clock', async (invocation) => {
      await new Promise<void>((_resolve, reject) => {
        invocation.signal?.addEventListener('abort', () => {
          aborted();
          reject(invocation.signal?.reason);
        });
      });
      return JSON.stringify({ ok: true });
    });
    const { started } = await connecting(transport);
    socket().message(AUDIO_FORMAT);
    await started;

    socket().message(
      JSON.stringify({
        type: 'rpc-request',
        request_id: 'request-1',
        method: 'clock',
        payload: '{}',
      }),
    );
    socket().message(JSON.stringify({ type: 'rpc-cancel', request_id: 'request-1' }));

    await vi.waitFor(() => expect(aborted).toHaveBeenCalledOnce());
    expect(socket().sent.filter((item) => typeof item === 'string')).toEqual([]);
  });

  it('bounds client-tool errors to the server RPC contract', async () => {
    const transport = new WebSocketTransport();
    transport.registerRpcMethod('fail', async () => {
      throw new Error('x'.repeat(1_000));
    });
    const { started } = await connecting(transport);
    socket().message(AUDIO_FORMAT);
    await started;

    socket().message(JSON.stringify({
      type: 'rpc-request',
      request_id: 'request-1',
      method: 'fail',
      payload: '{}',
    }));

    await vi.waitFor(() => {
      const response = socket().sent
        .filter((item): item is string => typeof item === 'string')
        .map((item) => JSON.parse(item) as Record<string, unknown>)
        .find((item) => item.type === 'rpc-response');
      expect(response?.error).toBe('x'.repeat(512));
    });
  });

  it('reports a policy close during the handshake as a failed start', async () => {
    const transport = new WebSocketTransport();
    const { started } = await connecting(transport);
    socket().serverClose(1008, 'claim expired');

    await expect(started).rejects.toThrow('claim expired');
  });

  it('reports a clean close with its code and a default reason', async () => {
    const transport = new WebSocketTransport();
    const onClose = vi.fn();
    transport.onClose(onClose);
    const { started } = await connecting(transport);
    socket().message(AUDIO_FORMAT);
    await started;

    socket().serverClose(1000, '');

    await vi.waitFor(() => expect(onClose).toHaveBeenCalledOnce());
    expect(onClose).toHaveBeenCalledWith({
      code: '1000',
      reason: 'socket closed',
      serverEnded: true,
    });
  });

  it('reports an abnormal close with its code and reason', async () => {
    const transport = new WebSocketTransport();
    const onClose = vi.fn();
    transport.onClose(onClose);
    const { started } = await connecting(transport);
    socket().message(AUDIO_FORMAT);
    await started;

    socket().serverClose(1008, 'policy violation');

    await vi.waitFor(() => expect(onClose).toHaveBeenCalledOnce());
    expect(onClose).toHaveBeenCalledWith({
      code: '1008',
      reason: 'policy violation',
      serverEnded: false,
    });
  });

  it.each([1001, 1005])('reports close code %i as a deliberate server end', async (code) => {
    const transport = new WebSocketTransport();
    const onClose = vi.fn();
    transport.onClose(onClose);
    const { started } = await connecting(transport);
    socket().message(AUDIO_FORMAT);
    await started;

    socket().serverClose(code, '');

    await vi.waitFor(() => expect(onClose).toHaveBeenCalledOnce());
    expect(onClose.mock.calls[0][0]).toMatchObject({ code: String(code), serverEnded: true });
  });

  it('does not report a locally requested close as unsolicited', async () => {
    const transport = new WebSocketTransport();
    const onClose = vi.fn();
    transport.onClose(onClose);
    const { started } = await connecting(transport);
    socket().message(AUDIO_FORMAT);
    await started;

    await transport.disconnect({ sendEndFrame: false });
    socket().serverClose(1000, 'done');
    expect(onClose).not.toHaveBeenCalled();
  });

  it('releases microphone and RPC work before reporting an unsolicited close', async () => {
    stubInputContexts([{}]);
    const stop = vi.fn();
    const track = { enabled: true, stop };
    const microphone = {
      getAudioTracks: () => [track],
      getTracks: () => [track],
    } as unknown as MediaStream;
    vi.stubGlobal('navigator', {
      mediaDevices: { getUserMedia: vi.fn().mockResolvedValue(microphone) },
    });
    const transport = new WebSocketTransport();
    const aborted = vi.fn();
    transport.registerRpcMethod('wait', async (invocation) => {
      await new Promise<void>((_resolve, reject) => {
        invocation.signal?.addEventListener('abort', () => {
          aborted();
          reject(invocation.signal?.reason);
        });
      });
      return '{}';
    });
    const onClose = vi.fn();
    transport.onClose(onClose);
    const { started } = await connecting(transport, { publishMicrophone: true });
    socket().message(AUDIO_FORMAT);
    await started;
    socket().message(JSON.stringify({
      type: 'rpc-request',
      request_id: 'request-1',
      method: 'wait',
      payload: '{}',
    }));

    socket().serverClose(1006, 'network lost');
    await vi.waitFor(() => expect(onClose).toHaveBeenCalledOnce());

    expect(aborted).toHaveBeenCalledOnce();
    expect(stop).toHaveBeenCalledOnce();
    expect(transport.getInputStream()).toBeNull();
  });

  it('releases a microphone acquired after disconnect', async () => {
    let resolveMicrophone!: (stream: MediaStream) => void;
    const getUserMedia = vi.fn(
      () => new Promise<MediaStream>((resolve) => { resolveMicrophone = resolve; }),
    );
    vi.stubGlobal('navigator', { mediaDevices: { getUserMedia } });
    const stop = vi.fn();
    const stream = {
      getTracks: () => [{ stop }],
    } as unknown as MediaStream;
    const transport = new WebSocketTransport();
    const { started } = await connecting(transport, { publishMicrophone: true });
    socket().message(AUDIO_FORMAT);
    await vi.waitFor(() => expect(getUserMedia).toHaveBeenCalledOnce());

    await transport.disconnect({ sendEndFrame: false });
    resolveMicrophone(stream);

    await expect(started).rejects.toThrow();
    expect(stop).toHaveBeenCalledOnce();
  });

  it('does not let initial microphone setup override an early mute', async () => {
    let resolveMicrophone!: (stream: MediaStream) => void;
    const getUserMedia = vi.fn(
      () => new Promise<MediaStream>((resolve) => { resolveMicrophone = resolve; }),
    );
    vi.stubGlobal('navigator', { mediaDevices: { getUserMedia } });
    const stop = vi.fn();
    const track = { enabled: true, stop };
    const microphone = {
      getAudioTracks: () => [track],
      getTracks: () => [track],
    } as unknown as MediaStream;
    const transport = new WebSocketTransport();
    const { started } = await connecting(transport, { publishMicrophone: true });
    socket().message(AUDIO_FORMAT);
    await vi.waitFor(() => expect(getUserMedia).toHaveBeenCalledOnce());

    await transport.setMicMuted(true);
    resolveMicrophone(microphone);
    await started;

    expect(transport.getInputStream()).toBeNull();
    expect(stop).toHaveBeenCalledOnce();
    expect(socket().sent.map(String)).toEqual([
      JSON.stringify({ type: 'mute', muted: true }),
    ]);
  });

  it('does not let initial microphone setup replace an early caller stream', async () => {
    let resolveMicrophone!: (stream: MediaStream) => void;
    const getUserMedia = vi.fn(
      () => new Promise<MediaStream>((resolve) => { resolveMicrophone = resolve; }),
    );
    vi.stubGlobal('navigator', { mediaDevices: { getUserMedia } });
    stubInputContexts([{}, {}]);
    const microphone = mediaStream('microphone');
    const caller = mediaStream('caller');
    const transport = new WebSocketTransport();
    const { started } = await connecting(transport, { publishMicrophone: true });
    socket().message(AUDIO_FORMAT);
    await vi.waitFor(() => expect(getUserMedia).toHaveBeenCalledOnce());

    await transport.startAudioStream(caller);
    resolveMicrophone(microphone);
    await started;
    expect(transport.getInputStream()).toBe(caller);

    await transport.stopAudioStream();
    expect(transport.getInputStream()).toBe(microphone);
  });

  it('releases a post-connect microphone acquired after disconnect', async () => {
    let resolveMicrophone!: (stream: MediaStream) => void;
    const getUserMedia = vi.fn(
      () => new Promise<MediaStream>((resolve) => { resolveMicrophone = resolve; }),
    );
    vi.stubGlobal('navigator', { mediaDevices: { getUserMedia } });
    const stop = vi.fn();
    const stream = { getTracks: () => [{ stop }] } as unknown as MediaStream;
    const transport = new WebSocketTransport();
    const { started } = await connecting(transport);
    socket().message(AUDIO_FORMAT);
    await started;

    const unmuting = transport.setMicMuted(false);
    await vi.waitFor(() => expect(getUserMedia).toHaveBeenCalledOnce());
    await transport.disconnect({ sendEndFrame: false });
    resolveMicrophone(stream);

    await expect(unmuting).rejects.toThrow();
    expect(stop).toHaveBeenCalledOnce();
  });

  it('keeps a later mute when an older unmute is waiting for permission', async () => {
    let resolveMicrophone!: (stream: MediaStream) => void;
    const getUserMedia = vi.fn(
      () => new Promise<MediaStream>((resolve) => { resolveMicrophone = resolve; }),
    );
    vi.stubGlobal('navigator', { mediaDevices: { getUserMedia } });
    const stop = vi.fn();
    const microphone = {
      getAudioTracks: () => [{ id: 'microphone', stop }],
      getTracks: () => [{ id: 'microphone', stop }],
    } as unknown as MediaStream;
    const transport = new WebSocketTransport();
    const { started } = await connecting(transport);
    socket().message(AUDIO_FORMAT);
    await started;

    const unmuting = transport.setMicMuted(false);
    await vi.waitFor(() => expect(getUserMedia).toHaveBeenCalledOnce());
    await transport.setMicMuted(true);
    resolveMicrophone(microphone);
    await expect(unmuting).resolves.toBeUndefined();

    expect(transport.getInputStream()).toBeNull();
    expect(socket().sent.map(String)).toEqual([
      JSON.stringify({ type: 'mute', muted: true }),
    ]);
    expect(stop).toHaveBeenCalledOnce();
  });

  it('shares one microphone request between overlapping unmute calls', async () => {
    let resolveMicrophone!: (stream: MediaStream) => void;
    const getUserMedia = vi.fn(
      () => new Promise<MediaStream>((resolve) => { resolveMicrophone = resolve; }),
    );
    vi.stubGlobal('navigator', { mediaDevices: { getUserMedia } });
    stubInputContexts([{}]);
    const microphone = mediaStream('microphone');
    const transport = new WebSocketTransport();
    const { started } = await connecting(transport);
    socket().message(AUDIO_FORMAT);
    await started;

    const first = transport.setMicMuted(false);
    const second = transport.setMicMuted(false);
    await vi.waitFor(() => expect(getUserMedia).toHaveBeenCalledOnce());
    resolveMicrophone(microphone);
    await Promise.all([first, second]);

    expect(getUserMedia).toHaveBeenCalledOnce();
    expect(transport.getInputStream()).toBe(microphone);
    expect(socket().sent.map(String)).toEqual([
      JSON.stringify({ type: 'mute', muted: false }),
    ]);
  });

  it('disables the device microphone track while muted', async () => {
    stubInputContexts([{}, {}]);
    const track = { id: 'microphone', enabled: true, stop: vi.fn() };
    const microphone = {
      getAudioTracks: () => [track],
      getTracks: () => [track],
    } as unknown as MediaStream;
    vi.stubGlobal('navigator', {
      mediaDevices: { getUserMedia: vi.fn().mockResolvedValue(microphone) },
    });
    const transport = new WebSocketTransport();
    const { started } = await connecting(transport, { publishMicrophone: true });
    socket().message(AUDIO_FORMAT);
    await started;

    await transport.setMicMuted(true);
    expect(track.enabled).toBe(false);

    await transport.setMicMuted(false);
    expect(track.enabled).toBe(true);
  });

  it('claims the caller audio slot before asynchronous input setup', async () => {
    let resumeInput!: () => void;
    class Node {
      connect(): this { return this; }
      disconnect(): void {}
    }
    class Context {
      readonly destination = new Node();
      createMediaStreamSource(): Node { return new Node(); }
      createScriptProcessor(): Node & { onaudioprocess: null } {
        return Object.assign(new Node(), { onaudioprocess: null });
      }
      createGain(): Node & { gain: { value: number } } {
        return Object.assign(new Node(), { gain: { value: 1 } });
      }
      resume(): Promise<void> {
        return new Promise((resolve) => { resumeInput = resolve; });
      }
      async close(): Promise<void> {}
    }
    vi.stubGlobal('AudioContext', Context);
    const stream = {
      getAudioTracks: () => [{ id: 'caller-audio' }],
    } as unknown as MediaStream;
    const transport = new WebSocketTransport();
    const { started } = await connecting(transport);
    socket().message(AUDIO_FORMAT);
    await started;

    const first = transport.startAudioStream(stream);
    await vi.waitFor(() => expect(resumeInput).toBeTypeOf('function'));
    await expect(transport.startAudioStream(stream)).rejects.toBeInstanceOf(
      SessionStateError,
    );
    resumeInput();
    await first;
  });

  it('keeps caller audio stopped when stop wins an in-flight start', async () => {
    let finishMicClose!: () => void;
    stubInputContexts([
      { close: () => new Promise<void>((resolve) => { finishMicClose = resolve; }) },
      {},
    ]);
    const microphone = mediaStream('microphone');
    const caller = mediaStream('caller');
    vi.stubGlobal('navigator', {
      mediaDevices: { getUserMedia: vi.fn().mockResolvedValue(microphone) },
    });
    const transport = new WebSocketTransport();
    const { started } = await connecting(transport, { publishMicrophone: true });
    socket().message(AUDIO_FORMAT);
    await started;

    const starting = transport.startAudioStream(caller);
    await vi.waitFor(() => expect(finishMicClose).toBeTypeOf('function'));
    await transport.stopAudioStream();
    finishMicClose();

    await expect(starting).resolves.toBeUndefined();
    expect(transport.getInputStream()).toBe(microphone);
  });

  it('restores the microphone when a caller stream cannot start', async () => {
    stubInputContexts([
      {},
      { resume: () => Promise.reject(new Error('caller resume failed')) },
      {},
      {},
    ]);
    const microphone = mediaStream('microphone');
    const caller = mediaStream('caller');
    vi.stubGlobal('navigator', {
      mediaDevices: { getUserMedia: vi.fn().mockResolvedValue(microphone) },
    });
    const transport = new WebSocketTransport();
    const { started } = await connecting(transport, { publishMicrophone: true });
    socket().message(AUDIO_FORMAT);
    await started;

    await expect(transport.startAudioStream(caller)).rejects.toThrow('caller resume failed');

    expect(transport.getInputStream()).toBe(microphone);
    await expect(transport.startAudioStream(caller)).resolves.toBeUndefined();
  });

  it('restores a pending microphone when a caller stream cannot start', async () => {
    let resolveMicrophone!: (stream: MediaStream) => void;
    const getUserMedia = vi.fn(
      () => new Promise<MediaStream>((resolve) => { resolveMicrophone = resolve; }),
    );
    vi.stubGlobal('navigator', { mediaDevices: { getUserMedia } });
    stubInputContexts([
      { resume: () => Promise.reject(new Error('caller resume failed')) },
      {},
    ]);
    const microphone = mediaStream('microphone');
    const caller = mediaStream('caller');
    const transport = new WebSocketTransport();
    const { started } = await connecting(transport, { publishMicrophone: true });
    socket().message(AUDIO_FORMAT);
    await vi.waitFor(() => expect(getUserMedia).toHaveBeenCalledOnce());

    const starting = transport.startAudioStream(caller);
    resolveMicrophone(microphone);

    await expect(starting).rejects.toThrow('caller resume failed');
    await started;
    expect(transport.getInputStream()).toBe(microphone);
  });

  it('keeps a muted device microphone muted across a caller-stream handoff', async () => {
    stubInputContexts([{}, {}]);
    const microphone = mediaStream('microphone');
    const caller = mediaStream('caller');
    vi.stubGlobal('navigator', {
      mediaDevices: { getUserMedia: vi.fn().mockResolvedValue(microphone) },
    });
    const transport = new WebSocketTransport();
    const { started } = await connecting(transport, { publishMicrophone: true });
    socket().message(AUDIO_FORMAT);
    await started;

    await transport.setMicMuted(true);
    await transport.startAudioStream(caller);
    await transport.stopAudioStream();

    expect(transport.getInputStream()).toBeNull();
    expect(socket().sent.map(String)).toEqual([
      JSON.stringify({ type: 'mute', muted: true }),
      JSON.stringify({ type: 'bind-input' }),
      JSON.stringify({ type: 'mute', muted: false }),
      JSON.stringify({ type: 'mute', muted: true }),
    ]);
  });

  it('restores a pending microphone after a caller-stream handoff', async () => {
    let resolveMicrophone!: (stream: MediaStream) => void;
    const getUserMedia = vi.fn(
      () => new Promise<MediaStream>((resolve) => { resolveMicrophone = resolve; }),
    );
    vi.stubGlobal('navigator', { mediaDevices: { getUserMedia } });
    stubInputContexts([{}, {}]);
    const microphone = mediaStream('microphone');
    const caller = mediaStream('caller');
    const transport = new WebSocketTransport();
    const { started } = await connecting(transport, { publishMicrophone: true });
    socket().message(AUDIO_FORMAT);
    await vi.waitFor(() => expect(getUserMedia).toHaveBeenCalledOnce());

    await transport.startAudioStream(caller);
    const stopping = transport.stopAudioStream();
    resolveMicrophone(microphone);
    await Promise.all([started, stopping]);

    expect(getUserMedia).toHaveBeenCalledOnce();
    expect(transport.getInputStream()).toBe(microphone);
    expect(socket().sent.map(String)).toEqual([
      JSON.stringify({ type: 'bind-input' }),
      JSON.stringify({ type: 'mute', muted: false }),
      JSON.stringify({ type: 'mute', muted: false }),
    ]);
  });

  it('does not let a stale unmute replace the microphone restored by stop', async () => {
    let finishCallerClose!: () => void;
    stubInputContexts([
      {},
      { close: () => new Promise<void>((resolve) => { finishCallerClose = resolve; }) },
      {},
    ]);
    const microphone = mediaStream('microphone');
    const caller = mediaStream('caller');
    vi.stubGlobal('navigator', {
      mediaDevices: { getUserMedia: vi.fn().mockResolvedValue(microphone) },
    });
    const transport = new WebSocketTransport();
    const { started } = await connecting(transport, { publishMicrophone: true });
    socket().message(AUDIO_FORMAT);
    await started;
    await transport.startAudioStream(caller);

    const unmuting = transport.setMicMuted(false);
    await vi.waitFor(() => expect(finishCallerClose).toBeTypeOf('function'));
    await transport.stopAudioStream();
    expect(transport.getInputStream()).toBe(microphone);

    finishCallerClose();
    await unmuting;
    expect(transport.getInputStream()).toBe(microphone);
  });

  it('reports fallback autoplay rejection and recovery', async () => {
    const outputSources: OutputNode[] = [];
    class OutputNode {
      buffer: AudioBuffer | null = null;
      onended: (() => void) | null = null;
      readonly start = vi.fn();
      readonly stop = vi.fn();
      connect(): this { return this; }
    }
    class OutputContext {
      readonly currentTime = 0;
      readonly destination = new OutputNode();
      createMediaStreamDestination(): { stream: MediaStream } {
        return { stream: mediaStream('output') };
      }
      createBuffer(_channels: number, length: number, rate: number): AudioBuffer {
        return {
          duration: length / rate,
          copyToChannel: vi.fn(),
        } as unknown as AudioBuffer;
      }
      createBufferSource(): OutputNode {
        const source = new OutputNode();
        outputSources.push(source);
        return source;
      }
      async resume(): Promise<void> {}
      async close(): Promise<void> {}
    }
    vi.stubGlobal('AudioContext', OutputContext);
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    let rejectAutoplay!: (error: Error) => void;
    const blocked = new Promise<void>((_resolve, reject) => { rejectAutoplay = reject; });
    const play = vi.spyOn(HTMLMediaElement.prototype, 'play')
      .mockReturnValueOnce(blocked)
      .mockResolvedValueOnce(undefined);
    const onOutputBlocked = vi.fn();
    const transport = new WebSocketTransport();
    const { started } = await connecting(transport, { onOutputBlocked });
    socket().message(AUDIO_FORMAT);
    await started;

    socket().message(new Uint8Array([0, 0]).buffer);
    socket().message(new Uint8Array([0, 0]).buffer);
    rejectAutoplay(new Error('autoplay blocked'));
    await vi.waitFor(() => expect(onOutputBlocked).toHaveBeenCalledWith(true));

    expect(outputSources).toHaveLength(2);
    expect(outputSources.every((source) => source.stop.mock.calls.length === 1)).toBe(true);
    socket().message(new Uint8Array([0, 0]).buffer);
    expect(outputSources).toHaveLength(2);

    await transport.resumeAudioPlayback();

    expect(play).toHaveBeenCalledTimes(2);
    expect(onOutputBlocked.mock.calls).toEqual([[true], [false]]);
  });

  it('publishes caller-owned MediaStream samples as server-rate PCM', async () => {
    class Node {
      connect(): this {
        return this;
      }
      disconnect(): void {}
    }
    class Processor extends Node {
      onaudioprocess: ((event: AudioProcessingEvent) => void) | null = null;
    }
    const processor = new Processor();
    class Context {
      readonly destination = new Node();
      createMediaStreamSource(): Node {
        return new Node();
      }
      createScriptProcessor(): Processor {
        return processor;
      }
      createGain(): Node & { gain: { value: number } } {
        return Object.assign(new Node(), { gain: { value: 1 } });
      }
      async resume(): Promise<void> {}
      async close(): Promise<void> {}
    }
    vi.stubGlobal('AudioContext', Context);
    const stream = {
      getAudioTracks: () => [{ id: 'caller-audio' }],
      getTracks: () => [{ id: 'caller-audio', stop: vi.fn() }],
    } as unknown as MediaStream;
    const transport = new WebSocketTransport();
    const { started } = await connecting(transport);
    socket().message(AUDIO_FORMAT);
    await started;

    await transport.startAudioStream(stream);
    processor.onaudioprocess?.({
      inputBuffer: {
        sampleRate: 48_000,
        getChannelData: () => Float32Array.from({ length: 480 }, () => 0.5),
      },
    } as unknown as AudioProcessingEvent);

    const binary = socket().sent.find((item) => item instanceof Int16Array);
    expect(binary).toBeInstanceOf(Int16Array);
    expect(binary).toHaveLength(160);
    expect(socket().sent.filter((item): item is string => typeof item === 'string')).toEqual(
      [JSON.stringify({ type: 'bind-input' }), JSON.stringify({ type: 'mute', muted: false })],
    );
  });
});

/**
 * The connect waterfall over the websocket lane, driven through a real
 * ``SessionEngine``: the transport hands the engine its measured origin, so
 * the ``ready`` mark that lands after the connect shares a clock with the
 * phases, and the server's start breakdown reaches the worker report.
 */
describe('websocket connect-timings report', () => {
  it('measures ready against the transport origin and carries the server breakdown', async () => {
    // ready_ms of 1180 requires the transport's origin (100) to have
    // replaced the engine's earlier fallback (5000) — negative otherwise.
    stubInputContexts([{}]);
    const nowValues = [5000, 100];
    let clock = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => nowValues.shift() ?? clock);
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(async () => {
        clock = 310;
        return new Response(JSON.stringify({ ...STARTED, timings: SERVER_TIMINGS }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }),
    );
    const engine = new SessionEngine({
      createTransport: () => new WebSocketTransport(),
      startUrl: () => START_URL,
      dialUrl: (id) => `${START_URL}/${id}/dial`,
      usageUrl: (id) => `${START_URL}/${id}/usage`,
      resolveAuthHeaders: async () => ({}),
      onStartUnauthorized: () => {},
    });

    const starting = engine.start({ config: CONFIG, publishMicrophone: false });
    while (FakeWebSocket.instances.length === 0) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    clock = 740;
    socket().message(AUDIO_FORMAT);
    clock = 1280;
    socket().message(JSON.stringify({ type: 'ready', session_id: 'session-1' }));
    await starting;
    await new Promise((resolve) => setTimeout(resolve, 0));

    const frames = socket().sent
      .filter((item): item is string => typeof item === 'string')
      .map((item) => JSON.parse(item) as Record<string, unknown>)
      .filter((item) => item.type === 'connect-timings');
    expect(frames).toEqual([
      {
        type: 'connect-timings',
        request_ms: 210,
        room_ms: 0,
        mic_ms: 0,
        ready_ms: 1180,
        server: SERVER_TIMINGS,
      },
    ]);
    expect(engine.getConnectTimings()?.readyMs).toBe(1180);
    expect(engine.getConnectTimings()?.serverTimings).toEqual(SERVER_TIMINGS);
  });
});

describe('websocket PCM conversion', () => {
  it('resamples captured float audio to the server input rate', () => {
    const input = Float32Array.from({ length: 480 }, (_, index) => Math.sin(index / 10));
    const pcm = floatToPcm16(input, 48_000, 16_000);
    expect(pcm).toHaveLength(160);
    expect(Math.max(...pcm.map(Math.abs))).toBeGreaterThan(20_000);
  });

  it('preserves resampling phase across browser audio callbacks', () => {
    const resampler = new Pcm16Resampler();
    const lengths = Array.from({ length: 3 }, () =>
      resampler.process(new Float32Array(2_048), 48_000, 16_000).length
    );
    expect(lengths).toEqual([683, 683, 682]);
    expect(lengths.reduce((total, length) => total + length, 0)).toBe(2_048);
  });

  it('decodes little-endian PCM16 for browser playback', () => {
    const bytes = new Uint8Array([0x00, 0x40, 0x00, 0xc0]);
    expect(Array.from(pcm16ToFloat(bytes))).toEqual([0.5, -0.5]);
  });
});
