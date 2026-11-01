import path from 'node:path';
import { promises as fs } from 'node:fs';
import { createRequire } from 'node:module';

import {
  createSymlink,
  ensureDir,
  isPnpmBinDirMissingFromPath,
  isWindows,
  localBinDir,
  readPackageJson,
  resolveGlobalDepotDir,
  resolveGlobalPkgDir,
} from './fs.mts';

type PkgError = { name: string; error: Error };

type PkgResult = {
  pkg: string;
  commands?: string[];
  notFound?: boolean;
  noBin?: boolean;
  globalBinDir?: boolean;
  errors?: PkgError[];
  /** 依赖来自全局安装根（pnpm 全局布局下包自身的祖先链够不到它）时为 true */
  depsLinked?: boolean;
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
 * 站在某个文件的位置解析依赖，解析不到时返回 null。
 */
function resolveFrom(from: string, request: string): string | null {
  try {
    return createRequire(from).resolve(request);
  } catch {
    return null;
  }
}

/**
 * 把包自己解析不到的依赖补进它的 `node_modules`。
 *
 * pnpm 的全局安装把真实包放在 store 里（`<pkgDir>` 就是指向 store 的软链），
 * 依赖则平铺在全局安装根的 `.pnpm/node_modules`。node 按真实路径向上找依赖，
 * 从 store 那一层往上走够不到全局安装根，包一 require 间接依赖就 MODULE_NOT_FOUND
 * （miniprogram-ci 的 moment 就是这么断的）。
 *
 * 所以在真实包的目录里补一层 `node_modules`，每个包指回全局安装根那张表——
 * 与工程里 `node_modules/<pkg>/node_modules/<dep>` 的解析方式一致。
 * 只补真正解析不到的包：先站在包的入口上试一次，能解析的一概不动。
 */
async function linkMissingDeps(
  pkg: string,
  pkgDir: string,
  binEntries: Array<[string, string]>,
): Promise<boolean> {
  const depotDir = await resolveGlobalDepotDir();
  const pkgJson = binEntries.length > 0 ? null : await readPackageJson(pkg);
  const entry = binEntries[0]?.[1] ?? pkgJson?.main;

  if (!depotDir || !entry) {
    return false;
  }

  const realPkgDir = await fs.realpath(pkgDir).catch(() => pkgDir);
  const entryFile = path.join(realPkgDir, entry);
  const depsNodeModules = path.join(realPkgDir, 'node_modules');

  const deps = await fs.readdir(depotDir).catch((): string[] => []);

  let linked = false;

  for (const dep of deps) {
    // 已经解析得到的、上一次补过的，都不动，要补的只是少数几个
    const todo = !resolveFrom(entryFile, dep);
    const link = path.join(depsNodeModules, dep);

    if (todo && !(await fs.lstat(link).catch(() => null))) {
      try {
        await ensureDir(depsNodeModules);
        await fs.symlink(path.join(depotDir, dep), link, 'dir');
        linked = true;
      } catch {
        // 补不上就算了：链接本身已经建好，缺哪个依赖交给运行时照实报错。
      }
    }
  }

  return linked;
}

/**
 * 链接单个包的可执行文件
 */
async function linkPackageBin(pkg: string): Promise<PkgResult> {
  const pkgDir = await resolveGlobalPkgDir(pkg);

  if (!pkgDir) {
    // 全局 bin 目录不在 PATH 时 pnpm 自身的全局目录查询会失效，
    // 此时多半是把「环境没配好」误报成「包没安装」，需要区分提示。
    if (isPnpmBinDirMissingFromPath()) {
      return { pkg, commands: [], globalBinDir: true };
    }

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

  const result: PkgResult = {
    pkg,
    commands: [],
    errors: [],
    depsLinked: await linkMissingDeps(pkg, pkgDir, binEntries).catch(
      () => false,
    ),
  };

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
