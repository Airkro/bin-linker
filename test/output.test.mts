import { describe, expect, it, vi } from 'vitest';

import { fmt, log } from '../src/output.mts';

describe('fmt', () => {
  it('joins command lists', () => {
    expect(fmt.list(['build', 'test'])).toBe('build, test');
  });

  it('returns an empty string for missing lists', () => {
    expect(fmt.list()).toBe('');
  });

  it('formats package, command, and path values', () => {
    expect(fmt.pkg('package')).toContain('package');
    expect(fmt.cmd('command')).toContain('command');
    expect(fmt.path('/tmp/package')).toContain('/tmp/package');
  });

  it('writes log messages at each level', () => {
    const info = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const error = vi
      .spyOn(console, 'error')
      .mockImplementation(() => undefined);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    log.info('info');
    log.error('error');
    log.warn('warn');

    expect(info).toHaveBeenCalled();
    expect(error).toHaveBeenCalled();
    expect(warn).toHaveBeenCalled();
  });
});
