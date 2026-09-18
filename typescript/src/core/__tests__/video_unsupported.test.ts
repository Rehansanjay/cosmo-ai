/** On a transport that carries no video — the websocket transport — every
 *  video entry point refuses with the one stable code ``video_unsupported``,
 *  the way the background-tools guard refuses; a stop for a share that could
 *  never start keeps its idempotent no-op contract. */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { RealtimeClient } from '../realtime_client';
import type { RealtimeSession } from '../session';
import { SessionStartError } from '../../transport/session_start_error';
import type { RealtimeTransport } from '../../transport/types';
import { WebSocketTransport } from '../../transport/websocket_transport';
import { makeFakeTransport, sentTurns, type FakeTransport } from './test_helpers';

async function liveVideolessSession(fake: FakeTransport): Promise<RealtimeSession> {
  const client = new RealtimeClient({ apiKey: 'test-key', transportFactory: () => fake });
  const session = await client.agent({}).start();
  fake.emitMessage({ type: 'ready', session_id: 'sess-fake' });
  return session;
}

function expectVideoUnsupported(err: unknown): void {
  expect(err).toBeInstanceOf(SessionStartError);
  expect((err as SessionStartError).detail?.code).toBe('video_unsupported');
}

beforeEach(() => {
  process.env.COSMO_API_KEY = 'cosmo_env_key';
});

afterEach(() => {
  delete process.env.COSMO_API_KEY;
});

describe('video on a transport without video', () => {
  it('the websocket transport declares no video capability', () => {
    const transport: RealtimeTransport = new WebSocketTransport();
    expect(transport.addVideoStream).toBeUndefined();
    expect(transport.removeVideoStream).toBeUndefined();
  });

  it('startScreenShare refuses with video_unsupported and surfaces the state error', async () => {
    const fake = makeFakeTransport();
    const session = await liveVideolessSession(fake);

    const err = await session.startScreenShare().catch((e: unknown) => e);

    expectVideoUnsupported(err);
    const state = session.getScreenShareState();
    expect(state.kind).toBe('error');
    if (state.kind === 'error') {
      expect(state.error.message).toContain('no video');
    }
  });

  it('addVideoStream refuses with video_unsupported', async () => {
    const fake = makeFakeTransport();
    const session = await liveVideolessSession(fake);

    const err = await session
      .addVideoStream({} as MediaStream)
      .catch((e: unknown) => e);

    expectVideoUnsupported(err);
  });

  it('a stop or remove for a publish that could never exist stays a no-op', async () => {
    const fake = makeFakeTransport();
    const session = await liveVideolessSession(fake);

    await session.stopScreenShare();
    await session.removeVideoStream('video-handle-1');

    expect(session.getScreenShareState().kind).toBe('inactive');
    expect(sentTurns(fake)).toEqual([]);
  });
});
