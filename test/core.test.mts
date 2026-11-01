import path from 'node:path';

import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  createSymlink: vi.fn(),
  ensureDir: vi.fn(),
  getLinkType: vi.fn(() => 'dir'),
  isPnpmBinDirMissingFromPath: vi.fn(() => false),
  isWindows: true,
  readPackageJson: vi.fn(),
  readdir: vi.fn(),
  realpath: vi.fn(async (dir: string) => dir),
  resolveGlobalDepotDir: vi.fn(),
  resolveGlobalPkgDirs: vi.fn(),
  symlink: vi.fn(),
}));

vi.mock('../src/fs.mts', () => ({
  createSymlink: mocks.createSymlink,
  ensureDir: mocks.ensureDir,
  get isWindows() {
    return mocks.isWindows;
  },
  getLinkType: mocks.getLinkType,
  localBinDir: '/project/node_modules/.bin',
  readPackageJson: mocks.readPackageJson,
}));
vi.mock('../src/pnpm.mts', () => ({
  isPnpmBinDirMissingFromPath: mocks.isPnpmBinDirMissingFromPath,
  resolveGlobalDepotDir: mocks.resolveGlobalDepotDir,
  resolveGlobalPkgDirs: mocks.resolveGlobalPkgDirs,
  // 名字归一在 pnpm.test 里验，这里只要它原样透传
  toPkgName: (name: string) => name,
}));
vi.mock('node:fs', () => ({
  promises: {
    readdir: mocks.readdir,
    realpath: mocks.realpath,
    symlink: mocks.symlink,
  },
}));

const { linkMissingDeps, linkPackageBins } = await import('../src/core.mts');

const PKG_DIR = path.join('/global/node_modules', 'tool');
const STORE_DIR = '/global/store/node_modules/tool';
const DEPOT_DIR = '/global/.pnpm/node_modules';
const PROJECT_LINK = path.join(process.cwd(), 'node_modules', 'tool');

describe('linkPackageBins', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.isWindows = true;
    mocks.ensureDir.mockResolvedValue(true);
    mocks.getLinkType.mockReturnValue('dir');
    mocks.readdir.mockResolvedValue([]);
    mocks.createSymlink.mockResolvedValue(true);
    mocks.realpath.mockImplementation(async (dir: string) => dir);
    mocks.createSymlink.mockResolvedValue(true);
    mocks.symlink.mockResolvedValue(undefined);
    mocks.resolveGlobalDepotDir.mockResolvedValue(null);
    mocks.resolveGlobalPkgDirs.mockImplementation(async (pkg: string) => [
      path.join('/global/node_modules', pkg),
    ]);
  });

  it('returns no results for an empty package list', async () => {
    await expect(linkPackageBins()).resolves.toEqual({ results: [] });
    expect(mocks.ensureDir).not.toHaveBeenCalled();
  });

  it('reports an unavailable local bin directory', async () => {
    mocks.ensureDir.mockResolvedValue(false);

    await expect(linkPackageBins(['tool'])).rejects.toThrow('无法创建目标目录');
  });

  it('reports missing metadata and binless packages', async () => {
    // 元数据一个候选位置都读不到 → 找不到包；读到了但没有 bin → 没有可执行文件
    mocks.readPackageJson.mockResolvedValueOnce(null).mockResolvedValueOnce({});

    await expect(linkPackageBins(['missing', 'library'])).resolves.toEqual({
      results: [
        { pkg: 'missing', notFound: true },
        { pkg: 'library', noBin: true },
      ],
    });
  });

  it('does not link a package that has nothing to run', async () => {
    // 没有 bin 的包连本体都不用链：工程里用不着它
    mocks.readPackageJson.mockResolvedValue({});

    await linkPackageBins(['library']);

    expect(mocks.createSymlink).not.toHaveBeenCalled();
  });

  it('reports packages that cannot be located in the global store', async () => {
    mocks.resolveGlobalPkgDirs.mockResolvedValue([]);

    await expect(linkPackageBins(['ghost'])).resolves.toEqual({
      results: [{ pkg: 'ghost', notFound: true }],
    });
    expect(mocks.readPackageJson).not.toHaveBeenCalled();
  });

  it('blames the missing global bin directory before reporting not found', async () => {
    // 全局 bin 目录不在 PATH 时 pnpm 的全局目录查询也会失效，报「找不到包」会误导用户
    mocks.resolveGlobalPkgDirs.mockResolvedValue([]);
    mocks.isPnpmBinDirMissingFromPath.mockReturnValue(true);

    await expect(linkPackageBins(['ghost'])).resolves.toEqual({
      results: [{ pkg: 'ghost', globalBinDir: true }],
    });
  });

  it('links all binaries and records individual failures', async () => {
    mocks.readPackageJson.mockResolvedValue({
      bin: { first: 'first.js', second: 'second.js' },
    });
    mocks.createSymlink.mockImplementation(async (link: string) => {
      if (link === PROJECT_LINK) {
        return true;
      }

      if (link.endsWith('/second')) {
        throw new Error('link failed');
      }

      return true;
    });

    const { results } = await linkPackageBins(['tool']);

    expect(results[0]?.commands).toEqual(['first']);
    expect(results[0]?.errors?.[0]?.name).toBe('second');
  });

  it('links a string bin using the package name as the command name', async () => {
    mocks.readPackageJson.mockResolvedValue({ bin: './bin/cli.js' });

    const { results } = await linkPackageBins(['tool']);

    expect(results[0]?.commands).toEqual(['tool']);
  });

  it('links commands into the project bin directory', async () => {
    mocks.readPackageJson.mockResolvedValue({ bin: { tool: 'tool.js' } });

    await linkPackageBins(['tool']);

    expect(mocks.createSymlink).toHaveBeenCalledWith(
      path.join('/project/node_modules/.bin', 'tool'),
      [path.join(PKG_DIR, 'tool.js')],
    );
  });

  it('uses the unscoped package name for a scoped string bin', async () => {
    mocks.readPackageJson.mockResolvedValue({ bin: 'cli.js' });

    const { results } = await linkPackageBins(['@scope/tool']);

    expect(results[0]?.commands).toEqual(['tool']);
    expect(mocks.createSymlink).toHaveBeenCalledWith(
      path.join('/project/node_modules/.bin', 'tool'),
      [path.join('/global/node_modules', '@scope/tool', 'cli.js')],
    );
  });

  it('links the package itself into the project node_modules', async () => {
    mocks.readPackageJson.mockResolvedValue({ bin: { tool: 'tool.js' } });

    await linkPackageBins(['tool']);

    expect(mocks.createSymlink).toHaveBeenCalledWith(PROJECT_LINK, [PKG_DIR]);
  });

  it('offers every install location to the package link', async () => {
    // 包同时留在两个版本目录里，链接指着其中任意一份就算到位
    mocks.resolveGlobalPkgDirs.mockResolvedValue([
      '/global/v11/node_modules/tool',
      '/global/10/node_modules/tool',
    ]);
    mocks.readPackageJson.mockResolvedValue({ bin: { tool: 'tool.js' } });

    await linkPackageBins(['tool']);

    expect(mocks.createSymlink).toHaveBeenCalledWith(PROJECT_LINK, [
      '/global/v11/node_modules/tool',
      '/global/10/node_modules/tool',
    ]);
  });

  it('falls through to the next install location when metadata is unreadable', async () => {
    // 第一份的软链可能已经断了（读不到 package.json），后面还排着一份好的
    mocks.resolveGlobalPkgDirs.mockResolvedValue([
      '/global/v11/node_modules/tool',
      '/global/10/node_modules/tool',
    ]);
    mocks.readPackageJson.mockImplementation(async (dir: string) =>
      dir === '/global/10/node_modules/tool'
        ? { bin: { tool: 'cli.js' } }
        : null,
    );

    const { results } = await linkPackageBins(['tool']);

    expect(results[0]?.commands).toEqual(['tool']);
    expect(mocks.createSymlink).toHaveBeenCalledWith(
      path.join('/project/node_modules/.bin', 'tool'),
      [path.join('/global/10/node_modules/tool', 'cli.js')],
    );
  });

  it('reports package link failures', async () => {
    mocks.readPackageJson.mockResolvedValue({ bin: { tool: 'tool.js' } });
    mocks.createSymlink.mockImplementation(async (link: string) => {
      if (link.endsWith(path.join('node_modules', 'link-failed'))) {
        throw new Error('remove failed');
      }

      return true;
    });

    const { results } = await linkPackageBins(['link-failed']);

    expect(results[0]?.errors?.[0]?.error.message).toBe('remove failed');
  });

  it('propagates Windows permission failures for package links', async () => {
    // Windows 上的 EPERM 要靠管理员权限解决，交给 CLI 统一提示
    mocks.readPackageJson.mockResolvedValue({ bin: { tool: 'tool.js' } });
    mocks.createSymlink.mockImplementation(async (link: string) => {
      if (link === PROJECT_LINK) {
        throw Object.assign(new Error('permission denied'), {
          code: 'EPERM',
        });
      }

      return true;
    });

    await expect(linkPackageBins(['tool'])).rejects.toThrow(
      'permission denied',
    );
  });

  it('records other package link failures per package', async () => {
    mocks.readPackageJson.mockResolvedValue({ bin: { tool: 'tool.js' } });
    mocks.createSymlink.mockImplementation(async (link: string) => {
      if (link === PROJECT_LINK) {
        throw new Error('cross-device');
      }

      return true;
    });

    await expect(linkPackageBins(['tool'])).resolves.toMatchObject({
      results: [{ errors: [{ error: { message: 'cross-device' } }] }],
    });
  });

  it('records command link failures on unix', async () => {
    // Windows 上 EPERM 要靠管理员权限解决，其它平台只是这一个命令没链上
    mocks.isWindows = false;
    mocks.readPackageJson.mockResolvedValue({ bin: { tool: 'tool.js' } });
    mocks.createSymlink.mockImplementation(async (link: string) => {
      if (link === PROJECT_LINK) {
        return true;
      }

      throw Object.assign(new Error('permission denied'), { code: 'EPERM' });
    });

    const { results } = await linkPackageBins(['tool']);

    expect(results[0]?.errors?.[0]?.error.message).toBe('permission denied');
  });

  it('keeps the command link when the dependency pass blows up', async () => {
    // 补依赖是附赠的，整段挂掉也不该把已经建好的命令链接连坐掉
    mocks.readPackageJson.mockResolvedValue({ bin: { tool: 'tool.js' } });
    mocks.readdir.mockResolvedValue([]);
    mocks.realpath.mockImplementation(async (dir: string) => dir);
    mocks.createSymlink.mockResolvedValue(true);
    mocks.resolveGlobalDepotDir.mockImplementation(async () => {
      throw new Error('boom');
    });

    await expect(linkPackageBins(['tool'])).resolves.toMatchObject({
      results: [{ commands: ['tool'], depsLinked: false }],
    });
  });

  it('continues after metadata errors', async () => {
    mocks.readPackageJson
      .mockRejectedValueOnce(new Error('metadata failed'))
      .mockResolvedValueOnce({ bin: { tool: 'tool.js' } });
    mocks.createSymlink.mockImplementation(async (link: string) => {
      if (link !== PROJECT_LINK) {
        throw new Error('binary failed');
      }

      return true;
    });

    const { results } = await linkPackageBins(['broken', 'tool']);

    // 读不到 package.json 的包按这一包的错误处理，别让一个包炸掉整次运行
    expect(results[0]?.errors?.[0]?.error.message).toBe('metadata failed');
    expect(results[1]?.errors?.[0]?.error.message).toBe('binary failed');
  });
});

describe('linkMissingDeps', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.ensureDir.mockResolvedValue(true);
    mocks.getLinkType.mockReturnValue('dir');
    mocks.readdir.mockResolvedValue([]);
    mocks.realpath.mockImplementation(async (dir: string) => dir);
    mocks.createSymlink.mockResolvedValue(true);
    mocks.symlink.mockResolvedValue(undefined);
    mocks.resolveGlobalDepotDir.mockResolvedValue(DEPOT_DIR);
  });

  it('links the dependencies the package does not have', async () => {
    // pnpm 全局布局下包的真实路径在 store 里，够不到全局安装根那张依赖表。
    // 第一次 readdir 是依赖表，第二次是包里现有的 node_modules：
    // 表里有、包里没有的才补，只付一次目录读的代价。
    mocks.realpath.mockImplementation(
      async () => '/real/store/node_modules/tool',
    );
    mocks.readdir
      .mockResolvedValueOnce(['missing-dep', 'present-dep'])
      .mockResolvedValueOnce(['present-dep']);

    await expect(linkMissingDeps(STORE_DIR)).resolves.toBe(true);
    expect(mocks.symlink).toHaveBeenCalledWith(
      path.join(DEPOT_DIR, 'missing-dep'),
      path.join('/real/store/node_modules/tool', 'node_modules', 'missing-dep'),
      'dir',
    );
    expect(mocks.symlink).not.toHaveBeenCalledWith(
      path.join(DEPOT_DIR, 'present-dep'),
      expect.anything(),
      'dir',
    );
  });

  it('does nothing without a dependency table', async () => {
    mocks.resolveGlobalDepotDir.mockResolvedValue(null);

    await expect(linkMissingDeps(STORE_DIR)).resolves.toBe(false);
    expect(mocks.readdir).not.toHaveBeenCalled();
  });

  it('treats an unreadable dependency table as empty', async () => {
    mocks.readdir.mockRejectedValue(new Error('unreadable'));

    await expect(linkMissingDeps(STORE_DIR)).resolves.toBe(false);
  });

  it('touches nothing when the package already has every dependency', async () => {
    // 上一次补过的依赖还在时不该重建：store 是共享的，重建是多余的写操作
    mocks.readdir
      .mockResolvedValueOnce(['linked-dep'])
      .mockResolvedValueOnce(['linked-dep']);

    await expect(linkMissingDeps(STORE_DIR)).resolves.toBe(false);
    expect(mocks.symlink).not.toHaveBeenCalled();
    expect(mocks.ensureDir).not.toHaveBeenCalled();
  });

  it('swallows dependency link failures', async () => {
    // 补不上依赖不该连命令一起丢掉：链接已建好，缺哪个依赖让运行时照实报错
    mocks.readdir
      .mockResolvedValueOnce(['broken-dep'])
      .mockResolvedValueOnce([]);
    mocks.symlink.mockRejectedValue(new Error('cross-device link'));

    await expect(linkMissingDeps(STORE_DIR)).resolves.toBe(false);
  });

  it('stops early when the per-package node_modules cannot be created', async () => {
    // 建不出目录就补不了任何依赖，不必逐个试
    mocks.readdir
      .mockResolvedValueOnce(['dep-a', 'dep-b'])
      .mockResolvedValueOnce([]);
    mocks.ensureDir.mockResolvedValue(false);

    await expect(linkMissingDeps(STORE_DIR)).resolves.toBe(false);
    expect(mocks.ensureDir).toHaveBeenCalledTimes(1);
    expect(mocks.symlink).not.toHaveBeenCalled();
  });

  it('falls back to the given directory when the store path cannot be resolved', async () => {
    // realpath 失败（如链接已断）时按原路径继续，别把整次链接拖垮
    mocks.realpath.mockRejectedValue(new Error('dangling'));
    mocks.readdir
      .mockResolvedValueOnce(['missing-dep'])
      .mockResolvedValueOnce([]);

    await linkMissingDeps(STORE_DIR);
    expect(mocks.symlink).toHaveBeenCalledWith(
      path.join(DEPOT_DIR, 'missing-dep'),
      path.join(STORE_DIR, 'node_modules', 'missing-dep'),
      'dir',
    );
  });
});
