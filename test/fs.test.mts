import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  access: vi.fn(),
  mkdir: vi.fn(),
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
    mkdir: mocks.mkdir,
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
  linkPointsTo,
  readDir,
  readPackageJson,
  resolvePath,
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
    // 默认：候选都存在
    mocks.access.mockResolvedValue(undefined);
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
