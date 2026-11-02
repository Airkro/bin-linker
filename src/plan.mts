import path from 'node:path';

import {
  isPackageEntry,
  readDir,
  readPackageJson,
  resolvePath,
  type PackageMeta,
} from './fs.mts';
import { getLayout, type PnpmLayout } from './layout.mts';
import type { LocateFailure } from './result.mts';

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

/**
 * 挑中的那一份包：位置、它自己那几层的依赖表、package.json 里的 bin。
 *
 * `root` 是包所在的那一层（`<内容寻址目录>/node_modules`）。依赖要按这一层去看，
 * 而不是按补进去的那张平铺表——见 `planDeps`。
 */
type Picked = {
  pkgDir: string;
  root: string;
  depots: (string | null)[];
  bin?: PackageMeta['bin'];
};

/** 一份计划，或者「没装上」的原因——两种结论都从这一个出口给出 */
export type Planned = LinkPlan | LocateFailure;

/**
 * 从布局的每一层里挑第一个读得到元数据的位置，链断了的那份自动落到下一个。
 *
 * 连同那几层的依赖表一起返回：补依赖得用包自己那层的表，别的层数出来的「缺哪些」不作数。
 */
async function pickPackage(
  layers: PnpmLayout['layers'],
  pkg: string,
): Promise<Picked | null> {
  for (const { pkgDir: dir } of layers) {
    const pkgDir = path.join(dir, pkg);
    const pkgJson = await readPackageJson(pkgDir);

    if (pkgJson) {
      // 同一个包目录可能因为好几张平铺表各出现一次，表要全带上
      const depots = layers
        .filter((layer) => layer.pkgDir === dir)
        .map((layer) => layer.depot);

      return { pkgDir, root: dir, depots, bin: pkgJson.bin };
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
 * pnpm 全局安装把真实包放在 store 里，直接依赖平铺在全局安装根的 `.pnpm/node_modules`。
 * node 按真实路径向上找依赖，从 store 那一层往上够不到全局安装根，包一 require
 * 依赖就 MODULE_NOT_FOUND（miniprogram-ci 的 moment 就是这么断的）。
 * 这里只算出缺哪些，补不补是执行阶段的事。
 *
 * 「该有哪些」按包所在的那一层算（`<内容寻址目录>/node_modules` 里指向 store 的软链），
 * 不按要补进去的那张平铺表算：表是全量的，装着别的安装留下的包；而补进去的链接
 * 只对包自己这一层有效，照表补等于把包里没有的全链一遍，多出来的那些会把
 * 包的 `node_modules` 撑到上百个。
 *
 * 换句话说：一个包缺的是「本该跟它装在一起、却被 pnpm 放在公共表里的那几份」，
 * 而它自己那层恰好就在告诉你哪几份才是它的。
 */
async function planDeps(
  pkgDir: string,
  root: string,
  depot: string | null,
): Promise<LinkPlan['deps']> {
  if (!depot) {
    return [];
  }

  // 补在包自己的真实目录里：工程 `node_modules` 里那条链接只是指过去，往链接里写等于改 store
  const realPkgDir = await resolvePath(pkgDir);
  const depsDir = path.join(realPkgDir, 'node_modules');
  // 同一层里指名给这个包的那几份，通常都已经躺平了；
  // 层里一份都没指名时（`pnpm root -g` 给出版本目录本身）不做补全
  const [here, table, present] = await Promise.all([
    readDir(root),
    readDir(depot),
    readDir(depsDir),
  ]);
  const installed = new Set(table);

  return here
    .filter(
      (dep) =>
        isPackageEntry(dep) && installed.has(dep) && !present.includes(dep),
    )
    .map((dep) => ({
      link: path.join(depsDir, dep),
      target: path.join(depot, dep),
    }));
}

/**
 * 把各层的补全并起来，同一个依赖只补一次。
 *
 * 平铺层与自己那一层常是同一个目录，同一个包会从两张表里各算出一遍；两处来源也可能
 * 各有一份同名依赖（版本不同），先出现的算数——它来自更靠前的那一层。
 */
function mergeDeps(...plans: LinkPlan['deps'][]): LinkPlan['deps'] {
  const deps = new Map<string, LinkPlan['deps'][number]>();

  for (const { link, target } of plans.flat()) {
    if (!deps.has(link)) {
      deps.set(link, { link, target });
    }
  }

  return [...deps.values()];
}

/**
 * 算出一个包要做的全部写操作；算不出来就是没装上，返回原因而不抛。
 *
 * `projectDir` 由调用方给：计划只描述「做什么」，不该自己去猜工程在哪。
 */
export async function planPackageLinks(
  pkg: string,
  projectDir: string,
): Promise<Planned> {
  // 布局与包无关，进程里只算一遍
  const { layers } = await getLayout();
  // 同一个包目录可能因为好几张平铺表各出现一次，候选只说位置
  const pkgDirs = [
    ...new Set(layers.map(({ pkgDir }) => path.join(pkgDir, pkg))),
  ];
  const picked = await pickPackage(layers, pkg);

  if (!picked) {
    return { pkg, pkgDirs, notFound: true };
  }

  const { pkgDir, root, depots, bin } = picked;
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
    deps: mergeDeps(
      ...(await Promise.all(
        depots.map((depot) => planDeps(pkgDir, root, depot)),
      )),
    ),
  };
}
