import path from 'node:path';

import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  createSymlink: vi.fn(),
  ensureDir: vi.fn(),
  getLayout: vi.fn(),
  isBinDirMissingFromPath: vi.fn(() => false),
  readDir: vi.fn(),
  readPackageJson: vi.fn(),
  resolvePath: vi.fn(),
}));

vi.mock('../src/fs.mts', () => ({
  createSymlink: mocks.createSymlink,
  ensureDir: mocks.ensureDir,
  readDir: mocks.readDir,
  readPackageJson: mocks.readPackageJson,
  resolvePath: mocks.resolvePath,
}));
vi.mock('../src/pnpm.mts', () => ({
  getLayout: mocks.getLayout,
  isBinDirMissingFromPath: mocks.isBinDirMissingFromPath,
}));

const { linkMissingDeps, linkPackageBins } = await import('../src/core.mts');

const PKG = 'tool';
const PKG_DIR = path.join('/global/node_modules', PKG);
const STORE_DIR = '/global/store/node_modules/tool';
const DEPOT_DIR = '/global/.pnpm/node_modules';
const BIN_DIR = path.join(process.cwd(), 'node_modules', '.bin');
const PROJECT_LINK = path.join(process.cwd(), 'node_modules', PKG);

const commandCalls = () =>
  mocks.createSymlink.mock.calls.filter(([link]) => link.startsWith(BIN_DIR));
/** 补依赖落在 store 里那个包的 node_modules 下，与命令链接分得开 */
const depCalls = () =>
  mocks.createSymlink.mock.calls.filter(([link]) => link.startsWith(STORE_DIR));

/** 一份只有这一处候选、没有依赖表的布局 */
const layout = (
  candidates: string[] = [path.join('/global/node_modules')],
) => ({
  candidates,
  depot: null,
});

describe('linkPackageBins', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.ensureDir.mockResolvedValue(true);
    mocks.readDir.mockResolvedValue([]);
    mocks.createSymlink.mockResolvedValue(undefined);
    mocks.resolvePath.mockImplementation(async (dir: string) => dir);
    mocks.readPackageJson.mockResolvedValue({ bin: { tool: 'tool.js' } });
    mocks.getLayout.mockResolvedValue(layout());
    mocks.isBinDirMissingFromPath.mockReturnValue(false);
  });

  it('reports packages that cannot be located in the global store', async () => {
    mocks.readPackageJson.mockResolvedValue(null);

    await expect(linkPackageBins(['ghost'])).resolves.toEqual([
      { pkg: 'ghost', notFound: true },
    ]);
    expect(mocks.readPackageJson).toHaveBeenCalled();
  });

  it('blames the missing global bin directory before reporting not found', async () => {
    // 全局 bin 目录不在 PATH 时 pnpm 的全局目录查询也会失效，报「找不到包」会误导用户
    mocks.getLayout.mockResolvedValue(layout([]));
    mocks.isBinDirMissingFromPath.mockReturnValue(true);

    await expect(linkPackageBins(['ghost'])).resolves.toEqual([
      { pkg: 'ghost', globalBinDir: true },
    ]);
  });

  it('does not blame the environment for a package nobody installed', async () => {
    // 布局探得出来、只是这个包不在里面：那是没装，不是环境问题
    mocks.readPackageJson.mockResolvedValue(null);
    mocks.isBinDirMissingFromPath.mockReturnValue(true);

    await expect(linkPackageBins(['ghost'])).resolves.toEqual([
      { pkg: 'ghost', notFound: true },
    ]);
  });

  it('reports missing metadata and binless packages', async () => {
    // 元数据一个候选位置都读不到 → 找不到包；读到了但没有 bin → 没有可执行文件
    mocks.readPackageJson.mockResolvedValueOnce(null).mockResolvedValueOnce({});

    await expect(linkPackageBins(['missing', 'library'])).resolves.toEqual([
      { pkg: 'missing', notFound: true },
      { pkg: 'library', noBin: true },
    ]);
  });

  it('does not link a package that has nothing to run', async () => {
    // 没有 bin 的包连本体都不用链：工程里用不着它
    mocks.readPackageJson.mockResolvedValue({});

    await linkPackageBins(['library']);

    expect(mocks.createSymlink).not.toHaveBeenCalled();
  });

  it('links commands into the project bin directory', async () => {
    await linkPackageBins([PKG]);

    expect(mocks.createSymlink).toHaveBeenCalledWith(
      path.join(BIN_DIR, 'tool'),
      [path.join(PKG_DIR, 'tool.js')],
    );
  });

  it('records individual command failures without dropping the rest', async () => {
    mocks.readPackageJson.mockResolvedValue({
      bin: { first: 'first.js', second: 'second.js' },
    });
    mocks.createSymlink.mockImplementation(async (link: string) => {
      if (link === path.join(BIN_DIR, 'second')) {
        throw new Error('link failed');
      }
    });

    const [result] = await linkPackageBins([PKG]);

    expect(result?.commands).toEqual(['first']);
    expect(result?.errors).toEqual([
      { name: 'second', error: new Error('link failed') },
    ]);
  });

  it('links a string bin using the package name as the command name', async () => {
    mocks.readPackageJson.mockResolvedValue({ bin: './bin/cli.js' });

    const [result] = await linkPackageBins([PKG]);

    expect(result?.commands).toEqual(['tool']);
    expect(mocks.createSymlink).toHaveBeenCalledWith(
      path.join(BIN_DIR, 'tool'),
      [path.join(PKG_DIR, './bin/cli.js')],
    );
  });

  it('uses the unscoped package name for a scoped string bin', async () => {
    mocks.readPackageJson.mockResolvedValue({ bin: 'cli.js' });

    const [result] = await linkPackageBins(['@scope/tool']);

    expect(result?.commands).toEqual(['tool']);
    expect(mocks.createSymlink).toHaveBeenCalledWith(
      path.join(BIN_DIR, 'tool'),
      [path.join('/global/node_modules', '@scope/tool', 'cli.js')],
    );
  });

  it('links the package itself into the project node_modules', async () => {
    await linkPackageBins([PKG]);

    expect(mocks.createSymlink).toHaveBeenCalledWith(PROJECT_LINK, [PKG_DIR]);
  });

  it('offers every install location to the package link', async () => {
    // 包同时留在两个版本目录里，链接指着其中任意一份就算到位
    mocks.getLayout.mockResolvedValue(
      layout(['/global/v11/node_modules', '/global/10/node_modules']),
    );

    await linkPackageBins([PKG]);

    expect(mocks.createSymlink).toHaveBeenCalledWith(PROJECT_LINK, [
      '/global/v11/node_modules/tool',
      '/global/10/node_modules/tool',
    ]);
  });

  it('falls through to the next install location when metadata is unreadable', async () => {
    // 第一份的软链可能已经断了（读不到 package.json），后面还排着一份好的
    mocks.getLayout.mockResolvedValue(
      layout(['/global/v11/node_modules', '/global/10/node_modules']),
    );
    mocks.readPackageJson.mockImplementation(async (dir: string) =>
      dir === '/global/10/node_modules/tool'
        ? { bin: { tool: 'cli.js' } }
        : null,
    );

    const [result] = await linkPackageBins([PKG]);

    expect(result).toEqual(
      expect.objectContaining({ commands: ['tool'], depsLinked: false }),
    );
    // 包本体与命令都取读得到元数据的那一份，包本体仍把全部候选交给链接
    expect(mocks.createSymlink).toHaveBeenCalledWith(PROJECT_LINK, [
      '/global/v11/node_modules/tool',
      '/global/10/node_modules/tool',
    ]);
    expect(commandCalls()).toEqual([
      [
        path.join(BIN_DIR, 'tool'),
        [path.join('/global/10/node_modules/tool', 'cli.js')],
      ],
    ]);
  });

  it('records package link failures per package', async () => {
    mocks.createSymlink.mockRejectedValueOnce(new Error('cross-device'));

    await expect(linkPackageBins([PKG])).resolves.toEqual([
      {
        pkg: PKG,
        errors: [{ name: PKG, error: new Error('cross-device') }],
      },
    ]);
    // 包本体没链上就别再谈命令了
    expect(mocks.readDir).not.toHaveBeenCalled();
  });

  it('records permission failures per command', async () => {
    // 非 Windows 上 EPERM 只是这一个命令没链上，别把整次运行掀了
    mocks.createSymlink.mockImplementation(async (link: string) => {
      if (link === path.join(BIN_DIR, 'tool')) {
        throw Object.assign(new Error('permission denied'), { code: 'EPERM' });
      }
    });

    const [result] = await linkPackageBins([PKG]);

    // 只有命令没链上，包本体照常
    expect(result?.commands).toEqual([]);
    expect(result?.errors?.[0]?.error.message).toBe('permission denied');
  });

  it('leaves a broken layout to the CLI', async () => {
    // 布局算不出来是环境问题，不是某个包的错，往上冒给 CLI 统一提示
    mocks.getLayout.mockRejectedValue(new Error('no pnpm'));

    await expect(linkPackageBins([PKG, 'other'])).rejects.toThrow('no pnpm');
  });

  it('keeps the command link when the dependency pass blows up', async () => {
    // 补依赖是附赠的，整段挂掉也不该把已经建好的命令链接连坐掉
    mocks.getLayout
      .mockResolvedValueOnce(layout())
      .mockRejectedValue(new Error('boom'));

    await expect(linkPackageBins([PKG])).resolves.toMatchObject([
      { commands: ['tool'], depsLinked: false },
    ]);
  });

  it('continues after a package blows up unexpectedly', async () => {
    mocks.createSymlink.mockRejectedValueOnce(new Error('store gone'));

    const results = await linkPackageBins(['broken', PKG]);

    // 一个包炸了只赔上它自己，别让整次运行停摆
    expect(results[0]).toEqual({
      pkg: 'broken',
      errors: [{ name: 'broken', error: new Error('store gone') }],
    });
    expect(results[1]?.commands).toEqual(['tool']);
  });

  it('propagates the permission failure Windows cannot work around', async () => {
    // Windows 上的 EPERM 不是这个包的问题，得让 CLI 统一提示管理员权限
    mocks.createSymlink.mockRejectedValue(
      Object.assign(new Error('permission denied'), { code: 'EPERM' }),
    );

    await expect(linkPackageBins([PKG], { platform: 'win32' })).rejects.toThrow(
      'permission denied',
    );
  });
});

describe('linkMissingDeps', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.ensureDir.mockResolvedValue(true);
    mocks.readDir.mockResolvedValue([]);
    mocks.resolvePath.mockImplementation(async (dir: string) => dir);
    mocks.getLayout.mockResolvedValue(layout(['/global/node_modules']));
  });

  it('links the dependencies the package does not have', async () => {
    // pnpm 全局布局下包的真实路径在 store 里，够不到全局安装根那张依赖表。
    // 表里有、包里没有的才补，只付两次目录读的代价。
    mocks.getLayout.mockResolvedValue({
      candidates: ['/global/node_modules'],
      depot: DEPOT_DIR,
    });
    mocks.resolvePath.mockResolvedValue(STORE_DIR);
    mocks.createSymlink.mockResolvedValue(undefined);
    mocks.readDir.mockImplementation(async (dir: string) =>
      dir === DEPOT_DIR ? ['missing-dep', 'present-dep'] : ['present-dep'],
    );

    await expect(linkMissingDeps(STORE_DIR)).resolves.toBe(true);
    expect(depCalls()).toEqual([
      [
        path.join(STORE_DIR, 'node_modules', 'missing-dep'),
        [path.join(DEPOT_DIR, 'missing-dep')],
      ],
    ]);
  });

  it('does nothing without a dependency table', async () => {
    await expect(linkMissingDeps(STORE_DIR)).resolves.toBe(false);
    expect(mocks.readDir).not.toHaveBeenCalled();
  });

  it('treats an unreadable dependency table as empty', async () => {
    mocks.getLayout.mockResolvedValue({
      candidates: ['/global/node_modules'],
      depot: DEPOT_DIR,
    });
    mocks.readDir.mockImplementation(async (dir: string) =>
      dir === DEPOT_DIR ? [] : [],
    );

    await expect(linkMissingDeps(STORE_DIR)).resolves.toBe(false);
    expect(mocks.createSymlink).not.toHaveBeenCalled();
  });

  it('touches nothing when the package already has every dependency', async () => {
    // 上一次补过的依赖还在时不该重建：store 是共享的，重建是多余的写操作
    mocks.getLayout.mockResolvedValue({
      candidates: ['/global/node_modules'],
      depot: DEPOT_DIR,
    });
    mocks.readDir.mockResolvedValue(['linked-dep']);

    await expect(linkMissingDeps(STORE_DIR)).resolves.toBe(false);
    expect(mocks.ensureDir).not.toHaveBeenCalled();
    expect(mocks.createSymlink).not.toHaveBeenCalled();
  });

  it('gives up when the per-package node_modules cannot be created', async () => {
    mocks.getLayout.mockResolvedValue({
      candidates: ['/global/node_modules'],
      depot: DEPOT_DIR,
    });
    mocks.readDir.mockImplementation(async (dir: string) =>
      dir === DEPOT_DIR ? ['dep-a', 'dep-b'] : [],
    );
    mocks.ensureDir.mockResolvedValue(false);

    await expect(linkMissingDeps(STORE_DIR)).resolves.toBe(false);
    expect(mocks.createSymlink).not.toHaveBeenCalled();
  });

  it('keeps going when a dependency link fails', async () => {
    // 补不上某个依赖不该连命令一起丢掉：链接已建好，缺哪个依赖让运行时照实报错
    mocks.getLayout.mockResolvedValue({
      candidates: ['/global/node_modules'],
      depot: DEPOT_DIR,
    });
    mocks.readDir.mockImplementation(async (dir: string) =>
      dir === DEPOT_DIR ? ['broken-dep', 'good-dep'] : [],
    );
    mocks.createSymlink
      .mockResolvedValue(undefined)
      .mockRejectedValueOnce(new Error('cross-device'));

    await expect(linkMissingDeps(STORE_DIR)).resolves.toBe(true);
    expect(depCalls()).toHaveLength(2);
  });

  it('reports nothing linked when every dependency fails', async () => {
    mocks.getLayout.mockResolvedValue({
      candidates: ['/global/node_modules'],
      depot: DEPOT_DIR,
    });
    mocks.readDir.mockImplementation(async (dir: string) =>
      dir === DEPOT_DIR ? ['broken-dep'] : [],
    );
    mocks.createSymlink.mockRejectedValue(new Error('cross-device'));

    await expect(linkMissingDeps(STORE_DIR)).resolves.toBe(false);
  });

  it('falls back to the given directory when the store path cannot be resolved', async () => {
    // realpath 失败（如链接已断）时按原路径继续，别把整次链接拖垮
    mocks.getLayout.mockResolvedValue({
      candidates: ['/global/node_modules'],
      depot: DEPOT_DIR,
    });
    mocks.resolvePath.mockImplementation(async (dir: string) => dir);
    mocks.createSymlink.mockResolvedValue(undefined);
    mocks.readDir.mockImplementation(async (dir: string) =>
      dir === DEPOT_DIR ? ['missing-dep'] : [],
    );

    await linkMissingDeps(STORE_DIR);
    expect(depCalls()).toEqual([
      [
        path.join(STORE_DIR, 'node_modules', 'missing-dep'),
        [path.join(DEPOT_DIR, 'missing-dep')],
      ],
    ]);
  });
});
