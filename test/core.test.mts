import { beforeEach, describe, expect, it, vi } from 'vitest';
import path from 'node:path';

const mocks = vi.hoisted(() => ({
  createSymlink: vi.fn(),
  ensureDir: vi.fn(),
  isWindows: true,
  readPackageJson: vi.fn(),
  resolveGlobalPkgDir: vi.fn(),
  symlink: vi.fn(),
  unlink: vi.fn(),
}));

vi.mock('../src/fs.mts', () => ({
  createSymlink: mocks.createSymlink,
  ensureDir: mocks.ensureDir,
  get isWindows() {
    return mocks.isWindows;
  },
  localBinDir: '/project/node_modules/.bin',
  pnpmGlobalPath: '/global/node_modules',
  readPackageJson: mocks.readPackageJson,
  resolveGlobalPkgDir: mocks.resolveGlobalPkgDir,
}));
vi.mock('node:fs', () => ({
  promises: {
    symlink: mocks.symlink,
    unlink: mocks.unlink,
  },
}));

const { linkPackageBins } = await import('../src/core.mts');

describe('linkPackageBins', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.isWindows = true;
    mocks.ensureDir.mockResolvedValue(true);
    mocks.unlink.mockRejectedValue({ code: 'ENOENT' });
    mocks.symlink.mockResolvedValue(undefined);
    mocks.createSymlink.mockResolvedValue(true);
    mocks.resolveGlobalPkgDir.mockImplementation(async (pkg: string) =>
      path.join('/global/node_modules', pkg),
    );
  });

  it('returns no results for an empty package list', async () => {
    await expect(linkPackageBins()).resolves.toEqual({ results: [] });
    expect(mocks.ensureDir).not.toHaveBeenCalled();
  });

  it('reports an unavailable local bin directory', async () => {
    mocks.ensureDir.mockResolvedValue(false);
    await expect(linkPackageBins(['tool'])).rejects.toThrow('无法创建目标目录');
  });

  it('reports missing and binless packages', async () => {
    mocks.readPackageJson.mockResolvedValueOnce(null).mockResolvedValueOnce({});

    await expect(linkPackageBins(['missing', 'library'])).resolves.toEqual({
      results: [
        { pkg: 'missing', commands: [], notFound: true },
        { pkg: 'library', commands: [], noBin: true },
      ],
    });
  });

  it('reports packages that cannot be located in the global store', async () => {
    // resolveGlobalPkgDir 在全局存储中找不到包目录时返回 null
    mocks.resolveGlobalPkgDir.mockResolvedValue(null);

    await expect(linkPackageBins(['ghost'])).resolves.toEqual({
      results: [{ pkg: 'ghost', commands: [], notFound: true }],
    });
    expect(mocks.readPackageJson).not.toHaveBeenCalled();
  });

  it('links all binaries and records individual failures', async () => {
    mocks.readPackageJson.mockResolvedValue({
      bin: { first: 'first.js', second: 'second.js' },
    });
    mocks.createSymlink
      .mockResolvedValueOnce(true)
      .mockRejectedValueOnce(new Error('link failed'));

    const result = await linkPackageBins(['tool']);

    expect(result.results[0]?.commands).toEqual(['first']);
    expect(result.results[0]?.errors?.[0]?.name).toBe('second');
  });

  it('links a string bin using the package name as the command name', async () => {
    mocks.readPackageJson.mockResolvedValue({ bin: './bin/cli.js' });

    const result = await linkPackageBins(['tool']);

    expect(result.results[0]?.commands).toEqual(['tool']);
    expect(mocks.createSymlink).toHaveBeenCalledWith(
      path.join('/global/node_modules', 'tool', 'bin/cli.js'),
      path.join('/project/node_modules/.bin', 'tool'),
    );
  });

  it('uses the unscoped package name for a scoped string bin', async () => {
    mocks.readPackageJson.mockResolvedValue({ bin: 'cli.js' });

    const result = await linkPackageBins(['@scope/tool']);

    expect(result.results[0]?.commands).toEqual(['tool']);
    expect(mocks.createSymlink).toHaveBeenCalledWith(
      path.join('/global/node_modules', '@scope/tool', 'cli.js'),
      path.join('/project/node_modules/.bin', 'tool'),
    );
  });

  it('continues after package linking and metadata errors', async () => {
    mocks.readPackageJson
      .mockRejectedValueOnce(new Error('metadata failed'))
      .mockResolvedValueOnce({ bin: { tool: 'tool.js' } });
    mocks.createSymlink.mockRejectedValueOnce(new Error('binary failed'));

    const result = await linkPackageBins(['broken', 'tool']);

    expect(result.results[0]?.errors?.[0]?.error.message).toBe(
      'metadata failed',
    );
    expect(result.results[1]?.errors?.[0]?.error.message).toBe('binary failed');
  });

  it('handles package link failures and Windows permission failures', async () => {
    mocks.readPackageJson.mockResolvedValueOnce({
      bin: { tool: 'tool.js' },
    });
    mocks.unlink.mockRejectedValueOnce(new Error('remove failed'));

    const linkFailure = await linkPackageBins(['link-failed']);
    expect(linkFailure.results[0]?.errors?.[0]?.error.message).toBe(
      'remove failed',
    );

    mocks.readPackageJson.mockResolvedValueOnce({
      bin: { tool: 'tool.js' },
    });
    mocks.createSymlink.mockRejectedValueOnce({
      code: 'EPERM',
      message: 'permission denied',
    });

    await expect(linkPackageBins(['permission-failed'])).rejects.toMatchObject({
      code: 'EPERM',
    });

    mocks.isWindows = false;
    mocks.readPackageJson.mockResolvedValueOnce({
      bin: { tool: 'tool.js' },
    });
    await expect(linkPackageBins(['unix-tool'])).resolves.toMatchObject({
      results: [{ commands: ['tool'] }],
    });
  });
});
