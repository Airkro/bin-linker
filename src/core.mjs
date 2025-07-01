import path from 'node:path';

import {
  createSymlink,
  ensureDir,
  isWindows,
  localBinDir,
  pnpmGlobalPath,
  readPackageJson,
} from './fs.mjs';

/**
 * 链接单个包的可执行文件
 */
async function linkPackage(pkg) {
  const pkgJson = await readPackageJson(pkg);

  if (!pkgJson) {
    return { pkg, commands: [], notFound: true };
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
      result.errors.push({ name, error });

      if (isWindows && error.code === 'EPERM') {
        throw error;
      }
    }
  }

  return result;
}

/**
 * 链接多个包的可执行文件
 */
export async function linkPackages(packages = []) {
  if (packages.length === 0) {
    return { results: [] };
  }

  if (!(await ensureDir(localBinDir))) {
    throw new Error('无法创建目标目录');
  }

  const results = [];

  for (const pkg of packages) {
    try {
      results.push(await linkPackage(pkg));
    } catch (error) {
      if (error.code === 'EPERM') {
        throw error;
      }

      results.push({ pkg, errors: [error] });
    }
  }

  return { results };
}
