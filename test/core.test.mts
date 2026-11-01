import path from 'node:path';

import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  createSymlink: vi.fn(),
  ensureDir: vi.fn(),
  isPnpmBinDirMissingFromPath: vi.fn(() => false),
  isWindows: true,
  getLinkType: vi.fn(() => 'dir'),
  readPackageJson: vi.fn(),
  readdir: vi.fn(),
  readlink: vi.fn(),
  realpath: vi.fn(async (dir: string) => dir),
  resolveGlobalDepotDir: vi.fn(),
  resolveGlobalPkgDirs: vi.fn(),
  symlink: vi.fn(),
  unlink: vi.fn(),
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
  // 名字归一在 pnpm.test 里验，这里只要它原样透传
  normalizePkgName: (name: string) => name,
  resolveGlobalDepotDir: mocks.resolveGlobalDepotDir,
  resolveGlobalPkgDirs: mocks.resolveGlobalPkgDirs,
}));
vi.mock('node:fs', () => ({
  promises: {
    readdir: mocks.readdir,
    readlink: mocks.readlink,
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
    mocks.getLinkType.mockReset();
    mocks.readPackageJson.mockReset();
    mocks.readdir.mockReset();
    mocks.realpath.mockReset();
    mocks.readlink.mockReset();
    mocks.resolveGlobalDepotDir.mockReset();
    mocks.resolveGlobalPkgDirs.mockReset();
    mocks.symlink.mockReset();
    mocks.unlink.mockReset();
    mocks.isWindows = true;
    mocks.isPnpmBinDirMissingFromPath.mockReturnValue(false);
    mocks.ensureDir.mockResolvedValue(true);
    mocks.unlink.mockRejectedValue({ code: 'ENOENT' });
    mocks.symlink.mockResolvedValue(undefined);
    // 默认：哪儿都没有现成的链接，一律走新建
    mocks.readlink.mockRejectedValue({ code: 'ENOENT' });
    mocks.getLinkType.mockReturnValue('dir');
    mocks.readdir.mockResolvedValue([]);
    mocks.createSymlink.mockResolvedValue(true);
    mocks.resolveGlobalDepotDir.mockResolvedValue(null);
    mocks.symlink.mockImplementation(async () => undefined);
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

    // 链接的是目录：类型交给 getLinkType（Windows 上它会选 junction）
    expect(mocks.symlink).toHaveBeenCalledWith(
      PKG_DIR,
      path.join(process.cwd(), 'node_modules', 'tool'),
      'dir',
    );
  });

  it('leaves a package link that already points at the same package', async () => {
    // 重跑时链接已经指着同一个包：不要再 unlink + symlink 一遍，也别短暂留个空洞
    mocks.readPackageJson.mockResolvedValue({ bin: { tool: 'tool.js' } });
    mocks.realpath.mockResolvedValue('/real/store/tool');
    // 链接与目标解析到同一处、readlink 也成功＝已经到位
    mocks.readlink.mockImplementation(async (link: string) => {
      if (link === path.join(process.cwd(), 'node_modules', 'tool')) {
        return PKG_DIR;
      }

      throw Object.assign(new Error('not a link'), { code: 'ENOENT' });
    });

    const { results } = await linkPackageBins(['tool']);

    expect(results[0]?.commands).toEqual(['tool']);

    // 包链接不该被重建（命令链接是 createSymlink 自己的事，不是这里）
    expect(mocks.symlink).not.toHaveBeenCalledWith(
      PKG_DIR,
      path.join(process.cwd(), 'node_modules', 'tool'),
      expect.anything(),
    );
  });

  it('accepts a link that points at any of the candidate locations', async () => {
    // 包同时留在两个版本目录里，链接指着其中一份就算到位
    mocks.resolveGlobalPkgDirs.mockResolvedValue([
      '/global/v11/node_modules/tool',
      '/global/10/node_modules/tool',
    ]);
    mocks.readPackageJson.mockResolvedValue({ bin: { tool: 'tool.js' } });
    mocks.realpath.mockResolvedValue('/real/tool');
    mocks.readlink.mockResolvedValue('/real/tool');

    await linkPackageBins(['tool']);

    expect(mocks.symlink).not.toHaveBeenCalledWith(
      '/global/v11/node_modules/tool',
      path.join(process.cwd(), 'node_modules', 'tool'),
      expect.anything(),
    );
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
      path.join('/global/10/node_modules/tool', 'cli.js'),
      path.join('/project/node_modules/.bin', 'tool'),
    );
  });

  it('rebuilds a package link that points elsewhere', async () => {
    // 链接指向旧版本装的那一份：realpath 对不上，得重建
    mocks.readPackageJson.mockResolvedValue({ bin: { tool: 'tool.js' } });
    mocks.realpath.mockImplementation(async (target: string) =>
      target === PKG_DIR ? '/real/new/tool' : '/real/old/tool',
    );
    mocks.readlink.mockImplementation(async (link: string) =>
      link === path.join(process.cwd(), 'node_modules', 'tool')
        ? '/real/old/tool'
        : undefined,
    );

    await linkPackageBins(['tool']);

    expect(mocks.symlink).toHaveBeenCalledWith(
      PKG_DIR,
      path.join(process.cwd(), 'node_modules', 'tool'),
      'dir',
    );
  });

  it('rebuilds when the project entry is a plain directory', async () => {
    // node_modules/<pkg> 被解压/拷进来一份真实目录时 readlink 会 EINVAL，同样要重建
    mocks.readPackageJson.mockResolvedValue({ bin: { tool: 'tool.js' } });
    mocks.realpath.mockImplementation(async (target: string) => target);
    mocks.readlink.mockImplementation(async (link: string) => {
      if (link === path.join(process.cwd(), 'node_modules', 'tool')) {
        throw Object.assign(new Error('not a link'), { code: 'EINVAL' });
      }

      return undefined;
    });

    await linkPackageBins(['tool']);

    expect(mocks.symlink).toHaveBeenCalledWith(
      PKG_DIR,
      path.join(process.cwd(), 'node_modules', 'tool'),
      'dir',
    );
  });

  it('rebuilds when the previous package link dangles', async () => {
    // 链接在，但指向的地方已经没了：realpath 失败，当成要重建
    mocks.readPackageJson.mockResolvedValue({ bin: { tool: 'tool.js' } });
    // 包那边解析失败 → 退回原路径；链接那边解析失败 → null，两边对不上
    const dangling = vi.fn(async () => {
      throw new Error('gone');
    });

    mocks.realpath.mockImplementation(dangling);
    mocks.readlink.mockImplementation(async (link: string) =>
      link === path.join(process.cwd(), 'node_modules', 'tool')
        ? '/global/old/tool'
        : undefined,
    );

    await linkPackageBins(['tool']);

    expect(dangling).toHaveBeenCalled();
    expect(mocks.symlink).toHaveBeenCalledWith(
      PKG_DIR,
      path.join(process.cwd(), 'node_modules', 'tool'),
      'dir',
    );
  });

  it('tolerates a missing previous package link', async () => {
    // 第一次链这个包时 node_modules 里本来就没有它，unlink 报 ENOENT 不算失败
    mocks.readPackageJson.mockResolvedValue({ bin: { tool: 'tool.js' } });
    mocks.unlink.mockRejectedValueOnce({ code: 'ENOENT' });

    const { results } = await linkPackageBins(['tool']);

    expect(results[0]?.errors).toEqual([]);
    expect(results[0]?.commands).toEqual(['tool']);
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
    mocks.getLinkType.mockReset();
    mocks.symlink.mockReset();
    mocks.ensureDir.mockReset();
    mocks.createSymlink.mockReset();
    mocks.resolveGlobalPkgDirs.mockReset();
    mocks.resolveGlobalDepotDir.mockResolvedValue(DEPOT_DIR);
    mocks.readPackageJson.mockResolvedValue({});
    mocks.createSymlink.mockResolvedValue(true);
    mocks.ensureDir.mockResolvedValue(true);
    mocks.realpath.mockImplementation(async (dir: string) => dir);
    mocks.readdir.mockImplementation(async () => []);
    mocks.getLinkType.mockReturnValue('dir');
    mocks.symlink.mockImplementation(async () => undefined);
    mocks.ensureDir.mockImplementation(async () => true);
    mocks.createSymlink.mockImplementation(async () => true);
    mocks.resolveGlobalPkgDirs.mockImplementation(async (pkg: string) => [
      path.join('/global/node_modules', pkg),
    ]);
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

  it('touches nothing when the package already has every dependency', async () => {
    // 上一次补过的依赖还在时不该重建：store 是共享的，重建是多余的写操作
    mocks.readdir
      .mockResolvedValueOnce(['linked-dep'])
      .mockResolvedValueOnce(['linked-dep']);

    await expect(linkMissingDeps(STORE_DIR, 'tool.js')).resolves.toBe(false);
    expect(mocks.symlink).not.toHaveBeenCalled();
    expect(mocks.ensureDir).not.toHaveBeenCalled();
  });

  it('swallows dependency link failures', async () => {
    // 补不上依赖不该连命令一起丢掉：链接已建好，缺哪个依赖让运行时照实报错
    mocks.readdir
      .mockResolvedValueOnce(['broken-dep'])
      .mockResolvedValueOnce([]);
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
    mocks.readdir
      .mockResolvedValueOnce(['missing-dep'])
      .mockResolvedValueOnce([]);

    await linkMissingDeps(STORE_DIR, 'tool.js');
    expect(mocks.symlink).toHaveBeenCalledWith(
      path.join(DEPOT_DIR, 'missing-dep'),
      path.join(STORE_DIR, 'node_modules', 'missing-dep'),
      'dir',
    );
  });
});
