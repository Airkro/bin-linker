import path from 'node:path';

import {
  readDir,
  readPackageJson,
  resolvePath,
  type PackageMeta,
} from './fs.mts';
import { getLayout, type PnpmLayout } from './layout.mts';

/** 可执行文件的名字与其在包里的相对位置 */
export type BinEntry = [name: string, relPath: string];

/** 一个包要做的全部写操作，出落成这份计划时磁盘上什么都还没动 */
export type LinkPlan = {
  /** 包本体落在工程 `node_modules` 里的位置 */
  pkgLink: string;
  /** 包本体的候选来源，顺序即优先级 */
  pkgDirs: string[];
  /** 实际读到元数据的那一份，它的路径才是命令与依赖该用的路径 */
  pkgDir: string;
  binEntries: BinEntry[];
  /** 要补进包里的依赖：链接位置与来源 */
  deps: { link: string; target: string }[];
};

/** 挑中的那一份包：位置、它自己那一层的依赖表、package.json 里的 bin */
type Picked = {
  pkgDir: string;
  depot: string | null;
  bin?: PackageMeta['bin'];
};

/**
 * 没装上：包里没有可执行文件，或全局目录里压根找不到它。
 *
 * `globalBinDir` 与 `notFound` 之所以分开，是因为前者能修（`pnpm setup`），
 * 后者只能装上——CLI 给的提示完全不同。
 */
export type LocateFailure = Pick<LinkPlan, 'pkgDirs'> & {
  pkg: string;
  noBin?: boolean;
  notFound?: boolean;
  globalBinDir?: boolean;
};

/**
 * 从布局的每一层里挑第一个读得到元数据的位置，链断了的那份自动落到下一个。
 *
 * 连同那一层的依赖表一起返回：补依赖得用包自己那层的表，别的层数出来的「缺哪些」不作数。
 */
async function pickPackage(
  layers: PnpmLayout['layers'],
  pkg: string,
): Promise<Picked | null> {
  for (const { pkgDir: dir, depot } of layers) {
    const pkgDir = path.join(dir, pkg);
    const pkgJson = await readPackageJson(pkgDir);

    if (pkgJson) {
      return { pkgDir, depot, bin: pkgJson.bin };
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
 * 包自己解析不到的依赖，返回「缺的那些」以及该从哪里补。
 *
 * pnpm 全局安装把真实包放在 store 里，依赖平铺在全局安装根的 `.pnpm/node_modules`。
 * node 按真实路径向上找依赖，从 store 那一层往上够不到全局安装根，包一 require
 * 间接依赖就 MODULE_NOT_FOUND（miniprogram-ci 的 moment 就是这么断的）。
 * 这里只算出缺哪些，补不补是执行阶段的事。
 *
 * 「缺哪些」只付两次 readdir：依赖表里列出来的就是这一版 pnpm 认为这个包该看得到的
 * 全部依赖，表里有、包里没有，就是缺。
 */
async function planDeps(
  pkgDir: string,
  depot: string | null,
): Promise<LinkPlan['deps']> {
  if (!depot) {
    return [];
  }

  const realPkgDir = await resolvePath(pkgDir);
  const depsDir = path.join(realPkgDir, 'node_modules');
  const [table, present] = await Promise.all([
    readDir(depot),
    readDir(depsDir),
  ]);

  return table
    .filter((dep) => !present.includes(dep))
    .map((dep) => ({
      link: path.join(depsDir, dep),
      target: path.join(depot, dep),
    }));
}

/**
 * 算出一个包要做的全部写操作；算不出来就是没装上，返回原因而不抛。
 *
 * `projectDir` 由调用方给：计划只描述「做什么」，不该自己去猜工程在哪。
 */
export async function planPackageLinks(
  pkg: string,
  projectDir: string,
): Promise<LinkPlan | LocateFailure> {
  // 布局与包无关，进程里只算一遍
  const { layers } = await getLayout();
  const pkgDirs = layers.map(({ pkgDir }) => path.join(pkgDir, pkg));
  const picked = await pickPackage(layers, pkg);

  if (!picked) {
    return { pkg, pkgDirs, notFound: true };
  }

  const { pkgDir, depot, bin } = picked;
  const binEntries = bin ? getBinEntries(pkg, bin) : [];

  // 没有 bin 的包连本体都不用链：它只提供库，工程里用不着它
  if (binEntries.length === 0) {
    return { pkg, pkgDirs, noBin: true };
  }

  return {
    pkgDir,
    pkgDirs,
    pkgLink: path.join(projectDir, 'node_modules', pkg),
    binEntries,
    deps: await planDeps(pkgDir, depot),
  };
}
