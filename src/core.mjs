import path from 'node:path';
import { promises as fs } from 'node:fs';

import {
  createSymlink,
  ensureDir,
  isWindows,
  localBinDir,
  pnpmGlobalPath,
  readPackageJson,
} from './fs.mjs';

/**
 * 安全删除文件（忽略文件不存在的错误）
 */
async function safeUnlink(filePath) {
  try {
    await fs.unlink(filePath);
  } catch (error) {
    if (error.code !== 'ENOENT') {
      throw error;
    }
  }
}

/**
 * 处理Windows权限错误
 */
function handleWindowsPermError(error) {
  if (isWindows && error.code === 'EPERM') {
    throw error;
  }

  return error;
}

/**
 * 链接单个包
 */
async function linkPackage(pkg) {
  const packageTarget = path.join(pnpmGlobalPath, pkg);
  const packageLink = path.join(process.cwd(), 'node_modules', pkg);

  await ensureDir(path.dirname(packageLink));

  try {
    await safeUnlink(packageLink);
    const type = isWindows ? 'junction' : 'dir';
    await fs.symlink(packageTarget, packageLink, type);

    return true;
  } catch (error) {
    throw handleWindowsPermError(error);
  }
}

/**
 * 链接单个包的可执行文件
 */
async function linkPackageBin(pkg) {
  const pkgJson = await readPackageJson(pkg);

  if (!pkgJson) {
    return { pkg, commands: [], notFound: true };
  }

  try {
    await linkPackage(pkg);
  } catch (error) {
    return { pkg, commands: [], errors: [error] };
  }

  const binEntries = Object.entries(pkgJson.bin || {});

  if (binEntries.length === 0) {
    return { pkg, commands: [], noBin: true };
  }

  const result = { pkg, commands: [], errors: [] };

  for (const [name, relPath] of binEntries) {
    const target = path.join(pnpmGlobalPath, pkg, relPath);
    const link = path.join(localBinDir, name);

    try {
      await createSymlink(target, link);
      result.commands.push(name);
    } catch (error) {
      const processedError = handleWindowsPermError(error);
      result.errors.push({ name, error: processedError });
    }
  }

  return result;
}

/**
 * 链接多个包的可执行文件
 */
export async function linkPackageBins(packages = []) {
  if (packages.length === 0) {
    return { results: [] };
  }

  if (!(await ensureDir(localBinDir))) {
    throw new Error('无法创建目标目录');
  }

  const results = [];

  for (const pkg of packages) {
    try {
      results.push(await linkPackageBin(pkg));
    } catch (error) {
      const processedError = handleWindowsPermError(error);
      results.push({ pkg, errors: [processedError] });
    }
  }

  return { results };
}
