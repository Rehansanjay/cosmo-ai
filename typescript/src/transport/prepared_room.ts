/**
 * The room reserved ahead of a session start by ``agent.prepareSession()``.
 * Not a published entry point: the reservation is the SDK's own accelerator,
 * and the prepared *session* is the only concept a caller sees.
 */

import type { RealtimeConnectOptions } from './types';

/** Join credentials for a reserved room, held until the prepared session is
 *  started. @internal */
export type PreparedRoomRef = {
  roomName: string;
  roomGrant: string;
  token: string;
  livekitUrl: string;
  /** ``Date.now()`` at reservation; the prepared session age-guards before
   *  handing the ref over. */
  preparedAt: number;
};

/** The connect options the SDK's own engine hands its LiveKit transport: the
 *  public contract plus the reserved room, joined while the session-start
 *  POST is in flight. Never part of the published transport contract. */
export type PreparedConnectOptions = RealtimeConnectOptions & {
  prepared?: PreparedRoomRef;
  /** When the caller began waiting, if before the connect itself — a
   *  prepared start awaits its reservation first, and the connect timings
   *  cover that wait. */
  startedAt?: number;
};
