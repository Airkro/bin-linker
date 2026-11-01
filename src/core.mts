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
  normalizePkgName,
  resolveGlobalDepotDir,
  resolveGlobalPkgDirs,
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

/** 读目录下现有的条目名；目录还不存在时就是空集合 */
async function readDirNames(dir: string): Promise<Set<string>> {
  return new Set(await fs.readdir(dir).catch((): string[] => []));
}

/**
 * 链接是否已经指向 target（且真的存在）。
 *
 * 先 `realpath` 再 `readlink`，只在「解析结果对上」之后才确认链接本身还在
 * （`readlink` 对普通目录也会失败，正好说明它不是链接）。链接已就位是常态
 * （重跑、`pnpm <cmd>` 前置钩子），两个 syscall 就收工。
 */
async function linkPointsTo(link: string, target: string): Promise<boolean> {
  // 不存在、或压根不是链接（普通目录会 EINVAL）：都算「要重建」
  try {
    await fs.readlink(link);
  } catch {
    return false;
  }

  const realLink = await fs.realpath(link).catch(() => null);

  // 包路径解析不到就按原路径比
  const realTarget = await fs.realpath(target).catch(() => target);

  return realLink === realTarget;
}

/** 把全局包链进工程的 `node_modules`，让运行时能按包名找到它 */
async function linkPackage(pkgDirs: string[], pkg: string): Promise<void> {
  const link = path.join(process.cwd(), 'node_modules', pkg);

  try {
    await ensureDir(path.dirname(link));

    // 已经指对了就别动：原来每次都 unlink + symlink，重跑等于把所有链接重建一遍，
    // 还会让链接短暂消失（`pnpm <cmd>`、`npx` 这类前置钩子里跑一次尤其浪费）
    for (const pkgDir of pkgDirs) {
      if (await linkPointsTo(link, pkgDir)) {
        return;
      }
    }

    // 多个安装位置取第一份（版本目录按新到旧，优先最近装的那个）
    await fs.unlink(link).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') {
        throw error;
      }
    });
    await fs.symlink(pkgDirs[0] as string, link, getLinkType());
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
 * 这里补一层 `node_modules` 指回那张表，与工程里 `node_modules/<pkg>/node_modules/<dep>`
 * 的解析方式一致。
 *
 * 「缺哪些」只付一次 readdir：依赖表里列出来的就是这一版 pnpm 认为这个包该看得到的
 * 全部依赖，表里有、包里没有，就是缺。早前是逐依赖 `createRequire().resolve()`，
 * 每个都要走一遍 node 的解析算法（含读 package.json），只为回答一个 lstat 就能回答的问题。
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
  const deps = await fs.readdir(depotDir).catch((): string[] => []);
  const present = await readDirNames(depsNodeModules);
  const todo = deps.filter((dep) => !present.has(dep));

  if (todo.length === 0) {
    return false;
  }

  let linked = false;

  for (const dep of todo) {
    try {
      await ensureDir(depsNodeModules);
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
 * 明明后面还排着一份好的。读到的元数据直接带下去用，不再读第二遍。
 */
async function pickPackage(
  pkgDirs: string[],
): Promise<{ pkgDir: string; pkgJson: PackageMeta | null } | null> {
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
  binEntries: Array<[string, string]>,
): Promise<{ commands: string[]; errors: PkgResult['errors'] }> {
  const commands: string[] = [];
  const errors: NonNullable<PkgResult['errors']> = [];

  for (const [name, relPath] of binEntries) {
    try {
      await createSymlink(
        path.join(pkgDir, relPath),
        path.join(localBinDir, name),
      );
      commands.push(name);
    } catch (error) {
      errors.push({ name, error: rethrowPermissions(error) });
    }
  }

  return { commands, errors };
}

async function linkPackageBin(name: string): Promise<PkgResult> {
  const pkg = normalizePkgName(name);
  const pkgDirs = await resolveGlobalPkgDirs(name);

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
  const binEntries = getBinEntries(pkg, pkgJson?.bin);

  try {
    await linkPackage(pkgDirs, pkg);
  } catch (error) {
    return { pkg, errors: [{ name: pkg, error: error as Error }] };
  }

  if (binEntries.length === 0) {
    return { pkg, noBin: true };
  }

  // 补依赖与建命令链接互不相干，并行：补依赖要读 store 那张表，动辄几十个 syscall
  const [depsLinked, { commands, errors }] = await Promise.all([
    linkMissingDeps(pkgDir, binEntries[0]?.[1]).catch(() => false),
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
