import { promises as fs } from 'node:fs';
import path from 'node:path';

import {
  createSymlink,
  ensureDir,
  getLinkType,
  isWindows,
  localBinDir,
  readPackageJson,
  type PackageMeta,
} from './fs.mts';
import {
  isPnpmBinDirMissingFromPath,
  resolveGlobalDepotDir,
  resolveGlobalPkgDirs,
  toPkgName,
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

type BinEntries = Array<[name: string, relPath: string]>;

/** `bin` 是字符串时命令名取包名（去掉 scope 前缀） */
function getBinEntries(pkg: string, bin: PackageMeta['bin']): BinEntries {
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

/** 读目录下现有的条目名；目录还不存在时就是空集合 */
async function readDirNames(dir: string): Promise<Set<string>> {
  return new Set(await fs.readdir(dir).catch((): string[] => []));
}

/**
 * 把包自己解析不到的依赖补进它的 `node_modules`。
 *
 * pnpm 全局安装把真实包放在 store 里，依赖平铺在全局安装根的 `.pnpm/node_modules`。
 * node 按真实路径向上找依赖，从 store 那一层往上够不到全局安装根，包一 require
 * 间接依赖就 MODULE_NOT_FOUND（miniprogram-ci 的 moment 就是这么断的）。
 * 这里补一层 `node_modules` 指回那张表，与工程里 `node_modules/<pkg>/node_modules/<dep>`
 * 的解析方式一致。
 *
 * 「缺哪些」只付一次 readdir：依赖表里列出来的就是这一版 pnpm 认为这个包该看得到的
 * 全部依赖，表里有、包里没有，就是缺。
 *
 * 返回是否真的补上了东西；补不上不算错误，命令链接已经建好，缺哪个依赖交给运行时照实报错。
 */
export async function linkMissingDeps(pkgDir: string): Promise<boolean> {
  const depotDir = await resolveGlobalDepotDir();

  if (!depotDir) {
    return false;
  }

  const realPkgDir = await fs.realpath(pkgDir).catch(() => pkgDir);
  const depsNodeModules = path.join(realPkgDir, 'node_modules');
  const deps = await fs.readdir(depotDir).catch((): string[] => []);
  const present = await readDirNames(depsNodeModules);
  const todo = deps.filter((dep) => !present.has(dep));

  if (todo.length === 0) {
    return false;
  }

  let linked = false;

  for (const dep of todo) {
    try {
      if (!(await ensureDir(depsNodeModules))) {
        return linked;
      }

      // 依赖目录也是 store 里的真实目录，Windows 上与包本体一样用 junction
      await fs.symlink(
        path.join(depotDir, dep),
        path.join(depsNodeModules, dep),
        getLinkType(),
      );
      linked = true;
    } catch {
      // 补不上就算了：链接本身已经建好，缺哪个依赖交给运行时照实报错。
    }
  }

  return linked;
}

/**
 * 从候选安装位置里挑出真正能用的那一份，并只读一次 `package.json`。
 *
 * 同一个包可能同时留在好几个版本目录里（旧版本没清），指向 store 的软链也可能已经断了。
 * 读不到元数据就换下一个候选——早前是先挑第一个路径再去读，读不到直接报「找不到包」，
 * 明明后面还排着一份好的。
 */
async function pickPackage(pkgDirs: string[]) {
  for (const pkgDir of pkgDirs) {
    const pkgJson = await readPackageJson(pkgDir);

    if (pkgJson) {
      return { pkgDir, pkgJson };
    }
  }

  return null;
}

/** 把可执行文件逐个链进工程的 `node_modules/.bin`；某个失败不影响其余命令 */
async function linkBinEntries(
  pkgDir: string,
  binEntries: BinEntries,
): Promise<{ commands: string[]; errors: NonNullable<PkgResult['errors']> }> {
  const commands: string[] = [];
  const errors: NonNullable<PkgResult['errors']> = [];

  for (const [name, relPath] of binEntries) {
    try {
      await createSymlink(path.join(localBinDir, name), [
        path.join(pkgDir, relPath),
      ]);
      commands.push(name);
    } catch (error) {
      errors.push({ name, error: rethrowPermissions(error) });
    }
  }

  return { commands, errors };
}

async function linkPackageBin(input: string): Promise<PkgResult> {
  const pkg = toPkgName(input);
  const pkgDirs = await resolveGlobalPkgDirs(pkg);

  if (pkgDirs.length === 0) {
    // 全局 bin 目录不在 PATH 时 pnpm 自身的全局目录查询会失效，
    // 此时多半是把「环境没配好」误报成「包没安装」。
    return isPnpmBinDirMissingFromPath()
      ? { pkg, globalBinDir: true }
      : { pkg, notFound: true };
  }

  const picked = await pickPackage(pkgDirs);

  if (!picked) {
    return { pkg, notFound: true };
  }

  const { pkgDir, pkgJson } = picked;
  const binEntries = getBinEntries(pkg, pkgJson.bin);

  // 没有 bin 的包连本体都不用链：它只提供库，工程里用不着它
  if (binEntries.length === 0) {
    return { pkg, noBin: true };
  }

  try {
    // 多个安装位置取第一份（按新到旧，优先最近装的那个）
    await createSymlink(path.join(process.cwd(), 'node_modules', pkg), pkgDirs);
  } catch (error) {
    // 包链接失败只影响这一个包，按包记账即可；Windows 的 EPERM 要靠管理员权限解决，
    // 混进「这个包链接失败」里没人看得懂，交给 CLI 统一提示。
    throw rethrowPermissions(error);
  }

  // 补依赖与建命令链接互不相干，并行：补依赖要读 store 那张表，动辄几十个 syscall
  const [depsLinked, { commands, errors }] = await Promise.all([
    linkMissingDeps(pkgDir).catch(() => false),
    linkBinEntries(pkgDir, binEntries),
  ]);

  return { pkg, commands, errors, depsLinked };
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
