// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { render } from '@testing-library/react';

import type { RealtimeSession } from '../../core/session';
import type { ScreenShareState } from '../../core/types';
import { RealtimeProvider } from '../RealtimeProvider';
import { useScreenShare, type ScreenShare } from '../hooks';

const fakeStream = { getTracks: () => [] } as unknown as MediaStream;

function fakeSession(screen: ScreenShareState): RealtimeSession {
  return {
    on: vi.fn(() => () => undefined),
    getScreenShareStream: vi.fn(() =>
      screen.kind === 'active' ? fakeStream : null,
    ),
    getSnapshot: () => ({
      transportState: 'ready',
      agentState: 'idle',
      mediaState: { mic: 'unknown', screen, output: 'silent' },
      error: null,
    }),
  } as unknown as RealtimeSession;
}

function probe(session: RealtimeSession): ScreenShare {
  let captured: ScreenShare | undefined;
  function Probe() {
    captured = useScreenShare();
    return null;
  }
  render(
    <RealtimeProvider session={session}>
      <Probe />
    </RealtimeProvider>,
  );
  if (captured === undefined) throw new Error('hook never rendered');
  return captured;
}

describe('useScreenShare', () => {
  it('hands over the captured stream while the share is active', () => {
    const share = probe(fakeSession({ kind: 'active', startedAt: 1 }));

    expect(share.state.kind).toBe('active');
    expect(share.stream).toBe(fakeStream);
  });

  it('reports no stream while nothing is being shared', () => {
    const share = probe(fakeSession({ kind: 'inactive' }));

    expect(share.state.kind).toBe('inactive');
    expect(share.stream).toBeNull();
  });
});
