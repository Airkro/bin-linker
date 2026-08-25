import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  linkPackageBins: vi.fn(),
  info: vi.fn(),
  error: vi.fn(),
  warn: vi.fn(),
}));

vi.mock('../src/core.mts', () => ({ linkPackageBins: mocks.linkPackageBins }));
vi.mock('../src/output.mts', () => ({
  fmt: {
    cmd: (value: string) => value,
    list: (values?: string[]) => values?.join(', ') ?? '',
    pkg: (value: string) => value,
  },
  log: { info: mocks.info, error: mocks.error, warn: mocks.warn },
}));

const { run } = await import('../src/cli.mts');

describe('cli', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    process.argv = ['node', 'bin-linker'];
  });

  it('shows usage when no packages are supplied', async () => {
    await expect(run()).resolves.toBe(0);
    expect(mocks.warn).toHaveBeenCalled();
  });

  it('filters options and reports all result types', async () => {
    process.argv = ['node', 'bin-linker', '--help', 'missing', 'empty', 'tool'];
    mocks.linkPackageBins.mockResolvedValue({
      results: [
        { pkg: 'missing', notFound: true },
        { pkg: 'empty', noBin: true },
        { pkg: 'tool', commands: ['tool'] },
      ],
    });

    await expect(run()).resolves.toBe(0);
    expect(mocks.linkPackageBins).toHaveBeenCalledWith([
      'missing',
      'empty',
      'tool',
    ]);
  });

  it('reports command errors and returns failure when nothing links', async () => {
    process.argv = ['node', 'bin-linker', 'broken'];
    mocks.linkPackageBins.mockResolvedValue({
      results: [
        {
          pkg: 'broken',
          errors: [{ name: 'broken', error: new Error('failed') }],
        },
      ],
    });

    await expect(run()).resolves.toBe(1);
    expect(mocks.error).toHaveBeenCalled();
  });

  it('reports totals when multiple packages link successfully', async () => {
    process.argv = ['node', 'bin-linker', 'first', 'second'];
    mocks.linkPackageBins.mockResolvedValue({
      results: [
        { pkg: 'first', commands: ['first'] },
        { pkg: 'second', commands: ['second'] },
      ],
    });

    await expect(run()).resolves.toBe(0);
    expect(mocks.info).toHaveBeenCalledTimes(3);
  });

  it('does not report a total for one successful package', async () => {
    process.argv = ['node', 'bin-linker', 'single'];
    mocks.linkPackageBins.mockResolvedValue({
      results: [{ pkg: 'single', commands: ['single'] }],
    });

    await expect(run()).resolves.toBe(0);
    expect(mocks.info).toHaveBeenCalledTimes(1);
  });

  it('reports permission, missing-path, and unknown failures', async () => {
    process.argv = ['node', 'bin-linker', 'tool'];
    for (const error of [
      { code: 'EPERM', message: 'permission' },
      { code: 'ENOENT', message: 'missing' },
      { code: 'OTHER', message: 'unknown' },
    ]) {
      mocks.linkPackageBins.mockRejectedValueOnce(error);
      await expect(run()).resolves.toBe(1);
    }
    expect(mocks.error).toHaveBeenCalledTimes(3);
  });
});
