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

// 布局根与查询结果都按模块实例记忆化，布局相关的用例各取一份隔离实例
const {
  getPnpmGlobalPath,
  getPnpmHome,
  isPnpmBinDirMissingFromPath,
  pnpmGlobalRoot,
  toPkgName,
} = await import('../src/pnpm.mts');

const GLOBAL_NODE_MODULES = '/global/node_modules';
const isDir = { isDirectory: () => true };
const isDirWithMtime = (mtimeMs: number) => ({
  isDirectory: () => true,
  mtimeMs,
});

/**
 * 隔离加载一份模块。
 *
 * 查询结果与布局根都按模块实例记忆化，换一份实例就是从头问一遍；
 * 每个用例自己声明一份，vitest 会按依赖图各自去重。
 */
const load = () => import('../src/pnpm.mts');

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
  // 查询结果与布局根都按模块实例记忆化，每条用例都要从头问一遍
  let api: typeof import('../src/pnpm.mts');

  beforeEach(async () => {
    // 记忆化按模块实例走，每个用例都从一份干净的实例开始
    vi.resetModules();
    vi.resetAllMocks();
    mocks.execSync.mockReturnValue('/global/node_modules\n');
    mocks.stat.mockResolvedValue(isDir);
    mocks.readdir.mockResolvedValue([]);
    api = await load();
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

        removeEnv('LOCALAPPDATA');
        expect(getPnpmHome('win32')).toBe(
          path.join(os.homedir(), 'AppData', 'Local', 'pnpm'),
        );

        expect(getPnpmHome('linux')).toBe('/data/pnpm');
        expect(getPnpmHome('darwin')).toBe(
          path.join(os.homedir(), 'Library', 'pnpm'),
        );

        removeEnv('XDG_DATA_HOME');
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
            // stdin 必须是 'ignore'（/dev/null）：继承（或给 pipe）时 corepack shim
            // 会一直等一个永不关闭的管道，`sleep 30 | bin-linker` 就是这么卡住的
            expect((options as { stdio?: unknown }).stdio).toEqual([
              'ignore',
              'pipe',
              'pipe',
            ]);
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

  it('does not need an inherited PATH to query the global root', async () => {
    await withEnv({ PATH: undefined, PNPM_HOME: undefined }, async () => {
      expect(api.getPnpmGlobalPath()).toBe('/global/node_modules');
      // 补出来的 PATH 是给子进程看的，进程自己的环境得原样留着
      expect(process.env.PATH).toBeUndefined();
    });
  });

  it('picks the last absolute line and ignores pnpm warnings', async () => {
    mocks.execSync.mockReturnValue(
      '[WARN] Using --global skips the package manager check for this project\n/pnpm/global/v11/node_modules\n',
    );

    expect(api.getPnpmGlobalPath()).toBe('/pnpm/global/v11/node_modules');

    // 没有以 / 开头的行就用整段输出兜底
    vi.resetModules();
    mocks.execSync.mockReturnValue('global root unavailable\n');
    const fallback = await load();
    expect(fallback.getPnpmGlobalPath()).toBe('global root unavailable');

    vi.resetModules();
    mocks.execSync.mockReturnValue('');
    const empty = await load();
    expect(empty.getPnpmGlobalPath()).toBe('');
  });

  it('returns null when pnpm cannot be queried', async () => {
    mocks.execSync.mockImplementation(() => {
      throw new Error('pnpm not found');
    });

    expect(api.getPnpmGlobalPath()).toBeNull();
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
        removeEnv('PATH');
        expect(isPnpmBinDirMissingFromPath()).toBe(true);
      },
    );
  });

  it('looks for the package in both places of every layout root', async () => {
    // `pnpm root -g` 给的就是 node_modules 那一层：直接依赖的位置先命中
    await expect(api.resolveGlobalPkgDirs('tool')).resolves.toEqual([
      path.join(GLOBAL_NODE_MODULES, 'tool'),
    ]);

    // 每层只看两处固定位置：直接依赖与平铺表，都不扫目录
    expect(mocks.stat).toHaveBeenNthCalledWith(
      1,
      path.join(GLOBAL_NODE_MODULES, 'tool'),
    );
    // 版本根只在布局那一步读一次，后面的解析不再读任何目录
    expect(mocks.readdir).toHaveBeenCalledTimes(1);
    expect(mocks.readdir).toHaveBeenCalledWith(pnpmGlobalRoot);
  });

  it('finds hoisted indirect dependencies in the flattened table', async () => {
    // 间接依赖常常只出现在 <层>/node_modules/.pnpm/node_modules 这一层
    const hoisted = path.join(
      GLOBAL_NODE_MODULES,
      '.pnpm',
      'node_modules',
      'tool',
    );

    mocks.stat.mockImplementation(async (dir: string) => {
      if (dir === hoisted) {
        return isDir;
      }

      throw new Error('missing');
    });

    await expect(api.resolveGlobalPkgDirs('tool')).resolves.toEqual([hoisted]);
  });

  it('scans version dirs newest first and tolerates unreadable ones', async () => {
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
    const layerOrder = ['zeta', 'alpha'].map((name) =>
      searched.indexOf(path.join(versionDir(name), 'node_modules', 'tool')),
    );

    // 最近改动的先查
    expect(layerOrder[0]).toBeLessThan(layerOrder[1] as number);
  });

  it('does not re-expand a version dir the query already pointed at', async () => {
    const versionDir = path.join(pnpmGlobalRoot, 'v11');

    mocks.execSync.mockReturnValue(`${versionDir}\n`);
    mocks.readdir.mockImplementation(async (dir: string) =>
      dir === pnpmGlobalRoot ? ['v11'] : [],
    );

    await expect(api.resolveGlobalPkgDirs('tool')).resolves.toEqual([
      path.join(versionDir, 'node_modules', 'tool'),
    ]);

    const searched = mocks.stat.mock.calls.map(([dir]) => String(dir));

    // 查询结果与扫版本目录得到的是同一个，只探一遍
    expect(searched.filter((dir) => dir === versionDir)).toHaveLength(1);
    expect(searched).toContain(path.join(versionDir, 'node_modules', 'tool'));
  });

  it('finds the package inside a content-addressed dir', async () => {
    // pnpm 11：版本根下是哈希目录，包在 <hash>/node_modules/<pkg>
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

  it('treats an unreadable global root as empty', async () => {
    mocks.execSync.mockReturnValue('');
    mocks.stat.mockRejectedValue(new Error('missing'));
    mocks.readdir.mockRejectedValue(new Error('permission denied'));

    await expect(api.resolveGlobalPkgDirs('ghost')).resolves.toEqual([]);
    expect(mocks.readdir).toHaveBeenCalledWith(pnpmGlobalRoot);
  });

  it('keeps the pnpm 10 root that pnpm itself reports', async () => {
    // `pnpm root -g` 直接给到 <版本目录>/node_modules：别再套一层 node_modules
    mocks.execSync.mockReturnValue('/global/10/node_modules\n');
    mocks.readdir.mockResolvedValue([]);
    mocks.stat.mockImplementation(async (dir: string) => {
      if (dir === path.join('/global/10/node_modules', 'tool')) {
        return isDir;
      }

      throw new Error('missing');
    });

    await expect(api.resolveGlobalPkgDirs('tool')).resolves.toEqual([
      path.join('/global/10/node_modules', 'tool'),
    ]);
  });

  it('normalizes package names that carry a path', () => {
    // `$(pwd)/node_modules/cowsay`、`./node_modules/@scope/pkg` 都得还原成包名，
    // node_modules 的位置是按包名拼的
    expect(toPkgName('cowsay')).toBe('cowsay');
    expect(toPkgName('./node_modules/cowsay')).toBe('cowsay');
    expect(toPkgName('/a/b/node_modules/@scope/pkg')).toBe('@scope/pkg');
    expect(toPkgName('@scope/pkg')).toBe('@scope/pkg');
    // 只剩 scope 一段（用户手抖）时别丢成空串
    expect(toPkgName('@scope')).toBe('@scope');
    // 空串这种退化输入别抛，原样回去，交给「找不到包」报
    expect(toPkgName('')).toBe('');
  });

  it('finds the dependency table through the same layout roots', async () => {
    const versionDir = path.join(pnpmGlobalRoot, 'v11');
    const depot = path.join(
      versionDir,
      'hash123',
      'node_modules',
      '.pnpm',
      'node_modules',
    );

    mocks.execSync.mockReturnValue('');
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

    await expect(api.resolveGlobalDepotDir()).resolves.toBe(depot);
  });

  it('prefers the dependency table of the newest layout root', async () => {
    const versionDir = path.join(pnpmGlobalRoot, 'v11');
    const newer = path.join(versionDir, 'newer', 'node_modules', '.pnpm');
    const older = path.join(versionDir, 'older', 'node_modules', '.pnpm');

    mocks.execSync.mockReturnValue('');
    mocks.readdir.mockImplementation(async (dir: string) =>
      dir === pnpmGlobalRoot ? ['v11'] : ['older', 'newer'],
    );
    mocks.stat.mockImplementation(async (dir: string) => {
      // 版本目录自身的 node_modules 在这里不存在，只有哈希目录下面那层有依赖表
      if (
        [
          path.join(newer, 'node_modules'),
          path.join(older, 'node_modules'),
        ].includes(dir)
      ) {
        return isDir;
      }

      if (dir === versionDir) {
        return isDirWithMtime(1);
      }

      if (dir === path.join(versionDir, 'newer')) {
        return isDirWithMtime(20);
      }

      if (dir === path.join(versionDir, 'older')) {
        return isDirWithMtime(10);
      }

      throw new Error('missing');
    });

    // 每装一次都可能多一张表，新到旧地排着，谁先谁后由 mtime 决定
    await expect(api.resolveGlobalDepotDir()).resolves.toBe(
      path.join(newer, 'node_modules'),
    );
  });

  it('returns null when no layout root exposes a dependency table', async () => {
    mocks.stat.mockRejectedValue(new Error('missing'));

    await expect(api.resolveGlobalDepotDir()).resolves.toBeNull();
  });
});
