import os from 'node:os';
import path from 'node:path';

import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  execSync: vi.fn(
    (_command?: string, _options?: unknown) => '/global/node_modules\n',
  ),
  readdir: vi.fn(),
  stat: vi.fn(),
}));

vi.mock('node:child_process', () => ({ execSync: mocks.execSync }));
vi.mock('node:fs', () => ({
  promises: { readdir: mocks.readdir, stat: mocks.stat },
}));

const {
  getPnpmGlobalPath,
  getPnpmHome,
  isPnpmBinDirMissingFromPath,
  pnpmGlobalRoot,
  normalizePkgName,
  resolveGlobalDepotDir,
  resolveGlobalPkgDirs,
} = await import('../src/pnpm.mts');

const GLOBAL_NODE_MODULES = '/global/node_modules';
const isDir = { isDirectory: () => true };
const isDirWithMtime = (mtimeMs: number) => ({
  isDirectory: () => true,
  mtimeMs,
});

/** 隔离加载一份模块：全局根目录是模块级常量，跟着加载时的 PNPM_HOME 走 */
async function load(query: string) {
  vi.resetModules();

  const specifier = `../src/pnpm.mts?${query}`;

  return import(specifier);
}

/** 环境变量名来自用例自己的表，删除只能用动态键 */
// eslint-disable-next-line @typescript-eslint/no-dynamic-delete
const removeEnv = (name: string) => delete process.env[name];

/** 借一个用例体改环境变量，结束后归还 */
async function withEnv(
  vars: Record<string, string | undefined>,
  run: () => Promise<void> | void,
) {
  const saved = Object.keys(vars).map(
    (name) => [name, process.env[name]] as const,
  );

  try {
    for (const [name, value] of Object.entries(vars)) {
      if (value === undefined) {
        removeEnv(name);
      } else {
        process.env[name] = value;
      }
    }

    await run();
  } finally {
    for (const [name, value] of saved) {
      if (value === undefined) {
        removeEnv(name);
      } else {
        process.env[name] = value;
      }
    }
  }
}

describe('pnpm global layout', () => {
  // 查询结果、版本目录清单、布局根、依赖表都按模块实例记忆化，每条用例都要从头问一遍
  let api = { resolveGlobalPkgDirs, resolveGlobalDepotDir };

  beforeEach(async () => {
    vi.resetAllMocks();
    mocks.execSync.mockReturnValue('/global/node_modules\n');
    mocks.stat.mockResolvedValue(isDir);
    mocks.readdir.mockResolvedValue([]);
    api = await load('fresh');
  });

  it('resolves pnpm home defaults per platform', async () => {
    await withEnv(
      {
        PNPM_HOME: undefined,
        XDG_DATA_HOME: '/data',
        LOCALAPPDATA: '/local-app-data',
      },
      () => {
        expect(getPnpmHome('win32')).toBe(path.join('/local-app-data', 'pnpm'));

        delete process.env.LOCALAPPDATA;
        expect(getPnpmHome('win32')).toBe(
          path.join(os.homedir(), 'AppData', 'Local', 'pnpm'),
        );

        expect(getPnpmHome('linux')).toBe('/data/pnpm');
        expect(getPnpmHome('darwin')).toBe(
          path.join(os.homedir(), 'Library', 'pnpm'),
        );

        delete process.env.XDG_DATA_HOME;
        expect(getPnpmHome('linux')).toBe(
          path.join(os.homedir(), '.local', 'share', 'pnpm'),
        );

        process.env.PNPM_HOME = '/pnpm-home';
        expect(getPnpmHome('linux')).toBe('/pnpm-home');
      },
    );
  });

  it('queries the global root with a patched environment and restores it', async () => {
    await withEnv(
      {
        npm_config_global_bin_dir: '/elsewhere/bin',
        PNPM_HOME: '/pnpm-home',
        CI: undefined,
        npm_config_update_notifier: undefined,
        PATH: ['/usr/bin', '/pnpm-home/bin'].join(path.delimiter),
      },
      () => {
        mocks.execSync.mockImplementationOnce(
          (command = '', options: unknown) => {
            // pnpm 传给子进程的 npm_config_global_bin_dir 会盖掉补进 PATH 的目录，必须摘掉
            expect(process.env.npm_config_global_bin_dir).toBeUndefined();
            // corepack 只在 CI 置位时才不弹「是否下载」
            expect(process.env.CI).toBe('true');
            // 更新检查是背景网络请求，断网时能把一次查询拖成分钟级
            expect(process.env.npm_config_update_notifier).toBe('false');
            // 继承永不关闭的 stdin 时，corepack shim 会一直等到它 end
            expect((options as { stdio?: string }).stdio).toBe('pipe');
            // pnpm 11 起会按 packageManager 声明重启成另一个版本，查询时关掉
            expect(command).toBe(
              'pnpm --config.manage-package-manager-versions=false root -g',
            );
            expect(process.env.PATH?.split(path.delimiter).slice(0, 2)).toEqual(
              ['/pnpm-home', '/pnpm-home/bin'],
            );

            return '/pnpm-home/global/v11/node_modules\n';
          },
        );

        expect(getPnpmGlobalPath()).toBe('/pnpm-home/global/v11/node_modules');
        // 查询时改过的环境必须原样还回去，别污染调用方
        expect(process.env.npm_config_global_bin_dir).toBe('/elsewhere/bin');
        expect(process.env.CI).toBeUndefined();
        expect(process.env.npm_config_update_notifier).toBeUndefined();
      },
    );
  });

  it('keeps the pinned path entries unique when no PATH is inherited', async () => {
    await withEnv({ PATH: undefined, PNPM_HOME: undefined }, async () => {
      const isolated = await load('no-path');
      expect(isolated.getPnpmGlobalPath()).toBe('/global/node_modules');
      expect(process.env.PATH).toBeUndefined();
    });
  });

  it('picks the last absolute line and ignores pnpm warnings', async () => {
    mocks.execSync.mockReturnValue(
      '[WARN] Using --global skips the package manager check for this project\n/pnpm/global/v11/node_modules\n',
    );

    const warned = await load('warned');
    expect(warned.getPnpmGlobalPath()).toBe('/pnpm/global/v11/node_modules');

    mocks.execSync.mockReturnValue('global root unavailable\n');
    const fallback = await load('root-fallback');
    expect(fallback.getPnpmGlobalPath()).toBe('global root unavailable');

    mocks.execSync.mockReturnValue('');
    const empty = await load('root-empty');
    expect(empty.getPnpmGlobalPath()).toBe('');
  });

  it('returns null when pnpm cannot be queried', async () => {
    mocks.execSync.mockImplementation(() => {
      throw new Error('pnpm not found');
    });

    const isolated = await load('query-failed');
    expect(isolated.getPnpmGlobalPath()).toBeNull();

    // 探测失败时回退到遍历 <pnpmHome>/global 下的版本目录
    await withEnv({ PNPM_HOME: '/pnpm-home' }, async () => {
      const fallback = await load('query-failed-fallback');
      const expected = path.join(
        '/pnpm-home',
        'global',
        'v11',
        'node_modules',
        'tool',
      );

      mocks.readdir.mockImplementation(async (dir: string) =>
        dir === path.join('/pnpm-home', 'global') ? ['v11'] : [],
      );
      mocks.stat.mockImplementation(async (dir: string) => {
        if (dir === expected) {
          return isDir;
        }

        if (dir === path.join('/pnpm-home', 'global', 'v11')) {
          return isDirWithMtime(1);
        }

        throw new Error('missing');
      });

      await expect(fallback.resolveGlobalPkgDirs('tool')).resolves.toEqual([
        expected,
      ]);
    });
  });

  it('detects whether the pnpm bin directory is missing from PATH', async () => {
    await withEnv(
      { PNPM_HOME: '/pnpm-home', npm_config_global_bin_dir: undefined },
      () => {
        process.env.PATH = ['/usr/bin', '/pnpm-home/bin'].join(path.delimiter);
        expect(isPnpmBinDirMissingFromPath()).toBe(false);

        // PNPM_HOME 本身也在 pnpm 的校验范围内
        process.env.PATH = '/pnpm-home';
        expect(isPnpmBinDirMissingFromPath()).toBe(false);

        process.env.PATH = '/usr/bin';
        expect(isPnpmBinDirMissingFromPath()).toBe(true);

        // pnpm 传给子进程的变量优先于 PNPM_HOME
        process.env.npm_config_global_bin_dir = '/elsewhere/bin';
        process.env.PATH = '/elsewhere/bin';
        expect(isPnpmBinDirMissingFromPath()).toBe(false);

        // 没有 PATH 时按空串处理
        delete process.env.PATH;
        expect(isPnpmBinDirMissingFromPath()).toBe(true);
      },
    );
  });

  it('resolves packages in every pnpm global layout', async () => {
    await withEnv({ PNPM_HOME: '/pnpm-home' }, async () => {
      const isolated = await load('layouts');
      const root = path.join('/pnpm-home', 'global');
      const globalModules = '/global/node_modules';

      mocks.execSync.mockReturnValue(`${globalModules}\n`);
      mocks.readdir.mockClear();

      await expect(isolated.resolveGlobalPkgDirs('tool')).resolves.toEqual([
        path.join(globalModules, 'tool'),
      ]);
      // 直接布局命中就不必遍历虚拟目录
      expect(
        mocks.readdir.mock.calls.every(([dir]) => dir !== globalModules),
      ).toBe(true);

      mocks.execSync.mockReturnValue('');
      // 布局根也是记忆化的：换一份实例，重新按新的全局布局来
      const pnpm10 = await load('layouts-pnpm10');
      mocks.readdir.mockImplementation(async (dir: string) =>
        dir === root ? ['5'] : [],
      );
      mocks.stat.mockImplementation(async (dir: string) => {
        if (dir === path.join(root, '5', 'node_modules', 'tool')) {
          return isDir;
        }

        if (dir === path.join(root, '5')) {
          return isDirWithMtime(1);
        }

        throw new Error('missing');
      });
      await expect(pnpm10.resolveGlobalPkgDirs('tool')).resolves.toEqual([
        path.join(root, '5', 'node_modules', 'tool'),
      ]);

      mocks.execSync.mockReturnValue(`${globalModules}\n`);
      const pnpm11 = await load('layouts-pnpm11');
      mocks.readdir.mockResolvedValue(['a1b2c3d4e5f6']);
      mocks.stat.mockImplementation(async (dir: string) => {
        if (
          dir ===
          path.join(globalModules, 'a1b2c3d4e5f6', 'node_modules', 'tool')
        ) {
          return isDir;
        }

        // 版本目录与里面的哈希目录都要能被认成目录，才会被逐层展开
        if (dir === globalModules) {
          return isDirWithMtime(1);
        }

        if (dir === path.join(globalModules, 'a1b2c3d4e5f6')) {
          return isDirWithMtime(1);
        }

        throw new Error('missing');
      });
      await expect(pnpm11.resolveGlobalPkgDirs('tool')).resolves.toEqual([
        path.join(globalModules, 'a1b2c3d4e5f6', 'node_modules', 'tool'),
      ]);
    });
  });

  it('ignores version entries that are files', async () => {
    // 全局根目录下混着文件（如 .modules.yaml），它们不是版本目录，不参与查找
    mocks.execSync.mockReturnValue('');
    mocks.readdir.mockImplementation(async (dir: string) =>
      dir === pnpmGlobalRoot ? ['manifest.json', 'v11'] : [],
    );
    mocks.stat.mockImplementation(async (dir: string) => {
      if (dir === path.join(pnpmGlobalRoot, 'manifest.json')) {
        return { isDirectory: () => false };
      }

      if (dir === path.join(pnpmGlobalRoot, 'v11')) {
        return isDirWithMtime(1);
      }

      throw new Error('missing');
    });

    await expect(api.resolveGlobalPkgDirs('tool')).resolves.toEqual([]);
  });

  it('normalizes package names that carry a path', async () => {
    // `$(pwd)/node_modules/cowsay`、`./node_modules/@scope/pkg` 都得还原成包名，
    // node_modules 的位置是按包名拼的
    expect(normalizePkgName('cowsay')).toBe('cowsay');
    expect(normalizePkgName('./node_modules/cowsay')).toBe('cowsay');
    expect(normalizePkgName('/a/b/node_modules/@scope/pkg')).toBe('@scope/pkg');
    expect(normalizePkgName('@scope/pkg')).toBe('@scope/pkg');
    // 只剩 scope 一段（用户手抖）时别丢成空串
    expect(normalizePkgName('@scope')).toBe('@scope');
    // 空串这种退化输入别抛，原样回去，交给「找不到包」报
    expect(normalizePkgName('')).toBe('');
  });

  it('keeps the pnpm 10 root layout lookup cheap', async () => {
    // pnpm 10：包直接位于全局根目录下，不必遍历虚拟目录
    await expect(api.resolveGlobalPkgDirs('tool')).resolves.toEqual([
      path.join(GLOBAL_NODE_MODULES, 'tool'),
    ]);
    // 只有扫版本目录那一步会读目录，虚拟目录不必再读
    expect(
      mocks.readdir.mock.calls.every(([dir]) => dir !== GLOBAL_NODE_MODULES),
    ).toBe(true);
  });

  it('searches version dirs newest first and tolerates unreadable ones', async () => {
    const versionDir = (name: string) => path.join(pnpmGlobalRoot, name);
    const expected = path.join(versionDir('alpha'), 'node_modules', 'tool');

    mocks.execSync.mockReturnValue('');
    mocks.readdir.mockImplementation(async (dir: string) =>
      dir === pnpmGlobalRoot ? ['zeta', 'alpha', 'broken'] : [],
    );
    mocks.stat.mockImplementation(async (dir: string) => {
      if (dir === expected) {
        return isDir;
      }

      if (dir === versionDir('zeta')) {
        return isDirWithMtime(300);
      }

      if (dir === versionDir('alpha')) {
        return isDirWithMtime(200);
      }

      throw new Error('vanished');
    });

    await expect(api.resolveGlobalPkgDirs('tool')).resolves.toEqual([expected]);

    const searched = mocks.stat.mock.calls.map(([dir]) => String(dir));
    const firstSeen = (name: string) =>
      searched.findIndex((dir) => dir.startsWith(versionDir(name)));

    // 最近改动的先查；读不到 mtime 的排最后
    expect(firstSeen('zeta')).toBeLessThan(firstSeen('alpha'));
    expect(firstSeen('alpha')).toBeLessThan(firstSeen('broken'));
  });

  it('does not re-scan version dirs already covered by the candidates', async () => {
    const versionDir = path.join(pnpmGlobalRoot, 'v11');
    const searched: string[] = [];

    mocks.execSync.mockReturnValue(`${versionDir}\n`);
    mocks.readdir.mockImplementation(async (dir: string) =>
      dir === pnpmGlobalRoot ? ['v11'] : [],
    );
    mocks.stat.mockImplementation(async (dir: string) => {
      searched.push(dir);

      if (dir === versionDir) {
        return isDirWithMtime(1);
      }

      throw new Error('missing');
    });

    await expect(api.resolveGlobalPkgDirs('tool')).resolves.toEqual([]);
    // 探测到的布局根与扫版本目录得到的同一个，只探一遍
    expect(searched.filter((dir) => dir === versionDir)).toHaveLength(1);
    expect(searched).toContain(path.join(versionDir, 'node_modules', 'tool'));
  });

  it('finds the package inside a content-addressed dir', async () => {
    // 包只在哈希目录里（pnpm 11）：先按 mtime 排好哈希目录，再逐个看两处固定位置
    const versionDir = path.join(pnpmGlobalRoot, 'v11');
    const expected = path.join(versionDir, 'hash123', 'node_modules', 'tool');

    mocks.execSync.mockReturnValue('');
    mocks.readdir.mockImplementation(async (dir: string) =>
      dir === pnpmGlobalRoot ? ['v11'] : ['hash123'],
    );
    mocks.stat.mockImplementation(async (dir: string) => {
      if (dir === versionDir || dir === path.join(versionDir, 'hash123')) {
        return isDirWithMtime(1);
      }

      if (dir === expected) {
        return isDir;
      }

      throw new Error('missing');
    });

    await expect(api.resolveGlobalPkgDirs('tool')).resolves.toEqual([expected]);
  });

  it('stops at a layout root that has node_modules but not the package', async () => {
    // 版本目录下已经有 node_modules（pnpm 10 布局），包不在里面就是不在这一层，
    // 不必再展开它的子目录
    const versionDir = path.join(pnpmGlobalRoot, 'v11');
    const readDirs: string[] = [];

    mocks.execSync.mockReturnValue('');
    mocks.readdir.mockImplementation(async (dir: string) => {
      readDirs.push(dir);

      return dir === pnpmGlobalRoot ? ['v11'] : ['node_modules', 'hash123'];
    });
    mocks.stat.mockImplementation(async (dir: string) => {
      if (dir === versionDir) {
        return isDirWithMtime(1);
      }

      // 版本目录下混着文件（.modules.yaml 之类），文件不参与查找
      if (dir === path.join(versionDir, 'node_modules')) {
        return { isDirectory: () => false };
      }

      throw new Error('missing');
    });

    await expect(api.resolveGlobalPkgDirs('tool')).resolves.toEqual([]);
    expect(readDirs).not.toContain(path.join(versionDir, 'hash123'));
  });

  it('treats an unreadable global root as empty', async () => {
    mocks.execSync.mockReturnValue('');
    mocks.stat.mockRejectedValue(new Error('missing'));
    mocks.readdir.mockRejectedValue(new Error('permission denied'));

    await expect(api.resolveGlobalPkgDirs('ghost')).resolves.toEqual([]);
    expect(mocks.readdir).toHaveBeenCalledWith(pnpmGlobalRoot);
  });

  it('finds the dependency table under a content-addressed version dir', async () => {
    const versionDir = path.join(pnpmGlobalRoot, 'v11');
    const depot = path.join(
      versionDir,
      'hash123',
      'node_modules',
      '.pnpm',
      'node_modules',
    );

    mocks.readdir.mockImplementation(async (dir: string) => {
      if (dir === pnpmGlobalRoot) {
        return ['v11'];
      }

      return dir === versionDir ? ['hash123'] : [];
    });
    mocks.stat.mockImplementation(async (dir: string) => {
      if (dir === depot) {
        return isDir;
      }

      if (dir === versionDir || dir === path.join(versionDir, 'hash123')) {
        return isDirWithMtime(1);
      }

      throw new Error('missing');
    });

    const isolated = await load('depot-nested');

    await expect(isolated.resolveGlobalDepotDir()).resolves.toBe(depot);
  });

  it('returns null when no version dir exposes a dependency table', async () => {
    mocks.stat.mockRejectedValue(new Error('missing'));

    await expect(api.resolveGlobalDepotDir()).resolves.toBeNull();
  });
});
