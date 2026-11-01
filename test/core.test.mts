import { beforeEach, describe, expect, it, vi } from 'vitest';
import path from 'node:path';

const createRequireMock = vi.hoisted(() => ({ resolve: vi.fn() }));

const mocks = vi.hoisted(() => ({
  createSymlink: vi.fn(),
  ensureDir: vi.fn(),
  isPnpmBinDirMissingFromPath: vi.fn(() => false),
  isWindows: true,
  readPackageJson: vi.fn(),
  realpath: vi.fn(async (dir: string) => dir),
  resolveGlobalDepotDir: vi.fn(),
  resolveGlobalPkgDir: vi.fn(),
  lstat: vi.fn(),
  readdir: vi.fn(),
  symlink: vi.fn(),
  unlink: vi.fn(),
}));

vi.mock('../src/fs.mts', () => ({
  createSymlink: mocks.createSymlink,
  ensureDir: mocks.ensureDir,
  get isWindows() {
    return mocks.isWindows;
  },
  isPnpmBinDirMissingFromPath: mocks.isPnpmBinDirMissingFromPath,
  localBinDir: '/project/node_modules/.bin',
  pnpmGlobalPath: '/global/node_modules',
  readPackageJson: mocks.readPackageJson,
  resolveGlobalDepotDir: mocks.resolveGlobalDepotDir,
  resolveGlobalPkgDir: mocks.resolveGlobalPkgDir,
}));
vi.mock('node:module', () => ({
  createRequire: () => createRequireMock,
}));
vi.mock('node:fs', () => ({
  promises: {
    lstat: mocks.lstat,
    realpath: mocks.realpath,
    readdir: mocks.readdir,
    symlink: mocks.symlink,
    unlink: mocks.unlink,
  },
}));

const { linkPackageBins } = await import('../src/core.mts');

describe('linkPackageBins', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.isWindows = true;
    mocks.isPnpmBinDirMissingFromPath.mockReturnValue(false);
    mocks.ensureDir.mockResolvedValue(true);
    mocks.unlink.mockRejectedValue({ code: 'ENOENT' });
    mocks.symlink.mockResolvedValue(undefined);
    mocks.lstat.mockRejectedValue({ code: 'ENOENT' });
    mocks.readdir.mockResolvedValue([]);
    mocks.resolveGlobalDepotDir.mockResolvedValue(null);
    createRequireMock.resolve.mockImplementation((request: string) => {
      throw new Error(`Cannot find module '${request}'`);
    });
    mocks.createSymlink.mockResolvedValue(true);
    mocks.resolveGlobalPkgDir.mockImplementation(async (pkg: string) =>
      path.join('/global/node_modules', pkg),
    );
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
        { pkg: 'missing', commands: [], notFound: true },
        { pkg: 'library', commands: [], noBin: true },
      ],
    });
  });

  it('reports packages that cannot be located in the global store', async () => {
    // resolveGlobalPkgDir 在全局存储中找不到包目录时返回 null
    mocks.resolveGlobalPkgDir.mockResolvedValue(null);

    await expect(linkPackageBins(['ghost'])).resolves.toEqual({
      results: [{ pkg: 'ghost', commands: [], notFound: true }],
    });
    expect(mocks.readPackageJson).not.toHaveBeenCalled();
  });

  it('blames the missing global bin directory before reporting not found', async () => {
    // pnpm 的全局 bin 目录不在 PATH 时，pnpm 自身的全局目录查询也会失效，
    // 此时报「找不到包」会误导用户，应提示先配置 pnpm 全局 bin 目录。
    mocks.resolveGlobalPkgDir.mockResolvedValue(null);
    mocks.isPnpmBinDirMissingFromPath.mockReturnValue(true);

    await expect(linkPackageBins(['ghost'])).resolves.toEqual({
      results: [{ pkg: 'ghost', commands: [], globalBinDir: true }],
    });
  });

  it('links all binaries and records individual failures', async () => {
    mocks.readPackageJson.mockResolvedValue({
      bin: { first: 'first.js', second: 'second.js' },
    });
    mocks.createSymlink
      .mockResolvedValueOnce(true)
      .mockRejectedValueOnce(new Error('link failed'));

    const result = await linkPackageBins(['tool']);

    expect(result.results[0]?.commands).toEqual(['first']);
    expect(result.results[0]?.errors?.[0]?.name).toBe('second');
  });

  it('links a string bin using the package name as the command name', async () => {
    mocks.readPackageJson.mockResolvedValue({ bin: './bin/cli.js' });

    const result = await linkPackageBins(['tool']);

    expect(result.results[0]?.commands).toEqual(['tool']);
    expect(mocks.createSymlink).toHaveBeenCalledWith(
      path.join('/global/node_modules', 'tool', 'bin/cli.js'),
      path.join('/project/node_modules/.bin', 'tool'),
    );
  });

  it('uses the unscoped package name for a scoped string bin', async () => {
    mocks.readPackageJson.mockResolvedValue({ bin: 'cli.js' });

    const result = await linkPackageBins(['@scope/tool']);

    expect(result.results[0]?.commands).toEqual(['tool']);
    expect(mocks.createSymlink).toHaveBeenCalledWith(
      path.join('/global/node_modules', '@scope/tool', 'cli.js'),
      path.join('/project/node_modules/.bin', 'tool'),
    );
  });

  it('links dependencies the package cannot resolve on its own', async () => {
    // pnpm 全局布局下包的真实路径在 store 里，够不到全局安装根那张依赖表：
    // 解析不到的依赖要补进真实包的 node_modules，解析得到的不要动
    mocks.resolveGlobalPkgDir.mockResolvedValue(
      '/global/store/node_modules/tool',
    );
    mocks.realpath.mockResolvedValue('/real/store/node_modules/tool');
    mocks.resolveGlobalDepotDir.mockResolvedValue('/global/.pnpm/node_modules');
    mocks.readdir.mockResolvedValue(['missing-dep', 'present-dep']);
    mocks.readPackageJson.mockResolvedValue({ bin: { tool: 'tool.js' } });
    createRequireMock.resolve.mockImplementation((request: string) => {
      if (request === 'present-dep') {
        return '/real/store/node_modules/tool/node_modules/present-dep';
      }

      throw new Error(`Cannot find module '${request}'`);
    });

    const result = await linkPackageBins(['tool']);

    expect(result.results[0]?.depsLinked).toBe(true);
    expect(mocks.symlink).toHaveBeenCalledWith(
      '/global/.pnpm/node_modules/missing-dep',
      path.join('/real/store/node_modules/tool', 'node_modules', 'missing-dep'),
      'dir',
    );
    expect(mocks.symlink).not.toHaveBeenCalledWith(
      '/global/.pnpm/node_modules/present-dep',
      expect.anything(),
      'dir',
    );
  });

  it('skips dependency linking when the package has no entry or no depot', async () => {
    mocks.readPackageJson.mockResolvedValue({ bin: './bin/cli.js' });

    // 没有全局安装根就没有可补的依赖表
    mocks.resolveGlobalDepotDir.mockResolvedValue(null);
    await expect(linkPackageBins(['tool'])).resolves.toMatchObject({
      results: [{ depsLinked: false }],
    });

    mocks.resolveGlobalDepotDir.mockResolvedValue('/global/.pnpm/node_modules');
    mocks.readdir.mockRejectedValue(new Error('unreadable'));
    await expect(linkPackageBins(['tool'])).resolves.toMatchObject({
      results: [{ depsLinked: false }],
    });
  });

  it('stands on the package main entry when the package has no bin', async () => {
    // 没有可执行文件的包，入口退回 package.json 的 main
    mocks.resolveGlobalPkgDir.mockResolvedValue(
      '/global/store/node_modules/tool',
    );
    mocks.realpath.mockResolvedValue('/real/store/node_modules/tool');
    mocks.resolveGlobalDepotDir.mockResolvedValue('/global/.pnpm/node_modules');
    mocks.readdir.mockResolvedValue(['missing-dep']);
    mocks.readPackageJson.mockResolvedValue({
      bin: { tool: 'tool.js' },
      main: 'index.js',
    });

    await linkPackageBins(['tool']);

    expect(mocks.symlink).toHaveBeenCalledWith(
      '/global/.pnpm/node_modules/missing-dep',
      path.join('/real/store/node_modules/tool', 'node_modules', 'missing-dep'),
      'dir',
    );
  });

  it('skips dependency linking when the package declares no entry at all', async () => {
    // 既没有 bin 也没有 main：没有「站在哪解析依赖」这回事，依赖表连读都不用读
    mocks.resolveGlobalPkgDir.mockResolvedValue(
      '/global/store/node_modules/tool',
    );
    mocks.resolveGlobalDepotDir.mockResolvedValue('/global/.pnpm/node_modules');
    mocks.readPackageJson.mockResolvedValue({});

    await expect(linkPackageBins(['tool'])).resolves.toMatchObject({
      results: [{ noBin: true }],
    });
    expect(mocks.readdir).not.toHaveBeenCalled();
  });

  it('skips dependency linking when there is no depot to link from', async () => {
    mocks.readPackageJson.mockResolvedValue({ bin: { tool: 'tool.js' } });
    mocks.resolveGlobalDepotDir.mockResolvedValue(null);

    await expect(linkPackageBins(['tool'])).resolves.toMatchObject({
      results: [{ commands: ['tool'], depsLinked: false }],
    });
    expect(mocks.readdir).not.toHaveBeenCalled();
  });

  it('skips dependency linking when the package bin points nowhere', async () => {
    // 有依赖表，但 bin 指向空串：没有入口可站，就不用去读依赖表
    mocks.readPackageJson.mockResolvedValue({ bin: { tool: '' } });
    mocks.resolveGlobalDepotDir.mockResolvedValue('/global/.pnpm/node_modules');

    await expect(linkPackageBins(['tool'])).resolves.toMatchObject({
      results: [{ commands: ['tool'], depsLinked: false }],
    });
    expect(mocks.readdir).not.toHaveBeenCalled();
  });

  it('keeps the command link when the dependency pass blows up', async () => {
    // 补依赖是附赠的，整段挂掉也不该把已经建好的命令链接连坐掉
    mocks.readPackageJson.mockResolvedValue({ bin: { tool: 'tool.js' } });
    mocks.resolveGlobalDepotDir.mockRejectedValue(new Error('boom'));

    await expect(linkPackageBins(['tool'])).resolves.toMatchObject({
      results: [{ commands: ['tool'], depsLinked: false }],
    });
  });

  it('ignores dependency links that are already in place', async () => {
    // 上一次补过的链接还在时不该重建：store 是共享的，重建是多余的写操作
    mocks.resolveGlobalPkgDir.mockResolvedValue(
      '/global/store/node_modules/tool',
    );
    mocks.realpath.mockResolvedValue('/real/store/node_modules/tool');
    mocks.resolveGlobalDepotDir.mockResolvedValue('/global/.pnpm/node_modules');
    mocks.readdir.mockResolvedValue(['linked-dep']);
    mocks.lstat.mockResolvedValue({ isSymbolicLink: () => true });
    mocks.readPackageJson.mockResolvedValue({ bin: { tool: 'tool.js' } });

    const result = await linkPackageBins(['tool']);

    expect(result.results[0]?.depsLinked).toBe(false);
    expect(mocks.symlink).not.toHaveBeenCalledWith(
      '/global/.pnpm/node_modules/linked-dep',
      expect.anything(),
      'dir',
    );
  });

  it('swallows dependency link failures and keeps the command link', async () => {
    // 补不上依赖不该连命令一起丢掉：链接已建好，缺哪个依赖让运行时照实报错
    mocks.resolveGlobalPkgDir.mockResolvedValue(
      '/global/store/node_modules/tool',
    );
    mocks.realpath.mockResolvedValue('/real/store/node_modules/tool');
    mocks.resolveGlobalDepotDir.mockResolvedValue('/global/.pnpm/node_modules');
    mocks.readdir.mockResolvedValue(['broken-dep']);
    mocks.readPackageJson.mockResolvedValue({ bin: { tool: 'tool.js' } });
    // 只有往包里补依赖的那次 symlink 失败（例如跨设备），命令链接本身照常建
    mocks.symlink.mockImplementation(async (_target: string, link: string) => {
      if (link.includes(`${path.sep}node_modules${path.sep}broken-dep`)) {
        throw new Error('cross-device link');
      }
    });

    await expect(linkPackageBins(['tool'])).resolves.toMatchObject({
      results: [{ commands: ['tool'], depsLinked: false }],
    });
  });

  it('falls back to the given directory when the store path cannot be resolved', async () => {
    // realpath 失败（如链接已断）时按原路径继续，别把整次链接拖垮
    mocks.resolveGlobalPkgDir.mockResolvedValue(
      '/global/store/node_modules/tool',
    );
    mocks.realpath.mockRejectedValue(new Error('dangling'));
    mocks.resolveGlobalDepotDir.mockResolvedValue('/global/.pnpm/node_modules');
    mocks.readdir.mockResolvedValue(['missing-dep']);
    mocks.readPackageJson.mockResolvedValue({ bin: { tool: 'tool.js' } });

    await linkPackageBins(['tool']);

    expect(mocks.symlink).toHaveBeenCalledWith(
      '/global/.pnpm/node_modules/missing-dep',
      path.join(
        '/global/store/node_modules/tool',
        'node_modules',
        'missing-dep',
      ),
      'dir',
    );
  });

  it('stands on the package main when there is no usable bin entry', async () => {
    // 没声明 bin、或 bin 指向空串，都退回 main——否则这类包永远补不上依赖
    const depLink = [
      '/global/.pnpm/node_modules/missing-dep',
      path.join(
        '/global/node_modules/@scope/tool',
        'node_modules',
        'missing-dep',
      ),
      'dir',
    ];

    mocks.resolveGlobalDepotDir.mockResolvedValue('/global/.pnpm/node_modules');
    mocks.readdir.mockResolvedValue(['missing-dep']);
    mocks.readPackageJson.mockResolvedValue({ bin: '', main: 'main.js' });

    // bin 是空串：命令名取包名、路径也算不出来，但 main 还在，能站上去解析
    await expect(linkPackageBins(['@scope/tool'])).resolves.toMatchObject({
      results: [{ commands: ['tool'] }],
    });
    expect(mocks.symlink).toHaveBeenCalledWith(...depLink);
  });

  it('continues after package linking and metadata errors', async () => {
    mocks.readPackageJson
      .mockRejectedValueOnce(new Error('metadata failed'))
      .mockResolvedValueOnce({ bin: { tool: 'tool.js' } });
    mocks.createSymlink.mockRejectedValueOnce(new Error('binary failed'));

    const result = await linkPackageBins(['broken', 'tool']);

    expect(result.results[0]?.errors?.[0]?.error.message).toBe(
      'metadata failed',
    );
    expect(result.results[1]?.errors?.[0]?.error.message).toBe('binary failed');
  });

  it('handles package link failures and Windows permission failures', async () => {
    mocks.readPackageJson.mockResolvedValueOnce({
      bin: { tool: 'tool.js' },
    });
    mocks.unlink.mockRejectedValueOnce(new Error('remove failed'));

    const linkFailure = await linkPackageBins(['link-failed']);
    expect(linkFailure.results[0]?.errors?.[0]?.error.message).toBe(
      'remove failed',
    );

    mocks.readPackageJson.mockResolvedValueOnce({
      bin: { tool: 'tool.js' },
    });
    mocks.createSymlink.mockRejectedValueOnce({
      code: 'EPERM',
      message: 'permission denied',
    });

    await expect(linkPackageBins(['permission-failed'])).rejects.toMatchObject({
      code: 'EPERM',
    });

    mocks.isWindows = false;
    mocks.readPackageJson.mockResolvedValueOnce({
      bin: { tool: 'tool.js' },
    });
    await expect(linkPackageBins(['unix-tool'])).resolves.toMatchObject({
      results: [{ commands: ['tool'] }],
    });
  });
});
