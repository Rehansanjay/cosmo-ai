import { afterEach, describe, expect, it, vi } from 'vitest';
import { mintAgentTool } from '../agent';
import { RealtimeClient } from '../realtime_client';
import { WebSocketTransport } from '../../transport/websocket_transport';
import type { RealtimeInboundMessage } from '../../transport/envelope';

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('RealtimeClient transport selection', () => {
  it('refuses two transport selection mechanisms', () => {
    expect(
      () =>
        new RealtimeClient({
          apiKey: 'test-key',
          transport: 'websocket',
          transportFactory: () => {
            throw new Error('unused');
          },
        }),
    ).toThrow('Provide transport or transportFactory, not both.');
  });

  it('refuses an unknown environment value instead of silently using LiveKit', () => {
    vi.stubEnv('COSMO_TRANSPORT', 'websockets');
    expect(() => new RealtimeClient({ apiKey: 'test-key' })).toThrow(
      'transport must be webrtc or websocket',
    );
  });

  it('keeps livekit as a deprecated alias for webrtc', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    new RealtimeClient({ apiKey: 'test-key', transport: 'livekit' });
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('transport "livekit" is deprecated'),
    );
  });

  it('selects the built-in websocket adapter and its private start route', async () => {
    let emit: ((msg: RealtimeInboundMessage) => void) | null = null;
    vi.spyOn(WebSocketTransport.prototype, 'onMessage').mockImplementation((cb) => {
      emit = cb;
      return () => {};
    });
    const connect = vi
      .spyOn(WebSocketTransport.prototype, 'connect')
      .mockImplementation(async (options) => {
        options.onSessionStarted?.('session-1');
        emit?.({ type: 'ready', session_id: 'session-1' });
      });
    const client = new RealtimeClient({
      apiKey: 'test-key',
      transport: 'websocket',
    });

    await client.agent().start({ publishMicrophone: false });

    expect(connect).toHaveBeenCalledTimes(1);
    expect(connect.mock.calls[0][0].sessionStartUrl).toBe(
      'https://api.example.com/api/v1/external/realtime/session/ws-start',
    );
  });

  it('rejects background tools before opening a local websocket session', async () => {
    const client = new RealtimeClient({ apiKey: 'test-key', transport: 'websocket' });
    const agent = client.agent({
      tools: [
        mintAgentTool({
          kind: 'client',
          background: true,
          name: 'slow_job',
          description: 'Runs for a while.',
          parameters: { type: 'object', properties: {} },
          handler: async () => undefined,
        }),
      ],
    });

    await expect(agent.start()).rejects.toMatchObject({
      name: 'SessionStartError',
      code: 'config',
      serverCode: 'background_tools_unsupported',
      message: 'Background client tools are not supported by the websocket transport.',
    });
  });
});
