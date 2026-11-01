import path from 'node:path';

import {
  createSymlink,
  ensureDir,
  readDir,
  readPackageJson,
  resolvePath,
  type PackageMeta,
} from './fs.mts';
import { getLayout, isBinDirMissingFromPath } from './pnpm.mts';

/** 单个命令 / 单个依赖的成败 */
type Failure = { name: string; error: Error };

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
  errors?: Failure[];
};

/** 可执行文件的名字与其在包里的相对位置 */
type BinEntry = [name: string, relPath: string];

const projectDir = process.cwd();
/** 链接落在工程自己的 `node_modules` 里，与包管理器装出来的一致 */
const localBinDir = path.join(projectDir, 'node_modules', '.bin');

/**
 * 做一件事，成与不成互不牵连：返回 `null` 表示成了，否则是败因。
 *
 * 建命令链接、补依赖都是这个形状：一件事成不成不取决于旁边那件。
 */
function settle(task: Promise<unknown>): Promise<Error | null> {
  return task.then(
    () => null,
    (error: Error) => error,
  );
}

/** Windows 的 EPERM 只能靠管理员权限解决，交给 CLI 统一提示，别在这里吞掉 */
function toFailure(name: string, error: unknown): Failure {
  const { code } = error as NodeJS.ErrnoException;

  if (process.platform === 'win32' && code === 'EPERM') {
    throw error;
  }

  return { name, error: error as Error };
}

/** 从 `pkgDirs` 里挑第一个读得到元数据的位置，链断了的那份自动落到下一个 */
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

/** `bin` 是字符串时命令名取包名（去掉 scope 前缀） */
function getBinEntries(
  pkg: string,
  bin: NonNullable<PackageMeta['bin']>,
): BinEntry[] {
  return typeof bin === 'string'
    ? [[pkg.split('/').at(-1) as string, bin]]
    : Object.entries(bin);
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
  const { depot } = await getLayout();

  if (!depot) {
    return false;
  }

  const depsDir = path.join(await resolvePath(pkgDir), 'node_modules');
  const [table, present] = await Promise.all([
    readDir(depot),
    readDir(depsDir),
  ]);
  const missing = table.filter((dep) => !present.includes(dep));

  if (missing.length === 0) {
    return false;
  }

  await ensureDir(depsDir);

  // 依赖目录也是 store 里的真实目录，Windows 上与包本体一样建目录链接。
  // 有一个补上就算这一趟有收获，其余交给运行时。
  const attempts = await Promise.all(
    missing.map((dep) =>
      settle(createSymlink(path.join(depsDir, dep), [path.join(depot, dep)])),
    ),
  );

  return attempts.some((error) => !error);
}

/**
 * 把可执行文件逐个链进工程的 `node_modules/.bin`。
 *
 * 一个失败不影响其余命令：包本身已经就位，赔掉一个命令而已。
 */
async function linkBinEntries(
  pkgDir: string,
  binEntries: BinEntry[],
): Promise<{ commands: string[]; errors: Failure[] }> {
  const attempts = await Promise.all(
    binEntries.map(([name, relPath]) =>
      settle(
        createSymlink(path.join(localBinDir, name), [
          path.join(pkgDir, relPath),
        ]),
      ),
    ),
  );
  const commands: string[] = [];
  const errors: Failure[] = [];

  attempts.forEach((error, index) => {
    const [name] = binEntries[index] as BinEntry;

    if (error) {
      // 单个命令没链上而已，包与其余命令照常
      errors.push(toFailure(name, error));
    } else {
      commands.push(name);
    }
  });

  return { commands, errors };
}

async function linkPackageBin(
  pkg: string,
  candidates: string[],
): Promise<PkgResult> {
  const pkgDirs = candidates.map((dir) => path.join(dir, pkg));
  const picked = await pickPackage(pkgDirs);

  if (!picked) {
    // 全局 bin 目录不在 PATH 时 pnpm 自身的全局目录查询也会失效，
    // 一处候选都没有多半是「环境没配好」，不是「包没安装」。
    return isBinDirMissingFromPath() && pkgDirs.length === 0
      ? { pkg, globalBinDir: true }
      : { pkg, notFound: true };
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

  // 补依赖与建命令链接互不相干，并行：补依赖要读 store 那张表，动辄几十个 syscall。
  // 补依赖是附赠的，补不上不影响已建好的命令链接。
  const [depsLinked, { commands, errors }] = await Promise.all([
    linkMissingDeps(pkgDir).catch(() => false),
    linkBinEntries(pkgDir, binEntries),
  ]);

  return { pkg, commands, errors, depsLinked };
}

export async function linkPackageBins(
  packages: string[],
): Promise<PkgResult[]> {
  // 布局与包无关，一次算完给所有包用
  const { candidates } = await getLayout();

  // 一个包出错只赔上它自己：别让某个包的意外把整次运行炸掉
  return Promise.all(
    packages.map((pkg) =>
      linkPackageBin(pkg, candidates).catch((error: unknown) => ({
        pkg,
        errors: [toFailure(pkg, error)],
      })),
    ),
  );
}
