import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  error: vi.fn(),
  info: vi.fn(),
  linkPackageBins: vi.fn(),
  warn: vi.fn(),
}));

vi.mock('../src/core.mts', () => ({
  linkPackageBins: mocks.linkPackageBins,
}));
vi.mock('../src/output.mts', () => ({
  fmt: {
    cmd: (value: string) => value,
    list: (values?: string[]) => values?.join(', ') ?? '',
    pkg: (value: string) => value,
  },
  log: { error: mocks.error, info: mocks.info, warn: mocks.warn },
}));

const { run } = await import('../src/cli.mts');

/** 用给定结果跑一次 CLI */
async function runWith(results: unknown[]): Promise<number> {
  mocks.linkPackageBins.mockResolvedValue({ results });

  return run();
}

describe('cli', () => {
  beforeEach(() => {
    mocks.error.mockReset();
    mocks.info.mockReset();
    mocks.linkPackageBins.mockReset();
    mocks.warn.mockReset();
    process.argv = ['node', 'bin-linker'];
  });

  it('dedupes repeated packages and strips the working directory', async () => {
    // 同一个包写两遍只该链一次；脚本里常传 $(pwd)/node_modules/xxx 这种绝对路径，
    // node_modules 的位置按包名拼，绝对路径会解析不到，得先在工程内还原成相对路径。
    process.argv = [
      'node',
      'bin-linker',
      'tool',
      'tool',
      `${process.cwd()}/node_modules/tool`,
      '/elsewhere/other-pkg',
    ];
    mocks.linkPackageBins.mockResolvedValue({ results: [] });

    await run();

    expect(mocks.linkPackageBins).toHaveBeenCalledWith([
      'tool',
      'node_modules/tool',
      '/elsewhere/other-pkg',
    ]);
  });

  it('shows usage when no packages are supplied', async () => {
    await expect(run()).resolves.toBe(0);
    expect(mocks.warn).toHaveBeenCalled();
    expect(mocks.linkPackageBins).not.toHaveBeenCalled();
  });

  it('filters options out of the package list', async () => {
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

    await expect(
      runWith([
        { pkg: 'broken', errors: [{ name: 'broken', error: new Error('x') }] },
      ]),
    ).resolves.toBe(1);
    expect(mocks.error).toHaveBeenCalled();
  });

  it('reports totals when multiple packages link successfully', async () => {
    process.argv = ['node', 'bin-linker', 'first', 'second'];

    await expect(
      runWith([
        { pkg: 'first', commands: ['first'] },
        { pkg: 'second', commands: ['second'] },
      ]),
    ).resolves.toBe(0);
    expect(mocks.info).toHaveBeenCalledTimes(3);
  });

  it('does not report a total for one successful package', async () => {
    process.argv = ['node', 'bin-linker', 'single'];

    await expect(
      runWith([{ pkg: 'single', commands: ['single'] }]),
    ).resolves.toBe(0);
    expect(mocks.info).toHaveBeenCalledTimes(1);
  });

  it('mentions dependency links right after the commands it fixed', async () => {
    // 补依赖是对刚链接的命令做的补充动作，说明要紧跟在结果后面，
    // 别等到后面那些包的结论都念完了才提。
    process.argv = ['node', 'bin-linker', 'tool', 'ghost'];

    await expect(
      runWith([
        { pkg: 'tool', commands: ['tool'], depsLinked: true },
        { pkg: 'ghost', notFound: true },
      ]),
    ).resolves.toBe(0);

    const notified = mocks.info.mock.calls.find(([message]) =>
      String(message).includes('补全依赖'),
    );

    expect(notified?.[0]).toContain('tool');
    // 补依赖的说明排在「找不到那个包」之前
    const reported = mocks.warn.mock.calls.findIndex(([message]) =>
      String(message).includes('找不到包'),
    );

    expect(reported).toBe(0);
    expect(notified?.[0]).toContain('补全依赖');
  });

  it('does not mention dependency links when nothing was linked', async () => {
    process.argv = ['node', 'bin-linker', 'tool'];

    await expect(
      runWith([{ pkg: 'tool', noBin: true, depsLinked: true }]),
    ).resolves.toBe(1);
    expect(mocks.info).not.toHaveBeenCalledWith(
      expect.stringContaining('补全'),
    );
  });

  it('fails when the pnpm global bin directory is missing from PATH', async () => {
    process.argv = ['node', 'bin-linker', 'tool'];

    await expect(
      runWith([
        { pkg: 'tool', globalBinDir: true },
        { pkg: 'other', commands: ['other'] },
      ]),
    ).resolves.toBe(1);
    expect(mocks.warn).toHaveBeenCalledWith(
      expect.stringContaining('无法定位'),
    );
  });

  it('explains permission, missing-path and unknown failures', async () => {
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
