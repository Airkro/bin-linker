import { execSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// 常量定义
export const isWindows = process.platform === 'win32';

/**
 * pnpm 11 checks that its global bin directory is in PATH even for `root -g`.
 * Temporarily add the likely pnpm home/bin locations so the query remains
 * compatible with pnpm 10 and pnpm 11, then restore the caller's environment.
 */
function getPnpmGlobalPath(): string {
  const {
    PATH: originalPath,
    npm_config_global_bin_dir: globalBinDir,
    PNPM_HOME: pnpmHome,
    LOCALAPPDATA: localAppData,
    XDG_DATA_HOME: xdgDataHome,
  } = process.env;
  const configuredBinDirs = [
    globalBinDir,
    pnpmHome && path.join(pnpmHome, 'bin'),
    pnpmHome,
  ].filter(Boolean);

  const defaultHome = (() => {
    if (isWindows) {
      return localAppData
        ? path.join(localAppData, 'pnpm')
        : path.join(os.homedir(), 'AppData', 'Local', 'pnpm');
    }

    if (process.platform === 'darwin') {
      return path.join(os.homedir(), 'Library', 'pnpm');
    }

    return path.join(
      xdgDataHome ?? path.join(os.homedir(), '.local', 'share'),
      'pnpm',
    );
  })();

  const pathEntries = (process.env.PATH ?? '').split(path.delimiter);
  process.env.PATH = [
    ...new Set([
      ...configuredBinDirs,
      path.join(defaultHome, 'bin'),
      ...pathEntries,
    ]),
  ].join(path.delimiter);

  try {
    return execSync('pnpm root -g', { encoding: 'utf8' }).trim();
  } finally {
    if (originalPath === undefined) {
      delete process.env.PATH;
    } else {
      process.env.PATH = originalPath;
    }
  }
}

export const pnpmGlobalPath = getPnpmGlobalPath();

export const localBinDir = path.resolve(process.cwd(), 'node_modules', '.bin');

/**
 * 确保目录存在，如果不存在则创建
 */
export async function ensureDir(dir: string): Promise<boolean> {
  try {
    await fs.mkdir(dir, { recursive: true });

    return true;
  } catch {
    return false;
  }
}

/**
 * 检查文件是否存在
 */
const fileExists = async (filePath: string): Promise<boolean> =>
  fs
    .access(filePath)
    .then(() => true)
    .catch(() => false);

/**
 * 读取包的package.json文件
 */
export async function readPackageJson(
  pkg: string,
): Promise<{ bin?: Record<string, string> } | null> {
  const pkgPath = path.join(pnpmGlobalPath, pkg, 'package.json');

  if (!(await fileExists(pkgPath))) {
    return null;
  }

  try {
    const content = await fs.readFile(pkgPath, 'utf8');

    return JSON.parse(content);
  } catch {
    return null;
  }
}

/**
 * 创建符号链接
 */
export async function createSymlink(
  target: string,
  link: string,
): Promise<boolean> {
  // 检查目标是否存在
  if (!(await fileExists(target))) {
    throw new Error(`目标不存在: ${target}`);
  }

  // 如果链接已存在，先删除
  await fs.unlink(link).catch((error) => {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw error;
    } // 忽略文件不存在的错误
  });

  // 在 Windows 上使用 file 类型，因为我们链接的是可执行文件
  const type = isWindows ? 'file' : undefined;

  await fs.symlink(target, link, type);

  return true;
}
