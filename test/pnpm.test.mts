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

type Pnpm = typeof import('../src/pnpm.mts');

const { getPnpmHome, toPkgName } = await import('../src/pnpm.mts');

const { PNPM_HOME } = process.env;

const isDir = { isDirectory: () => true };
const isFile = { isDirectory: () => false };
const isDirWithMtime = (mtimeMs: number) => ({
  isDirectory: () => true,
  mtimeMs,
});

/**
 * 隔离加载一份模块。
 *
 * 布局按模块实例记忆化，换一份实例就是从头问一遍；每个用例自己声明一份，
 * vitest 会按依赖图各自去重。
 */
const load = (): Promise<Pnpm> => import('../src/pnpm.mts');

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
 * 一个布局根下包的候选位置：`node_modules` 与 `.pnpm/node_modules`。
 * 根本身就叫 node_modules 时不再套一层（`pnpm root -g` 给的就是那一层）。
 */
const candidatesOf = (root: string) => {
  const nodeModules =
    path.basename(root) === 'node_modules'
      ? root
      : path.join(root, 'node_modules');

  return [nodeModules, path.join(nodeModules, '.pnpm', 'node_modules')];
};

describe('pnpm global layout', () => {
  // 布局按模块实例记忆化，每条用例都要从头问一遍
  let api: Pnpm;

  beforeEach(async () => {
    vi.resetAllMocks();
    // 布局按模块实例记忆化，模块又是共享的缓存，每条用例都得丢掉上一份
    vi.resetModules();
    mocks.execSync.mockReturnValue('/global/node_modules\n');
    mocks.execSync.mockClear();
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

        // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
        delete process.env.LOCALAPPDATA;
        expect(getPnpmHome('win32')).toBe(
          path.join(os.homedir(), 'AppData', 'Local', 'pnpm'),
        );

        expect(getPnpmHome('linux')).toBe('/data/pnpm');
        expect(getPnpmHome('darwin')).toBe(
          path.join(os.homedir(), 'Library', 'pnpm'),
        );

        // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
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
        // pnpm 主目录取 PNPM_HOME，扫版本目录也扫它下面，别落到真实的家目录
        XDG_DATA_HOME: '/pnpm-home-parent',
      },
      async () => {
        mocks.execSync.mockImplementationOnce(
          () => '/pnpm-home/global/v11/node_modules\n',
        );

        await expect(api.getLayout()).resolves.toEqual({
          candidates: candidatesOf('/pnpm-home/global/v11/node_modules'),
          depot: path.join(
            '/pnpm-home/global/v11/node_modules',
            '.pnpm',
            'node_modules',
          ),
        });
        // 查询相关的开关只在子进程那一下有效：stdin 的 'ignore'、关掉版本切换
        expect(mocks.execSync).toHaveBeenCalledWith(
          'pnpm --config.manage-package-manager-versions=false root -g',
          { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
        );
        // 查询时改过的环境必须原样还回去，别污染调用方
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
      candidates: candidatesOf('/pnpm/global/v11/node_modules'),
    });

    // 没有以 / 开头的行就用整段输出兜底
    vi.resetModules();
    mocks.execSync.mockReturnValue('global root unavailable\n');
    const fallback = await load();
    await expect(fallback.getLayout()).resolves.toBeDefined();

    vi.resetModules();
    mocks.execSync.mockReturnValue('');
    const empty = await load();
    await expect(empty.getLayout()).resolves.toEqual({
      candidates: [],
      depot: null,
    });
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
    await expect(api.getLayout()).resolves.toEqual({
      candidates: [],
      depot: null,
    });
  });

  it('detects whether the pnpm bin directory is missing from PATH', async () => {
    await withEnv(
      { PNPM_HOME: '/pnpm-home', npm_config_global_bin_dir: undefined },
      () => {
        process.env.PATH = ['/usr/bin', '/pnpm-home/bin'].join(path.delimiter);
        expect(api.isBinDirMissingFromPath()).toBe(false);

        // PNPM_HOME 本身也在 pnpm 的校验范围内
        process.env.PATH = '/pnpm-home';
        expect(api.isBinDirMissingFromPath()).toBe(false);

        process.env.PATH = '/usr/bin';
        expect(api.isBinDirMissingFromPath()).toBe(true);

        // pnpm 传给子进程的变量优先于 PNPM_HOME
        process.env.npm_config_global_bin_dir = '/elsewhere/bin';
        process.env.PATH = '/elsewhere/bin';
        expect(api.isBinDirMissingFromPath()).toBe(false);

        // 没有 PATH 时按空串处理
        // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
        delete process.env.PATH;
        expect(api.isBinDirMissingFromPath()).toBe(true);
      },
    );
  });

  it('exposes both fixed places of every layout root', async () => {
    // 直接依赖与平铺表各是一处候选，顺序按「直接依赖优先」
    await expect(api.getLayout()).resolves.toEqual({
      candidates: candidatesOf('/global/node_modules'),
      depot: path.join('/global', 'node_modules', '.pnpm', 'node_modules'),
    });
  });

  it('scans version dirs newest first and tolerates unreadable ones', async () => {
    const globals = path.join(getPnpmHome(), 'global');
    const versionDir = (name: string) => path.join(globals, name);

    mocks.execSync.mockReturnValue('');
    mocks.readdir.mockImplementation(async (dir: string) =>
      dir === globals ? ['zeta', 'alpha', 'broken'] : [],
    );
    fakeFs({
      [versionDir('zeta')]: isDirWithMtime(300),
      [versionDir('alpha')]: isDirWithMtime(200),
    });

    await expect(api.getLayout()).resolves.toMatchObject({
      candidates: [
        ...candidatesOf(versionDir('zeta')),
        ...candidatesOf(versionDir('alpha')),
      ],
    });
  });

  it('does not re-expand a version dir the query already pointed at', async () => {
    const globals = path.join(getPnpmHome(), 'global');
    const versionDir = path.join(globals, 'v11');
    const tree = {
      [versionDir]: isDirWithMtime(1),
      [path.join(versionDir, 'hash123')]: isDirWithMtime(2),
    };

    mocks.execSync.mockReturnValue(`${versionDir}\n`);
    mocks.readdir.mockImplementation(async (dir: string) =>
      dir === globals ? ['v11'] : ['hash123'],
    );
    mocks.stat.mockReset();
    fakeFs(tree);

    await expect(api.getLayout()).resolves.toMatchObject({
      candidates: [
        ...candidatesOf(versionDir),
        ...candidatesOf(path.join(versionDir, 'hash123')),
      ],
    });
  });

  it('finds packages inside a content-addressed dir', async () => {
    // pnpm 11：版本根下是哈希目录，包在 <hash>/node_modules/<pkg>
    const globals = path.join(getPnpmHome(), 'global');
    const versionDir = path.join(globals, 'v11');
    const hashDir = path.join(versionDir, 'hash123');

    mocks.execSync.mockReturnValue('');
    mocks.readdir.mockImplementation(async (dir: string) => {
      if (dir === globals) {
        return ['v11'];
      }

      return dir === versionDir ? ['hash123'] : [];
    });
    fakeFs({
      [versionDir]: isDirWithMtime(1),
      [hashDir]: isDirWithMtime(1),
    });

    await expect(api.getLayout()).resolves.toMatchObject({
      candidates: expect.arrayContaining(candidatesOf(hashDir)) as string[],
    });
  });

  it('ignores version entries that are files', async () => {
    // 全局根目录下混着文件（如 .modules.yaml），它们不是版本目录，不参与查找
    const globals = path.join(getPnpmHome(), 'global');

    mocks.execSync.mockReturnValue('');
    mocks.readdir.mockImplementation(async (dir: string) =>
      dir === globals ? ['manifest.json', 'v11'] : [],
    );
    fakeFs({
      [path.join(globals, 'manifest.json')]: isFile,
      [path.join(globals, 'v11')]: isDirWithMtime(1),
    });

    await expect(api.getLayout()).resolves.toMatchObject({
      candidates: candidatesOf(path.join(globals, 'v11')),
    });
  });

  it('treats an unreadable global root as empty', async () => {
    mocks.execSync.mockReturnValue('');
    mocks.stat.mockRejectedValue(new Error('missing'));
    mocks.readdir.mockRejectedValue(new Error('permission denied'));

    await expect(api.getLayout()).resolves.toEqual({
      candidates: [],
      depot: null,
    });
    expect(mocks.readdir).toHaveBeenCalledWith(
      path.join(getPnpmHome(), 'global'),
    );
  });

  it('keeps the pnpm 10 root that pnpm itself reports', async () => {
    // `pnpm root -g` 直接给到 <版本目录>/node_modules：别再套一层 node_modules
    mocks.execSync.mockReturnValue('/global/10/node_modules\n');
    mocks.readdir.mockResolvedValue([]);

    await expect(api.getLayout()).resolves.toMatchObject({
      candidates: candidatesOf('/global/10/node_modules'),
    });
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

      return dir === versionDir ? ['older', 'newer'] : [];
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

    // 每装一次都可能多一张表，新到旧地排着，谁先谁后由 mtime 决定
    await expect(api.getLayout()).resolves.toMatchObject({
      depot: path.join(newer, '.pnpm', 'node_modules'),
    });
  });

  it('returns no dependency table when none of the roots has one', async () => {
    mocks.stat.mockRejectedValue(new Error('missing'));

    await expect(api.getLayout()).resolves.toEqual({
      candidates: candidatesOf('/global/node_modules'),
      depot: null,
    });
  });

  it('builds the layout from PNPM_HOME rather than the current env of the caller', async () => {
    // 布局只跟 pnpm 主目录有关，别跟着后面的环境变量漂移
    expect(getPnpmHome('linux')).toBe(
      PNPM_HOME ?? path.join(os.homedir(), '.local', 'share', 'pnpm'),
    );
  });
});
