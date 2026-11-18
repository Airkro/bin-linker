import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  error: vi.fn(),
  info: vi.fn(),
  linkPackageBins: vi.fn(),
  warn: vi.fn(),
}));

vi.mock('../src/link.mts', () => ({
  linkPackageBins: mocks.linkPackageBins,
}));
vi.mock('../src/name.mts', () => ({
  // 名字归一的细节在 name.test 里验，这里只要它把路径尾巴去掉
  toPkgName: (name: string) => name.replace(/^.*[/\\]/, ''),
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

/**
用给定结果跑一次 CLI
*/
async function runWith(results: unknown[]): Promise<number> {
  mocks.linkPackageBins.mockResolvedValue(results);

  return run();
}

/**
播报里提到过某个词的那一次调用
*/
const said = (calls: unknown[][], word: string) =>
  calls.find(([message]) => String(message).includes(word))?.[0];

describe('cli', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    process.argv = ['node', 'bin-linker'];
  });

  it('normalizes arguments into package names before deduping', async () => {
    // 同一个包写三遍只该链一次；脚本里常传 $(pwd)/node_modules/xxx 这种绝对路径，
    // node_modules 的位置按包名拼，带路径就拼不出来，得先归一。
    process.argv = [
      'node',
      'bin-linker',
      'tool',
      'tool',
      `${process.cwd()}/node_modules/tool`,
      `${process.cwd()}/node_modules/@scope/tool`,
      '/elsewhere/node_modules/tool',
    ];

    await runWith([]);

    // 工程内的绝对路径先相对化再取包名：`.../@scope/tool` 归一成 `@scope/tool`；
    // 工程外的路径原样留着，包名只取最后几段——这里两处都落回同一个 `tool`
    expect(mocks.linkPackageBins).toHaveBeenCalledWith(['tool']);
  });

  it('shows usage and fails when no packages are supplied', async () => {
    // 没干活就是失败，跟「没链上任何东西」一个口径
    await expect(run()).resolves.toBe(1);
    expect(mocks.warn).toHaveBeenCalled();
    expect(mocks.linkPackageBins).not.toHaveBeenCalled();
  });

  it('filters options out of the package list', async () => {
    process.argv = ['node', 'bin-linker', '--help', 'missing', 'empty', 'tool'];

    await expect(
      runWith([
        { pkg: 'missing', notFound: true },
        { pkg: 'empty', commands: [], libraryOnly: true },
        { pkg: 'tool', commands: ['tool'] },
      ]),
    ).resolves.toBe(1);
    expect(mocks.linkPackageBins).toHaveBeenCalledWith([
      'missing',
      'empty',
      'tool',
    ]);
  });

  it('reports totals when multiple packages link successfully', async () => {
    process.argv = ['node', 'bin-linker', 'first', 'second'];

    await expect(
      runWith([
        { pkg: 'first', commands: ['first'] },
        { pkg: 'second', commands: ['second'] },
      ]),
    ).resolves.toBe(0);
    // 两个包各一条 + 一条总计
    expect(mocks.info).toHaveBeenCalledTimes(3);
    expect(said(mocks.info.mock.calls, '共链接了')).toContain('2');
  });

  it('does not report a total for one successful package', async () => {
    process.argv = ['node', 'bin-linker', 'single'];

    await expect(
      runWith([{ pkg: 'single', commands: ['single'] }]),
    ).resolves.toBe(0);
    expect(mocks.info).toHaveBeenCalledTimes(1);
  });

  it('does not fail when other packages linked fine', async () => {
    // 总览说的是「一共链上几条命令」，各包的结论各自说过了，不必再报一遍
    process.argv = ['node', 'bin-linker', 'two', 'ghost'];

    await expect(
      runWith([
        { pkg: 'two', commands: ['one', 'two'] },
        { pkg: 'ghost', notFound: true },
      ]),
    ).resolves.toBe(1);
    expect(said(mocks.info.mock.calls, '共链接了')).toContain('2');
    expect(said(mocks.warn.mock.calls, '找不到包')).toContain('ghost');
  });

  it('warns and fails when nothing links', async () => {
    process.argv = ['node', 'bin-linker', 'broken'];

    await expect(
      runWith([
        { pkg: 'broken', errors: [{ name: 'broken', error: new Error('x') }] },
      ]),
    ).resolves.toBe(1);
    expect(said(mocks.error.mock.calls, '链接 broken 失败')).toBeDefined();
    expect(said(mocks.warn.mock.calls, '没有链接任何东西')).toBeDefined();
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
    ).resolves.toBe(1);

    expect(said(mocks.info.mock.calls, '补全依赖')).toContain('tool');
    // 补依赖的说明排在「找不到那个包」之前
    expect(said(mocks.warn.mock.calls, '找不到包')).toContain('ghost');
  });

  it('fails when the commands are linked but a dependency is still broken', async () => {
    // 「命令起来了」不等于「包能用」：依赖断着还报成功，等于把问题推给运行时。
    // CI 上那种绿着红的构建，就是这么攒出来的
    process.argv = ['node', 'bin-linker', 'tool'];

    await expect(
      runWith([{ pkg: 'tool', commands: ['tool'], unresolved: ['moment'] }]),
    ).resolves.toBe(1);
    expect(said(mocks.error.mock.calls, '依赖解析不到')).toContain('moment');
    expect(said(mocks.info.mock.calls, 'pnpm add -g tool')).toBeDefined();
  });

  it('shortens a long list of broken dependencies', async () => {
    // 一次报出十几个断开的依赖名字没人会读：念五个，剩下的用省略号带过
    process.argv = ['node', 'bin-linker', 'tool'];

    await expect(
      runWith([
        {
          pkg: 'tool',
          commands: ['tool'],
          unresolved: ['one', 'two', 'three', 'four', 'five', 'six'],
        },
      ]),
    ).resolves.toBe(1);

    const line = String(said(mocks.error.mock.calls, '依赖解析不到'));

    expect(line).toContain('one');
    expect(line.trimEnd().endsWith('…')).toBe(true);
  });

  it('mentions dependency links for a package with no commands', async () => {
    // 库也会断在间接依赖上：补过就要说，不然人不知道 store 里多了那些链接
    process.argv = ['node', 'bin-linker', 'library'];

    await expect(
      runWith([
        { pkg: 'library', commands: [], libraryOnly: true, depsLinked: true },
      ]),
    ).resolves.toBe(0);
    expect(said(mocks.info.mock.calls, '补全依赖')).toContain('library');
  });

  it('counts a package that only provides a library as work done', async () => {
    // 没有命令的包链上了本体就是干了活：念不出命令不该让这趟变成一次失败
    process.argv = ['node', 'bin-linker', 'library'];

    await expect(
      runWith([{ pkg: 'library', commands: [], libraryOnly: true }]),
    ).resolves.toBe(0);
    expect(said(mocks.info.mock.calls, '已链入工程')).toContain('library');
  });

  it('counts the libraries in the total', async () => {
    process.argv = ['node', 'bin-linker', 'tool', 'library'];

    await expect(
      runWith([
        { pkg: 'tool', commands: ['tool'] },
        { pkg: 'library', commands: [], libraryOnly: true },
      ]),
    ).resolves.toBe(0);
    expect(said(mocks.info.mock.calls, '共链接了')).toContain('1 个库');
  });

  it('does not report a zero command total when only libraries linked', async () => {
    // 「0 个命令」念出来像出了事：这一趟是链上了两个库，不是什么都没干
    process.argv = ['node', 'bin-linker', 'first', 'second'];

    await expect(
      runWith([
        { pkg: 'first', commands: [], libraryOnly: true },
        { pkg: 'second', commands: [], libraryOnly: true },
      ]),
    ).resolves.toBe(0);

    const total = said(mocks.info.mock.calls, '共链接了');

    expect(total).toContain('2 个库');
    expect(total).not.toContain('命令');
  });

  it('fails when a linked library still has a broken dependency', async () => {
    // 库里用间接依赖同样会炸：链上本体不等于这个包能用
    process.argv = ['node', 'bin-linker', 'library'];

    await expect(
      runWith([
        {
          pkg: 'library',
          commands: [],
          libraryOnly: true,
          unresolved: ['moment'],
        },
      ]),
    ).resolves.toBe(1);
    expect(said(mocks.error.mock.calls, '依赖解析不到')).toContain('moment');
  });

  it('fails when the pnpm global bin directory is missing from PATH', async () => {
    process.argv = ['node', 'bin-linker', 'tool', 'other'];

    await expect(
      runWith([
        { pkg: 'tool', globalBinDir: true },
        { pkg: 'other', commands: ['other'] },
      ]),
    ).resolves.toBe(1);
    expect(mocks.warn.mock.calls[0]?.[0]).toContain('无法定位');
    expect(mocks.warn.mock.calls[0]?.[0]).toContain('tool');
    expect(said(mocks.info.mock.calls, 'pnpm setup')).toBeDefined();
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

    expect(said(mocks.error.mock.calls, '管理员权限')).toBeDefined();
    expect(said(mocks.error.mock.calls, '找不到指定的包')).toBeDefined();
    expect(said(mocks.error.mock.calls, '操作失败: unknown')).toBeDefined();
  });
});
