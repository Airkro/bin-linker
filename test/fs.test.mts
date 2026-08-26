import os from 'node:os';
import path from 'node:path';

import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  access: vi.fn(),
  mkdir: vi.fn(),
  readFile: vi.fn(),
  readdir: vi.fn(),
  stat: vi.fn(),
  unlink: vi.fn(),
  symlink: vi.fn(),
  execSync: vi.fn(() => '/global/node_modules\n'),
}));

vi.mock('node:child_process', () => ({ execSync: mocks.execSync }));
vi.mock('node:fs', () => ({
  promises: {
    access: mocks.access,
    mkdir: mocks.mkdir,
    readFile: mocks.readFile,
    readdir: mocks.readdir,
    stat: mocks.stat,
    unlink: mocks.unlink,
    symlink: mocks.symlink,
  },
}));

const {
  createSymlink,
  ensureDir,
  getPnpmHome,
  getSymlinkType,
  isWindows,
  pnpmGlobalRoot,
  readPackageJson,
  resolveGlobalPkgDir,
} = await import('../src/fs.mts');

const GLOBAL_NODE_MODULES = '/global/node_modules';

const isDir = { isDirectory: () => true };

describe('filesystem helpers', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.execSync.mockReturnValue('/global/node_modules\n');
    mocks.stat.mockResolvedValue(isDir);
    mocks.readdir.mockResolvedValue([]);
  });

  it('creates directories and reports creation failures', async () => {
    await expect(ensureDir('/tmp/bin-linker')).resolves.toBe(true);

    mocks.mkdir.mockRejectedValueOnce(new Error('read-only'));
    await expect(ensureDir('/tmp/bin-linker')).resolves.toBe(false);
  });

  it('reads valid packages and handles missing or invalid metadata', async () => {
    // 'tool' - 包直接位于全局根目录下 (pnpm 10 布局)
    mocks.access.mockResolvedValueOnce(undefined);
    mocks.readFile.mockResolvedValueOnce('{"bin":{"tool":"cli.js"}}');
    await expect(readPackageJson('tool')).resolves.toEqual({
      bin: { tool: 'cli.js' },
    });

    // 'missing' - 在根目录和 pnpm 11 布局中都找不到
    mocks.stat.mockRejectedValue(new Error('missing'));
    mocks.readdir.mockResolvedValue([]);
    await expect(readPackageJson('missing')).resolves.toBeNull();

    // 'broken' - 存在但 package.json 内容无效
    mocks.stat.mockResolvedValue(isDir);
    mocks.access.mockResolvedValueOnce(undefined);
    mocks.readFile.mockResolvedValueOnce('invalid json');
    await expect(readPackageJson('broken')).resolves.toBeNull();
  });

  it('returns null when the package directory exists but its package.json is missing', async () => {
    // 包目录存在（pnpm 10 布局命中），但目录内没有 package.json 文件
    mocks.stat.mockResolvedValueOnce(isDir);
    mocks.access.mockRejectedValue(new Error('no package.json'));

    await expect(readPackageJson('no-manifest')).resolves.toBeNull();
  });

  it('finds packages inside the pnpm 11 content-addressed global store', async () => {
    // pnpm 11：包不在全局根目录下，而是位于 <root>/<hash>/node_modules/<pkg>
    // 依次跳过 pnpm 10 的直接布局与 node_modules 子目录布局，再命中 pnpm 11 虚拟目录
    mocks.stat
      .mockRejectedValueOnce(new Error('not at root'))
      .mockRejectedValueOnce(new Error('no node_modules subdir'))
      .mockResolvedValueOnce(isDir);
    mocks.readdir.mockResolvedValue(['a1b2c3d4e5f6']);
    mocks.access.mockResolvedValueOnce(undefined);
    mocks.readFile.mockResolvedValueOnce('{"bin":{"tool":"cli.js"}}');

    await expect(readPackageJson('tool')).resolves.toEqual({
      bin: { tool: 'cli.js' },
    });

    expect(mocks.readdir).toHaveBeenCalledWith(GLOBAL_NODE_MODULES);
    expect(mocks.readFile).toHaveBeenCalledWith(
      path.join(
        GLOBAL_NODE_MODULES,
        'a1b2c3d4e5f6',
        'node_modules',
        'tool',
        'package.json',
      ),
      'utf8',
    );
  });

  it('resolves the pnpm 10 layout where the package sits at the global root', async () => {
    // pnpm 10：包直接位于 <global>/<pkg>，无需遍历虚拟目录
    mocks.stat.mockResolvedValueOnce(isDir);

    await expect(resolveGlobalPkgDir('tool')).resolves.toBe(
      path.join(GLOBAL_NODE_MODULES, 'tool'),
    );
    expect(mocks.readdir).not.toHaveBeenCalled();
  });

  it('resolves the pnpm 11 layout inside the content-addressed global store', async () => {
    // pnpm 11：包不在全局根目录下，而是位于 <global>/<hash>/node_modules/<pkg>
    // 依次跳过 pnpm 10 的直接布局与 node_modules 子目录布局，再命中 pnpm 11 虚拟目录
    mocks.stat
      .mockRejectedValueOnce(new Error('not at root'))
      .mockRejectedValueOnce(new Error('no node_modules subdir'))
      .mockResolvedValueOnce(isDir);
    mocks.readdir.mockResolvedValue(['a1b2c3d4e5f6']);

    await expect(resolveGlobalPkgDir('tool')).resolves.toBe(
      path.join(GLOBAL_NODE_MODULES, 'a1b2c3d4e5f6', 'node_modules', 'tool'),
    );
    expect(mocks.readdir).toHaveBeenCalledWith(GLOBAL_NODE_MODULES);
  });

  it('finds a pnpm 10 package via the node_modules subdir in another version root', async () => {
    // 当前 pnpm 为 pnpm 11（`pnpm root -g` 返回 <global>/v11），但全局包由 pnpm 10
    // 安装，位于 <pnpmHome>/global/5/node_modules/<pkg>。
    // 这正是 CI 中「pnpm 11 运行 bin-linker、包为镜像预装」的场景，此前会误报找不到包。
    const globalRoot = pnpmGlobalRoot;
    // 模拟 pnpm 11 为当前 pnpm，`pnpm root -g` 返回 <global>/v11
    mocks.execSync.mockReturnValue(`${globalRoot}/v11\n`);
    vi.resetModules();

    // @ts-expect-error Vitest supports query strings for isolated module imports.
    const ciFs = await import('../src/fs.mts?ci-pnpm10-node-modules');

    // isDirectory 调用顺序：
    // 1. 当前根 global/v11/tool 直接布局未命中
    // 2. 当前根 global/v11/node_modules/tool 未命中
    // 3. 版本目录 global/5 的直接布局（global/5/tool）未命中
    // 4. 版本目录 global/5 的 node_modules 子目录布局（global/5/node_modules/tool）命中
    mocks.stat
      .mockRejectedValueOnce(new Error('not at root'))
      .mockRejectedValueOnce(new Error('no node_modules subdir'))
      .mockRejectedValueOnce(new Error('not in version root'))
      .mockResolvedValueOnce(isDir);
    // readdir 调用顺序：
    // 1. 读当前根 global/v11 的虚拟目录（无结果）
    // 2. 读 <pnpmHome>/global 版本目录列表
    mocks.readdir.mockResolvedValueOnce([]).mockResolvedValueOnce(['5', 'v11']);

    await expect(ciFs.resolveGlobalPkgDir('tool')).resolves.toBe(
      path.join(globalRoot, '5', 'node_modules', 'tool'),
    );
    expect(mocks.readdir).toHaveBeenCalledWith(globalRoot);

    mocks.execSync.mockReturnValue('/global/node_modules\n');
    vi.resetModules();
  });

  it('returns null when the package exists in neither layout', async () => {
    // 根目录与所有候选虚拟目录都找不到包
    mocks.stat.mockRejectedValue(new Error('missing'));
    mocks.readdir.mockResolvedValue(['a1b2c3d4e5f6', 'f6e5d4c3b2a1']);

    await expect(resolveGlobalPkgDir('ghost')).resolves.toBeNull();
    expect(mocks.readdir).toHaveBeenCalledWith(GLOBAL_NODE_MODULES);
  });

  it('skips a version entry that resolves to the current global root', async () => {
    mocks.execSync.mockReturnValue(`${pnpmGlobalRoot}\n`);
    vi.resetModules();

    // @ts-expect-error Vitest supports query strings for isolated module imports.
    const sameRootFs = await import('../src/fs.mts?same-global-root');
    // 直接布局与 node_modules 子目录布局均未命中（跳过 pnpm 10 两种布局）
    mocks.stat
      .mockRejectedValueOnce(new Error('missing'))
      .mockRejectedValueOnce(new Error('no node_modules subdir'));
    mocks.readdir.mockResolvedValueOnce([]).mockResolvedValueOnce(['.']);

    await expect(sameRootFs.resolveGlobalPkgDir('ghost')).resolves.toBeNull();
    expect(mocks.readdir).toHaveBeenCalledWith(sameRootFs.pnpmGlobalRoot);
    mocks.execSync.mockReturnValue('/global/node_modules\n');
    vi.resetModules();
  });

  it('treats an unreadable global store as empty during lookup', async () => {
    // 全局根目录不可读时，readdir 失败，回退为空数组（覆盖 catch 分支）
    mocks.stat.mockRejectedValue(new Error('missing'));
    mocks.readdir.mockRejectedValue(new Error('permission denied'));

    await expect(resolveGlobalPkgDir('ghost')).resolves.toBeNull();
    expect(mocks.readdir).toHaveBeenCalledWith(GLOBAL_NODE_MODULES);
  });

  it('finds packages installed by another pnpm version in the shared global root', async () => {
    // 当前 pnpm（pnpm 11）的全局根目录中找不到包，但包由其它 pnpm 版本
    // （pnpm 10，位于 <pnpmHome>/global/5）安装。应跨版本目录继续查找。
    const globalRoot = pnpmGlobalRoot;
    // isDirectory 调用顺序：
    // 1. 当前全局根目录的直接布局（/global/node_modules/tool）未命中
    // 2. 当前全局根目录的 node_modules 子目录布局（/global/node_modules/node_modules/tool）未命中
    // 3. 版本目录 global/5 的直接命中（global/5/tool）命中
    mocks.stat
      .mockRejectedValueOnce(new Error('not in current'))
      .mockRejectedValueOnce(new Error('no node_modules subdir'))
      .mockResolvedValueOnce(isDir);
    // readdir 调用顺序：
    // 1. 读当前全局根目录的虚拟目录（无结果）
    // 2. 读 <pnpmHome>/global 版本目录列表
    mocks.readdir.mockResolvedValueOnce([]).mockResolvedValueOnce(['5', 'v11']);

    await expect(resolveGlobalPkgDir('tool')).resolves.toBe(
      path.join(globalRoot, '5', 'tool'),
    );
    expect(mocks.readdir).toHaveBeenCalledWith(globalRoot);
  });

  it('creates symlinks and handles target and unlink errors', async () => {
    mocks.access.mockRejectedValueOnce(new Error('missing target'));
    await expect(createSymlink('/target', '/link')).rejects.toThrow(
      '目标不存在',
    );

    mocks.access.mockResolvedValueOnce(undefined);
    mocks.unlink.mockRejectedValueOnce({ code: 'ENOENT' });
    await expect(createSymlink('/target', '/link')).resolves.toBe(true);
    expect(mocks.symlink).toHaveBeenCalledWith(
      '/target',
      '/link',
      isWindows ? 'file' : undefined,
    );

    mocks.access.mockResolvedValueOnce(undefined);
    mocks.unlink.mockRejectedValueOnce(new Error('cannot unlink'));
    await expect(createSymlink('/target', '/link')).rejects.toThrow(
      'cannot unlink',
    );
  });

  it('resolves pnpm home defaults on macOS and Linux', async () => {
    const originalPlatform = process.platform;
    const originalPath = process.env.PATH;
    const originalXdgDataHome = process.env.XDG_DATA_HOME;
    const originalLocalAppData = process.env.LOCALAPPDATA;
    const originalPnpmHome = process.env.PNPM_HOME;

    try {
      delete process.env.PNPM_HOME;
      process.env.LOCALAPPDATA = '/local-app-data';
      expect(getPnpmHome('win32')).toBe(path.join('/local-app-data', 'pnpm'));
      delete process.env.LOCALAPPDATA;
      expect(getPnpmHome('win32')).toBe(
        path.join(os.homedir(), 'AppData', 'Local', 'pnpm'),
      );

      process.env.XDG_DATA_HOME = '/data';
      expect(getPnpmHome('linux')).toBe(path.join('/data', 'pnpm'));
      delete process.env.XDG_DATA_HOME;
      expect(getPnpmHome('linux')).toBe(
        path.join(os.homedir(), '.local', 'share', 'pnpm'),
      );
      expect(getPnpmHome('darwin')).toBe(
        path.join(os.homedir(), 'Library', 'pnpm'),
      );

      process.env.PNPM_HOME = '/pnpm-home';
      expect(getPnpmHome('linux')).toBe('/pnpm-home');
      expect(getSymlinkType('win32')).toBe('file');
      expect(getSymlinkType('linux')).toBeUndefined();

      Object.defineProperty(process, 'platform', { value: 'darwin' });
      delete process.env.PATH;
      vi.resetModules();
      // @ts-expect-error Vitest supports query strings for isolated module imports.
      await import('../src/fs.mts?darwin');

      Object.defineProperty(process, 'platform', { value: 'linux' });
      process.env.XDG_DATA_HOME = '/data';
      vi.resetModules();
      // @ts-expect-error Vitest supports query strings for isolated module imports.
      const linuxFs = await import('../src/fs.mts?linux');
      mocks.access.mockResolvedValueOnce(undefined);
      mocks.unlink.mockRejectedValueOnce({ code: 'ENOENT' });
      await linuxFs.createSymlink('/target', '/link');

      delete process.env.XDG_DATA_HOME;
      vi.resetModules();
      // @ts-expect-error Vitest supports query strings for isolated module imports.
      await import('../src/fs.mts?linux-default');

      // PNPM_HOME 存在时，会拼接到 configuredBinDirs（`pnpmHome/bin` 与 `pnpmHome`）
      process.env.PNPM_HOME = '/pnpm-home';
      delete process.env.XDG_DATA_HOME;
      vi.resetModules();
      // @ts-expect-error Vitest supports query strings for isolated module imports.
      await import('../src/fs.mts?pnpm-home');

      Object.defineProperty(process, 'platform', { value: 'win32' });
      process.env.LOCALAPPDATA = '/local-app-data';
      delete process.env.XDG_DATA_HOME;
      delete process.env.PNPM_HOME;
      vi.resetModules();
      // @ts-expect-error Vitest supports query strings for isolated module imports.
      const windowsFs = await import('../src/fs.mts?windows-localappdata');
      // Windows 下 isWindows 为 true，createSymlink 使用 'file' 类型（覆盖 line 186）
      mocks.access.mockResolvedValueOnce(undefined);
      mocks.unlink.mockRejectedValueOnce({ code: 'ENOENT' });
      await windowsFs.createSymlink('/target', '/link');

      delete process.env.LOCALAPPDATA;
      vi.resetModules();
      // @ts-expect-error Vitest supports query strings for isolated module imports.
      await import('../src/fs.mts?windows-default');
    } finally {
      Object.defineProperty(process, 'platform', { value: originalPlatform });
      if (originalPath === undefined) {
        delete process.env.PATH;
      } else {
        process.env.PATH = originalPath;
      }
      if (originalXdgDataHome === undefined) {
        delete process.env.XDG_DATA_HOME;
      } else {
        process.env.XDG_DATA_HOME = originalXdgDataHome;
      }
      if (originalLocalAppData === undefined) {
        delete process.env.LOCALAPPDATA;
      } else {
        process.env.LOCALAPPDATA = originalLocalAppData;
      }
      if (originalPnpmHome === undefined) {
        delete process.env.PNPM_HOME;
      } else {
        process.env.PNPM_HOME = originalPnpmHome;
      }
    }
  });

  it('ignores pnpm warnings printed before the global root', async () => {
    mocks.execSync.mockReturnValue(
      '[WARN] Using --global skips the package manager check for this project\n' +
        '/pnpm/global/v11/node_modules\n',
    );
    vi.resetModules();

    // @ts-expect-error Vitest supports query strings for isolated module imports.
    const warningFs = await import('../src/fs.mts?pnpm-warning');

    expect(warningFs.pnpmGlobalPath).toBe('/pnpm/global/v11/node_modules');
  });

  it('falls back to trimmed pnpm output when no absolute path is present', async () => {
    mocks.execSync.mockReturnValue('global root unavailable\n');
    vi.resetModules();

    // @ts-expect-error Vitest supports query strings for isolated module imports.
    const fallbackFs = await import('../src/fs.mts?pnpm-root-fallback');

    expect(fallbackFs.pnpmGlobalPath).toBe('global root unavailable');
  });

  it('falls back to scanning the global root when `pnpm root -g` fails', async () => {
    // `pnpm root -g` 失败（pnpm 不在 PATH 或校验不通过）时，模块不应崩溃，
    // `pnpmGlobalPath` 为 null，查找回退到遍历 <pnpmHome>/global 自行定位。
    const originalPnpmHome = process.env.PNPM_HOME;
    process.env.PNPM_HOME = '/pnpm-home';

    try {
      mocks.execSync.mockImplementation(() => {
        throw new Error('pnpm not found');
      });
      vi.resetModules();

      // @ts-expect-error Vitest supports query strings for isolated module imports.
      const failedFs = await import('../src/fs.mts?pnpm-root-failed');

      expect(failedFs.pnpmGlobalPath).toBeNull();
      expect(failedFs.pnpmGlobalRoot).toBe(path.join('/pnpm-home', 'global'));

      // 兜底查找：当前无全局根目录可用，直接遍历 <pnpmHome>/global 下版本目录，
      // 首个版本目录 `5` 的直接布局命中。
      const globalRoot = path.join('/pnpm-home', 'global');
      mocks.stat.mockResolvedValueOnce(isDir);
      mocks.readdir.mockResolvedValueOnce(['5', 'v11']);

      await expect(failedFs.resolveGlobalPkgDir('tool')).resolves.toBe(
        path.join(globalRoot, '5', 'tool'),
      );
      expect(mocks.readdir).toHaveBeenCalledWith(globalRoot);
    } finally {
      if (originalPnpmHome === undefined) {
        delete process.env.PNPM_HOME;
      } else {
        process.env.PNPM_HOME = originalPnpmHome;
      }
      mocks.execSync.mockReturnValue('/global/node_modules\n');
      vi.resetModules();
    }
  });
});
