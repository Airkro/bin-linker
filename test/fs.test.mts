import path from 'node:path';

import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  mkdir: vi.fn(),
  readFile: vi.fn(),
  readlink: vi.fn(),
  symlink: vi.fn(),
  unlink: vi.fn(),
}));

vi.mock('node:fs', () => ({
  promises: {
    mkdir: mocks.mkdir,
    readFile: mocks.readFile,
    readlink: mocks.readlink,
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

describe('filesystem helpers', () => {
  beforeEach(() => {
    vi.resetAllMocks();
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

  it('replaces an existing link', async () => {
    mocks.readlink.mockRejectedValueOnce({ code: 'ENOENT' });
    mocks.unlink.mockResolvedValueOnce(undefined);

    await expect(createSymlink('/target', '/link')).resolves.toBe(true);
    expect(mocks.unlink).toHaveBeenCalledWith('/link');
  });

  it('leaves a link that already points at the target', async () => {
    // 命令链接在重跑、`pnpm <cmd>` 前置钩子里是常态，重建纯属两次多余的写操作
    mocks.readlink.mockResolvedValueOnce('/target');

    await expect(createSymlink('/target', '/link')).resolves.toBe(true);
    expect(mocks.unlink).not.toHaveBeenCalled();
    expect(mocks.symlink).not.toHaveBeenCalled();
  });

  it('creates symlinks, replacing an existing link', async () => {
    mocks.readlink.mockRejectedValueOnce({ code: 'ENOENT' });
    mocks.unlink.mockRejectedValueOnce({ code: 'ENOENT' });

    await expect(createSymlink('/target', '/link')).resolves.toBe(true);
    expect(mocks.symlink).toHaveBeenCalledWith(
      '/target',
      '/link',
      // 目标是可执行文件：Windows 上必须是 file 类型，否则跑不起来
      isWindows ? 'file' : undefined,
    );
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
    mocks.readlink.mockRejectedValueOnce({ code: 'ENOENT' });
    mocks.unlink.mockRejectedValueOnce(new Error('cannot unlink'));

    await expect(createSymlink('/target', '/link')).rejects.toThrow(
      'cannot unlink',
    );
  });
});
