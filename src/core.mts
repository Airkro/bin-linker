import { promises as fs } from 'node:fs';
import path from 'node:path';

import {
  createSymlink,
  ensureDir,
  isWindows,
  localBinDir,
  projectDir,
  readPackageJson,
  tryLink,
  type PackageMeta,
} from './fs.mts';
import {
  findPackageDirs,
  isBinDirMissingFromPath,
  resolveDepotDir,
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
  /** 本次补上了包自己解析不到的依赖 */
  depsLinked?: boolean;
  errors?: Array<{ name: string; error: Error }>;
};

type BinEntries = Array<[name: string, relPath: string]>;
type Failures = NonNullable<PkgResult['errors']>;

/** `bin` 是字符串时命令名取包名（去掉 scope 前缀） */
function getBinEntries(
  pkg: string,
  bin: NonNullable<PackageMeta['bin']>,
): BinEntries {
  return typeof bin === 'string'
    ? [[pkg.split('/').at(-1) as string, bin]]
    : Object.entries(bin);
}

/** Windows 的 EPERM 要靠管理员权限解决（交给 CLI 统一提示），其它错误在本地处理掉 */
function rethrowPermissions(error: unknown): Error {
  if (isWindows && (error as NodeJS.ErrnoException).code === 'EPERM') {
    throw error;
  }

  return error as Error;
}

/**
 * 把包自己解析不到的依赖补进它的 `node_modules`，返回是否真的补上了东西。
 *
 * pnpm 全局安装把真实包放在 store 里，依赖平铺在全局安装根的 `.pnpm/node_modules`。
 * node 按真实路径向上找依赖，从 store 那一层往上够不到全局安装根，包一 require
 * 间接依赖就 MODULE_NOT_FOUND（miniprogram-ci 的 moment 就是这么断的）。
 * 这里补一层 `node_modules` 指回那张表，与工程里 `node_modules/<pkg>/node_modules/<dep>`
 * 的解析方式一致。
 *
 * 「缺哪些」只付两次 readdir：依赖表里列出来的就是这一版 pnpm 认为这个包该看得到的
 * 全部依赖，表里有、包里没有，就是缺。
 *
 * 补不上不算错误：命令链接已经建好，缺哪个依赖交给运行时照实报错。
 */
export async function linkMissingDeps(pkgDir: string): Promise<boolean> {
  const depotDir = await resolveDepotDir();

  if (!depotDir) {
    return false;
  }

  const depsDir = path.join(
    await fs.realpath(pkgDir).catch(() => pkgDir),
    'node_modules',
  );
  const [table, present] = await Promise.all([
    fs.readdir(depotDir).catch((): string[] => []),
    fs.readdir(depsDir).catch((): string[] => []),
  ]);
  const missing = table.filter((dep) => !present.includes(dep));

  if (missing.length === 0 || !(await ensureDir(depsDir))) {
    return false;
  }

  // 依赖目录也是 store 里的真实目录，Windows 上与包本体一样建目录链接。
  // 逐个试，别因为一个补不上就放弃其余；有一个补上就算这一趟有收获。
  const linked = await Promise.all(
    missing.map((dep) =>
      tryLink(path.join(depsDir, dep), [path.join(depotDir, dep)]),
    ),
  );

  return linked.includes(true);
}

/**
 * 把可执行文件逐个链进工程的 `node_modules/.bin`。
 *
 * 一个失败不影响其余命令：包本身已经就位，赔掉一个命令而已。
 */
async function linkBinEntries(
  pkgDir: string,
  binEntries: BinEntries,
): Promise<{ commands: string[]; errors: Failures }> {
  const commands: string[] = [];
  const errors: Failures = [];

  for (const [name, relPath] of binEntries) {
    try {
      await createSymlink(path.join(localBinDir, name), [
        path.join(pkgDir, relPath),
      ]);
      commands.push(name);
    } catch (error) {
      // Windows 的 EPERM 靠管理员权限解决，往上冒给 CLI 统一提示；
      // 其它错误只赔上这一个命令，包与其余命令照常
      errors.push({ name, error: rethrowPermissions(error) });
    }
  }

  return { commands, errors };
}

/**
 * 从候选安装位置里挑出真正能用的那一份，并顺手读一次 `package.json`。
 *
 * 同一个包可能同时留在好几个版本目录里（旧版本没清），指向 store 的软链也可能已经断了。
 * 读不到元数据就换下一个候选——早前是先挑第一个路径再去读，读不到直接报「找不到包」，
 * 明明后面还排着一份好的。
 */
async function pickPackage(
  pkgDirs: string[],
): Promise<[pkgDir: string, pkgJson: PackageMeta] | null> {
  for (const pkgDir of pkgDirs) {
    const pkgJson = await readPackageJson(pkgDir);

    if (pkgJson) {
      return [pkgDir, pkgJson];
    }
  }

  return null;
}

async function linkPackageBin(pkg: string): Promise<PkgResult> {
  const pkgDirs = await findPackageDirs(pkg);

  if (pkgDirs.length === 0) {
    // 全局 bin 目录不在 PATH 时 pnpm 自身的全局目录查询会失效，
    // 此时多半是把「环境没配好」误报成「包没安装」。
    return isBinDirMissingFromPath()
      ? { pkg, globalBinDir: true }
      : { pkg, notFound: true };
  }

  const picked = await pickPackage(pkgDirs);

  if (!picked) {
    return { pkg, notFound: true };
  }

  const [pkgDir, { bin }] = picked;
  const binEntries = bin ? getBinEntries(pkg, bin) : [];

  // 没有 bin 的包连本体都不用链：它只提供库，工程里用不着它
  if (binEntries.length === 0) {
    return { pkg, noBin: true };
  }

  // 包本体与全部命令都落在工程自己的 node_modules 里。
  // 候选位置按新到旧一起交给链接：任意一份已到位就不重建，要建就建最新那份。
  await createSymlink(path.join(projectDir, 'node_modules', pkg), pkgDirs);

  // 补依赖与建命令链接互不相干，并行：补依赖要读 store 那张表，动辄几十个 syscall
  const [depsLinked, { commands, errors }] = await Promise.all([
    linkMissingDeps(pkgDir).catch(() => false),
    linkBinEntries(pkgDir, binEntries),
  ]);

  return { pkg, commands, errors, depsLinked };
}

/** 一个包出错只赔上它自己：别让某个包的意外把整次运行炸掉 */
async function settle(pkg: string): Promise<PkgResult> {
  try {
    return await linkPackageBin(pkg);
  } catch (error) {
    return { pkg, errors: [{ name: pkg, error: rethrowPermissions(error) }] };
  }
}

export async function linkPackageBins(
  packages: string[],
): Promise<PkgResult[]> {
  if (!(await ensureDir(localBinDir))) {
    throw new Error('无法创建目标目录');
  }

  return Promise.all(packages.map((pkg) => settle(pkg)));
}
