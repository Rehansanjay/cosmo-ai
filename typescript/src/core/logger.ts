/** The SDK's log sink, quiet by default.
 *
 * A library writing straight to `console` puts its diagnostics into the host
 * app's output whether the app wanted them or not. Everything here routes
 * through one level gate instead: `warn` and above print, `info` and `debug`
 * stay off until the app asks for them.
 *
 *     import { setLogLevel } from 'cosmo-ai';
 *     setLogLevel('debug');   // or 'silent' for nothing at all
 *
 * Outside the browser the starting level also comes from `COSMO_LOG_LEVEL`,
 * so a developer can turn the SDK verbose without editing their app:
 *
 *     COSMO_LOG_LEVEL=debug node ./agent.js
 */

export type LogLevel = 'silent' | 'error' | 'warn' | 'info' | 'debug';

const RANK: Record<LogLevel, number> = {
  silent: 0,
  error: 1,
  warn: 2,
  info: 3,
  debug: 4,
};

const DEFAULT_LEVEL: LogLevel = 'warn';

/** The environment's requested level, or null when it asked for nothing.
 *
 * An unrecognized value is ignored rather than fatal: a typo in a debugging
 * env var must not stop the app from starting. `process` is absent in a
 * browser bundle, where an env var has no meaning anyway.
 */
function levelFromEnvironment(): LogLevel | null {
  const raw =
    typeof process !== 'undefined'
      ? process.env?.COSMO_LOG_LEVEL?.trim().toLowerCase()
      : undefined;
  return raw && raw in RANK ? (raw as LogLevel) : null;
}

let current: LogLevel = levelFromEnvironment() ?? DEFAULT_LEVEL;

/** Set how much the SDK logs. Applies to every SDK logger immediately.
 *
 * An explicit call outranks `COSMO_LOG_LEVEL` — the app's own decision is
 * the later, more specific one.
 */
export function setLogLevel(level: LogLevel): void {
  current = level;
}

/** The level the SDK is logging at right now. */
export function getLogLevel(): LogLevel {
  return current;
}

function enabled(level: Exclude<LogLevel, 'silent'>): boolean {
  return RANK[level] <= RANK[current];
}

export const log = {
  error(...args: unknown[]): void {
    if (enabled('error')) console.error(...args);
  },
  warn(...args: unknown[]): void {
    if (enabled('warn')) console.warn(...args);
  },
  info(...args: unknown[]): void {
    if (enabled('info')) console.info(...args);
  },
  debug(...args: unknown[]): void {
    if (enabled('debug')) console.debug(...args);
  },
};
