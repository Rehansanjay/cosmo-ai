/** The locally captured display stream is the app's to render while a share
 *  is active — and nobody else's to hold once it stops. */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { RealtimeClient } from '../realtime_client';
import { makeFakeTransport, type FakeTransport } from './test_helpers';

function fakeVideoTrack(): MediaStreamTrack {
  const listeners = new Map<string, () => void>();
  return {
    kind: 'video',
    stop: vi.fn(),
    addEventListener: (name: string, cb: () => void) => listeners.set(name, cb),
    removeEventListener: (name: string) => listeners.delete(name),
  } as unknown as MediaStreamTrack;
}

function fakeDisplayStream(track: MediaStreamTrack): MediaStream {
  return {
    getVideoTracks: () => [track],
    getTracks: () => [track],
  } as unknown as MediaStream;
}

async function liveSessionWithVideo(fake: FakeTransport) {
  fake.addVideoStream = vi.fn(async () => 'video-handle-1');
  fake.removeVideoStream = vi.fn(async () => {});
  const original = fake.connect.bind(fake);
  fake.connect = async (opts) => {
    await original(opts);
  };
  const client = new RealtimeClient({ apiKey: 'test-key', transportFactory: () => fake });
  const session = await client.agent({}).start();
  fake.emitMessage({ type: 'ready', session_id: 'sess-fake' });
  return session;
}

beforeEach(() => {
  process.env.COSMO_API_KEY = 'cosmo_env_key';
});

afterEach(() => {
  delete process.env.COSMO_API_KEY;
  vi.unstubAllGlobals();
});

describe('the screen share stream', () => {
  it('is exposed while the share is active, and gone once it stops', async () => {
    const track = fakeVideoTrack();
    const stream = fakeDisplayStream(track);
    const fake = makeFakeTransport();
    const session = await liveSessionWithVideo(fake);
    // After start: a stubbed ``navigator`` flips runtime detection into
    // browser mode, which sends credential resolution down the wrong path.
    vi.stubGlobal('navigator', {
      mediaDevices: { getDisplayMedia: vi.fn(async () => stream) },
    });

    expect(session.getScreenShareStream()).toBeNull();

    await session.startScreenShare();
    expect(session.getScreenShareState().kind).toBe('active');
    expect(session.getScreenShareStream()).toBe(stream);

    await session.stopScreenShare();
    expect(session.getScreenShareState().kind).toBe('inactive');
    expect(session.getScreenShareStream()).toBeNull();
    expect(track.stop).toHaveBeenCalled();
  });

  it('stays null when the capture was refused', async () => {
    const fake = makeFakeTransport();
    const session = await liveSessionWithVideo(fake);
    vi.stubGlobal('navigator', {
      mediaDevices: {
        getDisplayMedia: vi.fn(async () => {
          throw new DOMException('Permission denied', 'NotAllowedError');
        }),
      },
    });

    await expect(session.startScreenShare()).rejects.toThrow();
    expect(session.getScreenShareState().kind).toBe('error');
    expect(session.getScreenShareStream()).toBeNull();
  });
});
