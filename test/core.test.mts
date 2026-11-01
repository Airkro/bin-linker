import path from 'node:path';

import { beforeEach, describe, expect, it, vi } from 'vitest';

const resolver = vi.hoisted(() => ({ resolve: vi.fn() }));

const mocks = vi.hoisted(() => ({
  createSymlink: vi.fn(),
  ensureDir: vi.fn(),
  isPnpmBinDirMissingFromPath: vi.fn(() => false),
  isWindows: true,
  lstat: vi.fn(),
  readPackageJson: vi.fn(),
  readdir: vi.fn(),
  realpath: vi.fn(async (dir: string) => dir),
  resolveGlobalDepotDir: vi.fn(),
  resolveGlobalPkgDir: vi.fn(),
  symlink: vi.fn(),
  unlink: vi.fn(),
}));

vi.mock('../src/fs.mts', () => ({
  createSymlink: mocks.createSymlink,
  ensureDir: mocks.ensureDir,
  get isWindows() {
    return mocks.isWindows;
  },
  localBinDir: '/project/node_modules/.bin',
  readPackageJson: mocks.readPackageJson,
}));
vi.mock('../src/pnpm.mts', () => ({
  isPnpmBinDirMissingFromPath: mocks.isPnpmBinDirMissingFromPath,
  resolveGlobalDepotDir: mocks.resolveGlobalDepotDir,
  resolveGlobalPkgDir: mocks.resolveGlobalPkgDir,
}));
vi.mock('node:module', () => ({ createRequire: () => resolver }));
vi.mock('node:fs', () => ({
  promises: {
    lstat: mocks.lstat,
    readdir: mocks.readdir,
    realpath: mocks.realpath,
    symlink: mocks.symlink,
    unlink: mocks.unlink,
  },
}));

const { linkMissingDeps, linkPackageBins } = await import('../src/core.mts');

const PKG_DIR = path.join('/global/node_modules', 'tool');
const STORE_DIR = '/global/store/node_modules/tool';
const DEPOT_DIR = '/global/.pnpm/node_modules';

describe('linkPackageBins', () => {
  beforeEach(() => {
    mocks.createSymlink.mockReset();
    mocks.ensureDir.mockReset();
    mocks.isPnpmBinDirMissingFromPath.mockReset();
    mocks.lstat.mockReset();
    mocks.readPackageJson.mockReset();
    mocks.readdir.mockReset();
    mocks.realpath.mockReset();
    mocks.resolveGlobalDepotDir.mockReset();
    mocks.resolveGlobalPkgDir.mockReset();
    mocks.symlink.mockReset();
    mocks.unlink.mockReset();
    resolver.resolve.mockReset();
    mocks.isWindows = true;
    mocks.isPnpmBinDirMissingFromPath.mockReturnValue(false);
    mocks.ensureDir.mockResolvedValue(true);
    mocks.unlink.mockRejectedValue({ code: 'ENOENT' });
    mocks.symlink.mockResolvedValue(undefined);
    mocks.lstat.mockRejectedValue({ code: 'ENOENT' });
    mocks.readdir.mockResolvedValue([]);
    mocks.createSymlink.mockResolvedValue(true);
    mocks.resolveGlobalDepotDir.mockResolvedValue(null);
    mocks.symlink.mockImplementation(async () => undefined);
    mocks.resolveGlobalPkgDir.mockImplementation(async (pkg: string) =>
      path.join('/global/node_modules', pkg),
    );
    resolver.resolve.mockImplementation((request: string) => {
      throw new Error(`Cannot find module '${request}'`);
    });
  });

  it('returns no results for an empty package list', async () => {
    await expect(linkPackageBins()).resolves.toEqual({ results: [] });
    expect(mocks.ensureDir).not.toHaveBeenCalled();
  });

  it('reports an unavailable local bin directory', async () => {
    mocks.ensureDir.mockResolvedValue(false);

    await expect(linkPackageBins(['tool'])).rejects.toThrow('无法创建目标目录');
  });

  it('reports missing and binless packages', async () => {
    mocks.readPackageJson.mockResolvedValueOnce(null).mockResolvedValueOnce({});

    await expect(linkPackageBins(['missing', 'library'])).resolves.toEqual({
      results: [
        { pkg: 'missing', noBin: true },
        { pkg: 'library', noBin: true },
      ],
    });
  });

  it('reports packages that cannot be located in the global store', async () => {
    mocks.resolveGlobalPkgDir.mockResolvedValue(null);

    await expect(linkPackageBins(['ghost'])).resolves.toEqual({
      results: [{ pkg: 'ghost', notFound: true }],
    });
    expect(mocks.readPackageJson).not.toHaveBeenCalled();
  });

  it('blames the missing global bin directory before reporting not found', async () => {
    // 全局 bin 目录不在 PATH 时 pnpm 的全局目录查询也会失效，报「找不到包」会误导用户
    mocks.resolveGlobalPkgDir.mockResolvedValue(null);
    mocks.isPnpmBinDirMissingFromPath.mockReturnValue(true);

    await expect(linkPackageBins(['ghost'])).resolves.toEqual({
      results: [{ pkg: 'ghost', globalBinDir: true }],
    });
  });

  it('links all binaries and records individual failures', async () => {
    mocks.readPackageJson.mockResolvedValue({
      bin: { first: 'first.js', second: 'second.js' },
    });
    mocks.createSymlink
      .mockResolvedValueOnce(true)
      .mockRejectedValueOnce(new Error('link failed'));

    const { results } = await linkPackageBins(['tool']);

    expect(results[0]?.commands).toEqual(['first']);
    expect(results[0]?.errors?.[0]?.name).toBe('second');
  });

  it('links a string bin using the package name as the command name', async () => {
    mocks.readPackageJson.mockResolvedValue({ bin: './bin/cli.js' });

    const { results } = await linkPackageBins(['tool']);

    expect(results[0]?.commands).toEqual(['tool']);
    expect(mocks.createSymlink).toHaveBeenCalledWith(
      path.join(PKG_DIR, 'bin/cli.js'),
      path.join('/project/node_modules/.bin', 'tool'),
    );
  });

  it('uses the unscoped package name for a scoped string bin', async () => {
    mocks.readPackageJson.mockResolvedValue({ bin: 'cli.js' });

    const { results } = await linkPackageBins(['@scope/tool']);

    expect(results[0]?.commands).toEqual(['tool']);
    expect(mocks.createSymlink).toHaveBeenCalledWith(
      path.join('/global/node_modules', '@scope/tool', 'cli.js'),
      path.join('/project/node_modules/.bin', 'tool'),
    );
  });

  it('links the package itself into the project node_modules', async () => {
    mocks.readPackageJson.mockResolvedValue({ bin: { tool: 'tool.js' } });
    mocks.unlink.mockResolvedValueOnce(undefined);

    await linkPackageBins(['tool']);

    expect(mocks.symlink).toHaveBeenCalledWith(
      PKG_DIR,
      path.join(process.cwd(), 'node_modules', 'tool'),
      'junction',
    );
  });

  it('reports package link failures', async () => {
    mocks.readPackageJson.mockResolvedValue({ bin: { tool: 'tool.js' } });
    mocks.unlink.mockRejectedValueOnce(new Error('remove failed'));

    const { results } = await linkPackageBins(['link-failed']);

    expect(results[0]?.errors?.[0]?.error.message).toBe('remove failed');
  });

  it('propagates Windows permission failures for package links', async () => {
    // Windows 上的 EPERM 要靠管理员权限解决，交给 CLI 统一提示
    mocks.readPackageJson.mockResolvedValue({ bin: { tool: 'tool.js' } });
    mocks.symlink.mockImplementation(() => {
      throw Object.assign(new Error('permission denied'), { code: 'EPERM' });
    });

    // 包链接失败在 linkPackageBin 里就被记成了这一包的错误，
    // 只有命令链接的 EPERM 才往上冒（交给 CLI 统一提示）
    const { results } = await linkPackageBins(['tool']);

    expect(results[0]?.errors?.[0]?.error.message).toBe('permission denied');
  });

  it('records other package link failures per package', async () => {
    mocks.readPackageJson.mockResolvedValue({ bin: { tool: 'tool.js' } });
    mocks.symlink.mockRejectedValueOnce(new Error('cross-device'));

    await expect(linkPackageBins(['tool'])).resolves.toMatchObject({
      results: [{ errors: [{ error: { message: 'cross-device' } }] }],
    });
  });

  it('swallows Windows permission failures for command links on unix', async () => {
    // Windows 上 EPERM 要靠管理员权限解决，其它平台只是这一个命令没链上
    mocks.isWindows = false;
    mocks.readPackageJson.mockResolvedValue({ bin: { tool: 'tool.js' } });
    mocks.createSymlink.mockRejectedValueOnce({
      code: 'EPERM',
      message: 'permission denied',
    });

    const { results } = await linkPackageBins(['tool']);

    expect(results[0]?.errors?.[0]?.error.message).toBe('permission denied');
  });

  it('continues after metadata errors', async () => {
    mocks.readPackageJson
      .mockRejectedValueOnce(new Error('metadata failed'))
      .mockResolvedValueOnce({ bin: { tool: 'tool.js' } });
    mocks.createSymlink.mockRejectedValueOnce(new Error('binary failed'));

    const { results } = await linkPackageBins(['broken', 'tool']);

    // 读不到 package.json 的包按「没有可执行文件」处理，别让一个包炸掉整次运行
    expect(results[0]?.errors?.[0]?.error.message).toBe('metadata failed');
    expect(results[1]?.errors?.[0]?.error.message).toBe('binary failed');
  });
});

describe('linkMissingDeps', () => {
  beforeEach(() => {
    // 重新绑定实现：mockReset 之后 getMockImplementation 会失效，只能重设
    mocks.resolveGlobalDepotDir.mockReset();
    mocks.realpath.mockReset();
    mocks.readdir.mockReset();
    mocks.lstat.mockReset();
    mocks.symlink.mockReset();
    mocks.ensureDir.mockReset();
    mocks.createSymlink.mockReset();
    mocks.resolveGlobalPkgDir.mockReset();
    resolver.resolve.mockReset();
    mocks.resolveGlobalDepotDir.mockResolvedValue(DEPOT_DIR);
    mocks.readPackageJson.mockResolvedValue({});
    mocks.createSymlink.mockResolvedValue(true);
    mocks.ensureDir.mockResolvedValue(true);
    mocks.realpath.mockImplementation(async (dir: string) => dir);
    mocks.readdir.mockImplementation(async () => []);
    mocks.lstat.mockImplementation(async () => {
      throw Object.assign(new Error('missing'), { code: 'ENOENT' });
    });
    mocks.symlink.mockImplementation(async () => undefined);
    mocks.ensureDir.mockImplementation(async () => true);
    mocks.createSymlink.mockImplementation(async () => true);
    mocks.resolveGlobalPkgDir.mockImplementation(async (pkg: string) =>
      path.join('/global/node_modules', pkg),
    );
    resolver.resolve.mockImplementation((request: string) => {
      throw new Error(`Cannot find module '${request}'`);
    });
  });

  it('links dependencies the package cannot resolve on its own', async () => {
    // pnpm 全局布局下包的真实路径在 store 里，够不到全局安装根那张依赖表
    mocks.realpath.mockImplementation(
      async () => '/real/store/node_modules/tool',
    );
    mocks.readdir.mockImplementation(async () => [
      'missing-dep',
      'present-dep',
    ]);
    resolver.resolve.mockImplementation((request: string) => {
      if (request === 'present-dep') {
        return '/real/store/node_modules/tool/node_modules/present-dep';
      }

      throw new Error(`Cannot find module '${request}'`);
    });

    await linkMissingDeps(STORE_DIR, 'tool.js');
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

  it('does nothing without an entry to stand on', async () => {
    // 没有入口就没有「站在哪解析依赖」这回事，依赖表连读都不用读
    await expect(linkMissingDeps(STORE_DIR, undefined)).resolves.toBe(false);
    expect(mocks.readdir).not.toHaveBeenCalled();
  });

  it('does nothing without a dependency table', async () => {
    mocks.resolveGlobalDepotDir.mockResolvedValue(null);

    await expect(linkMissingDeps(STORE_DIR, 'tool.js')).resolves.toBe(false);
    expect(mocks.readdir).not.toHaveBeenCalled();
  });

  it('treats an unreadable dependency table as empty', async () => {
    mocks.readdir.mockRejectedValue(new Error('unreadable'));

    await expect(linkMissingDeps(STORE_DIR, 'tool.js')).resolves.toBe(false);
  });

  it('keeps the command link when the dependency pass blows up', async () => {
    // 补依赖是附赠的，整段挂掉也不该把已经建好的命令链接连坐掉
    mocks.readPackageJson.mockResolvedValue({ bin: { tool: 'tool.js' } });
    mocks.resolveGlobalDepotDir.mockImplementation(async () => {
      throw new Error('boom');
    });

    await expect(linkPackageBins(['tool'])).resolves.toMatchObject({
      results: [{ commands: ['tool'], depsLinked: false }],
    });
  });

  it('ignores dependency links that are already in place', async () => {
    // 上一次补过的链接还在时不该重建：store 是共享的，重建是多余的写操作
    mocks.readdir.mockImplementation(async () => ['linked-dep']);
    mocks.lstat.mockImplementation(async () => ({
      isSymbolicLink: () => true,
    }));

    await expect(linkMissingDeps(STORE_DIR, 'tool.js')).resolves.toBe(false);
    expect(mocks.symlink).not.toHaveBeenCalled();
  });

  it('swallows dependency link failures', async () => {
    // 补不上依赖不该连命令一起丢掉：链接已建好，缺哪个依赖让运行时照实报错
    mocks.readdir.mockImplementation(async () => ['broken-dep']);
    mocks.symlink.mockImplementation(async () => {
      throw new Error('cross-device link');
    });

    await expect(linkMissingDeps(STORE_DIR, 'tool.js')).resolves.toBe(false);
  });

  it('falls back to the given directory when the store path cannot be resolved', async () => {
    // realpath 失败（如链接已断）时按原路径继续，别把整次链接拖垮
    mocks.realpath.mockImplementation(async () => {
      throw new Error('dangling');
    });
    mocks.readdir.mockImplementation(async () => ['missing-dep']);

    await linkMissingDeps(STORE_DIR, 'tool.js');
    expect(mocks.symlink).toHaveBeenCalledWith(
      path.join(DEPOT_DIR, 'missing-dep'),
      path.join(STORE_DIR, 'node_modules', 'missing-dep'),
      'dir',
    );
  });
});
