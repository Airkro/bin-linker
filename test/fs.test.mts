import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  access: vi.fn(),
  lstat: vi.fn(),
  mkdir: vi.fn(),
  stat: vi.fn(),
  readFile: vi.fn(),
  readdir: vi.fn(),
  readlink: vi.fn(),
  realpath: vi.fn(),
  symlink: vi.fn(),
  unlink: vi.fn(),
}));

vi.mock('node:fs', () => ({
  promises: {
    access: mocks.access,
    lstat: mocks.lstat,
    mkdir: mocks.mkdir,
    stat: mocks.stat,
    readFile: mocks.readFile,
    readdir: mocks.readdir,
    readlink: mocks.readlink,
    realpath: mocks.realpath,
    symlink: mocks.symlink,
    unlink: mocks.unlink,
  },
}));

const {
  createSymlink,
  ensureDir,
  hasEntries,
  linkPointsTo,
  probePath,
  readDir,
  readPackageJson,
  resolvePath,
  settle,
} = await import('../src/fs.mts');

const LINK = '/project/node_modules/.bin/tool';
const TARGET = '/global/node_modules/tool/cli.js';

/** 让 readlink 只对给定路径成功，其余一律当作不是链接 */
function readingOnly(points: Record<string, string>) {
  mocks.readlink.mockImplementation(async (link: string) => {
    if (link in points) {
      return points[link];
    }

    throw Object.assign(new Error('not a link'), { code: 'EINVAL' });
  });
}

describe('filesystem helpers', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    // 默认：链接不存在（readlink 报 ENOENT），realpath 原样返回
    mocks.readlink.mockRejectedValue(
      Object.assign(new Error('missing'), { code: 'ENOENT' }),
    );
    mocks.realpath.mockImplementation(async (target: string) => target);
    // 默认：候选都存在，且都是普通文件（空壳目录的用例自己改）
    mocks.access.mockResolvedValue(undefined);
    mocks.stat.mockImplementation(async () => ({ isDirectory: () => false }));
    mocks.unlink.mockResolvedValue(undefined);
    mocks.symlink.mockResolvedValue(undefined);
  });

  it('reads directories and treats unreadable ones as empty', async () => {
    mocks.readdir.mockResolvedValueOnce(['a', 'b']);
    await expect(readDir('/global')).resolves.toEqual(['a', 'b']);

    // 不存在与没权限在这里都是「没有」
    mocks.readdir.mockRejectedValueOnce(new Error('permission denied'));
    await expect(readDir('/global')).resolves.toEqual([]);
  });

  it('treats empty and unreadable directories as having nothing inside', async () => {
    mocks.stat.mockResolvedValue({ isDirectory: () => true });

    mocks.readdir.mockResolvedValueOnce(['pkg']);
    await expect(hasEntries('/global')).resolves.toBe(true);

    // pnpm 12 会留一个空的 `.pnpm/node_modules` 空壳：目录在不算数，里头有东西才算
    mocks.readdir.mockResolvedValueOnce([]);
    await expect(hasEntries('/global')).resolves.toBe(false);

    // 路径被当成文件（store 里的包都是文件 / 目录混杂的地盘）
    mocks.readdir.mockResolvedValueOnce(['x']);
    mocks.stat.mockResolvedValueOnce({ isDirectory: () => false });
    await expect(hasEntries('/global/file')).resolves.toBe(false);

    // 读不到 stat（目录刚被 pnpm 切版本删掉）也当没有
    mocks.readdir.mockResolvedValueOnce(['x']);
    mocks.stat.mockRejectedValueOnce(new Error('missing'));
    await expect(hasEntries('/global')).resolves.toBe(false);
  });

  it('turns a task into null on success and the cause on failure', async () => {
    await expect(settle(Promise.resolve('done'))).resolves.toBeNull();

    const error = new Error('nope');
    await expect(settle(Promise.reject(error))).resolves.toBe(error);
  });

  it('falls back to the literal path when it cannot be resolved', async () => {
    await expect(resolvePath('/global/tool')).resolves.toBe('/global/tool');

    mocks.realpath.mockRejectedValueOnce(new Error('dangling'));
    await expect(resolvePath('/global/tool')).resolves.toBe('/global/tool');
  });

  it('creates directories and swallows creation failures', async () => {
    mocks.mkdir.mockResolvedValue(undefined);
    await expect(ensureDir('/tmp/bin-linker')).resolves.toBeUndefined();
    expect(mocks.mkdir).toHaveBeenCalledWith('/tmp/bin-linker', {
      recursive: true,
    });

    // 建不出来就交给后面那一步报错，这里不额外造一种失败
    mocks.mkdir.mockRejectedValueOnce(new Error('read-only'));
    await expect(ensureDir('/tmp/bin-linker')).resolves.toBeUndefined();
  });

  it('reads package metadata and swallows broken manifests', async () => {
    mocks.readFile.mockResolvedValueOnce('{"bin":{"tool":"cli.js"}}');
    await expect(readPackageJson('/global/tool')).resolves.toEqual({
      bin: { tool: 'cli.js' },
    });

    // 内容不是 JSON：与「文件不存在」一样当作读不到
    mocks.readFile.mockResolvedValueOnce('invalid json');
    await expect(readPackageJson('/global/tool')).resolves.toBeNull();

    mocks.readFile.mockRejectedValueOnce(new Error('no package.json'));
    await expect(readPackageJson('/global/tool')).resolves.toBeNull();
  });

  it('creates the link when nothing is there yet', async () => {
    mocks.unlink.mockRejectedValue(
      Object.assign(new Error('missing'), { code: 'ENOENT' }),
    );

    // 第一次链这个包时目标位置本来就没有东西，unlink 报 ENOENT 不算失败
    await expect(createSymlink(LINK, [TARGET])).resolves.toBeUndefined();
    expect(mocks.unlink).toHaveBeenCalledWith(LINK);
    // 第三个参数是 Windows 的链接类型；非 win32 上给 undefined
    expect(mocks.symlink).toHaveBeenCalledWith(TARGET, LINK, undefined);
  });

  it('leaves a link that already points at the target', async () => {
    // 重跑、`pnpm <cmd>` 前置钩子里链接已就位是常态，重建纯属两次多余的写操作
    readingOnly({ [LINK]: TARGET });
    mocks.realpath.mockImplementation(async (target: string) =>
      target === LINK ? TARGET : target,
    );

    await createSymlink(LINK, [TARGET]);
    expect(mocks.unlink).not.toHaveBeenCalled();
    expect(mocks.symlink).not.toHaveBeenCalled();
  });

  it('links the first target that actually exists', async () => {
    // 候选表里常有不存在的层（pnpm 12 的 global/v11/node_modules 就只是个空壳），
    // 照着排头建等于亲手做一条断链
    mocks.access.mockImplementation(async (target: string) => {
      if (target === TARGET) {
        throw Object.assign(new Error('missing'), { code: 'ENOENT' });
      }
    });

    await createSymlink(LINK, [TARGET, '/global/10/node_modules/tool/cli.js']);
    expect(mocks.symlink).toHaveBeenCalledWith(
      '/global/10/node_modules/tool/cli.js',
      LINK,
      undefined,
    );
  });

  it('skips an empty shell and links the next target with content', async () => {
    // pnpm 12 的 `global/v11/node_modules` 探得到、里头什么都没有：照着排头建，
    // 链过去的是一条空壳，命令照样起不来
    const shell = '/global/v11/node_modules/tool';
    const real = '/global/v11/abc123/node_modules/tool';

    mocks.access.mockImplementation(async (target: string) => {
      if (target !== shell && target !== real) {
        throw Object.assign(new Error('missing'), { code: 'ENOENT' });
      }
    });
    mocks.stat.mockImplementation(async () => ({ isDirectory: () => true }));
    mocks.readdir.mockImplementation(async (dir: string) =>
      dir === real ? ['package.json'] : [],
    );

    await createSymlink(LINK, [shell, real]);
    expect(mocks.symlink).toHaveBeenCalledWith(real, LINK, undefined);
  });

  it('accepts a target that is itself a link', async () => {
    // pnpm 12 的全局安装根常把整层 `node_modules` 做成软链（`global/v11/node_modules`），
    // 解到根是一份按内容寻址命名的目录，每次安装都换名字；
    // 只比解到根的路径，指着同一条软链也会判成「不在位」，于是每次运行都重建
    const layer = '/global/v11/node_modules/tool';
    readingOnly({ [layer]: '/global/v11/abc123/node_modules/tool' });
    mocks.realpath.mockImplementation(async (dir: string) =>
      dir === '/project/node_modules/tool' ? layer : dir,
    );

    await expect(
      linkPointsTo('/project/node_modules/tool', [layer]),
    ).resolves.toBe(true);
  });

  it('treats a target it cannot stat as a plain entry', async () => {
    // 探得到（access 过了）却 stat 不到：断链一类。当文件放行，别把它当空壳跳过
    mocks.stat.mockRejectedValue(
      Object.assign(new Error('dangling'), { code: 'ENOENT' }),
    );

    await createSymlink(LINK, [TARGET]);
    expect(mocks.symlink).toHaveBeenCalledWith(TARGET, LINK, undefined);
  });

  it('fails when none of the targets exist', async () => {
    mocks.access.mockRejectedValue(
      Object.assign(new Error('missing'), { code: 'ENOENT' }),
    );

    await expect(createSymlink(LINK, [TARGET])).rejects.toThrow(
      '候选位置都不存在',
    );
    expect(mocks.symlink).not.toHaveBeenCalled();
  });

  it('rebuilds a link whose target no longer exists', async () => {
    // 空壳链接的字面路径恰好等于某个候选，只比字面路径就永远「已到位」，
    // 于是断链一直留着——用户看到的就是一条跑不起来的软链
    readingOnly({ [LINK]: TARGET });
    mocks.realpath.mockImplementation(async (target: string) => {
      if (target === LINK) {
        throw Object.assign(new Error('dangling'), { code: 'ENOENT' });
      }

      return target;
    });

    await createSymlink(LINK, [TARGET]);
    expect(mocks.symlink).toHaveBeenCalledWith(TARGET, LINK, undefined);
  });

  it('accepts any of the candidate targets', async () => {
    // 包同时留在两个版本目录里，链接指着其中一份就算到位（第一份的软链可能是断的）
    readingOnly({
      '/project/node_modules/tool': '/global/10/node_modules/tool',
    });
    mocks.realpath.mockImplementation(async (dir: string) =>
      dir.startsWith('/global/v11') ? dir : '/real/tool',
    );

    await expect(
      linkPointsTo('/project/node_modules/tool', [
        '/global/v11/node_modules/tool',
        '/global/10/node_modules/tool',
      ]),
    ).resolves.toBe(true);
    expect(mocks.symlink).not.toHaveBeenCalled();
  });

  it('rebuilds a link that points somewhere else', async () => {
    // 指向旧版本装的那一份：链接与目标解析出来是两处
    readingOnly({ [LINK]: '/global/old/tool' });
    mocks.realpath.mockImplementation(async (dir: string) =>
      dir === LINK ? '/real/store/old/tool' : '/real/store/tool',
    );

    await expect(linkPointsTo(LINK, [TARGET])).resolves.toBe(false);

    await createSymlink(LINK, [TARGET]);
    expect(mocks.unlink).toHaveBeenCalledWith(LINK);
    expect(mocks.symlink).toHaveBeenCalledWith(TARGET, LINK, undefined);
  });

  it('rebuilds a dangling link whose target is gone too', async () => {
    // 链接本身解析不到：它是坏的，重建。两边 realpath 都失败时退回字面路径正好对得上
    // ——早前就是这么把空壳判成「已到位」，于是永远不重建
    const gone = vi.fn(async () => {
      throw new Error('gone');
    });

    readingOnly({ [LINK]: '/global/old/tool' });
    mocks.realpath.mockImplementation(gone);

    await expect(linkPointsTo(LINK, [TARGET])).resolves.toBe(false);
    await createSymlink(LINK, [TARGET]);
    expect(gone).toHaveBeenCalled();
    expect(mocks.symlink).toHaveBeenCalled();
  });

  it('rebuilds when the project entry is a plain directory', async () => {
    // node_modules/<pkg> 被解压/拷进来一份真实目录时 readlink 会 EINVAL，同样要重建
    mocks.readlink.mockRejectedValue(
      Object.assign(new Error('not a link'), { code: 'EINVAL' }),
    );

    await expect(
      linkPointsTo('/project/node_modules/tool', [TARGET]),
    ).resolves.toBe(false);
    await createSymlink(LINK, [TARGET]);
    expect(mocks.symlink).toHaveBeenCalled();
  });

  it('chooses the Windows link type by target kind', async () => {
    // 目录（包本体、node_modules 里的依赖）用 junction：不需要开发者模式或管理员权限；
    // 普通文件才用 file，file 类型对着目录必失败
    const platform = vi.spyOn(process, 'platform', 'get');
    mocks.readlink.mockRejectedValue(
      Object.assign(new Error('missing'), { code: 'ENOENT' }),
    );
    platform.mockReturnValue('win32');

    await createSymlink('/project/node_modules/tool', [
      '/global/node_modules/tool',
    ]);
    expect(mocks.symlink).toHaveBeenLastCalledWith(
      '/global/node_modules/tool',
      '/project/node_modules/tool',
      'junction',
    );

    await createSymlink(LINK, [TARGET]);
    expect(mocks.symlink).toHaveBeenLastCalledWith(TARGET, LINK, 'file');
    platform.mockRestore();
  });

  it('propagates unlink failures other than a missing link', async () => {
    mocks.unlink.mockRejectedValueOnce(new Error('cannot unlink'));

    await expect(createSymlink(LINK, [TARGET])).rejects.toThrow(
      'cannot unlink',
    );
  });
});

describe('probePath', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('tells a missing entry from a dangling link', async () => {
    // 两件事得分得开：名字都没占住是「要补」，名字占着却连不过去是「先撤再补」。
    // 后者光补补不上——`symlink` 对着已存在的条目一律 EEXIST
    mocks.lstat.mockRejectedValue(new Error('ENOENT'));
    mocks.stat.mockRejectedValue(new Error('ENOENT'));

    await expect(probePath(LINK)).resolves.toEqual({
      exists: false,
      alive: false,
    });

    // 断链：lstat 看得见那条链接本身，stat 跟过去是空的
    mocks.lstat.mockResolvedValue({});
    await expect(probePath(LINK)).resolves.toEqual({
      exists: true,
      alive: false,
    });

    // 指着的还在
    mocks.stat.mockResolvedValue({});
    await expect(probePath(LINK)).resolves.toEqual({
      exists: true,
      alive: true,
    });
  });
});

/** 造一棵只认这几条路径的目录树，别的一律解析不到 */
function fakeTree(files: Record<string, string>) {
  vi.doMock('node:module', async (importOriginal) => {
    const actual = await importOriginal<typeof import('node:module')>();

    return {
      ...actual,
      createRequire: () => ({
        resolve: (specifier: string) => {
          const found = files[specifier];

          if (!found) {
            throw Object.assign(new Error('MODULE_NOT_FOUND'), {
              code: 'MODULE_NOT_FOUND',
            });
          }

          return found;
        },
      }),
    };
  });
}

describe('findUnresolvedDeps', () => {
  const PKG_DIR = '/root/node_modules/tool';
  const OWN_DIR = `${PKG_DIR}/node_modules`;

  beforeEach(() => {
    vi.resetAllMocks();
    mocks.realpath.mockImplementation(async (target: string) => target);
    mocks.readFile.mockRejectedValue(new Error('ENOENT'));
  });

  /** 造一棵树再拿一份新的实现去查：`doMock` 只对之后的 import 生效 */
  async function resolveWith(files: Record<string, string>, names: string[]) {
    fakeTree(files);
    vi.resetModules();
    const fresh = await import('../src/fs.mts');

    return fresh.findUnresolvedDeps(PKG_DIR, names);
  }

  afterEach(() => {
    vi.doUnmock('node:module');
  });

  it('clears a dependency that really sits in the package', async () => {
    // pnpm 的链一层套一层，屋里那份解析出来也是 store 里的路径：
    // 拿字面路径比对，屋里这份会被判成「在外头」，于是永远判红
    mocks.realpath.mockImplementation(async (target: string) =>
      target === `${OWN_DIR}/moment` ? '/store/links/moment/2.31.0' : target,
    );

    await expect(
      resolveWith({ moment: '/store/links/moment/2.31.0/moment.js' }, [
        'moment',
      ]),
    ).resolves.toEqual([]);
  });

  it('names the dependencies nobody can resolve', async () => {
    await expect(resolveWith({}, ['moment', 'node:fs', 'fs'])).resolves.toEqual(
      ['moment'],
    );
  });

  it('lets a dependency without a root entry go when a subpath resolves', async () => {
    // @babel/runtime 这类包只给了 `exports` 的子路径，`require('@babel/runtime')`
    // 本来就不成立；它和「东西真缺了」的区别，只有那份 package.json 说得清。
    // 只认自己那份：别的包有没有 package.json 与这条判据无关
    mocks.readFile.mockImplementation(async (file: string) =>
      file === `${OWN_DIR}/@babel/runtime/package.json`
        ? JSON.stringify({ exports: { './regenerator': './regenerator.js' } })
        : Promise.reject(new Error('ENOENT')),
    );

    await expect(
      resolveWith(
        {
          // 子路径试的是包名最后那一段（`runtime`），取到的仍是包里的一条
          '@babel/runtime/runtime': `${OWN_DIR}/@babel/runtime/regenerator.js`,
        },
        ['@babel/runtime'],
      ),
    ).resolves.toEqual([]);
  });
});
