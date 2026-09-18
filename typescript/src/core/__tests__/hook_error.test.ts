import { describe, expect, it } from 'vitest';

import { buildAgentSessionConfig } from '../agent';
import { RealtimeError } from '../errors';
import { HookError, preToolUse } from '../hooks';

/** The public surface `HookError` exists for: one catch over hook
 *  registration, a code to branch on, and membership of the error family.
 *  Every case below threw a bare `Error` before, which is why asserting the
 *  message alone would not have caught a regression. */
describe('HookError', () => {
  function thrownBy(fn: () => unknown): unknown {
    try {
      fn();
    } catch (err) {
      return err;
    }
    return undefined;
  }

  it('reports a malformed matcher with its code', () => {
    const err = thrownBy(() => preToolUse(() => undefined, { matcher: '[delete_*' }));
    expect(err).toBeInstanceOf(HookError);
    expect(err).toBeInstanceOf(RealtimeError);
    expect((err as HookError).code).toBe('malformed_matcher');
  });

  it('refuses a server hook on a catalog agent as a hook problem', () => {
    // The runtime guard, not the type-level one: a JS consumer or a parsed
    // config reaches it with a plain object the types never saw.
    const serverHook = {
      type: 'silence_timeout',
      timeout_seconds: 9,
      action: { type: 'end_call' },
    };
    const err = thrownBy(() =>
      buildAgentSessionConfig({ name: 'driver-pay' } as never, {
        serverHooks: [serverHook] as never,
      }),
    );
    expect(err).toBeInstanceOf(HookError);
    expect(err).toBeInstanceOf(RealtimeError);
    expect((err as HookError).code).toBe('server_hook_not_allowed');
  });

  it('carries the prose in message, without the code prefixed', () => {
    const err = thrownBy(() =>
      preToolUse(() => undefined, { matcher: '[delete_*' }),
    ) as HookError;
    expect(err.message).toMatch(/^malformed hook matcher/);
    expect(err.message).not.toContain('malformed_matcher:');
  });
});
