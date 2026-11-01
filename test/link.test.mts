import path from 'node:path';

import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  createSymlink: vi.fn(),
  rmdir: vi.fn(),
  ensureDir: vi.fn(),
  getLayout: vi.fn(),
  isBinDirMissingFromPath: vi.fn(() => false),
  readDir: vi.fn(),
  readPackageJson: vi.fn(),
  resolvePath: vi.fn(),
}));

vi.mock('node:fs', () => ({ promises: { rmdir: mocks.rmdir } }));
vi.mock('../src/fs.mts', () => ({
  createSymlink: mocks.createSymlink,
  ensureDir: mocks.ensureDir,
  readDir: mocks.readDir,
  readPackageJson: mocks.readPackageJson,
  resolvePath: mocks.resolvePath,
  // 只有一处实现，跟着被测代码走，不另立一份。
  // 用真货而不是再 mock 一层：mock 出错时会被当成「链接失败」，测试照样绿
  settle: (task: Promise<unknown>) =>
    task.then(
      () => null,
      (error: Error) => error,
    ),
}));
vi.mock('../src/layout.mts', () => ({ getLayout: mocks.getLayout }));
vi.mock('../src/pnpm.mts', () => ({
  isBinDirMissingFromPath: mocks.isBinDirMissingFromPath,
}));

const { linkPackageBins } = await import('../src/link.mts');
const { planPackageLinks } = await import('../src/plan.mts');

const PKG = 'tool';
const PKG_DIR = path.join('/global/node_modules', PKG);
const STORE_DIR = '/global/store/node_modules/tool';
const DEPOT_DIR = '/global/.pnpm/node_modules';
/** 工程目录就是进程的工作目录，链接落在它自己的 node_modules 里 */
const PROJECT_DIR = process.cwd();
const BIN_DIR = path.join(PROJECT_DIR, 'node_modules', '.bin');
const PROJECT_LINK = path.join(PROJECT_DIR, 'node_modules', PKG);

const commandCalls = () =>
  mocks.createSymlink.mock.calls.filter(([link]) => link.startsWith(BIN_DIR));
/** 补依赖落在 store 里那个包的 node_modules 下，与命令链接分得开 */
const depCalls = () =>
  mocks.createSymlink.mock.calls.filter(([link]) => link.startsWith(STORE_DIR));

/** 一份只有这一层、没有依赖表的布局 */
const layout = (
  pkgDirs: string[] = ['/global/node_modules'],
  depots: (string | null)[] = pkgDirs.map(() => null),
) => ({
  layers: pkgDirs.map((pkgDir, index) => ({
    pkgDir,
    depot: depots[index] ?? null,
  })),
});

describe('planPackageLinks', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.readDir.mockResolvedValue([]);
    mocks.resolvePath.mockImplementation(async (dir: string) => dir);
    mocks.readPackageJson.mockResolvedValue({ bin: { tool: 'tool.js' } });
    mocks.getLayout.mockResolvedValue(layout());
  });

  it('plans the package link, the commands and the missing dependencies', async () => {
    // 计划只描述「做什么」，出落成计划时磁盘上什么都还没动
    mocks.readDir.mockImplementation(async (dir: string) =>
      dir === DEPOT_DIR ? ['missing-dep'] : [],
    );
    mocks.getLayout.mockResolvedValue(
      layout(['/global/node_modules'], [DEPOT_DIR]),
    );
    mocks.resolvePath.mockResolvedValue(STORE_DIR);

    await expect(planPackageLinks(PKG, PROJECT_DIR)).resolves.toEqual({
      pkgDir: PKG_DIR,
      pkgDirs: [PKG_DIR],
      pkgLink: PROJECT_LINK,
      binEntries: [['tool', 'tool.js']],
      deps: [
        {
          link: path.join(STORE_DIR, 'node_modules', 'missing-dep'),
          target: path.join(DEPOT_DIR, 'missing-dep'),
        },
      ],
    });
    expect(mocks.createSymlink).not.toHaveBeenCalled();
  });

  it('uses the dependency table of the layer the package came from', async () => {
    // 全局安装根下常有好几层，各层各有一张表。拿最新那层的表去补另一层的包，
    // 「缺哪些」永远算不对——那层可能只装了零星几个包（CI 上跑上百次构建就是这样）
    const latestDepot = '/global/cowsay-only/node_modules';
    const pkgDepot = '/global/miniprogram/node_modules';

    mocks.getLayout.mockResolvedValue(
      layout(
        ['/global/cowsay-only', '/global/miniprogram'],
        [latestDepot, pkgDepot],
      ),
    );
    mocks.readPackageJson.mockImplementation(async (dir: string) =>
      dir === path.join('/global/miniprogram', PKG)
        ? { bin: { tool: 'tool.js' } }
        : null,
    );
    mocks.readDir.mockImplementation(async (dir: string) =>
      dir === pkgDepot ? ['missing-dep'] : [],
    );

    await expect(planPackageLinks(PKG, PROJECT_DIR)).resolves.toMatchObject({
      pkgDir: path.join('/global/miniprogram', PKG),
      deps: [
        {
          link: path.join(
            '/global/miniprogram',
            PKG,
            'node_modules',
            'missing-dep',
          ),
          target: path.join(pkgDepot, 'missing-dep'),
        },
      ],
    });
  });

  it('keeps the newest candidate first and picks the one with metadata', async () => {
    // 第一份的软链可能已经断了（读不到 package.json），后面还排着一份好的
    mocks.getLayout.mockResolvedValue(
      layout(['/global/v11/node_modules', '/global/10/node_modules']),
    );
    mocks.readPackageJson.mockImplementation(async (dir: string) =>
      dir === '/global/10/node_modules/tool'
        ? { bin: { tool: 'cli.js' } }
        : null,
    );

    await expect(planPackageLinks(PKG, PROJECT_DIR)).resolves.toMatchObject({
      // 候选全留着：任意一份已到位就不重建，要建就建最新那份
      pkgDirs: [
        '/global/v11/node_modules/tool',
        '/global/10/node_modules/tool',
      ],
      // 命令与依赖只认读得到元数据的那一份
      pkgDir: '/global/10/node_modules/tool',
    });
  });

  it('reports packages that cannot be located in the global store', async () => {
    mocks.readPackageJson.mockResolvedValue(null);

    await expect(planPackageLinks('ghost', PROJECT_DIR)).resolves.toEqual({
      pkg: 'ghost',
      pkgDirs: [path.join('/global/node_modules', 'ghost')],
      notFound: true,
    });
  });

  it('reports packages without anything to run', async () => {
    mocks.readPackageJson.mockResolvedValue({});

    await expect(planPackageLinks('library', PROJECT_DIR)).resolves.toEqual({
      pkg: 'library',
      pkgDirs: [path.join('/global/node_modules', 'library')],
      noBin: true,
    });
  });

  it('names the command after the package when bin is a path', async () => {
    mocks.readPackageJson.mockResolvedValue({ bin: './bin/cli.js' });

    await expect(planPackageLinks(PKG, PROJECT_DIR)).resolves.toMatchObject({
      binEntries: [['tool', './bin/cli.js']],
    });
  });

  it('uses the unscoped name for a scoped package', async () => {
    mocks.readPackageJson.mockResolvedValue({ bin: 'cli.js' });

    await expect(
      planPackageLinks('@scope/tool', PROJECT_DIR),
    ).resolves.toMatchObject({
      binEntries: [['tool', 'cli.js']],
      pkgLink: path.join(PROJECT_DIR, 'node_modules', '@scope/tool'),
    });
  });

  it('plans no dependency links without a dependency table', async () => {
    await expect(planPackageLinks(PKG, PROJECT_DIR)).resolves.toMatchObject({
      deps: [],
    });
    expect(mocks.readDir).not.toHaveBeenCalled();
  });

  it('plans nothing to link when the package already has every dependency', async () => {
    // 上一次补过的依赖还在时不该重建：store 是共享的，重建是多余的写操作
    mocks.getLayout.mockResolvedValue(
      layout([path.dirname(PKG_DIR)], [DEPOT_DIR]),
    );
    mocks.readDir.mockResolvedValue(['linked-dep']);

    await expect(planPackageLinks(PKG, PROJECT_DIR)).resolves.toMatchObject({
      deps: [],
    });
  });

  it('falls back to the given directory when the store path cannot be resolved', async () => {
    // realpath 失败（如链接已断）时按原路径继续，别把整次链接拖垮
    mocks.getLayout.mockResolvedValue(
      layout([path.dirname(PKG_DIR)], [DEPOT_DIR]),
    );
    mocks.readDir.mockImplementation(async (dir: string) =>
      dir === DEPOT_DIR ? ['missing-dep'] : [],
    );

    await expect(planPackageLinks(PKG, PROJECT_DIR)).resolves.toMatchObject({
      deps: [
        {
          link: path.join(PKG_DIR, 'node_modules', 'missing-dep'),
          target: path.join(DEPOT_DIR, 'missing-dep'),
        },
      ],
    });
  });
});

describe('linkPackageBins', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.ensureDir.mockResolvedValue(undefined);
    mocks.rmdir.mockResolvedValue(undefined);
    mocks.readDir.mockResolvedValue([]);
    mocks.createSymlink.mockResolvedValue(undefined);
    mocks.resolvePath.mockImplementation(async (dir: string) => dir);
    mocks.readPackageJson.mockResolvedValue({ bin: { tool: 'tool.js' } });
    mocks.getLayout.mockResolvedValue(layout());
    mocks.isBinDirMissingFromPath.mockReturnValue(false);
  });

  it('reports missing metadata and binless packages', async () => {
    mocks.readPackageJson.mockResolvedValueOnce(null).mockResolvedValueOnce({});

    expect(await linkPackageBins(['missing', 'library'])).toMatchObject([
      { pkg: 'missing', notFound: true },
      { pkg: 'library', noBin: true },
    ]);
  });

  it('blames the missing global bin directory before reporting not found', async () => {
    // 全局 bin 目录不在 PATH 时 pnpm 的全局目录查询也会失效，报「找不到包」会误导用户
    mocks.getLayout.mockResolvedValue(layout([]));
    mocks.readPackageJson.mockResolvedValue(null);
    mocks.isBinDirMissingFromPath.mockReturnValue(true);

    expect(await linkPackageBins(['ghost'])).toMatchObject([
      { pkg: 'ghost', globalBinDir: true },
    ]);
  });

  it('does not blame the environment for a package nobody installed', async () => {
    // 布局探得出来、只是这个包不在里面：那是没装，不是环境问题
    mocks.readPackageJson.mockResolvedValue(null);
    mocks.isBinDirMissingFromPath.mockReturnValue(true);

    expect(await linkPackageBins(['ghost'])).toMatchObject([
      { pkg: 'ghost', notFound: true },
    ]);
  });

  it('does not link a package that has nothing to run', async () => {
    // 没有 bin 的包连本体都不用链：工程里用不着它
    mocks.readPackageJson.mockResolvedValue({});

    await linkPackageBins(['library']);

    expect(mocks.createSymlink).not.toHaveBeenCalled();
  });

  it('links the package itself and its commands', async () => {
    await linkPackageBins([PKG]);

    expect(mocks.createSymlink).toHaveBeenCalledWith(PROJECT_LINK, [PKG_DIR]);
    expect(commandCalls()).toEqual([
      [path.join(BIN_DIR, 'tool'), [path.join(PKG_DIR, 'tool.js')]],
    ]);
  });

  it('records individual command failures without dropping the rest', async () => {
    mocks.readPackageJson.mockResolvedValue({
      bin: { first: 'first.js', second: 'second.js' },
    });
    mocks.createSymlink.mockImplementation(async (link: string) => {
      if (link === path.join(BIN_DIR, 'second')) {
        throw new Error('link failed');
      }
    });

    const [result] = await linkPackageBins([PKG]);

    expect(result).toEqual({
      pkg: PKG,
      commands: ['first'],
      depsLinked: false,
      errors: [{ name: 'second', error: new Error('link failed') }],
    });
  });

  it('links the dependencies the package does not have', async () => {
    // pnpm 全局布局下包的真实路径在 store 里，够不到全局安装根那张依赖表。
    // 表里有、包里没有的才补，只付两次目录读的代价。
    mocks.getLayout.mockResolvedValue(
      layout([path.dirname(PKG_DIR)], [DEPOT_DIR]),
    );
    mocks.resolvePath.mockResolvedValue(STORE_DIR);
    mocks.readDir.mockImplementation(async (dir: string) =>
      dir === DEPOT_DIR ? ['missing-dep', 'present-dep'] : ['present-dep'],
    );

    const [result] = await linkPackageBins([PKG]);

    expect(result).toMatchObject({ commands: ['tool'], depsLinked: true });
    expect(mocks.ensureDir).toHaveBeenCalledWith(
      path.join(STORE_DIR, 'node_modules'),
    );
    expect(depCalls()).toEqual([
      [
        path.join(STORE_DIR, 'node_modules', 'missing-dep'),
        [path.join(DEPOT_DIR, 'missing-dep')],
      ],
    ]);
  });

  it('prepares the directories the links land in', async () => {
    // 工程可能刚 `npm init`，一个 node_modules 都没有：软链不会替谁建父目录，
    // 缺一层就 ENOENT，报出来还像是「包没装」
    mocks.getLayout.mockResolvedValue(
      layout([path.dirname(PKG_DIR)], [DEPOT_DIR]),
    );
    mocks.resolvePath.mockResolvedValue(STORE_DIR);
    mocks.readDir.mockImplementation(async (dir: string) =>
      dir === DEPOT_DIR ? ['missing-dep'] : [],
    );

    await linkPackageBins([PKG]);

    expect(mocks.ensureDir.mock.calls.flat()).toEqual(
      expect.arrayContaining([
        BIN_DIR,
        path.join(PROJECT_DIR, 'node_modules'),
        path.join(STORE_DIR, 'node_modules'),
      ]),
    );
  });

  it('takes back the directories nothing ended up in', async () => {
    // 铺了没人用就撤掉：命令一条都没链上时，工程里不该多出一个空的 node_modules/.bin
    mocks.createSymlink.mockImplementation(async (link: string) => {
      if (link.startsWith(BIN_DIR)) {
        throw new Error('EPERM');
      }
    });

    await linkPackageBins([PKG]);

    expect(mocks.rmdir).toHaveBeenCalledWith(BIN_DIR);
  });

  it('leaves the directories behind when they cannot be removed', async () => {
    // 撤不掉也不该把结果变成失败：删目录只是收尾，链接该怎样还怎样
    mocks.rmdir.mockRejectedValue(new Error('ENOTEMPTY'));
    mocks.createSymlink.mockImplementation(async (link: string) => {
      if (link.startsWith(BIN_DIR)) {
        throw new Error('EPERM');
      }
    });

    await expect(linkPackageBins([PKG])).resolves.toMatchObject([
      { commands: [], depsLinked: false },
    ]);
    // 空壳删不掉就留在原地，工程里最多多一个空目录，链接本身没受影响
    expect(mocks.rmdir).toHaveBeenCalledWith(BIN_DIR);
  });

  it('still attempts the links when the directories cannot be created', async () => {
    // 建不成不该挡住链接：真建不出来时建链自己会照实报错
    mocks.ensureDir.mockRejectedValue(new Error('EACCES'));
    mocks.getLayout.mockResolvedValue(
      layout([path.dirname(PKG_DIR)], [DEPOT_DIR]),
    );
    mocks.resolvePath.mockResolvedValue(STORE_DIR);
    mocks.readDir.mockImplementation(async (dir: string) =>
      dir === DEPOT_DIR ? ['missing-dep'] : [],
    );

    await expect(linkPackageBins([PKG])).resolves.toMatchObject([
      { depsLinked: true, commands: ['tool'] },
    ]);
  });

  it('treats an unreadable dependency table as empty', async () => {
    mocks.getLayout.mockResolvedValue(
      layout([path.dirname(PKG_DIR)], [DEPOT_DIR]),
    );
    mocks.readDir.mockResolvedValue([]);

    const [result] = await linkPackageBins([PKG]);

    expect(result).toMatchObject({ depsLinked: false });
    expect(mocks.createSymlink).toHaveBeenCalledTimes(2);
  });

  it('keeps going when a dependency link fails', async () => {
    // 补不上某个依赖不该连命令一起丢掉：链接已建好，缺哪个依赖让运行时照实报错
    mocks.getLayout.mockResolvedValue(
      layout([path.dirname(PKG_DIR)], [DEPOT_DIR]),
    );
    mocks.resolvePath.mockResolvedValue(STORE_DIR);
    mocks.readDir.mockImplementation(async (dir: string) =>
      dir === DEPOT_DIR ? ['broken-dep', 'good-dep'] : [],
    );
    // 命令链接与存在的那一半依赖都建得成，只有坏的那个依赖链不上
    mocks.createSymlink.mockImplementation(async (link: string) => {
      if (link.endsWith('broken-dep') && link.startsWith(STORE_DIR)) {
        throw new Error('cross-device');
      }
    });

    const [result] = await linkPackageBins([PKG]);

    expect(result).toMatchObject({ depsLinked: true, commands: ['tool'] });
    expect(depCalls()).toHaveLength(2);
  });

  it('reports nothing linked when every dependency fails', async () => {
    mocks.getLayout.mockResolvedValue(
      layout([path.dirname(PKG_DIR)], [DEPOT_DIR]),
    );
    mocks.resolvePath.mockResolvedValue(STORE_DIR);
    mocks.readDir.mockImplementation(async (dir: string) =>
      dir === DEPOT_DIR ? ['broken-dep'] : [],
    );
    mocks.createSymlink.mockImplementation(async (link: string) => {
      if (link.endsWith('broken-dep') && link.startsWith(STORE_DIR)) {
        throw new Error('cross-device');
      }
    });

    const [result] = await linkPackageBins([PKG]);

    expect(result).toMatchObject({ depsLinked: false });
  });

  it('records package link failures per package', async () => {
    mocks.createSymlink.mockRejectedValueOnce(new Error('cross-device'));

    await expect(linkPackageBins([PKG])).resolves.toEqual([
      {
        pkg: PKG,
        errors: [{ name: PKG, error: new Error('cross-device') }],
      },
    ]);
    // 包本体没链上就别再谈命令了
    expect(mocks.readDir).not.toHaveBeenCalled();
  });

  it('records permission failures per command', async () => {
    // 非 Windows 上 EPERM 只是这一个命令没链上，别把整次运行掀了
    mocks.createSymlink.mockImplementation(async (link: string) => {
      if (link === path.join(BIN_DIR, 'tool')) {
        throw Object.assign(new Error('permission denied'), { code: 'EPERM' });
      }
    });

    const [result] = await linkPackageBins([PKG]);

    // 只有命令没链上，包本体照常
    expect(result).toMatchObject({
      commands: [],
      errors: [{ error: new Error('permission denied') }],
    });
  });

  it('leaves a broken layout to the CLI', async () => {
    // 布局算不出来是环境问题，不是某个包的错，往上冒给 CLI 统一提示
    // （`Promise.all` 不 await 剩下的分支，谁先炸谁说话）
    mocks.getLayout.mockRejectedValue(new Error('no pnpm'));

    await expect(planPackageLinks(PKG, PROJECT_DIR)).rejects.toThrow('no pnpm');
  });

  it('keeps the command link when the dependency pass blows up', async () => {
    // 补依赖是附赠的，整段挂掉也不该把已经建好的命令链接连坐掉
    mocks.readDir.mockRejectedValue(new Error('boom'));

    await expect(linkPackageBins([PKG])).resolves.toMatchObject([
      { commands: ['tool'], depsLinked: false },
    ]);
  });

  it('continues after a package blows up unexpectedly', async () => {
    mocks.createSymlink.mockRejectedValueOnce(new Error('store gone'));

    const results = await linkPackageBins(['broken', PKG]);

    // 一个包炸了只赔上它自己，别让整次运行停摆
    expect(results[0]).toEqual({
      pkg: 'broken',
      errors: [{ name: 'broken', error: new Error('store gone') }],
    });
    expect(results[1]).toMatchObject({ commands: ['tool'] });
  });

  it('propagates the permission failure Windows cannot work around', async () => {
    // Windows 上的 EPERM 不是这个包的问题，得让 CLI 统一提示管理员权限
    const platform = vi.spyOn(process, 'platform', 'get');
    platform.mockReturnValue('win32');
    mocks.createSymlink.mockRejectedValue(
      Object.assign(new Error('permission denied'), { code: 'EPERM' }),
    );

    await expect(linkPackageBins([PKG])).rejects.toThrow('permission denied');
    platform.mockRestore();
  });
});
