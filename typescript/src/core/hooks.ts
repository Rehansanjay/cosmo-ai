/**
 * Hooks for the realtime SDK: in-process lifecycle callbacks fired by the
 * session at four seams (``SessionStart``, ``PreToolUse``, ``PostToolUse``,
 * ``SessionEnd``), plus declarative server hooks the SERVER executes.
 *
 * Two kinds of hooks, one idea (when X happens, do Y), one ``hooks: [...]``
 * list on the agent:
 *
 * - **client hooks** — your callbacks, run in-process. Declare with the seam
 *   factories: ``sessionStart(fn)``, ``preToolUse(fn, {matcher})``,
 *   ``postToolUse(fn)``, ``sessionEnd(fn)``. List order is fold order.
 * - **server hooks** — wire config the server executes, working even if this
 *   process dies mid-call: a ``SilenceTimeout`` with a ``say`` or
 *   ``end_call`` action.
 *
 * Every seam hangs off something this process does, which is what makes it a
 * seam rather than a notification: ``SessionStart`` rewrites the config before
 * it is sent, ``PreToolUse`` gates a local handler, ``PostToolUse`` reads that
 * handler's outcome, and ``SessionEnd`` fires even when the socket dropped and
 * no frame ever arrived. Anything the SERVER did reaches you as an event —
 * ``on('user_speech_timeout')`` for a fired silence hook — never as a hook.
 *
 * Observer-grade by default; the two client-controlled seams honor
 * overrides — ``SessionStart`` may inject ``additionalContext`` into the
 * instructions and ``PreToolUse`` may deny or rewrite a local client-tool
 * call. A throwing hook is isolated and never breaks the session. Python
 * (``cosmo_ai.hooks``) is the reference for shape and semantics; the
 * matcher grammar and fold rules are pinned by the shared conformance
 * vectors shared across the SDKs.
 */

import { RealtimeError } from './errors';
import { log } from './logger';
import type { EndCall, Say, SilenceTimeout } from '../protocol';

import type { DisconnectReason } from './state';

/** Why a hook could not be registered.
 *
 *  Closed: every one is thrown when hooks are declared, so it changes only
 *  when the SDK does. Every member is declared in every SDK even where that
 *  SDK cannot reach the case, so a branch written against one ports
 *  unchanged. */
export type HookErrorCode =
  /** The matcher pattern does not parse — an unterminated `[` group. The
   *  underlying matcher never errors on one, it just silently matches
   *  nothing, which for a deny matcher is a guard that never fires. */
  | 'malformed_matcher'
  /** A `hooks` element is neither a hook built by a seam factory nor a server
   *  hook. */
  | 'invalid_hook'
  /** A server hook was passed to a catalog agent, which runs its stored
   *  configuration verbatim. */
  | 'server_hook_not_allowed';

/** A hook could not be registered.
 *
 *  `malformed_matcher` and `invalid_hook` are thrown where the hook is
 *  declared — a matcher that would never fire is refused up front rather than
 *  silently matching nothing. `server_hook_not_allowed` is thrown when the
 *  agent's session config is assembled, which in this SDK is during
 *  `agent.start()`. `code` names which — switch on it rather than matching
 *  the message. */
export class HookError extends RealtimeError {
  /** Why the hook was refused. A closed set this SDK throws — switch on it. */
  readonly code: HookErrorCode;

  constructor(options: { code: HookErrorCode; message: string }) {
    super(options.message !== '' ? options.message : options.code);
    this.name = 'HookError';
    this.code = options.code;
  }
}



/** The two actions a server hook can take, and the hook config itself.
 *  Declared in ``../protocol`` — these cross the wire as-is, so the SDK
 *  re-exports the protocol's own shapes rather than a second spelling of
 *  them. */
export type { Say, EndCall, SilenceTimeout } from '../protocol';

/** What a server hook does when it fires — speak a line, or end the call,
 *  as reported on the frame the firing produced. */
export type ServerHookAction =
  | ({ type?: 'say' } & Say)
  | ({ type?: 'end_call' } & EndCall);

/** A server-executed hook — wire config, not a callback. The family's
 *  extension point: becomes a union when a second server-hook kind lands. */
export type ServerHook = SilenceTimeout;

// A hook runs in-process on the session's hot path (SessionStart blocks
// session establishment; PreToolUse/PostToolUse are awaited inline in the
// tool-call RPC reply during a live voice turn). Nothing bounds a hook's
// runtime, so a slow hook (e.g. a network call) stalls that path; this only
// warns, it never cancels or times out a hook.
const SLOW_HOOK_WARN_THRESHOLD_MS = 200;

// ── Tool outcome (what PostToolUse observes) ───────────────────────────

/** How one client-tool call finished: its handler returned, it threw, or a
 *  ``PreToolUse`` hook denied it before the handler ran. */
export type ToolOutcome =
  | {
      /** The handler returned. */
      kind: 'ok';
      /** What the handler returned, or ``null`` if it returned nothing. */
      result: Record<string, unknown> | null;
    }
  | {
      /** The handler threw. */
      kind: 'error';
      /** The exception text from the handler that threw. */
      message: string;
    }
  | {
      /** A ``PreToolUse`` hook refused the call before the handler ran. */
      kind: 'denied';
      /** Why a ``PreToolUse`` hook refused the call. The handler never ran. */
      reason: string;
    };

// ── Per-event contexts ─────────────────────────────────────────────────

/** Passed to a ``SessionStart`` hook, which runs before the config is sent.
 *  There is no session id yet — the handshake has not completed; read the
 *  ``ready`` event for the started id. */
export type SessionStartContext = {
  /** Names the seam, so one callback can serve several events. */
  event: 'SessionStart';
};

/** Passed to a ``PreToolUse`` hook, before the local handler runs. Return a
 *  ``PreToolUseResult`` to deny the call or rewrite its arguments. */
export type PreToolUseContext = {
  /** Names the seam, so one callback can serve several events. */
  event: 'PreToolUse';
  /** The tool about to run — what a ``matcher`` is tested against. */
  toolName: string;
  /** Read-only view; rewrite via ``PreToolUseResult.updatedArguments``. */
  arguments: Readonly<Record<string, unknown>>;
  /** The session the call belongs to. */
  sessionId: string;
};

/** Passed to a ``PostToolUse`` hook once the local handler settled.
 *  ``arguments`` are the ones the handler actually ran with, after any
 *  ``PreToolUse`` rewrite. Observer-only: it cannot change the result. It
 *  is awaited before the reply goes back to the model, so a slow hook
 *  delays the tool call — keep it quick, or hand the work off. */
export type PostToolUseContext = {
  /** Names the seam, so one callback can serve several events. */
  event: 'PostToolUse';
  /** The tool that ran. */
  toolName: string;
  /** The arguments it ran with, after any ``PreToolUse`` rewrite. */
  arguments: Record<string, unknown>;
  /** How it finished — switch on ``kind``; a denial is not an error. */
  outcome: ToolOutcome;
  /** The session the call belonged to. */
  sessionId: string;
};

/** Passed to a ``SessionEnd`` hook at teardown, on every exit path,
 *  including a start that never reached ``ready``. ``sessionId`` is
 *  ``null`` only when the failure predates the server's session-start
 *  response; a socket that drops after that still carries the id. */
export type SessionEndContext = {
  /** Names the seam, so one callback can serve several events. */
  event: 'SessionEnd';
  /** Why the session ended — who ended it, and whether cleanly. */
  reason: DisconnectReason;
  /** Extra context on the ending when the server or transport supplied any. */
  detail: string | null;
  /** The session that ended, or ``null`` if it never became live. */
  sessionId: string | null;
};

// ── Per-event results ──────────────────────────────────────────────────

/** What a ``SessionStart`` hook may return. ``additionalContext`` is
 *  appended to the agent's instructions for this run; every hook's
 *  contribution is joined in list order. Return nothing to change
 *  nothing. */
export type SessionStartResult = {
  /** Text to add to the agent's instructions before the session opens.
   *  Applies to an inline agent only — a catalog agent runs its stored
   *  config verbatim, so context returned here is dropped. */
  additionalContext?: string | null;
};

/** What a ``PreToolUse`` hook may return. ``permission: 'deny'`` stops the
 *  call and reports ``reason`` to the model; ``updatedArguments`` replaces
 *  the arguments the handler runs with and is passed on to later hooks.
 *  Return nothing to let the call through unchanged. */
export type PreToolUseResult = {
  /** ``'deny'`` blocks the call; ``'allow'`` states no objection. Unset
   *  abstains and leaves the decision to the other hooks. Any deny wins. */
  permission?: 'allow' | 'deny';
  /** Why it was denied — surfaced to the model so it can say something
   *  useful instead of retrying blindly. */
  reason?: string;
  /** Replacement arguments for the call. Unset leaves them untouched; the
   *  last hook to rewrite wins. */
  updatedArguments?: Record<string, unknown>;
};

/** Folded result of all PreToolUse hooks for one tool call. */
export type PreToolUseOutcome = {
  /** Whether any hook denied the call. */
  denied: boolean;
  /** The denying hook's reason, or ``null`` when nothing denied. */
  reason: string | null;
  /** The arguments after every rewrite, in hook order. */
  arguments: Record<string, unknown>;
};

/** The callback ``sessionStart(fn)`` takes. Sync or async; a throw is
 *  logged and skipped rather than failing the session. */
export type SessionStartHook = (
  ctx: SessionStartContext,
) =>
  | SessionStartResult
  | null
  | undefined
  | void
  | Promise<SessionStartResult | null | undefined | void>;

/** The callback ``preToolUse(fn)`` takes. Sync or async; a throw is logged
 *  and skipped, which lets the call through. */
export type PreToolUseHook = (
  ctx: PreToolUseContext,
) => PreToolUseResult | null | undefined | void | Promise<PreToolUseResult | null | undefined | void>;

/** The callback ``postToolUse(fn)`` takes. Returns nothing — the tool
 *  result has already gone back to the model. */
export type PostToolUseHook = (ctx: PostToolUseContext) => void | Promise<void>;

/** The callback ``sessionEnd(fn)`` takes. Fires exactly once per session. */
export type SessionEndHook = (ctx: SessionEndContext) => void | Promise<void>;

// ── Matcher grammar ────────────────────────────────────────────────────

/** Normative matcher grammar, shared with the Python and Swift SDKs via
 *  ``hook-matcher-vectors.json``: glob-style
 *  ``*`` ``?`` ``[seq]`` ``[!seq]``, case-sensitive, matched against the
 *  full tool name, no path semantics. A malformed pattern is rejected at
 *  registration (``validateMatcher``) rather than reaching this function,
 *  so every pattern seen here is well-formed. */
export function toolNameMatches(toolName: string, pattern: string): boolean {
  return translateMatcher(pattern).test(toolName);
}

/** Reject an unterminated ``[...]`` group at hook-registration time.
 *
 *  The glob grammar treats a stray ``[`` as a literal character, so e.g.
 *  ``matcher="[delete_*"`` would silently never match any real tool name
 *  instead of erroring. For a ``PreToolUse`` deny matcher that is a silent
 *  fail-open (the guard never fires), so this fails loud instead. */
export function validateMatcher(pattern: string): void {
  let i = 0;
  const n = pattern.length;
  while (i < n) {
    if (pattern[i] === '[') {
      let j = i + 1;
      if (j < n && pattern[j] === '!') j += 1;
      if (j < n && pattern[j] === ']') j += 1;
      while (j < n && pattern[j] !== ']') j += 1;
      if (j >= n) {
        throw new HookError({
          code: 'malformed_matcher',
          message: `malformed hook matcher ${JSON.stringify(pattern)}: unterminated '[' at index ${String(i)}`,
        });
      }
      i = j + 1;
    } else {
      i += 1;
    }
  }
}

const REGEXP_SPECIALS = /[.*+?^${}()|[\]\\]/g;

function translateMatcher(pattern: string): RegExp {
  let out = '';
  let i = 0;
  const n = pattern.length;
  while (i < n) {
    const c = pattern[i];
    i += 1;
    if (c === '*') {
      out += '.*';
    } else if (c === '?') {
      out += '.';
    } else if (c === '[') {
      let j = i;
      if (j < n && pattern[j] === '!') j += 1;
      if (j < n && pattern[j] === ']') j += 1;
      while (j < n && pattern[j] !== ']') j += 1;
      if (j >= n) {
        out += '\\[';
      } else {
        let stuff = pattern.slice(i, j).replace(/\\/g, '\\\\').replace(/\]/g, '\\]');
        if (stuff.startsWith('!')) stuff = `^${stuff.slice(1)}`;
        else if (stuff.startsWith('^')) stuff = `\\${stuff}`;
        out += `[${stuff}]`;
        i = j + 1;
      }
    } else {
      out += c.replace(REGEXP_SPECIALS, '\\$&');
    }
  }
  // ``s`` so ``*`` / ``?`` match newlines, mirroring Python's ``(?s:...)``.
  return new RegExp(`^(?:${out})$`, 's');
}

// ── Declared hooks + the seam factories ────────────────────────────────

/** The four seams a client hook can fire at. */
export type HookEventName =
  | 'SessionStart'
  | 'PreToolUse'
  | 'PostToolUse'
  | 'SessionEnd';

/** Any of the four seam callbacks, as carried on a built ``Hook``. */
type AnyHookCallback =
  | SessionStartHook
  | PreToolUseHook
  | PostToolUseHook
  | SessionEndHook;

/** One declared client hook: the seam it fires at, the callback, and (for
 *  the tool seams) an optional matcher. Built by the seam factories; list
 *  order in ``hooks: [...]`` is fold order. */
export class Hook {
  /** Which seam this hook fires at. */
  readonly event: HookEventName;
  /** @internal */
  readonly callback: AnyHookCallback;
  /** Which tools it applies to, for the tool seams — a glob tested against
   *  the tool name. ``null`` matches every tool, and the field is meaningless
   *  on the session seams. */
  readonly matcher: string | null;

  /** @internal — construct via the seam factories. */
  constructor(event: HookEventName, callback: AnyHookCallback, matcher: string | null) {
    this.event = event;
    this.callback = callback;
    this.matcher = matcher;
    Object.freeze(this);
  }
}

/** Declare a ``SessionStart`` hook — may return a ``SessionStartResult``
 *  to inject ``additionalContext`` into the instructions. */
export function sessionStart(fn: SessionStartHook): Hook {
  return new Hook('SessionStart', fn, null);
}

/** Declare a ``PreToolUse`` hook — may deny or rewrite a local client-tool
 *  call. ``matcher`` restricts it to matching tool names (glob grammar); a
 *  malformed matcher throws here, not at session start. */
export function preToolUse(fn: PreToolUseHook, options?: { matcher?: string }): Hook {
  if (options?.matcher !== undefined) validateMatcher(options.matcher);
  return new Hook('PreToolUse', fn, options?.matcher ?? null);
}

/** Declare a ``PostToolUse`` observer, fired with the final ``ToolOutcome``
 *  of each local client-tool call. */
export function postToolUse(fn: PostToolUseHook, options?: { matcher?: string }): Hook {
  if (options?.matcher !== undefined) validateMatcher(options.matcher);
  return new Hook('PostToolUse', fn, options?.matcher ?? null);
}

/** Declare a ``SessionEnd`` observer, fired exactly once at teardown. */
export function sessionEnd(fn: SessionEndHook): Hook {
  return new Hook('SessionEnd', fn, null);
}

/** Split one unified ``hooks: [...]`` list into the client hooks (folded
 *  in-process, in list order) and the server hooks (wire config). Rejects
 *  anything that is neither. @internal */
export function resolveHooks(
  hooks: readonly (Hook | ServerHook)[] | undefined,
): { clientHooks: Hook[]; serverHooks: ServerHook[] } {
  const clientHooks: Hook[] = [];
  const serverHooks: ServerHook[] = [];
  for (const hook of hooks ?? []) {
    if (hook instanceof Hook) {
      clientHooks.push(hook);
    } else if (
      hook !== null &&
      typeof hook === 'object' &&
      // ``trigger`` is optional on the wire type; the required
      // ``timeout_seconds`` is the reliable discriminator.
      typeof (hook as ServerHook).timeout_seconds === 'number'
    ) {
      serverHooks.push(hook);
    } else {
      throw new HookError({
        code: 'invalid_hook',
        message:
          'hooks elements must be seam-factory Hooks or server hooks (SilenceTimeout)',
      });
    }
  }
  return { clientHooks, serverHooks };
}

// ── HookEngine ─────────────────────────────────────────────────────────

/** Dispatch engine over one agent's declared client hooks. Immutable —
 *  built from the resolved ``Hook`` list at session start; fold semantics
 *  are pinned by the shared hook-engine vectors. @internal */
export class HookEngine {
  private readonly sessionStartHooks: SessionStartHook[] = [];
  private readonly preToolUseHooks: { matcher: string | null; hook: PreToolUseHook }[] =
    [];
  private readonly postToolUseHooks: { matcher: string | null; hook: PostToolUseHook }[] =
    [];
  private readonly sessionEndHooks: SessionEndHook[] = [];

  constructor(hooks: readonly Hook[]) {
    for (const hook of hooks) {
      switch (hook.event) {
        case 'SessionStart':
          this.sessionStartHooks.push(hook.callback as SessionStartHook);
          break;
        case 'PreToolUse':
          this.preToolUseHooks.push({
            matcher: hook.matcher,
            hook: hook.callback as PreToolUseHook,
          });
          break;
        case 'PostToolUse':
          this.postToolUseHooks.push({
            matcher: hook.matcher,
            hook: hook.callback as PostToolUseHook,
          });
          break;
        case 'SessionEnd':
          this.sessionEndHooks.push(hook.callback as SessionEndHook);
          break;
      }
    }
  }

  /** Fold every SessionStart hook's ``additionalContext`` in list order;
   *  ``null`` when no hook contributed context. */
  async runSessionStart(ctx: SessionStartContext): Promise<string | null> {
    const chunks: string[] = [];
    for (const hook of this.sessionStartHooks) {
      const out = await callHook(hook, ctx);
      if (out === null || out === undefined) continue;
      if (out.additionalContext) chunks.push(out.additionalContext);
    }
    return chunks.length > 0 ? chunks.join('\n\n') : null;
  }

  async runPreToolUse(options: {
    toolName: string;
    arguments: Record<string, unknown>;
    sessionId: string;
  }): Promise<PreToolUseOutcome> {
    let current: Record<string, unknown> = { ...options.arguments };
    for (const { matcher, hook } of this.preToolUseHooks) {
      if (matcher !== null && !toolNameMatches(options.toolName, matcher)) continue;
      const out = await callHook(hook, {
        event: 'PreToolUse',
        toolName: options.toolName,
        arguments: Object.freeze({ ...current }),
        sessionId: options.sessionId,
      });
      if (out === null || out === undefined) continue;
      if (out.permission === 'deny') {
        log.info('[realtime] hook denied tool', {
          tool: options.toolName,
          reason: out.reason,
        });
        return {
          denied: true,
          // ``||`` not ``??``: an empty-string reason folds to the default,
          // matching Python's ``reason or "denied by hook"``.
          reason: out.reason || 'denied by hook',
          arguments: current,
        };
      }
      if (out.updatedArguments !== undefined) {
        current = { ...out.updatedArguments };
      }
    }
    return { denied: false, reason: null, arguments: current };
  }

  async runPostToolUse(ctx: PostToolUseContext): Promise<void> {
    for (const { matcher, hook } of this.postToolUseHooks) {
      if (matcher !== null && !toolNameMatches(ctx.toolName, matcher)) continue;
      await callHook(hook, ctx);
    }
  }

  async runSessionEnd(ctx: SessionEndContext): Promise<void> {
    for (const hook of this.sessionEndHooks) {
      await callHook(hook, ctx);
    }
  }
}

async function callHook<Ctx extends { event: string }, R>(
  hook: (ctx: Ctx) => R | Promise<R>,
  ctx: Ctx,
): Promise<R | null> {
  const start = performance.now();
  try {
    return await hook(ctx);
  } catch (err) {
    log.error('[realtime] hook failed', { hookEvent: ctx.event }, err);
    return null;
  } finally {
    const elapsedMs = performance.now() - start;
    if (elapsedMs > SLOW_HOOK_WARN_THRESHOLD_MS) {
      log.warn('[realtime] slow hook', { hookEvent: ctx.event, elapsedMs });
    }
  }
}
