import { execSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';

// 常量定义
export const isWindows = process.platform === 'win32';

export const pnpmGlobalPath = execSync('pnpm root -g', {
  encoding: 'utf8',
}).trim();

export const localBinDir = path.resolve(process.cwd(), 'node_modules', '.bin');

/**
 * 确保目录存在，如果不存在则创建
 */
export async function ensureDir(dir) {
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
const fileExists = async (filePath) =>
  fs
    .access(filePath)
    .then(() => true)
    .catch(() => false);

/**
 * 读取包的package.json文件
 */
export async function readPackageJson(pkg) {
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
export async function createSymlink(target, link) {
  // 检查目标是否存在
  if (!(await fileExists(target))) {
    throw new Error(`目标不存在: ${target}`);
  }

  // 如果链接已存在，先删除
  await fs.unlink(link).catch((error) => {
    if (error.code !== 'ENOENT') {
      throw error;
    } // 忽略文件不存在的错误
  });

  // 在 Windows 上使用 file 类型，因为我们链接的是可执行文件
  const type = isWindows ? 'file' : undefined;

  await fs.symlink(target, link, type);

  return true;
}
