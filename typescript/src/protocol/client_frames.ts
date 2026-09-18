/**
 * The external protocol's outbound frames.
 *
 * Declared by the SDK rather than re-exported from ``../wire/types.gen``, so
 * no generated symbol reaches a published entry point and a regenerated
 * schema cannot change a consumer's types without this file changing first.
 * ``__tests__/wire_parity.test.ts`` holds every twin identical to its
 * generated counterpart, so the decoupling costs no accuracy.
 *
 * Field spellings are the wire's, because these types are the wire. The
 * SDK's own camelCase surface lives in ``core/`` and maps onto these.
 */

/**
 * Client signals end-of-turn for manual-VAD turn-taking. Distinct from
 * ``ClientEnd`` (whole-session teardown).
 */
import type { DelegationChannel } from './shared';

export type ClientActivityEnd = {
    /**
     * The message type. Always ``activity-end``.
     */
    type: 'activity-end';
};

/**
 * Bind the agent's audio input to this client.
 *
 * Sent after the client publishes its own audio (the human voice) so the
 * agent listens to *this* participant. The server binds to the sender's
 * participant identity — a client can only bind its own input — and the pin is
 * sticky thereafter. A client that joins only to receive events or serve
 * client tools, publishing no audio, never sends this and so is never the
 * voice.
 */
export type ClientBindInput = {
    /**
     * The message type. Always ``bind-input``.
     */
    type: 'bind-input';
};

/**
 * How long the client's own half of the connect took, sent once the
 * session is live.
 *
 * The server measures its own phases and the client measures its own; only
 * the client can see the API call, the media join and the microphone
 * permission, so without this report the connect waterfall stops at the
 * worker's edge. Durations only, in milliseconds: absolute instants would
 * have to be trusted against a clock the server has no way to check.
 *
 * ``server`` echoes back the timings the session-start response carried,
 * because the worker that records the session never saw that response.
 *
 * A session accepts one of these, so an empty or ill-formed report must
 * fail here rather than downstream: the frame is dropped at parse and the
 * slot stays open for a later usable one. The same requirement is published
 * in the schema, so a client cannot build a message the contract calls valid
 * and the worker then drops.
 */
export type ClientConnectTimings = {
    /**
     * Local capture: microphone requested → publishing.
     */
    mic_ms?: number;
    /**
     * The whole client-side wait: session start requested → agent ready.
     */
    ready_ms?: number;
    /**
     * Session-start API call: request sent → response received.
     */
    request_ms?: number;
    /**
     * Media transport: room connect → connected.
     */
    room_ms?: number;
    /**
     * The server-side breakdown from the session-start response, echoed back
     * so both halves of the connect land on one record.
     */
    server?: SessionStartTimings;
    /**
     * The message type. Always ``connect-timings``.
     */
    type: 'connect-timings';
};

/**
 * Add text to the model's context without asking it to reply.
 *
 * The content rides the provider's pre-turn channel, so the model is never
 * asked for a response and cannot open a turn for it; it reads the note as
 * background when it next answers the user. This is the opposite of
 * ``send-text``, which *is* a turn.
 *
 * For live application state (scroll position, selection, current record,
 * form values) that should inform the agent without interrupting it.
 */
export type ClientContext = {
    /**
     * The note to put in front of the model. Read as background, never
     * answered directly.
     */
    content: string;
    /**
     * The message type. Always ``send-context``.
     */
    type: 'send-context';
};

/**
 * Hand text back to the voice model for work it delegated to you, or
 * steer it outside any delegation.
 *
 * Three channels: ``thinking`` is background the model keeps to itself,
 * ``commentary`` is something it says now in its own words, and
 * ``instructions`` changes how it behaves from here on. Each append is
 * one short piece; send several as work progresses rather than one
 * long one at the end.
 */
export type DelegationAppend = {
    /**
     * How the text reaches the model.
     */
    channel: DelegationChannel;
    /**
     * The text. Under ``commentary`` the model paraphrases it rather than
     * reading it verbatim.
     */
    content: string;
    /**
     * The ``delegation-created`` event this answers. ``None`` steers the
     * session as a whole, outside any delegation.
     */
    delegation_id?: string;
    /**
     * The message type. Always ``delegation-append``.
     */
    type: 'delegation-append';
};

/**
 * User ended the session. Server tears down the upstream session and closes.
 */
export type ClientEnd = {
    /**
     * The message type. Always ``end``.
     */
    type: 'end';
};

/**
 * Generic chunked carrier for any oversized client message.
 *
 * The SDK auto-wraps any outbound message whose JSON exceeds the
 * transport's per-packet threshold into a sequence of envelope chunks; the
 * server buffers by ``envelope_id``, concatenates the base64-encoded UTF-8
 * bytes back into the original JSON, and re-runs classification.
 *
 * ``data`` is a base64-encoded fragment of the UTF-8 bytes of the inner
 * message JSON. Base64 keeps every chunk ASCII-safe — splitting at byte
 * boundaries can land mid-codepoint in a raw UTF-8 substring, which would
 * corrupt the decode on the server.
 *
 * Ordering is guaranteed by the reliable channel (chunks arrive in ``seq``
 * order); ``envelope_id`` keeps concurrent envelopes from interleaving.
 * ``seq`` runs ``0..total-1`` and the assembler emits the reassembled
 * inner message as soon as the last chunk arrives.
 */
export type ClientEnvelope = {
    /**
     * This chunk's slice of the inner message, base64-encoded.
     */
    data: string;
    /**
     * Groups the chunks of one message, so concurrent envelopes do not
     * interleave.
     */
    envelope_id: string;
    /**
     * Position of this chunk, ``0`` to ``total - 1``.
     */
    seq: number;
    /**
     * How many chunks the message was split into.
     */
    total: number;
    /**
     * The message type. Always ``envelope-chunk``.
     */
    type: 'envelope-chunk';
};

/**
 * One image frame from the client — screen share, camera capture, or
 * any other visual input the application wants to feed to the model.
 *
 * Carried as base64 in JSON so it rides the same control channel as text
 * and tool calls (the audio channel stays pure PCM). Oversized frames are
 * wrapped in ``ClientEnvelope`` chunks transparently by the SDK.
 *
 * ``stream_id`` lets the application label multiple concurrent video
 * streams (e.g. ``camera``, ``screen_share_main``).
 */
export type ClientImage = {
    /**
     * The frame itself, base64-encoded.
     */
    data: string;
    /**
     * Media type of the encoded frame, e.g. ``image/jpeg``.
     */
    mime_type: string;
    /**
     * Labels this stream so several concurrent video streams stay
     * distinguishable. Always sent; it has no server-side default.
     */
    stream_id: string;
    /**
     * The message type. Always ``send-image``.
     */
    type: 'send-image';
};

/**
 * Toggle the mic gate. While muted the client drops outbound audio frames.
 */
export type ClientMute = {
    /**
     * ``true`` gates outbound audio, ``false`` reopens it.
     */
    muted: boolean;
    /**
     * The message type. Always ``mute``.
     */
    type: 'mute';
};

/**
 * Heartbeat. Server replies with ``PongEvent``.
 */
export type ClientPing = {
    /**
     * The message type. Always ``ping``.
     */
    type: 'ping';
};

/**
 * Send a text message instead of audio.
 */
export type ClientText = {
    /**
     * The message text, treated exactly as a spoken turn would be.
     */
    content: string;
    /**
     * The message type. Always ``send-text``.
     */
    type: 'send-text';
};

/**
 * A long-running client tool finished off-band and is delivering its
 * terminal result. The server resolves the original tool call from
 * ``job_id`` and injects the outcome; ``summary`` / ``error`` are the
 * model-facing text and ``result`` is structured data for logging.
 *
 * Half of the background client-tool primitive — a tool whose work outlives
 * the RPC reply budget acks first and lands its outcome here. Every SDK
 * implements it, so it is protocol vocabulary rather than a first-party
 * extension.
 */
export type ToolJobResult = {
    /**
     * Model-facing text for a failed job — what the assistant is told went
     * wrong.
     */
    error?: string;
    /**
     * Identifies the job this result belongs to — the id the acked tool call
     * was given.
     */
    job_id: string;
    /**
     * Structured outcome. Accepted for forward compatibility but not
     * consumed today — only ``status`` and ``summary``/``error`` reach the
     * model, so put anything the agent must act on in those.
     */
    result?: {
        [key: string]: unknown;
    };
    /**
     * Whether the work succeeded. ``failed`` pairs with ``error``.
     */
    status: 'completed' | 'failed';
    /**
     * Model-facing text for a completed job — what the assistant is told
     * came back.
     */
    summary?: string;
    /**
     * Name of the tool that ran, for logging and attribution.
     */
    tool_name: string;
    /**
     * The message type. Always ``tool_job_result``.
     */
    type: 'tool_job_result';
};

/**
 * Server-side phase breakdown of session start (milliseconds).
 *
 * Mirrors the ``starter_*`` fields of the "realtime session dispatched"
 * log line. Echoed to the client so it can emit one joined
 * startup-waterfall event (server + client phases) keyed by session_id,
 * instead of leaving the join to log archaeology.
 *
 * The server produces these on ``/session/start``; the same shape comes
 * back untrusted on ``connect-timings``, so the bounds hold on both paths.
 */
export type SessionStartTimings = {
    /**
     * Recording the session row.
     */
    db_insert_ms: number;
    /**
     * Dispatching the agent to the room. Reports ``0`` when dispatch runs
     * after the response, where it costs the client nothing.
     */
    dispatch_ms: number;
    /**
     * Minting the room join token.
     */
    mint_tokens_ms: number;
    /**
     * Resolving and authorizing the calling project.
     */
    project_check_ms: number;
    /**
     * Choosing the model provider and confirming it is available here.
     */
    provider_resolve_ms: number;
    /**
     * Version check, project, provider, tools and limits, resolved
     * together and reported as one number. The phases folded into it report
     * ``0`` in their own fields rather than a fabricated split, and
     * ``dispatch_ms`` reports ``0`` too — dispatch runs after the response, so
     * it costs the client nothing.
     */
    resolve_ms?: number;
    /**
     * The whole server-side start, end to end. Not the sum of the phases
     * above — phases folded into ``resolve_ms`` report ``0`` individually.
     */
    total_ms: number;
    /**
     * Checking the client's SDK version against the supported floor.
     */
    version_check_ms: number;
};

/**
 * Connection credentials for a started session.
 *
 * The client joins the LiveKit room at ``livekit_url`` with ``token``;
 * ``session_id`` correlates the session across API calls and session
 * events.
 */
export type SessionResponse = {
    /**
     * LiveKit room URL to connect to.
     */
    livekit_url: string;
    /**
     * LiveKit room name.
     */
    room_name: string;
    /**
     * Server-minted session identifier.
     */
    session_id: string;
    /**
     * Server-side session-start phase breakdown (ms).
     */
    timings?: SessionStartTimings;
    /**
     * Short-lived participant join token.
     */
    token: string;
};

/** Every outbound frame a session sends. A custom transport routes on the
 *  ``type`` discriminator; it never needs to build one. */
export type RealtimeClientMessage =
  | ClientActivityEnd
  | ClientBindInput
  | ClientConnectTimings
  | ClientContext
  | ClientEnd
  | ClientEnvelope
  | ClientImage
  | ClientMute
  | ClientPing
  | ClientText
  | DelegationAppend
  | ToolJobResult;
