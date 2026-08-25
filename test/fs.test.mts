import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  access: vi.fn(),
  mkdir: vi.fn(),
  readFile: vi.fn(),
  unlink: vi.fn(),
  symlink: vi.fn(),
  execSync: vi.fn(() => '/global/node_modules\n'),
}));

vi.mock('node:child_process', () => ({ execSync: mocks.execSync }));
vi.mock('node:fs', () => ({
  promises: {
    access: mocks.access,
    mkdir: mocks.mkdir,
    readFile: mocks.readFile,
    unlink: mocks.unlink,
    symlink: mocks.symlink,
  },
}));

const { createSymlink, ensureDir, isWindows, readPackageJson } =
  await import('../src/fs.mts');

describe('filesystem helpers', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.execSync.mockReturnValue('/global/node_modules\n');
  });

  it('creates directories and reports creation failures', async () => {
    await expect(ensureDir('/tmp/bin-linker')).resolves.toBe(true);

    mocks.mkdir.mockRejectedValueOnce(new Error('read-only'));
    await expect(ensureDir('/tmp/bin-linker')).resolves.toBe(false);
  });

  it('reads valid packages and handles missing or invalid metadata', async () => {
    mocks.access.mockResolvedValueOnce(undefined);
    mocks.readFile.mockResolvedValueOnce('{"bin":{"tool":"cli.js"}}');
    await expect(readPackageJson('tool')).resolves.toEqual({
      bin: { tool: 'cli.js' },
    });

    mocks.access.mockRejectedValueOnce(new Error('missing'));
    await expect(readPackageJson('missing')).resolves.toBeNull();

    mocks.access.mockResolvedValueOnce(undefined);
    mocks.readFile.mockResolvedValueOnce('invalid json');
    await expect(readPackageJson('broken')).resolves.toBeNull();
  });

  it('creates symlinks and handles target and unlink errors', async () => {
    mocks.access.mockRejectedValueOnce(new Error('missing target'));
    await expect(createSymlink('/target', '/link')).rejects.toThrow(
      '目标不存在',
    );

    mocks.access.mockResolvedValueOnce(undefined);
    mocks.unlink.mockRejectedValueOnce({ code: 'ENOENT' });
    await expect(createSymlink('/target', '/link')).resolves.toBe(true);
    expect(mocks.symlink).toHaveBeenCalledWith(
      '/target',
      '/link',
      isWindows ? 'file' : undefined,
    );

    mocks.access.mockResolvedValueOnce(undefined);
    mocks.unlink.mockRejectedValueOnce(new Error('cannot unlink'));
    await expect(createSymlink('/target', '/link')).rejects.toThrow(
      'cannot unlink',
    );
  });

  it('resolves pnpm home defaults on macOS and Linux', async () => {
    const originalPlatform = process.platform;
    const originalPath = process.env.PATH;
    const originalXdgDataHome = process.env.XDG_DATA_HOME;
    const originalLocalAppData = process.env.LOCALAPPDATA;

    try {
      Object.defineProperty(process, 'platform', { value: 'darwin' });
      delete process.env.PATH;
      vi.resetModules();
      // @ts-expect-error Vitest supports query strings for isolated module imports.
      await import('../src/fs.mts?darwin');

      Object.defineProperty(process, 'platform', { value: 'linux' });
      process.env.XDG_DATA_HOME = '/data';
      vi.resetModules();
      // @ts-expect-error Vitest supports query strings for isolated module imports.
      const linuxFs = await import('../src/fs.mts?linux');
      mocks.access.mockResolvedValueOnce(undefined);
      mocks.unlink.mockRejectedValueOnce({ code: 'ENOENT' });
      await linuxFs.createSymlink('/target', '/link');

      delete process.env.XDG_DATA_HOME;
      vi.resetModules();
      // @ts-expect-error Vitest supports query strings for isolated module imports.
      await import('../src/fs.mts?linux-default');

      Object.defineProperty(process, 'platform', { value: 'win32' });
      delete process.env.LOCALAPPDATA;
      delete process.env.XDG_DATA_HOME;
      vi.resetModules();
      // @ts-expect-error Vitest supports query strings for isolated module imports.
      await import('../src/fs.mts?windows-default');
    } finally {
      Object.defineProperty(process, 'platform', { value: originalPlatform });
      if (originalPath === undefined) {
        delete process.env.PATH;
      } else {
        process.env.PATH = originalPath;
      }
      if (originalXdgDataHome === undefined) {
        delete process.env.XDG_DATA_HOME;
      } else {
        process.env.XDG_DATA_HOME = originalXdgDataHome;
      }
      if (originalLocalAppData === undefined) {
        delete process.env.LOCALAPPDATA;
      } else {
        process.env.LOCALAPPDATA = originalLocalAppData;
      }
    }
  });
});
