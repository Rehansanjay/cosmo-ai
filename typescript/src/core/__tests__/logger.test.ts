/** The SDK's log gate. Default is quiet for info/debug so a library import
 *  never puts diagnostics into the host app's console. */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getLogLevel, log, setLogLevel } from '../logger';

afterEach(() => setLogLevel('warn'));

describe('log level gate', () => {
  it("defaults to warn, so info and debug stay silent", () => {
    expect(getLogLevel()).toBe('warn');
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    const debug = vi.spyOn(console, 'debug').mockImplementation(() => {});
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    log.info('chatty');
    log.debug('chattier');
    log.warn('actionable');

    expect(info).not.toHaveBeenCalled();
    expect(debug).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith('actionable');
    info.mockRestore();
    debug.mockRestore();
    warn.mockRestore();
  });

  it('lets the app opt into everything', () => {
    setLogLevel('debug');
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    log.info('now visible');
    expect(info).toHaveBeenCalledWith('now visible');
    info.mockRestore();
  });

  it('silent suppresses even errors', () => {
    setLogLevel('silent');
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    log.error('boom');
    log.warn('hmm');
    expect(error).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
    error.mockRestore();
    warn.mockRestore();
  });
});

describe('COSMO_LOG_LEVEL', () => {
  const original = process.env.COSMO_LOG_LEVEL;

  beforeEach(() => vi.resetModules());
  afterEach(() => {
    if (original === undefined) delete process.env.COSMO_LOG_LEVEL;
    else process.env.COSMO_LOG_LEVEL = original;
  });

  async function freshLogger() {
    return await import('../logger');
  }

  it('sets the starting level', async () => {
    process.env.COSMO_LOG_LEVEL = 'debug';
    expect((await freshLogger()).getLogLevel()).toBe('debug');
  });

  it('is case- and whitespace-insensitive', async () => {
    process.env.COSMO_LOG_LEVEL = '  SILENT ';
    expect((await freshLogger()).getLogLevel()).toBe('silent');
  });

  it('ignores a value that is not a level, rather than throwing', async () => {
    process.env.COSMO_LOG_LEVEL = 'verbose';
    expect((await freshLogger()).getLogLevel()).toBe('warn');
  });

  it('yields to an explicit setLogLevel call', async () => {
    process.env.COSMO_LOG_LEVEL = 'debug';
    const logger = await freshLogger();
    logger.setLogLevel('silent');
    expect(logger.getLogLevel()).toBe('silent');
  });
});
