import os from 'node:os';
import path from 'node:path';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { getPnpmHome, isBinDirMissingFromPath } from '../src/pnpm.mts';

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

type Layout = typeof import('../src/layout.mts');

const isDir = { isDirectory: () => true, mtimeMs: 0 };
const isFile = { isDirectory: () => false };
const isDirWithMtime = (mtimeMs: number) => ({
  isDirectory: () => true,
  mtimeMs,
});

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
        // 环境变量名来自用例自己的表，删除只能用动态键
        // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
        delete process.env[name];
      } else {
        process.env[name] = value;
      }
    }

    await run();
  } finally {
    for (const [name, value] of saved) {
      if (value === undefined) {
        // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
        delete process.env[name];
      } else {
        process.env[name] = value;
      }
    }
  }
}

/** 用一张「路径 → stat 结果」的表充当文件系统，表外的路径一律不存在 */
function fakeFs(
  tree: Record<string, { isDirectory: () => boolean; mtimeMs?: number }>,
) {
  mocks.stat.mockImplementation(async (dir: string) => {
    const entry = tree[dir];

    if (!entry) {
      throw new Error(`missing: ${dir}`);
    }

    return entry;
  });
}

/**
 * 一个布局根给出的那一层：包落在 `node_modules`（根本身就叫 node_modules 时不再套一层，
 * `pnpm root -g` 给的就是那一层），依赖表默认就在它下面。
 */
const layerOf = (root: string, depot: string | null = null) => {
  const pkgDir =
    path.basename(root) === 'node_modules'
      ? root
      : path.join(root, 'node_modules');

  return { pkgDir, depot };
};

/** 某一层的 `.pnpm/node_modules` */
const nestedOf = (pkgDir: string) => path.join(pkgDir, '.pnpm', 'node_modules');

describe('pnpm home', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('resolves the pnpm home from the environment', async () => {
    await withEnv({ PNPM_HOME: undefined, XDG_DATA_HOME: '/data' }, () => {
      expect(getPnpmHome()).toBe('/data/pnpm');

      // 没有 XDG 约定时退回用户目录，各平台同一条式子
      // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
      delete process.env.XDG_DATA_HOME;
      expect(getPnpmHome()).toBe(
        path.join(os.homedir(), '.local', 'share', 'pnpm'),
      );

      process.env.PNPM_HOME = '/pnpm-home';
      expect(getPnpmHome()).toBe('/pnpm-home');
    });
  });

  it('detects whether the pnpm bin directory is missing from PATH', async () => {
    await withEnv(
      { PNPM_HOME: '/pnpm-home', npm_config_global_bin_dir: undefined },
      () => {
        process.env.PATH = ['/usr/bin', '/pnpm-home/bin'].join(path.delimiter);
        expect(isBinDirMissingFromPath()).toBe(false);

        // PNPM_HOME 本身也在 pnpm 的校验范围内
        process.env.PATH = '/pnpm-home';
        expect(isBinDirMissingFromPath()).toBe(false);

        process.env.PATH = '/usr/bin';
        expect(isBinDirMissingFromPath()).toBe(true);

        // pnpm 传给子进程的变量优先于 PNPM_HOME
        process.env.npm_config_global_bin_dir = '/elsewhere/bin';
        process.env.PATH = '/elsewhere/bin';
        expect(isBinDirMissingFromPath()).toBe(false);

        // 没有 PATH 时按空串处理
        // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
        delete process.env.PATH;
        expect(isBinDirMissingFromPath()).toBe(true);
      },
    );
  });
});

describe('pnpm global layout', () => {
  // 布局按模块实例记忆化，每条用例都要从头问一遍
  let api: Layout;

  /**
   * 隔离加载一份模块。
   *
   * 布局按模块实例记忆化，换一份实例就是从头问一遍；每个用例自己声明一份，
   * vitest 会按依赖图各自去重。
   */
  const load = (): Promise<Layout> => import('../src/layout.mts');

  beforeEach(async () => {
    vi.resetAllMocks();
    vi.resetModules();
    mocks.execSync.mockReturnValue('/global/node_modules\n');
    mocks.execSync.mockClear();
    mocks.stat.mockResolvedValue(isDir);
    mocks.readdir.mockResolvedValue([]);
    api = await load();
  });

  it('queries the global root and passes it to the child process', async () => {
    await withEnv(
      {
        npm_config_global_bin_dir: '/elsewhere/bin',
        PNPM_HOME: '/pnpm-home',
        CI: undefined,
        npm_config_update_notifier: undefined,
        PATH: ['/usr/bin', '/pnpm-home/bin'].join(path.delimiter),
        // pnpm 主目录取 PNPM_HOME，扫版本目录也扫它下面，别落到真实的家目录
        XDG_DATA_HOME: '/pnpm-home-parent',
      },
      async () => {
        mocks.execSync.mockImplementationOnce(
          () => '/pnpm-home/global/v11/node_modules\n',
        );
        // 依赖表得真有东西，且优先 `node_modules` 与 `.pnpm/node_modules` 里先出现的那个；
        // 两处都有时取 `node_modules`（直接依赖那层）
        mocks.readdir.mockImplementation(async (dir: string) =>
          dir.endsWith('.pnpm/node_modules') ? ['dep'] : [],
        );

        const pkgDir = '/pnpm-home/global/v11/node_modules';

        await expect(api.getLayout()).resolves.toEqual({
          layers: [layerOf(pkgDir, nestedOf(pkgDir))],
        });

        const [command, options] = mocks.execSync.mock.calls[0] as [
          string,
          { env: Record<string, string>; stdio: string[] },
        ];

        // stdin 的 'ignore'、关掉版本切换：corepack shim 会等一个永不关闭的管道
        expect(command).toBe(
          'pnpm --config.manage-package-manager-versions=false root -g',
        );
        expect(options.stdio).toEqual(['ignore', 'pipe', 'pipe']);
        // 环境只传给子进程：补上 bin 目录、摘掉 pnpm 传下来的校验值、关掉两个碍事的开关
        // npm_config_global_bin_dir 与它下面的 bin 一起补进 PATH，原有的条目一个不落
        expect(options.env.PATH?.split(path.delimiter)).toEqual([
          '/elsewhere/bin',
          '/elsewhere/bin/bin',
          '/usr/bin',
          '/pnpm-home/bin',
        ]);
        expect(options.env.CI).toBe('true');
        expect(options.env.npm_config_update_notifier).toBe('false');
        expect(options.env.npm_config_global_bin_dir).toBeUndefined();
        // 进程自己的环境必须原样留着，别污染调用方
        expect(process.env.npm_config_global_bin_dir).toBe('/elsewhere/bin');
        expect(process.env.CI).toBeUndefined();
        expect(process.env.npm_config_update_notifier).toBeUndefined();
      },
    );
  });

  it('does not need an inherited PATH to query the global root', async () => {
    await withEnv({ PATH: undefined, PNPM_HOME: undefined }, async () => {
      await api.getLayout();

      expect(mocks.execSync).toHaveBeenCalled();
      // 补出来的 PATH 是给子进程看的，进程自己的环境得原样留着
      expect(process.env.PATH).toBeUndefined();
    });
  });

  it('picks the last absolute line and ignores pnpm warnings', async () => {
    mocks.execSync.mockReturnValue(
      '[WARN] Using --global skips the package manager check for this project\n/pnpm/global/v11/node_modules\n',
    );

    await expect(api.getLayout()).resolves.toMatchObject({
      layers: [layerOf('/pnpm/global/v11/node_modules')],
    });

    // 没有以 / 开头的行就用整段输出兜底
    vi.resetModules();
    mocks.execSync.mockReturnValue('global root unavailable\n');
    const fallback = await load();
    await expect(fallback.getLayout()).resolves.toBeDefined();

    vi.resetModules();
    mocks.execSync.mockReturnValue('');
    const empty = await load();
    await expect(empty.getLayout()).resolves.toEqual({ layers: [] });
  });

  it('asks pnpm only once per process', async () => {
    await api.getLayout();
    await api.getLayout();

    expect(mocks.execSync).toHaveBeenCalledTimes(1);
  });

  it('falls back to scanning the global dir when pnpm cannot be queried', async () => {
    mocks.execSync.mockImplementation(() => {
      throw new Error('pnpm not found');
    });
    mocks.readdir.mockImplementation(async (dir: string) =>
      dir.endsWith(path.join('global', 'v11')) ? [] : [],
    );

    // 查询失败只是一条线索没了，布局还是能靠读盘拼出来
    await expect(api.getLayout()).resolves.toEqual({ layers: [] });
  });

  it('exposes both fixed places of every layout root', async () => {
    // 直接依赖与平铺表各是一处候选，顺序按「直接依赖优先」
    await expect(api.getLayout()).resolves.toMatchObject({
      layers: [layerOf('/global/node_modules')],
    });
  });

  it('scans version dirs newest first and tolerates unreadable ones', async () => {
    const globals = path.join(getPnpmHome(), 'global');

    mocks.execSync.mockReturnValue('');
    mocks.readdir.mockImplementation(async (dir: string) => {
      if (dir === globals) {
        return ['v11', '10'];
      }

      return [];
    });
    mocks.stat.mockReset();
    fakeFs({
      [path.join(globals, 'v11')]: isDirWithMtime(20),
      [path.join(globals, '10')]: isDirWithMtime(10),
    });

    // 目录名跟版本号没有约定（pnpm 10 是 `10`，pnpm 11 换成 `v11`），新到旧靠 mtime
    await expect(api.getLayout()).resolves.toMatchObject({
      layers: [
        layerOf(path.join(globals, 'v11')),
        layerOf(path.join(globals, '10')),
      ],
    });
  });

  it('does not re-expand a version dir the query already pointed at', async () => {
    const globals = path.join(getPnpmHome(), 'global');
    const version = path.join(globals, 'v11');

    mocks.execSync.mockReturnValue(`${path.join(version, 'node_modules')}\n`);
    mocks.readdir.mockImplementation(async (dir: string) =>
      dir === globals ? ['v11'] : [],
    );

    // 查询结果常就是某个版本目录，不能把同一份布局探两遍（层内 `.pnpm/node_modules`
    // 那种子目录也算一层根，所以按 pkgDir 去重）
    const { layers } = await api.getLayout();

    expect(new Set(layers.map(({ pkgDir }) => pkgDir)).size).toBe(
      layers.length,
    );
  });

  it('finds packages inside a content-addressed dir', async () => {
    const globals = path.join(getPnpmHome(), 'global');
    const version = path.join(globals, 'v11');
    const hashed = path.join(version, 'abc123');

    mocks.execSync.mockReturnValue('');
    mocks.readdir.mockImplementation(async (dir: string) => {
      if (dir === globals) {
        return ['v11'];
      }

      return dir === version ? ['abc123'] : [];
    });
    mocks.stat.mockReset();
    fakeFs({
      [version]: isDirWithMtime(1),
      [hashed]: isDirWithMtime(2),
    });

    // pnpm 11 把包放在内容寻址的哈希目录下，比版本目录再深一层；
    // 版本目录本身仍是候选（包装在它自己下面时也在那儿）
    await expect(api.getLayout()).resolves.toMatchObject({
      layers: [layerOf(version), layerOf(hashed)],
    });
  });

  it('ignores version entries that are files', async () => {
    const globals = path.join(getPnpmHome(), 'global');

    mocks.execSync.mockReturnValue('');
    mocks.readdir.mockImplementation(async (dir: string) =>
      dir === globals ? ['v11', 'LICENSE'] : [],
    );
    mocks.stat.mockReset();
    fakeFs({
      [path.join(globals, 'v11')]: isDirWithMtime(1),
      [path.join(globals, 'LICENSE')]: isFile,
    });

    await expect(api.getLayout()).resolves.toEqual({
      layers: [layerOf(path.join(globals, 'v11'))],
    });
  });

  it('skips entries that vanish between readdir and stat', async () => {
    const globals = path.join(getPnpmHome(), 'global');

    mocks.execSync.mockReturnValue('');
    mocks.readdir.mockImplementation(async (dir: string) =>
      dir === globals ? ['v11', 'gone'] : [],
    );
    mocks.stat.mockReset();
    fakeFs({ [path.join(globals, 'v11')]: isDirWithMtime(1) });

    // pnpm 正在切版本时，读到的目录下一瞬就没了：当作不存在，别把整次探测拖垮
    await expect(api.getLayout()).resolves.toMatchObject({
      layers: [layerOf(path.join(globals, 'v11'))],
    });
  });

  it('treats an unreadable global root as empty', async () => {
    mocks.execSync.mockReturnValue('');
    mocks.readdir.mockRejectedValue(new Error('EACCES'));

    await expect(api.getLayout()).resolves.toEqual({ layers: [] });
  });

  it('keeps the pnpm 10 root that pnpm itself reports', async () => {
    mocks.execSync.mockReturnValue('/global/10/node_modules\n');

    await expect(api.getLayout()).resolves.toMatchObject({
      layers: [layerOf('/global/10/node_modules')],
    });
  });

  it('picks the dependency table of the newest layout root', async () => {
    const globals = path.join(getPnpmHome(), 'global');
    const versionDir = path.join(globals, 'v11');
    const newer = path.join(versionDir, 'newer', 'node_modules');
    const older = path.join(versionDir, 'older', 'node_modules');

    mocks.execSync.mockReturnValue('');
    mocks.readdir.mockImplementation(async (dir: string) => {
      if (dir === globals) {
        return ['v11'];
      }

      if (dir === versionDir) {
        return ['older', 'newer'];
      }

      return dir.endsWith('.pnpm/node_modules') ? ['dep'] : [];
    });
    const tree = {
      // 版本目录自身的 node_modules 在这里不存在，只有哈希目录下面那层有依赖表
      [newer]: isDir,
      [older]: isDir,
      [versionDir]: isDirWithMtime(1),
      [path.dirname(newer)]: isDirWithMtime(20),
      [path.dirname(older)]: isDirWithMtime(10),
      [path.join(newer, '.pnpm', 'node_modules')]: isDir,
      [path.join(older, '.pnpm', 'node_modules')]: isDir,
    };

    // 前面那些用例改动过 stat 的行为，这里得整份换掉
    mocks.stat.mockReset();
    fakeFs(tree);

    // 每装一次都可能多一张表：各层各带各的表，新到旧地排着，谁先谁后由 mtime 决定。
    // 不能全进程只挑一张——拿别的层的表去补这层的包，「缺哪些」永远算不对
    const { layers } = await api.getLayout();

    expect(layers).toEqual(
      expect.arrayContaining([
        { pkgDir: newer, depot: path.join(newer, '.pnpm', 'node_modules') },
        { pkgDir: older, depot: path.join(older, '.pnpm', 'node_modules') },
      ]),
    );
    // 新的排在前面
    expect(layers.map(({ pkgDir }) => pkgDir).indexOf(newer)).toBeLessThan(
      layers.map(({ pkgDir }) => pkgDir).indexOf(older),
    );
  });

  it('skips a dependency table that exists but holds nothing', async () => {
    // pnpm 12 把依赖 public hoist 到全局安装根自己的 node_modules 顶层，
    // 同时留下一个空的 `.pnpm/node_modules`：只认「目录在不在」会挑中空壳
    const globals = path.join(getPnpmHome(), 'global');

    mocks.execSync.mockReturnValue('');
    mocks.readdir.mockImplementation(async (dir: string) =>
      dir === globals ? ['v11'] : [],
    );
    mocks.stat.mockResolvedValue(isDir);

    // 全是空表：宁可没有，也别拿空壳去算「缺哪些依赖」
    await expect(api.getLayout()).resolves.toEqual({
      layers: [layerOf(path.join(globals, 'v11'))],
    });
  });

  it('returns no dependency table when none of the roots has one', async () => {
    mocks.stat.mockRejectedValue(new Error('missing'));

    await expect(api.getLayout()).resolves.toEqual({
      layers: [layerOf('/global/node_modules')],
    });
  });
});
