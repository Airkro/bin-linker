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
  execSync: vi.fn(
    (_command?: string, _options?: unknown) => '/global/node_modules\n',
  ),
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
  getPnpmGlobalPath,
  getPnpmHome,
  getSymlinkType,
  isPnpmBinDirMissingFromPath,
  isWindows,
  pnpmGlobalRoot,
  readPackageJson,
  resolveGlobalDepotDir,
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
    // 版本目录（<pnpmHome>/global/<ver>）默认不存在，避免与各用例的布局断言互相干扰
    mocks.readdir.mockImplementation(async () => []);
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

    // 候选根目录按顺序探测，逐个尝试三种布局。只让 pnpm 10 的
    // `<root>/node_modules/<pkg>` 这一种命中，其余一律落空。
    // 这样断言不再依赖「第几次 stat 命中」这种跟实现顺序绑死的约定。
    mocks.stat.mockImplementation(async (dir: string) => {
      if (dir === path.join(globalRoot, '5', 'node_modules', 'tool')) {
        return isDir;
      }

      throw new Error('missing');
    });

    await expect(ciFs.resolveGlobalPkgDir('tool')).resolves.toBe(
      path.join(globalRoot, '5', 'node_modules', 'tool'),
    );

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

  it('finds the dependency table under a content-addressed version dir', async () => {
    // pnpm 11 每装一次就在版本根下新建一个内容寻址目录，依赖表（.pnpm/node_modules）
    // 只在那里面；版本根自己的 node_modules 可能根本没有
    const versionDir = path.join(pnpmGlobalRoot, 'v11');
    mocks.readdir.mockImplementation(async (dir: string) => {
      if (dir === pnpmGlobalRoot) {
        return ['v11'];
      }

      return dir === versionDir ? ['hash123'] : [];
    });
    mocks.stat.mockImplementation(async (dir: string) => {
      if (
        dir ===
        path.join(
          versionDir,
          'hash123',
          'node_modules',
          '.pnpm',
          'node_modules',
        )
      ) {
        return isDir;
      }

      throw new Error('missing');
    });

    await expect(resolveGlobalDepotDir()).resolves.toBe(
      path.join(versionDir, 'hash123', 'node_modules', '.pnpm', 'node_modules'),
    );
  });

  it('ignores version dirs that are already covered by the fixed candidates', async () => {
    // 固定候选里已经包含 global/v11，扫到的同名目录不该再查一遍
    const versionDir = path.join(pnpmGlobalRoot, 'v11');
    const searched: string[] = [];

    mocks.readdir.mockImplementation(async (dir: string) =>
      dir === pnpmGlobalRoot ? ['v11'] : [],
    );
    mocks.stat.mockImplementation(async (dir: string) => {
      searched.push(dir);

      if (dir === versionDir) {
        return { isDirectory: () => true, mtimeMs: 1 };
      }

      throw new Error('missing');
    });

    await expect(resolveGlobalPkgDir('tool')).resolves.toBeNull();
    // 只作为「当前根目录 / 推断候选」查过，扫目录那一步没有重复查它
    expect(searched.filter((dir) => dir === versionDir)).toHaveLength(1);
    expect(searched).toContain(path.join(versionDir, 'tool'));
  });

  it('returns null when no version dir exposes a dependency table', async () => {
    mocks.readdir.mockResolvedValue([]);
    mocks.stat.mockRejectedValue(new Error('missing'));

    await expect(resolveGlobalDepotDir()).resolves.toBeNull();
  });

  it('skips a version entry that resolves to the current global root', async () => {
    mocks.execSync.mockReturnValue(`${pnpmGlobalRoot}\n`);
    vi.resetModules();

    // @ts-expect-error Vitest supports query strings for isolated module imports.
    const sameRootFs = await import('../src/fs.mts?same-global-root');
    // 所有候选根目录（当前根与推断版本目录）的两种布局均未命中
    mocks.stat.mockRejectedValue(new Error('missing'));
    mocks.readdir.mockResolvedValue([]);

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
    const expected = path.join(globalRoot, '5', 'tool');

    mocks.stat.mockImplementation(async (dir: string) => {
      if (dir === expected) {
        return isDir;
      }

      throw new Error('missing');
    });

    await expect(resolveGlobalPkgDir('tool')).resolves.toBe(expected);
  });

  it('searches version dirs newest first and tolerates unreadable ones', async () => {
    // 一次全局安装会新建一个版本目录，旧的仍在。按 mtime 从新到旧查，
    // 最近装的那个最可能装着要找的包；stat 失败（目录被删 / 无权限）的排到最后。
    const versionDir = (name: string) => path.join(pnpmGlobalRoot, name);
    // 只让最旧的那个版本目录命中，才看得出查找顺序
    const expected = path.join(versionDir('alpha'), 'node_modules', 'tool');

    mocks.readdir.mockImplementation(async (dir: string) =>
      dir === pnpmGlobalRoot ? ['zeta', 'alpha', 'broken'] : [],
    );
    mocks.stat.mockImplementation(async (dir: string) => {
      if (dir === expected) {
        return isDir;
      }

      if (dir === versionDir('zeta')) {
        return { isDirectory: () => true, mtimeMs: 300 };
      }

      if (dir === versionDir('alpha')) {
        return { isDirectory: () => true, mtimeMs: 200 };
      }

      throw new Error('vanished');
    });

    await expect(resolveGlobalPkgDir('tool')).resolves.toBe(expected);

    const searched = mocks.stat.mock.calls.map(([dir]) => String(dir));
    const firstSeen = (name: string) =>
      searched.findIndex((dir) => dir.startsWith(versionDir(name)));

    // 最近改动的先查；读不到 mtime 的排最后
    expect(firstSeen('zeta')).toBeLessThan(firstSeen('alpha'));
    expect(firstSeen('alpha')).toBeLessThan(firstSeen('broken'));
  });

  it('detects whether the pnpm bin directory is missing from PATH', async () => {
    const originalPath = process.env.PATH;
    const originalPnpmHome = process.env.PNPM_HOME;
    const originalGlobalBinDir = process.env.npm_config_global_bin_dir;

    try {
      delete process.env.npm_config_global_bin_dir;
      process.env.PNPM_HOME = '/pnpm-home';

      process.env.PATH = ['/usr/bin', '/pnpm-home/bin'].join(path.delimiter);
      expect(isPnpmBinDirMissingFromPath()).toBe(false);

      // PNPM_HOME 本身也在 pnpm 的校验范围内（pnpm 10 看它，pnpm 11 看它的 bin）
      process.env.PATH = '/pnpm-home';
      expect(isPnpmBinDirMissingFromPath()).toBe(false);

      process.env.PATH = '/usr/bin';
      expect(isPnpmBinDirMissingFromPath()).toBe(true);

      // pnpm 自己传给子进程的 npm_config_global_bin_dir 优先于 PNPM_HOME
      process.env.npm_config_global_bin_dir = '/elsewhere/bin';
      process.env.PATH = '/elsewhere/bin';
      expect(isPnpmBinDirMissingFromPath()).toBe(false);

      // 没有 PATH 时按空串处理，不该抛异常
      delete process.env.PATH;
      expect(isPnpmBinDirMissingFromPath()).toBe(true);
    } finally {
      if (originalPath === undefined) {
        delete process.env.PATH;
      } else {
        process.env.PATH = originalPath;
      }
      if (originalPnpmHome === undefined) {
        delete process.env.PNPM_HOME;
      } else {
        process.env.PNPM_HOME = originalPnpmHome;
      }
      if (originalGlobalBinDir === undefined) {
        delete process.env.npm_config_global_bin_dir;
      } else {
        process.env.npm_config_global_bin_dir = originalGlobalBinDir;
      }
    }
  });

  it('restores an unset PATH after querying the global root', async () => {
    const originalPath = process.env.PATH;
    const originalPnpmHome = process.env.PNPM_HOME;

    try {
      delete process.env.PATH;
      process.env.PNPM_HOME = '/pnpm-home';
      mocks.execSync.mockReturnValue('');

      // 没有 PATH 时补出来的 PATH 也要能还原成「没有」
      expect(getPnpmGlobalPath()).toBe('');
      expect(process.env.PATH).toBeUndefined();
    } finally {
      if (originalPath === undefined) {
        delete process.env.PATH;
      } else {
        process.env.PATH = originalPath;
      }
      if (originalPnpmHome === undefined) {
        delete process.env.PNPM_HOME;
      } else {
        process.env.PNPM_HOME = originalPnpmHome;
      }
      mocks.execSync.mockReturnValue('/global/node_modules\n');
    }
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

    expect(warningFs.getPnpmGlobalPath()).toBe('/pnpm/global/v11/node_modules');
  });

  it('falls back to trimmed pnpm output when no absolute path is present', async () => {
    mocks.execSync.mockReturnValue('global root unavailable\n');
    vi.resetModules();

    // @ts-expect-error Vitest supports query strings for isolated module imports.
    const fallbackFs = await import('../src/fs.mts?pnpm-root-fallback');

    expect(fallbackFs.getPnpmGlobalPath()).toBe('global root unavailable');
  });

  it('queries the global root without the inherited global bin dir and with a piped stdin', async () => {
    const originalGlobalBinDir = process.env.npm_config_global_bin_dir;
    const originalCi = process.env.CI;
    const originalPnpmHome = process.env.PNPM_HOME;
    process.env.npm_config_global_bin_dir = '/elsewhere/bin';
    process.env.PNPM_HOME = '/pnpm-home';
    delete process.env.CI;

    try {
      mocks.execSync.mockImplementation((command, options) => {
        // pnpm 自己传下来的 npm_config_global_bin_dir 会覆盖补进 PATH 的目录，
        // 让 pnpm 10 的 PATH 校验直接失败，查询时必须摘掉它。
        expect(process.env.npm_config_global_bin_dir).toBeUndefined();
        // corepack 只在 CI 置位时才不弹「是否下载」，别把行为赌在 runner 的变量上。
        expect(process.env.CI).toBe('true');
        // 更新检查是背景网络请求，断网时能把一次查询拖成分钟级。
        expect(process.env.npm_config_update_notifier).toBe('false');
        // 继承了永不关闭的 stdin 时，corepack shim 会一直等到它 end，execSync 就挂住了。
        expect((options as { stdio?: string }).stdio).toBe('pipe');
        // pnpm 11 起会按附近的 packageManager 声明重启成另一个版本（甚至现下），
        // 查全局目录时显式关掉版本切换。
        expect(command).toBe(
          'pnpm --config.manage-package-manager-versions=false root -g',
        );

        return '/pnpm-home/global/v11/node_modules\n';
      });
      vi.resetModules();

      // @ts-expect-error Vitest supports query strings for isolated module imports.
      const queryFs = await import('../src/fs.mts?pnpm-query-env');

      expect(queryFs.getPnpmGlobalPath()).toBe(
        '/pnpm-home/global/v11/node_modules',
      );
      // 查询结束必须原样还回去，别污染调用方的环境
      expect(process.env.npm_config_global_bin_dir).toBe('/elsewhere/bin');
      expect(process.env.CI).toBeUndefined();
      expect(process.env.npm_config_update_notifier).toBeUndefined();
    } finally {
      if (originalGlobalBinDir === undefined) {
        delete process.env.npm_config_global_bin_dir;
      } else {
        process.env.npm_config_global_bin_dir = originalGlobalBinDir;
      }
      if (originalCi === undefined) {
        delete process.env.CI;
      } else {
        process.env.CI = originalCi;
      }
      delete process.env.npm_config_update_notifier;
      if (originalPnpmHome === undefined) {
        delete process.env.PNPM_HOME;
      } else {
        process.env.PNPM_HOME = originalPnpmHome;
      }
      vi.resetModules();
    }
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

      expect(failedFs.getPnpmGlobalPath()).toBeNull();
      expect(failedFs.pnpmGlobalRoot).toBe(path.join('/pnpm-home', 'global'));

      // 兜底查找：探测失败时按版本号从高到低推断候选根目录（global/v11、
      // global/10 … global/5），首个命中的是推断出的 global/v11 直接布局。
      const globalRoot = path.join('/pnpm-home', 'global');
      mocks.stat.mockResolvedValueOnce(isDir);

      await expect(failedFs.resolveGlobalPkgDir('tool')).resolves.toBe(
        path.join(globalRoot, 'v11', 'tool'),
      );
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
