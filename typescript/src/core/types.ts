import type { ErrorCode } from '../protocol';

export { RealtimeError } from './errors';

/** An error the server reported on a live session.
 *
 *  ``fatal`` means the session is dead and must be torn down; ``false``
 *  means only this turn failed and the session continues. The wire omits
 *  the field for a non-fatal error, so it reads ``false`` here rather than
 *  going absent — the same shape Python publishes. */
export type ErrorEvent = {
  /** Stable code to switch on for recovery. Match this, not ``message``.
   *
   *  The set is the server's, not this SDK's, so a deployment newer than
   *  your package can send a code this version does not name. That widens
   *  the type rather than failing the event: branch on the codes you know
   *  and let a `default` carry the rest, which is what every code here is
   *  for. */
  code: ErrorCode | (string & {});
  /** Human-readable explanation, for logs and display. */
  message: string;
  /** ``true`` means the session is dead and must be torn down; ``false``
   *  means only this turn failed. */
  fatal: boolean;
};

/** Where a screen share is in its lifecycle. ``active`` carries when the
 *  share began; ``error`` carries why the last attempt failed, including
 *  the person declining the picker. */
export type ScreenShareState =
  | { kind: 'inactive' }
  | { kind: 'requesting' }
  | {
      kind: 'active';
      /** When the share began, as an epoch-milliseconds timestamp. */
      startedAt: number;
    }
  | {
      kind: 'error';
      /** Why the last attempt failed — including the person declining the
       *  picker, which is an error here rather than a cancellation. */
      error: {
        /** ``'screen_denied'`` is the person declining the picker; anything
         *  else that kept the share from starting is
         *  ``'screen_start_failed'``. */
        code: 'screen_denied' | 'screen_start_failed';
        /** Human-readable explanation, for logs and display. */
        message: string;
      };
    };
