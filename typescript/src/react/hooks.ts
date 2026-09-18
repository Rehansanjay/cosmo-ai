'use client';

/**
 * Read-only React hooks that publish the normalized SDK state
 * (transport / agent / media) plus the transcript and tool-call
 * streams.
 *
 * Imperative entry points (start / end / sendText / setMuted /
 * attachAudioElement) live on the ``RealtimeSession`` — these hooks are
 * purely for reading. Each hook is backed by the provider's React
 * snapshot derived from the session's event stream, so the SDK has no
 * app-internal state dependency.
 */

import { useEffect, useState } from 'react';

import type { AgentState, MediaState, TransportState } from '../core/state';
import type { AudioUnavailableError } from '../core/errors';
import type { SessionStartError } from '../transport/session_start_error';
import type { ErrorEvent, ScreenShareState } from '../core/types';
import type { TranscriptItem } from '../core/events';

import {
  useRealtimeSessionContext,
  useRealtimeSnapshot,
  type RealtimeToolCallItem,
} from './RealtimeProvider';

/** Wire connectivity, for a connection indicator. ``'ready'`` is the state
 *  in which the session is usable. */
export function useTransportState(): TransportState {
  return useRealtimeSnapshot().transportState;
}

/** What the agent is doing — listening, thinking, speaking — for a talking
 *  indicator. */
export function useAgentState(): AgentState {
  return useRealtimeSnapshot().agentState;
}

/** The mic, screen share and audio output states together. */
export function useMediaState(): MediaState {
  return useRealtimeSnapshot().mediaState;
}

/** Options for ``useTranscript()``. */
export type UseTranscriptOptions = {
  /** Cap the returned slice to the last ``limit`` items (e.g. a compact
   *  toolbar preview). Omit for the full conversation. */
  limit?: number;
};

/** The session's coalesced conversation — one item per turn, already
 *  folded by the SDK. Render it as-is; ``TranscriptItem.id`` is the
 *  stable render key and ``isFinal`` marks turns that can no longer
 *  change. */
export function useTranscript(
  options: UseTranscriptOptions = {},
): readonly TranscriptItem[] {
  const { limit } = options;
  const transcript = useRealtimeSnapshot().transcript;
  if (limit === undefined || transcript.length <= limit) return transcript;
  return transcript.slice(-limit);
}

/** Tool calls made during this run, oldest first, each folded into one row
 *  whose ``status`` settles when its result lands. Resets on every new
 *  session — unlike the transcript, it is not carried over. */
export function useToolCalls(): RealtimeToolCallItem[] {
  return useRealtimeSnapshot().toolCalls;
}

/** Most recent terminal-ish error reported by the SDK, or ``null`` if
 *  the session is healthy. Cleared on a successful ``connect()`` reset.
 *  The value is the error itself: branch with ``instanceof RealtimeError``
 *  and ``name`` for the typed start failures; the remaining case is the
 *  decoded wire ``error`` frame with the server's ``code`` and ``fatal``. */
export function useRealtimeError():
  | SessionStartError
  | AudioUnavailableError
  | ErrorEvent
  | null {
  return useRealtimeSnapshot().error;
}

function useVolumeChannel(channel: 'mic' | 'output'): number {
  const session = useRealtimeSessionContext();
  const [level, setLevel] = useState<number>(0);
  useEffect(() => {
    if (session === null) return;
    const unsub = session.on('volume', (e) => {
      setLevel(channel === 'mic' ? e.mic : e.output);
    });
    return () => {
      unsub();
      setLevel(0);
    };
  }, [session, channel]);
  return level;
}

/** What ``useScreenShare()`` returns: the share's state, and the stream to
 *  render a preview from while it is active. */
export type ScreenShare = {
  /** Where the share is in its lifecycle: inactive, requesting, active,
   *  or error. */
  state: ScreenShareState;
  /** The locally captured display stream while ``state.kind`` is
   *  ``'active'`` — hand it to a ``<video>`` element's ``srcObject`` to
   *  show the person what they are sharing. ``null`` otherwise. The SDK
   *  owns its lifecycle; call ``session.stopScreenShare()`` to end it,
   *  never ``track.stop()``. */
  stream: MediaStream | null;
};

/** The screen share, for rendering. Starting and stopping are session
 *  calls (``session.startScreenShare()`` / ``session.stopScreenShare()``),
 *  like every other imperative entry point. */
export function useScreenShare(): ScreenShare {
  const session = useRealtimeSessionContext();
  const state = useMediaState().screen;
  return {
    state,
    stream:
      state.kind === 'active' && session !== null
        ? session.getScreenShareStream()
        : null,
  };
}

/** How loudly the person is speaking, 0–1, for a mic meter. Updates per
 *  animation frame while a session is live, and returns ``0`` otherwise. */
export function useMicLevel(): number {
  return useVolumeChannel('mic');
}

/** How loudly the agent is speaking, 0–1, on the same terms as
 *  ``useMicLevel``. */
export function useOutputLevel(): number {
  return useVolumeChannel('output');
}
