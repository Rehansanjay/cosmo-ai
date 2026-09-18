/**
 * The external protocol's inbound frames, as the transport sees them.
 *
 * Nothing here is restated from the schema. An inbound frame reaches a
 * consumer only as the session's own event type, converted in
 * ``core/wire_decode``, so the frames themselves need no hand-written twin
 * to keep generated symbols off the published surface — they never reach
 * it. What remains is the transport's view: the envelope carrier it
 * unwraps, and the union it decodes into.
 */

import type { ServerEnvelope as WireServerEnvelope } from '../wire/types.gen';
import type { WireServerMessage } from '../core/wire_decode';

/**
 * Generic chunked carrier for any oversized server message.
 *
 * Mirror of ``ClientEnvelope`` for the server→client direction. The server
 * wraps any server message whose serialized JSON exceeds the transport
 * threshold into a sequence of these chunks; the SDK buffers by
 * ``envelope_id``, base64-decodes and concatenates, then re-dispatches the
 * inner message through the same handler path as un-chunked messages.
 */
export type ServerEnvelope = WireServerEnvelope;

/**
 * Every inbound frame this SDK recognizes. The transport unwraps
 * ``server-envelope-chunk`` carriers before dispatch, so the envelope type
 * intentionally does not appear here.
 */
export type RealtimeServerMessage = WireServerMessage;
