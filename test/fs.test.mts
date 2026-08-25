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
  isWindows,
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
    mocks.stat
      .mockRejectedValueOnce(new Error('not at root'))
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
    mocks.stat
      .mockRejectedValueOnce(new Error('not at root'))
      .mockResolvedValueOnce(isDir);
    mocks.readdir.mockResolvedValue(['a1b2c3d4e5f6']);

    await expect(resolveGlobalPkgDir('tool')).resolves.toBe(
      path.join(GLOBAL_NODE_MODULES, 'a1b2c3d4e5f6', 'node_modules', 'tool'),
    );
    expect(mocks.readdir).toHaveBeenCalledWith(GLOBAL_NODE_MODULES);
  });

  it('returns null when the package exists in neither layout', async () => {
    // 根目录与所有候选虚拟目录都找不到包
    mocks.stat.mockRejectedValue(new Error('missing'));
    mocks.readdir.mockResolvedValue(['a1b2c3d4e5f6', 'f6e5d4c3b2a1']);

    await expect(resolveGlobalPkgDir('ghost')).resolves.toBeNull();
    expect(mocks.readdir).toHaveBeenCalledWith(GLOBAL_NODE_MODULES);
  });

  it('treats an unreadable global store as empty during lookup', async () => {
    // 全局根目录不可读时，readdir 失败，回退为空数组（覆盖 catch 分支）
    mocks.stat.mockRejectedValue(new Error('missing'));
    mocks.readdir.mockRejectedValue(new Error('permission denied'));

    await expect(resolveGlobalPkgDir('ghost')).resolves.toBeNull();
    expect(mocks.readdir).toHaveBeenCalledWith(GLOBAL_NODE_MODULES);
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
});
