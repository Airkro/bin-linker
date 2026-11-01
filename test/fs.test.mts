import path from 'node:path';

import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  mkdir: vi.fn(),
  readFile: vi.fn(),
  readlink: vi.fn(),
  realpath: vi.fn(),
  symlink: vi.fn(),
  unlink: vi.fn(),
}));

vi.mock('node:fs', () => ({
  promises: {
    mkdir: mocks.mkdir,
    readFile: mocks.readFile,
    readlink: mocks.readlink,
    realpath: mocks.realpath,
    symlink: mocks.symlink,
    unlink: mocks.unlink,
  },
}));

const {
  createSymlink,
  ensureDir,
  getLinkType,
  isWindows,
  localBinDir,
  readPackageJson,
} = await import('../src/fs.mts');

const LINK = '/link';
const TARGET = '/target';

describe('filesystem helpers', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    // 默认：链接不存在（readlink 报 ENOENT），realpath 原样返回
    mocks.readlink.mockRejectedValue({ code: 'ENOENT' });
    mocks.realpath.mockImplementation(async (target: string) => target);
    mocks.unlink.mockResolvedValue(undefined);
    mocks.symlink.mockResolvedValue(undefined);
  });

  it('keeps links inside the project node_modules', () => {
    expect(localBinDir).toBe(
      path.resolve(process.cwd(), 'node_modules', '.bin'),
    );
  });

  it('creates directories and reports creation failures', async () => {
    await expect(ensureDir('/tmp/bin-linker')).resolves.toBe(true);

    mocks.mkdir.mockRejectedValueOnce(new Error('read-only'));
    await expect(ensureDir('/tmp/bin-linker')).resolves.toBe(false);
  });

  it('reads package metadata and swallows broken manifests', async () => {
    mocks.readFile.mockResolvedValueOnce('{"bin":{"tool":"cli.js"}}');
    await expect(readPackageJson('/global/tool')).resolves.toEqual({
      bin: { tool: 'cli.js' },
    });

    mocks.readFile.mockResolvedValueOnce('invalid json');
    await expect(readPackageJson('/global/tool')).resolves.toBeNull();

    mocks.readFile.mockRejectedValueOnce(new Error('no package.json'));
    await expect(readPackageJson('/global/tool')).resolves.toBeNull();
  });

  it('creates the link when nothing is there yet', async () => {
    await expect(createSymlink(LINK, [TARGET])).resolves.toBe(true);
    expect(mocks.symlink).toHaveBeenCalledWith(
      TARGET,
      LINK,
      // 目标是可执行文件：Windows 上必须是 file 类型，否则跑不起来
      isWindows ? 'file' : undefined,
    );
  });

  it('leaves a link that already points at the target', async () => {
    // 命令链接在重跑、`pnpm <cmd>` 前置钩子里是常态，重建纯属两次多余的写操作
    // readlink 先拿字面路径去比（省一次 realpath）——这里让字面路径就对得上
    mocks.readlink.mockResolvedValue(TARGET);

    await expect(createSymlink(LINK, [TARGET])).resolves.toBe(true);
    expect(mocks.unlink).not.toHaveBeenCalled();
    expect(mocks.symlink).not.toHaveBeenCalled();
  });

  it('accepts any of the candidate targets', async () => {
    // 包同时留在两个版本目录里，链接指着其中一份就算到位
    mocks.readlink.mockResolvedValue('/global/10/tool');

    await expect(
      createSymlink(LINK, ['/global/11/tool', '/global/10/tool']),
    ).resolves.toBe(true);
    expect(mocks.symlink).not.toHaveBeenCalled();
  });

  it('rebuilds a link that points somewhere else', async () => {
    mocks.readlink.mockResolvedValue('/real/stale/tool');
    mocks.realpath.mockImplementation(async (target: string) =>
      target === TARGET ? '/real/keyed/tool' : target,
    );

    await expect(createSymlink(LINK, [TARGET])).resolves.toBe(true);
    expect(mocks.unlink).toHaveBeenCalledWith(LINK);
    expect(mocks.symlink).toHaveBeenCalledWith(
      TARGET,
      LINK,
      isWindows ? 'file' : undefined,
    );
  });

  it('rebuilds a dangling link even when both paths fail to resolve', async () => {
    // 链接在，指向的地方已经没了：两边 realpath 都失败，退回字面路径正好对得上
    // ——早前就是这么把空壳判成「已到位」，于是永远不重建
    const gone = vi.fn(async () => {
      throw new Error('gone');
    });

    mocks.readlink.mockResolvedValue('/global/old/tool');
    mocks.realpath.mockImplementation(gone);

    await expect(createSymlink(LINK, [TARGET])).resolves.toBe(true);
    expect(gone).toHaveBeenCalled();
    expect(mocks.symlink).toHaveBeenCalled();
  });

  it('rebuilds when the link cannot be resolved at all', async () => {
    mocks.readlink.mockResolvedValue('/global/old/tool');

    await expect(createSymlink(LINK, [TARGET])).resolves.toBe(true);
    expect(mocks.symlink).toHaveBeenCalled();
  });

  it('rebuilds when the entry is a plain directory', async () => {
    // node_modules/<pkg> 被解压/拷进来一份真实目录时 readlink 会 EINVAL，同样要重建
    mocks.readlink.mockRejectedValue({ code: 'EINVAL' });

    await expect(createSymlink(LINK, [TARGET])).resolves.toBe(true);
    expect(mocks.symlink).toHaveBeenCalled();
  });

  it('tolerates a missing previous link', async () => {
    mocks.unlink.mockRejectedValueOnce({ code: 'ENOENT' });

    await expect(createSymlink(LINK, [TARGET])).resolves.toBe(true);
    expect(mocks.symlink).toHaveBeenCalled();
  });

  it('picks the link type by target kind', () => {
    // 链接目录（包本体、node_modules 里的依赖）用 junction：不需要开发者模式或管理员权限
    expect(getLinkType(undefined, 'win32')).toBe('junction');
    expect(getLinkType('/global/node_modules/tool', 'win32')).toBe('junction');
    // 普通文件才用 file
    expect(getLinkType('/global/node_modules/tool/cli.js', 'win32')).toBe(
      'file',
    );
    // 其它平台交给默认值
    expect(getLinkType('/global/node_modules/tool', 'linux')).toBeUndefined();
  });

  it('propagates unlink failures other than a missing link', async () => {
    mocks.unlink.mockRejectedValueOnce(new Error('cannot unlink'));

    await expect(createSymlink(LINK, [TARGET])).rejects.toThrow(
      'cannot unlink',
    );
  });
});
