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
  lstat: vi.fn(),
}));

vi.mock('node:child_process', () => ({ execSync: mocks.execSync }));
vi.mock('node:fs', () => ({
  promises: {
    readdir: mocks.readdir,
    stat: mocks.stat,
    lstat: mocks.lstat,
  },
}));

type Layout = typeof import('../src/layout.mts');

const dirStat = { isDirectory: () => true, mtimeMs: 0 };
const fileStat = { isDirectory: () => false };
const dirStatWithMtime = (mtimeMs: number) => ({
  isDirectory: () => true,
  mtimeMs,
});
/**
带「是不是软链」答案的目录，排序要认的那个
*/
const dirStatWith = (mtimeMs: number, isLink = false) => ({
  isDirectory: () => true,
  isSymbolicLink: () => isLink,
  mtimeMs,
});

/**
借一个用例体改环境变量，结束后归还
*/
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

/**
用一张「路径 → stat 结果」的表充当文件系统，表外的路径一律不存在
*/
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
一个布局根给出的那一层：包落在 `node_modules`（根本身就叫 node_modules 时不再套一层，
`pnpm root -g` 给的就是那一层），依赖表默认就在它下面。
*/
const layerOf = (root: string, depot: string | null = null) => {
  const pkgDir =
    path.basename(root) === 'node_modules'
      ? root
      : path.join(root, 'node_modules');

  return { pkgDir, depot };
};

/**
某一层的 `.pnpm/node_modules`
*/
const nestedOf = (pkgDir: string) => path.join(pkgDir, '.pnpm', 'node_modules');
/**
平铺表所在的子目录名，用 path.join 拼，跨平台比较才一致
*/
const NESTED_SUFFIX = path.join('.pnpm', 'node_modules');

describe('pnpm home', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('resolves the pnpm home from the environment', async () => {
    await withEnv({ PNPM_HOME: undefined, XDG_DATA_HOME: '/data' }, () => {
      expect(getPnpmHome()).toBe(path.join('/data', 'pnpm'));

      // 没有 XDG 约定时退回用户目录，各平台同一条式子

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
  隔离加载一份模块。

  布局按模块实例记忆化，换一份实例就是从头问一遍；每个用例自己声明一份，
  vitest 会按依赖图各自去重。
  */
  const load = (): Promise<Layout> => import('../src/layout.mts');

  beforeEach(async () => {
    vi.resetAllMocks();
    vi.resetModules();
    mocks.execSync.mockReturnValue('/global/node_modules\n');
    mocks.execSync.mockClear();
    mocks.stat.mockResolvedValue(dirStat);
    mocks.readdir.mockResolvedValue([]);
    // 平铺表里的条目默认是实物（真目录），别名表才用软链
    mocks.lstat.mockResolvedValue({ isSymbolicLink: () => false });
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
          dir.endsWith(NESTED_SUFFIX) ? ['dep'] : [],
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
          path.join('/elsewhere/bin', 'bin'),
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
      return dir === globals ? ['v11', '10'] : [];
    });
    mocks.stat.mockReset();
    fakeFs({
      [path.join(globals, 'v11')]: dirStatWithMtime(20),
      [path.join(globals, '10')]: dirStatWithMtime(10),
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
      [version]: dirStatWithMtime(1),
      [hashed]: dirStatWithMtime(2),
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
      [path.join(globals, 'v11')]: dirStatWithMtime(1),
      [path.join(globals, 'LICENSE')]: fileStat,
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
    fakeFs({ [path.join(globals, 'v11')]: dirStatWithMtime(1) });

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

      return dir.endsWith(NESTED_SUFFIX) ? ['dep'] : [];
    });
    const tree = {
      // 版本目录自身的 node_modules 在这里不存在，只有哈希目录下面那层有依赖表
      [newer]: dirStat,
      [older]: dirStat,
      [versionDir]: dirStatWithMtime(1),
      [path.dirname(newer)]: dirStatWithMtime(20),
      [path.dirname(older)]: dirStatWithMtime(10),
      [path.join(newer, '.pnpm', 'node_modules')]: dirStat,
      [path.join(older, '.pnpm', 'node_modules')]: dirStat,
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

  it('keeps both dependency tables pnpm 12 hoists in one layer', async () => {
    // pnpm 12 把直接装的包 public hoist 到 `<layer>/node_modules` 顶层，
    // 同时仍留着一份 `.pnpm/node_modules`：顶层只有直接装的几个，间接依赖（moment）在后面那份里。
    // 挑一个了事就会漏掉大半张表，补依赖算出来是零，包一 require 就断
    const globals = path.join(getPnpmHome(), 'global');
    const version = path.join(globals, 'v11');
    const hashed = path.join(version, 'abc123');
    const pkgDir = path.join(hashed, 'node_modules');

    mocks.execSync.mockReturnValue('');
    mocks.readdir.mockImplementation(async (dir: string) => {
      if (dir === globals) {
        return ['v11'];
      }

      if (dir === version) {
        return ['abc123'];
      }

      return dir === pkgDir || dir === nestedOf(pkgDir) ? ['dep'] : [];
    });
    // 版本目录自己的 node_modules 两处候选都不存在，两张表都在哈希目录下面那层
    mocks.stat.mockReset();
    fakeFs({
      [version]: dirStatWithMtime(1),
      [hashed]: dirStatWithMtime(2),
      [pkgDir]: dirStatWithMtime(0),
      [nestedOf(pkgDir)]: dirStatWithMtime(0),
      [path.dirname(pkgDir)]: dirStatWithMtime(0),
    });

    // 两张表都算数；版本目录自己的 node_modules 是空壳，包探不到那儿去
    await expect(api.getLayout()).resolves.toEqual({
      layers: [
        layerOf(version),
        layerOf(pkgDir, pkgDir),
        layerOf(pkgDir, nestedOf(pkgDir)),
      ],
    });
  });

  it('skips a table whose entries all alias another table', async () => {
    // pnpm 12 的全局安装根会在 `global/v11/node_modules` 铺一张别名表：条目一个不少，
    // 但全是软链回内容寻址目录。照着这张表把依赖链进包的 store 目录，每一条都会落空
    // （`Cannot find module 'moment'` 就是这么来的），所以整张表跳过，只认实物那份
    const globals = path.join(getPnpmHome(), 'global');
    const version = path.join(globals, 'v11');
    const pkgDir = path.join(version, 'node_modules');
    const real = path.join(version, 'abc123', 'node_modules');

    mocks.execSync.mockReturnValue(`${pkgDir}\n`);
    mocks.readdir.mockImplementation(async (dir: string) => {
      if (dir === globals) {
        return ['v11'];
      }

      if (dir === version) {
        return ['abc123'];
      }

      if (dir === pkgDir) {
        return ['.bin', 'miniprogram-ci'];
      }

      return dir === nestedOf(real) ? ['moment'] : [];
    });
    mocks.stat.mockReset();
    fakeFs({
      [version]: dirStatWithMtime(1),
      [path.join(version, 'abc123')]: dirStatWithMtime(2),
      [pkgDir]: dirStatWithMtime(0),
      [nestedOf(real)]: dirStatWithMtime(0),
      [path.dirname(real)]: dirStatWithMtime(0),
    });
    // 顶层是别名表（软链），`.pnpm/node_modules` 里才是实物
    mocks.lstat.mockImplementation(async (entry: string) => ({
      isSymbolicLink: () => entry.startsWith(pkgDir),
    }));

    const { layers } = await api.getLayout();

    expect(layers.map(({ depot }) => depot)).not.toContain(pkgDir);
    const aliasedLayer = layerOf(real, nestedOf(real));
    expect(layers).toEqual(expect.arrayContaining([aliasedLayer]));
  });

  it('orders version entries by the content, not by the mtime of the link', async () => {
    // `pnpm global add` 装完会在版本目录里改一次 `lastKnownGood` 软链，那一下的 mtime
    // 比内容本身新。按软链自己那条排，它指向的那份会顶到最前面，
    // 于是挑中一份对不上这个包的布局，补依赖算出来是零（moment 就是这么断的）
    const globals = path.join(getPnpmHome(), 'global');
    const version = path.join(globals, 'v11');
    const stale = path.join(version, 'stale');
    const linked = path.join(version, 'lkg');

    mocks.execSync.mockReturnValue('');
    mocks.readdir.mockImplementation(async (dir: string) => {
      if (dir === globals) {
        return ['v11'];
      }

      return dir === version ? ['stale', 'lkg'] : [];
    });
    mocks.stat.mockReset();
    // lkg 问两遍：第一遍是它自己（软链，50），第二遍是它指向的那份（10）
    let asked = 0;
    mocks.stat.mockImplementation(async (entry: string) => {
      if (entry === version) {
        return dirStatWith(1);
      }

      if (entry === stale) {
        return dirStatWith(20);
      }

      asked += 1;

      return dirStatWith(asked === 1 ? 50 : 10, asked === 1);
    });

    const { layers } = await api.getLayout();
    const order = layers.map(({ pkgDir }) => pkgDir);

    // 软链那一下的 mtime 不作数：拿它排，lkg（50）会排到 stale（20）前面
    expect(order.indexOf(path.join(stale, 'node_modules'))).toBeLessThan(
      order.indexOf(path.join(linked, 'node_modules')),
    );
  });

  it('counts a table holding only dot entries as empty', async () => {
    // 只有 `.bin`、`.modules.yaml` 这类元数据的层不是依赖表：
    // 拿它去算「缺哪些」，一个依赖都算不出来
    const globals = path.join(getPnpmHome(), 'global');
    const root = path.join(globals, 'v11');
    const dots = path.join(root, 'node_modules');

    mocks.execSync.mockReturnValue('');
    mocks.readdir.mockImplementation(async (dir: string) => {
      if (dir === globals) {
        return ['v11'];
      }

      return dir === dots ? ['.bin', '.modules.yaml'] : [];
    });
    mocks.stat.mockReset();
    fakeFs({ [root]: dirStatWithMtime(1), [dots]: dirStat });

    // 整层只有元数据：认得出那里没有表（不该拿它当表去算依赖），
    // 但包还得照旧在那一层里找
    const { layers } = await api.getLayout();

    expect(layers.map(({ pkgDir }) => pkgDir)).toEqual([dots]);
    expect(layers.every(({ depot }) => depot === null)).toBe(true);
  });

  it('skips a table whose lstat cannot resolve an entry', async () => {
    // 读到目录又扫到条目之后，pnpm 可能正在删其中一条（切版本）：
    // 探不到就当作不是软链，别把整次探测炸掉
    const globals = path.join(getPnpmHome(), 'global');
    const root = path.join(globals, 'v11');
    const table = path.join(root, 'node_modules');

    mocks.execSync.mockReturnValue('');
    mocks.readdir.mockImplementation(async (dir: string) => {
      if (dir === globals) {
        return ['v11'];
      }

      return dir === table ? ['tool'] : [];
    });
    mocks.stat.mockReset();
    fakeFs({ [root]: dirStatWithMtime(1), [table]: dirStat });
    mocks.lstat.mockRejectedValue(
      Object.assign(new Error('gone'), { code: 'ENOENT' }),
    );

    const { layers } = await api.getLayout();

    expect(layers.map(({ depot }) => depot)).toEqual([table]);
  });

  it('looks at one dependency table when the layer has no nested one', async () => {
    // 没有 `.pnpm/node_modules` 的层（pnpm 10 的全局根）：顶层那张表就是唯一的表，
    // 别为了探第二处把同一个目录的名字读两遍
    const globals = path.join(getPnpmHome(), 'global');
    const root = path.join(globals, '10');
    const table = path.join(root, 'node_modules');

    mocks.execSync.mockReturnValue('');
    mocks.readdir.mockImplementation(async (dir: string) => {
      if (dir === globals) {
        return ['10'];
      }

      return dir === table ? ['tool'] : [];
    });
    mocks.stat.mockReset();
    fakeFs({ [root]: dirStatWithMtime(1), [table]: dirStat });

    const { layers } = await api.getLayout();

    expect(layers.map(({ depot }) => depot)).toEqual([table]);
  });

  it('does not ask whether a table holding only dot entries is an alias', async () => {
    // 只有元数据的层没有条目可查，元数据本身不该被当成包
    const globals = path.join(getPnpmHome(), 'global');
    const root = path.join(globals, 'v11');
    const table = path.join(root, 'node_modules');

    mocks.execSync.mockReturnValue('');
    mocks.readdir.mockImplementation(async (dir: string) => {
      if (dir === globals) {
        return ['v11'];
      }

      return dir === table ? ['.bin'] : [];
    });
    mocks.stat.mockReset();
    fakeFs({ [root]: dirStatWithMtime(1), [table]: dirStat });
    mocks.lstat.mockClear();

    const { layers } = await api.getLayout();

    expect(layers.every(({ depot }) => depot === null)).toBe(true);
    expect(mocks.lstat).not.toHaveBeenCalledWith(path.join(table, '.bin'));
  });

  it('drops a link whose target is gone or is a file', async () => {
    // lastKnownGood 这类软链可能指向一份被删掉的目录，也可能指到文件上：都不算目录
    const globals = path.join(getPnpmHome(), 'global');
    const version = path.join(globals, 'v11');
    const broken = path.join(version, 'broken');
    const toFile = path.join(version, 'to-file');

    mocks.execSync.mockReturnValue('');
    mocks.readdir.mockImplementation(async (dir: string) => {
      if (dir === version) {
        return ['broken', 'to-file'];
      }

      return dir === globals ? ['v11'] : [];
    });
    mocks.stat.mockReset();
    // 每个软链问两次：先问「你是什么」，再问「你指向的那份是什么」
    const asked = new Map<string, number>();
    mocks.stat.mockImplementation(async (entry: string) => {
      if (entry === version) {
        return dirStatWith(1);
      }

      if (entry === broken || entry === toFile) {
        const times = (asked.get(entry) ?? 0) + 1;

        asked.set(entry, times);

        if (times === 1) {
          return { isDirectory: () => true, isSymbolicLink: () => true };
        }

        // broken 指向的已经不在了；to-file 指向一个文件
        if (entry === broken) {
          throw new Error('missing');
        }

        return { isDirectory: () => false, isSymbolicLink: () => false };
      }

      throw new Error(`unexpected: ${entry}`);
    });

    const { layers } = await api.getLayout();

    // 断链、指到文件的都排掉，只剩版本目录那一层
    expect(layers.map(({ pkgDir }) => pkgDir)).toEqual([
      path.join(version, 'node_modules'),
    ]);
  });

  it('skips a dependency table that exists but holds nothing', async () => {
    // pnpm 12 把依赖 public hoist 到全局安装根自己的 node_modules 顶层，
    // 同时留下一个空的 `.pnpm/node_modules`：只认「目录在不在」会挑中空壳
    const globals = path.join(getPnpmHome(), 'global');

    mocks.execSync.mockReturnValue('');
    mocks.readdir.mockImplementation(async (dir: string) =>
      dir === globals ? ['v11'] : [],
    );
    mocks.stat.mockResolvedValue(dirStat);

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
