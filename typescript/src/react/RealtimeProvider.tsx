'use client';

import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type MutableRefObject,
  type ReactNode,
} from 'react';

import type { RealtimeSession } from '../core/session';
import type {
  ToolCallEvent,
  ToolResultEvent,
  TranscriptItem,
  Unsubscribe,
} from '../core/events';
import {
  INITIAL_SNAPSHOT,
  type AgentState,
  type MediaState,
  type RealtimeSnapshot,
  type TransportState,
} from '../core/state';

/**
 * Canonical React-first surface for the Cosmo Realtime SDK.
 *
 * The provider is the read side of one ``RealtimeSession``: pass it the
 * session a run returned (``useRealtimeSession``'s ``session``, or your
 * own ``agent.start()`` result) and it publishes a React snapshot through
 * context so the read-only hooks (``useTransportState`` /
 * ``useAgentState`` / ``useMediaState`` / ``useTranscript`` /
 * ``useToolCalls``) read from React state. With no session (``null``,
 * between runs) the snapshot is the initial idle state.
 *
 * Session lifecycle stays the caller's: the provider never starts or
 * ends anything.
 */

/** One tool call, folded from its ``tool_call`` and ``tool_result`` events
 *  into a single row a UI can render. ``status`` moves from ``in_flight``
 *  once the result lands. Read the list with ``useToolCalls()``. */
export type RealtimeToolCallItem = {
  /** Server-assigned id for this call, stable across its two events and
   *  suitable as a React key. */
  toolCallId: string;
  /** The tool the model called. */
  name: string;
  /** ``in_flight`` until the result lands, then whether it succeeded. */
  status: 'in_flight' | 'ok' | 'error';
  /** A short rendering of the result, or the error when it failed.
   *  ``null`` while still in flight. */
  summary: string | null;
};

/** What the provider publishes through context: the session's state axes,
 *  transcript and tool calls, as React state. The read-only hooks
 *  (``useAgentState``, ``useTranscript``, …) are the way to read it. */
export type RealtimeSnapshotState = {
  /** Where the transport is — connecting, connected, reconnecting, closed. */
  transportState: TransportState;
  /** What the agent is doing: idle, listening, thinking, speaking. */
  agentState: AgentState;
  /** Which media are live — microphone, speaker, camera, screen share. */
  mediaState: MediaState;
  /** The conversation so far. Session-owned, so a provider handed a
   *  mid-run session starts with it already populated. */
  transcript: readonly TranscriptItem[];
  /** Tool calls this provider has observed, oldest first. Derived from the
   *  event stream, so it starts empty on every session change. */
  toolCalls: RealtimeToolCallItem[];
  /** Most recent terminal-ish error. Cleared back to ``null`` when the
   *  next session is supplied. */
  error: RealtimeSnapshot['error'];
};

/** The value ``<RealtimeProvider>`` puts on context. The hooks are the way
 *  to read it — this type is here for a component that needs to name it. */
export type RealtimeContextValue = {
  /** The session the provider was given, or ``null`` between runs. */
  session: RealtimeSession | null;
  /** Host-supplied ``<audio>`` element ref. Populated by
   *  ``<RealtimeAudio />``; ``null`` when no host element is mounted. */
  audioElementRef: MutableRefObject<HTMLAudioElement | null>;
  /** The session's state as React state, re-rendering on every change. */
  snapshot: RealtimeSnapshotState;
};

/** Seed the provider's React snapshot from whatever the session already
 *  knows. The transcript is session-owned state, so a provider handed a
 *  mid-run session starts with the conversation so far; the tool-call
 *  list is event-stream-derived and starts empty on every session
 *  change. Lifecycle fields (transport / agent / media) come from the
 *  live session so an already-connected session doesn't briefly show
 *  ``disconnected`` until the next event fires. */
function snapshotFromSession(session: RealtimeSession | null): RealtimeSnapshotState {
  const snap = session !== null ? session.getSnapshot() : INITIAL_SNAPSHOT;
  return {
    transportState: snap.transportState,
    agentState: snap.agentState,
    mediaState: snap.mediaState,
    transcript: session !== null ? session.transcript : [],
    toolCalls: [],
    error: snap.error,
  };
}

const RealtimeContext = createContext<RealtimeContextValue | null>(null);

/** Props for ``<RealtimeProvider>``. */
export type RealtimeProviderProps = {
  /** The tree that reads the session through the hooks. */
  children: ReactNode;
  /** The run to read from — ``useRealtimeSession``'s ``session``, or your
   *  own ``agent.start()`` result. ``null`` (or omitted) between runs;
   *  the snapshot then reports the initial idle state. Lifecycle is the
   *  caller's responsibility — the provider never ends the session. */
  session?: RealtimeSession | null;
};

/**
 * Publishes one session's state to the read-only hooks below it.
 *
 * ```tsx
 * <RealtimeProvider session={session}>
 *   <RealtimeAudio />
 *   <Transcript />
 * </RealtimeProvider>
 * ```
 *
 * Wrap the tree that renders a session. Hand it the session ``start()``
 * returned, and ``useTranscript()``, ``useAgentState()`` and the rest read
 * from React state instead of wiring their own subscriptions. Between runs
 * pass ``null`` (or nothing) and they report the idle state.
 *
 * Read-only: the provider never starts or ends a session. That stays with
 * whoever owns the run — ``useRealtimeSession`` if you want that handled
 * too.
 */
export function RealtimeProvider({
  children,
  session = null,
}: RealtimeProviderProps) {
  const audioElementRef = useRef<HTMLAudioElement | null>(null);

  const [snapshot, setSnapshot] = useState<RealtimeSnapshotState>(() =>
    snapshotFromSession(session),
  );

  useEffect(() => {
    setSnapshot(snapshotFromSession(session));
    if (session === null) return;
    const unsubs: Unsubscribe[] = [];
    unsubs.push(
      session.on('transport_state', (next) => {
        setSnapshot((prev) => (prev.transportState === next ? prev : { ...prev, transportState: next }));
      }),
    );
    unsubs.push(
      session.on('agent_state', (next) => {
        setSnapshot((prev) => (prev.agentState === next ? prev : { ...prev, agentState: next }));
      }),
    );
    unsubs.push(
      session.on('media_state', (next) => {
        setSnapshot((prev) => ({ ...prev, mediaState: next }));
      }),
    );
    unsubs.push(
      // Session-owned state, replayed on subscribe — the handler runs
      // synchronously with the current transcript, so the seed above and
      // this subscription can never disagree.
      session.on('transcript_updated', ({ items }) => {
        setSnapshot((prev) => (prev.transcript === items ? prev : { ...prev, transcript: items }));
      }),
    );
    unsubs.push(
      session.on('tool_call', (event) => {
        setSnapshot((prev) => ({
          ...prev,
          toolCalls: reduceToolCall(prev.toolCalls, event),
        }));
      }),
    );
    unsubs.push(
      session.on('tool_result', (event) => {
        setSnapshot((prev) => ({
          ...prev,
          toolCalls: reduceToolResult(prev.toolCalls, event),
        }));
      }),
    );
    unsubs.push(
      session.on('error', (next) => {
        setSnapshot((prev) => (prev.error === next ? prev : { ...prev, error: next }));
      }),
    );
    return () => {
      for (const u of unsubs) u();
    };
  }, [session]);

  const value = useMemo<RealtimeContextValue>(
    () => ({ session, audioElementRef, snapshot }),
    [session, snapshot],
  );
  return <RealtimeContext.Provider value={value}>{children}</RealtimeContext.Provider>;
}

function reduceToolCall(
  current: RealtimeToolCallItem[],
  event: ToolCallEvent,
): RealtimeToolCallItem[] {
  return [
    ...current,
    {
      toolCallId: event.toolCallId,
      name: event.name,
      status: 'in_flight',
      summary: null,
    },
  ];
}

function reduceToolResult(
  current: RealtimeToolCallItem[],
  event: ToolResultEvent,
): RealtimeToolCallItem[] {
  return current.map((entry) =>
    entry.toolCallId === event.toolCallId
      ? { ...entry, status: event.ok ? 'ok' : 'error', summary: event.summary }
      : entry,
  );
}

function useRealtimeContext(): RealtimeContextValue {
  const ctx = useContext(RealtimeContext);
  if (!ctx) {
    throw new Error(
      'Cosmo realtime hooks and components must be used inside <RealtimeProvider>.',
    );
  }
  return ctx;
}

/** The provider's current session, or ``null`` between runs. For
 *  imperative calls (``sendText``, ``setMuted``, …) from components that
 *  don't own the run themselves. */
export function useRealtimeSessionContext(): RealtimeSession | null {
  return useRealtimeContext().session;
}

/** The whole published snapshot, which the per-field hooks below read from.
 *  Reach for it when a component genuinely needs several axes at once. */
export function useRealtimeSnapshot(): RealtimeSnapshotState {
  return useRealtimeContext().snapshot;
}

/** Internal: the ref shared between ``<RealtimeAudio />`` and
 *  ``<StartAudio />``. Not exported from the package surface — it's an
 *  implementation detail of how the autoplay-unlock primitive finds
 *  the element to ``play()`` on. */
export function useRealtimeAudioElementRef(): MutableRefObject<HTMLAudioElement | null> {
  return useRealtimeContext().audioElementRef;
}
