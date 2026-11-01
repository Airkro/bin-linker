import path from 'node:path';

import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  access: vi.fn(),
  mkdir: vi.fn(),
  readFile: vi.fn(),
  symlink: vi.fn(),
  unlink: vi.fn(),
}));

vi.mock('node:fs', () => ({
  promises: {
    access: mocks.access,
    mkdir: mocks.mkdir,
    readFile: mocks.readFile,
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
    mocks.access.mockResolvedValueOnce(undefined);
    mocks.unlink.mockResolvedValueOnce(undefined);

    await expect(createSymlink('/target', '/link')).resolves.toBe(true);
    expect(mocks.unlink).toHaveBeenCalledWith('/link');
  });

  it('creates symlinks, replacing an existing link', async () => {
    mocks.access.mockResolvedValueOnce(undefined);
    mocks.unlink.mockRejectedValueOnce({ code: 'ENOENT' });

    await expect(createSymlink('/target', '/link')).resolves.toBe(true);
    expect(mocks.symlink).toHaveBeenCalledWith(
      '/target',
      '/link',
      isWindows ? 'file' : undefined,
    );
  });

  it('refuses to link a missing target', async () => {
    mocks.access.mockRejectedValueOnce(new Error('missing target'));

    await expect(createSymlink('/target', '/link')).rejects.toThrow(
      '目标不存在',
    );
    expect(mocks.symlink).not.toHaveBeenCalled();
  });

  it('only pins the link type on Windows', () => {
    expect(getLinkType('win32')).toBe('file');
    expect(getLinkType('linux')).toBeUndefined();
  });

  it('propagates unlink failures other than a missing link', async () => {
    mocks.access.mockResolvedValueOnce(undefined);
    mocks.unlink.mockRejectedValueOnce(new Error('cannot unlink'));

    await expect(createSymlink('/target', '/link')).rejects.toThrow(
      'cannot unlink',
    );
  });
});
