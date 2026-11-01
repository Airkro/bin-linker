import { promises as fs } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

import {
  createSymlink,
  ensureDir,
  isWindows,
  localBinDir,
  readPackageJson,
  type PackageMeta,
} from './fs.mts';
import {
  isPnpmBinDirMissingFromPath,
  resolveGlobalDepotDir,
  resolveGlobalPkgDir,
} from './pnpm.mts';

export type PkgResult = {
  pkg: string;
  /** 链接成功的命令名 */
  commands?: string[];
  /** 全局目录里找不到这个包 */
  notFound?: boolean;
  /** 包没有可执行文件 */
  noBin?: boolean;
  /** pnpm 的全局 bin 目录不在 PATH，定位不了包 */
  globalBinDir?: boolean;
  errors?: Array<{ name: string; error: Error }>;
  /** 本次补上了包自己解析不到的依赖 */
  depsLinked?: boolean;
};

/** `bin` 是字符串时命令名取包名（去掉 scope 前缀） */
function getBinEntries(
  pkg: string,
  bin: PackageMeta['bin'],
): Array<[string, string]> {
  if (typeof bin === 'string') {
    return [[pkg.split('/').at(-1) as string, bin]];
  }

  return Object.entries(bin ?? {});
}

/** Windows 的 EPERM 要靠管理员权限解决，其它错误在本地处理掉 */
function rethrowPermissions(error: unknown): Error {
  if (isWindows && (error as NodeJS.ErrnoException).code === 'EPERM') {
    throw error;
  }

  return error as Error;
}

/** 把全局包链进工程的 `node_modules`，让运行时能按包名找到它 */
async function linkPackage(pkgDir: string, pkg: string): Promise<void> {
  const link = path.join(process.cwd(), 'node_modules', pkg);

  try {
    await ensureDir(path.dirname(link));
    // 上一次的链接（或残留目录）先删掉，重跑才是幂等的
    await fs.unlink(link).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') {
        throw error;
      }
    });
    await fs.symlink(pkgDir, link, isWindows ? 'junction' : 'dir');
  } catch (error) {
    // 包链接失败只影响这一个包，按包记账即可；Windows 的 EPERM 要靠管理员权限解决，
    // 混进「这个包链接失败」里没人看得懂，交给 CLI 统一提示。
    throw rethrowPermissions(error);
  }
}

/**
 * 把包自己解析不到的依赖补进它的 `node_modules`。
 *
 * pnpm 全局安装把真实包放在 store 里，依赖平铺在全局安装根的 `.pnpm/node_modules`。
 * node 按真实路径向上找依赖，从 store 那一层往上够不到全局安装根，包一 require
 * 间接依赖就 MODULE_NOT_FOUND（miniprogram-ci 的 moment 就是这么断的）。
 * 这里补一层 `node_modules` 指回那张表，只补真正解析不到的：能解析的一概不动。
 *
 * 返回是否真的补上了东西；补不上不算错误，命令链接已经建好，缺哪个依赖交给运行时照实报错。
 */
export async function linkMissingDeps(
  pkgDir: string,
  entry: string | undefined,
): Promise<boolean> {
  const depotDir = entry && (await resolveGlobalDepotDir());

  if (!depotDir) {
    return false;
  }

  const realPkgDir = await fs.realpath(pkgDir).catch(() => pkgDir);
  const depsNodeModules = path.join(realPkgDir, 'node_modules');
  const resolveFrom = createRequire(path.join(realPkgDir, entry));
  const canResolve = (dep: string): boolean => {
    try {
      resolveFrom.resolve(dep);

      return true;
    } catch {
      return false;
    }
  };

  let linked = false;

  for (const dep of await fs.readdir(depotDir).catch((): string[] => [])) {
    try {
      // 已经解析得到的、上一次补过的，都不动，要补的只是少数几个
      if (
        !canResolve(dep) &&
        !(await fs.lstat(path.join(depsNodeModules, dep)).catch(() => null))
      ) {
        await ensureDir(depsNodeModules);
        await fs.symlink(
          path.join(depotDir, dep),
          path.join(depsNodeModules, dep),
          'dir',
        );
        linked = true;
      }
    } catch {
      // 补不上就算了：链接本身已经建好，缺哪个依赖交给运行时照实报错。
    }
  }

  return linked;
}

async function linkPackageBin(pkg: string): Promise<PkgResult> {
  const pkgDir = await resolveGlobalPkgDir(pkg);

  if (!pkgDir) {
    // 全局 bin 目录不在 PATH 时 pnpm 自身的全局目录查询会失效，
    // 此时多半是把「环境没配好」误报成「包没安装」。
    return isPnpmBinDirMissingFromPath()
      ? { pkg, globalBinDir: true }
      : { pkg, notFound: true };
  }

  const pkgJson = await readPackageJson(pkgDir);
  const binEntries = getBinEntries(pkg, pkgJson?.bin);

  try {
    await linkPackage(pkgDir, pkg);
  } catch (error) {
    return { pkg, errors: [{ name: pkg, error: error as Error }] };
  }

  if (binEntries.length === 0) {
    return { pkg, noBin: true };
  }

  const result: PkgResult = {
    pkg,
    commands: [],
    errors: [],
    depsLinked: await linkMissingDeps(pkgDir, binEntries[0]?.[1]).catch(
      () => false,
    ),
  };

  for (const [name, relPath] of binEntries) {
    try {
      await createSymlink(
        path.join(pkgDir, relPath),
        path.join(localBinDir, name),
      );
      result.commands?.push(name);
    } catch (error) {
      result.errors?.push({ name, error: rethrowPermissions(error) });
    }
  }

  return result;
}

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
      results.push({
        pkg,
        errors: [{ name: pkg, error: rethrowPermissions(error) }],
      });
    }
  }

  return { results };
}
