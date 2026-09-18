/**
 * Protocol values used by both directions of the wire.
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
 * Speaker for a transcript fragment.
 */
export type TranscriptRole = 'USER' | 'ASSISTANT';

/**
 * How an appended text reaches the voice model.
 */
export type DelegationChannel = 'thinking' | 'commentary' | 'instructions';

/**
 * Resolved-agent summary echoed on ``ready`` when the session referenced a
 * registry agent (``agent.name``). Informational only — never authoritative;
 * clients don't act on it.
 */
export type ResolvedAgent = {
    /**
     * The registry agent the session resolved against.
     */
    name: string;
    /**
     * Final effective tool names (registry tools ∪ client-declared tools,
     * by name).
     */
    tools?: Array<string>;
};

/**
 * Stable error codes carried on wire-protocol error events; clients
 * switch on them to choose recovery behavior. Distinct from the REST
 * rejection codes carried on error envelopes (``error.code``).
 */
export type ErrorCode = 'auth_failed' | 'workspace_forbidden' | 'voice_disabled' | 'upstream_disconnect' | 'internal_error' | 'invalid_message' | 'version_mismatch';

/**
 * One tool spec the server refused, with the reason — so a client can
 * log *why* a spec was dropped instead of debugging silence.
 */
export type RejectedTool = {
    /**
     * What the dropped tool was called — a client tool's declared name, or a
     * server tool's wire kind.
     */
    name: string;
    /**
     * Why it was unavailable, e.g. a capability this workspace has not
     * enabled. Free text for logs and display, not a stable code to match
     * on.
     */
    reason: string;
};

/**
 * Idle-message action for a server hook: `text` = exact words,
 * `prompt` = model-generated per instruction, both unset = free model speech.
 */
export type Say = {
    /**
     * Instruction the model composes its line from, for wording that follows
     * what has been said so far. Mutually exclusive with ``text``.
     */
    prompt?: string;
    /**
     * Exact words for the assistant to speak. Mutually exclusive with
     * ``prompt``.
     */
    text?: string;
    /**
     * The action type. Always ``say``.
     */
    type: 'say';
};

/**
 * End-call action for a server hook.
 */
export type EndCall = {
    /**
     * Parting line to speak before hanging up. ``None`` ends the call
     * without one.
     */
    farewell?: string;
    /**
     * The action type. Always ``end_call``.
     */
    type: 'end_call';
};

/**
 * Server-runtime hook: perform `action` after `timeout_seconds` of user
 * silence.
 */
export type SilenceTimeout = {
    /**
     * What to do when the timeout fires — speak a line, or end the call.
     */
    action: ({
        type?: 'say';
    } & Say) | ({
        type?: 'end_call';
    } & EndCall);
    /**
     * How many times this hook may fire, 1–10, so a silent caller is not
     * prompted forever. Counted per run of silence when ``reset_mode`` is
     * ``on_user_speech``, and across the session when it is ``never``.
     */
    max_count?: number;
    /**
     * Label for this hook, for your own reference and the server's logs. It
     * is not carried on the event the hook fires, so a session running several
     * silence hooks cannot tell from the event which one fired.
     */
    name?: string;
    /**
     * How much to widen ``timeout_seconds`` once the caller has spoken at
     * least once, 1–10, so a present but quiet caller waits longer than a line
     * that was silent from the start. ``1`` waits the same either way. Unset
     * uses the server's default.
     */
    present_multiplier?: number;
    /**
     * Whether the fire count resets. ``never`` counts across the whole
     * session; ``on_user_speech`` starts over each time the user speaks.
     */
    reset_mode?: 'never' | 'on_user_speech';
    /**
     * Seconds of user silence before the action runs, 1–1000. Scaled by
     * ``present_multiplier`` once the caller has spoken at least once.
     */
    timeout_seconds: number;
    /**
     * What fires the hook. Always ``user.speech.timeout``.
     */
    trigger?: 'user.speech.timeout';
};
