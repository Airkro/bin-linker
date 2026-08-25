import path from 'node:path';
import { promises as fs } from 'node:fs';

import {
  createSymlink,
  ensureDir,
  isWindows,
  localBinDir,
  readPackageJson,
  resolveGlobalPkgDir,
} from './fs.mts';

type PkgError = { name: string; error: Error };

type PkgResult = {
  pkg: string;
  commands?: string[];
  notFound?: boolean;
  noBin?: boolean;
  errors?: PkgError[];
};

function getBinEntries(
  pkg: string,
  bin: string | Record<string, string> | undefined,
): Array<[string, string]> {
  if (typeof bin === 'string') {
    return [[path.basename(pkg), bin]];
  }

  return Object.entries(bin ?? {});
}

/**
 * 安全删除文件（忽略文件不存在的错误）
 */
async function safeUnlink(filePath: string): Promise<void> {
  try {
    await fs.unlink(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw error;
    }
  }
}

/**
 * 处理Windows权限错误
 */
function handleWindowsPermError(error: unknown): Error {
  if (isWindows && (error as NodeJS.ErrnoException).code === 'EPERM') {
    throw error;
  }

  return error as Error;
}

/**
 * 链接单个包
 */
async function linkPackage(pkg: string, pkgDir: string): Promise<boolean> {
  const packageTarget = pkgDir;
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
async function linkPackageBin(pkg: string): Promise<PkgResult> {
  const pkgDir = await resolveGlobalPkgDir(pkg);

  if (!pkgDir) {
    return { pkg, commands: [], notFound: true };
  }

  const pkgJson = await readPackageJson(pkg);

  if (!pkgJson) {
    return { pkg, commands: [], notFound: true };
  }

  try {
    await linkPackage(pkg, pkgDir);
  } catch (error) {
    return {
      pkg,
      commands: [],
      errors: [{ name: pkg, error: error as Error }],
    };
  }

  const binEntries = getBinEntries(pkg, pkgJson.bin);

  if (binEntries.length === 0) {
    return { pkg, commands: [], noBin: true };
  }

  const result: PkgResult = { pkg, commands: [], errors: [] };

  for (const [name, relPath] of binEntries) {
    const target = path.join(pkgDir, relPath);
    const link = path.join(localBinDir, name);

    try {
      await createSymlink(target, link);
      (result.commands ??= []).push(name);
    } catch (error) {
      const processedError = handleWindowsPermError(error);
      (result.errors ??= []).push({ name, error: processedError });
    }
  }

  return result;
}

/**
 * 链接多个包的可执行文件
 */
export async function linkPackageBins(
  packages: string[] = [],
): Promise<{ results: PkgResult[] }> {
  if (packages.length === 0) {
    return { results: [] };
  }

  if (!(await ensureDir(localBinDir))) {
    throw new Error('无法创建目标目录');
  }

  const results: PkgResult[] = [];

  for (const pkg of packages) {
    try {
      results.push(await linkPackageBin(pkg));
    } catch (error) {
      const processedError = handleWindowsPermError(error);
      results.push({ pkg, errors: [{ name: pkg, error: processedError }] });
    }
  }

  return { results };
}
