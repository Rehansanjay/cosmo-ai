/**
 * Normalized state model for the Realtime SDK.
 *
 * Three independent axes — transport (wire connectivity), agent (LLM
 * activity), and media (mic / screen / output) — each progresses at its
 * own cadence and surfaces different UX cues, so we model them
 * separately rather than collapsing them to a single union.
 */

import type { SessionStartTimings } from '../protocol';
import type { AudioUnavailableError } from './errors';
import type { SessionStartError } from '../transport/session_start_error';
import type { ErrorEvent, ScreenShareState } from './types';

/** Wire connectivity, at the granularity a browser UI renders: the
 *  permission prompt, the join, and the teardown are each their own state.
 *  ``ready`` means the session is usable; ``connected`` means the room is
 *  joined but the model has not finished handshaking. For the cross-SDK
 *  lifecycle with typed end reasons, read ``SessionState`` instead. */
export type TransportState =
  | 'disconnected'
  | 'requesting-permission'
  | 'connecting'
  | 'connected'
  | 'ready'
  | 'reconnecting'
  | 'disconnecting'
  | 'failed';

/** Typed end reasons for the formal session lifecycle. Cross-SDK
 *  vocabulary — Python's ``DisconnectReason`` is the reference. */
export type DisconnectReason =
  | 'client_ended'
  | 'client_closed'
  | 'handshake_failed'
  | 'server_ended'
  | 'transport_error';

/** Formal connection lifecycle:
 *  ``idle → connecting → connected ↔ reconnecting → disconnected``.
 *  Distinct from ``TransportState`` (the browser-UX axis with
 *  permission/ready/disconnecting phases): this machine is the
 *  cross-SDK session lifecycle with typed end reasons.
 *  ``disconnectReason`` is populated only when ``kind`` is
 *  ``'disconnected'``; ``detail`` carries the server's end slug or a
 *  transport message when one exists. */
export type SessionStateKind =
  | 'idle'
  | 'connecting'
  | 'connected'
  | 'reconnecting'
  | 'disconnected';

/** Where the session is in its lifecycle, with the reason it ended once it
 *  has. Readable at any time as ``RealtimeSession.state``. */
export type SessionState = {
  /** Where the session is in its transport lifecycle. */
  kind: SessionStateKind;
  /** Why it disconnected. Present only on ``'disconnected'``. */
  disconnectReason?: DisconnectReason;
  /** Extra context on the ending — the server's end slug, or a transport
   *  message — when one exists. */
  detail?: string;
};

/** The lifecycle state a session holds before it starts connecting. */
export const INITIAL_LIFECYCLE_STATE: SessionState = { kind: 'idle' };

/** What the agent is doing, for driving a talking indicator: waiting for
 *  the session to start, hearing the person, composing a reply, or
 *  speaking one. */
export type AgentState = 'idle' | 'listening' | 'thinking' | 'speaking';

/** The microphone, from permission through capture. ``unknown`` before
 *  anything has been asked, ``denied`` when the browser refused, and
 *  ``not-found`` when the device is missing; ``muted`` is the person having
 *  muted a granted mic. */
export type MicState =
  | 'unknown'
  | 'requesting'
  | 'granted'
  | 'denied'
  | 'muted'
  | 'not-found'
  | 'in-use';

/** Agent audio playback. ``blocked`` is the browser refusing to autoplay
 *  until a user gesture — the state ``<StartAudio />`` renders against. */
export type OutputState = 'blocked' | 'playing' | 'silent';

/** The three media axes together — what the person's mic, screen share and
 *  speakers are each doing. */
export type MediaState = {
  /** What the person's microphone is doing. */
  mic: MicState;
  /** What the screen share is doing. */
  screen: ScreenShareState;
  /** What playback of the agent's voice is doing. */
  output: OutputState;
};

/** Connect-latency breakdown: the client-measured phases of this session's
 *  start plus the server's own breakdown from the start response.
 *
 *  ``wsMs`` is the session-start POST, ``roomMs`` the LiveKit join, ``micMs``
 *  the mic publish (``0`` for a session that publishes none), ``totalConnectMs``
 *  the whole connect. ``readyMs`` runs from that same connect start to the
 *  ``ready`` event and is ``null`` until it lands. ``serverTimings`` is
 *  ``null`` on a backend that doesn't report it; a server phase the serving
 *  flow doesn't have reports ``0`` rather than a fabricated split, so a zero
 *  there is a real measurement.
 *
 *  A transport that predates the mark may omit it; it is absent rather than
 *  ``null`` on such a value. */
export type SessionConnectTimings = {
  /** The session-start POST round trip. */
  wsMs: number;
  /** Joining the media room. */
  roomMs: number;
  /** Publishing the microphone. ``0`` for a session that publishes none. */
  micMs: number;
  /** The whole connect, from the call to a live session. */
  totalConnectMs: number;
  /** From the same start as ``totalConnectMs`` to the ``ready`` event — what
   *  the user actually waited. ``null`` until it lands, and absent on a
   *  transport that predates the mark. */
  readyMs?: number | null;
  /** The server's own phase breakdown, so both halves of the connect land on
   *  one record. ``null`` on a backend that does not report it. */
  serverTimings: SessionStartTimings | null;
};

/** Every state axis read together at one instant, from
 *  ``RealtimeSession.getSnapshot()``. For a value that re-renders as it
 *  changes, use the React hooks rather than polling this. */
export type RealtimeSnapshot = {
  /** Where the transport is — connecting, connected, reconnecting, closed. */
  transportState: TransportState;
  /** What the agent is doing: idle, listening, thinking, speaking. */
  agentState: AgentState;
  /** Which media are live — microphone, speaker, camera, screen share. */
  mediaState: MediaState;
  /** The most recent error, or ``null`` when none has occurred. It is not
   *  cleared by a later success, so treat it as the last thing that went
   *  wrong rather than as current health. The value is the error itself:
   *  a typed start failure, or the decoded wire ``error`` frame. */
  error: SessionStartError | AudioUnavailableError | ErrorEvent | null;
};

/** Media state before anything has been requested or captured. */
export const INITIAL_MEDIA_STATE: MediaState = {
  mic: 'unknown',
  screen: { kind: 'inactive' },
  output: 'silent',
};

/** The snapshot with no session running — what a React provider publishes
 *  between runs. */
export const INITIAL_SNAPSHOT: RealtimeSnapshot = {
  transportState: 'disconnected',
  agentState: 'idle',
  mediaState: INITIAL_MEDIA_STATE,
  error: null,
};
