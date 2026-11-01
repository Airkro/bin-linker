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

  it('mentions dependency links right after the commands it fixed', async () => {
    // 补依赖是对刚链接的命令做的补充动作，说明要紧跟在结果后面，
    // 别等到后面的报错信息都念完了才提。
    process.argv = ['node', 'bin-linker', 'tool', 'ghost'];
    mocks.linkPackageBins.mockResolvedValue({
      results: [
        { pkg: 'tool', commands: ['tool'], depsLinked: true },
        { pkg: 'ghost', notFound: true },
      ],
    });

    await expect(run()).resolves.toBe(0);

    const notified = mocks.info.mock.calls.find(([message]) =>
      String(message).includes('补全依赖'),
    );
    const reported = mocks.warn.mock.calls.find(([message]) =>
      String(message).includes('找不到包'),
    );

    expect(notified?.[0]).toContain('tool');
    // 补依赖的说明先于后面那个包的结论
    expect(mocks.info.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.warn.mock.invocationCallOrder[0] ?? Infinity,
    );
    expect(reported).toBeDefined();
  });

  it('does not mention dependency links when nothing was linked', async () => {
    process.argv = ['node', 'bin-linker', 'tool'];
    mocks.linkPackageBins.mockResolvedValue({
      results: [{ pkg: 'tool', commands: [], noBin: true, depsLinked: true }],
    });

    await expect(run()).resolves.toBe(1);
    expect(mocks.info).not.toHaveBeenCalledWith(
      expect.stringContaining('补全'),
    );
  });

  it('fails when the pnpm global bin directory is missing from PATH', async () => {
    process.argv = ['node', 'bin-linker', 'tool'];
    mocks.linkPackageBins.mockResolvedValue({
      results: [
        { pkg: 'tool', commands: [], globalBinDir: true },
        { pkg: 'other', commands: ['other'] },
      ],
    });

    await expect(run()).resolves.toBe(1);
    expect(mocks.warn).toHaveBeenCalledWith(
      expect.stringContaining('无法定位'),
    );
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
