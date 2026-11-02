import path from 'node:path';

import {
  isPackageEntry,
  probePath,
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
  /** 断掉的依赖链接：先撤掉再重建，留着它 `symlink` 一律 EEXIST */
  stale: string[];
  /** 包自己声明的依赖名，补完之后照这份清单验一遍 */
  declared: string[];
};

/**
 * 挑中的那一份包：位置、它自己那几层的依赖表、package.json 里的 bin。
 */
type Picked = {
  pkgDir: string;
  depots: (string | null)[];
  bin?: PackageMeta['bin'];
  deps?: string[];
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

      return {
        pkgDir,
        depots,
        bin: pkgJson.bin,
        deps: Object.keys(pkgJson.dependencies ?? {}),
      };
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
 * pnpm 全局安装把真实包放在 store 里，依赖平铺在内容寻址目录的 `.pnpm/node_modules`。
 * node 按真实路径向上找依赖，从 store 那一层往上够不到全局安装根，包一 require
 * 依赖就 MODULE_NOT_FOUND（miniprogram-ci 的 moment 就是这么断的）。
 * 这里只算出缺哪些，补不补是执行阶段的事。
 *
 * 「该有哪些」既不能只看包自己那一层，也不能只看 `package.json` 里的 `dependencies`：
 * - 只数那一层的条目，间接依赖（moment 压根没在 miniprogram-ci 的 `dependencies` 里出现，
 *   它的 `node_modules` 里也没有）永远算不出来——按包名补一份 moment 就绿过一版，
 *   换一个包又断；
 * - 只认 `dependencies` 同样漏：`moment` 是 `moment-timezone` 的依赖，包只会 require 它。
 *
 * 所以补的是整张平铺表：它是 pnpm 按这一层的完整依赖图算出来的，一个不少，
 * 版本也是 pnpm 自己定的，不会出现两份不同版本抢同一个名字。代价是包里多出几百条链接，
 * 都在 store 里那一个包的目录下，不占工程、不影响别处。
 */
async function planDeps(
  pkgName: string,
  pkgDir: string,
  depot: string | null,
): Promise<{ deps: LinkPlan['deps']; stale: string[] }> {
  const empty = { deps: [], stale: [] };

  if (!depot) {
    return empty;
  }

  // 补在包自己的真实目录里：工程 `node_modules` 里那条链接只是指过去，往链接里写等于改 store
  const realPkgDir = await resolvePath(pkgDir);
  const depsDir = path.join(realPkgDir, 'node_modules');
  const table = await readDir(depot);
  const deps = table
    .filter((dep) => dep !== pkgName && isPackageEntry(dep))
    .map((dep) => ({
      link: path.join(depsDir, dep),
      target: path.join(depot, dep),
    }));

  // 已在的那份只留真还活着的：链接可能指着上一次安装的版本目录
  // （`global/v11/<旧哈希>`），pnpm 重装之后那一层连同里面的包一起被删，
  // 链接就成了断链——名字还在、`readdir` 也看得见，`require` 却一个都解析不到。
  // 不撤掉它还会一直赖着：`symlink` 对着已存在的条目一律 EEXIST，补依赖直接放弃。
  const probes = await Promise.all(deps.map(({ link }) => probePath(link)));

  return {
    // 名字没占住的直接补；占着却连不过去的也在这一份里——先撤再补
    deps: deps.filter(
      (_, index) => !probes[index]?.exists || !probes[index]?.alive,
    ),
    stale: deps
      .filter((_, index) => probes[index]?.exists && !probes[index]?.alive)
      .map(({ link }) => link),
  };
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

/** 把各层的断链并起来，同一个位置只撤一次 */
function mergeStale(...plans: LinkPlan['stale'][]): string[] {
  return [...new Set(plans.flat())];
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

  const { pkgDir, depots, bin, deps: declared = [] } = picked;
  const binEntries = bin ? getBinEntries(pkg, bin) : [];

  // 没有 bin 的包连本体都不用链：它只提供库，工程里用不着它
  if (binEntries.length === 0) {
    return { pkg, pkgDirs, noBin: true };
  }

  const planned = await Promise.all(
    depots.map((depot) => planDeps(pkg, pkgDir, depot)),
  );

  return {
    pkgDir,
    pkgDirs,
    pkgLink: path.join(projectDir, 'node_modules', pkg),
    binEntries,
    deps: mergeDeps(...planned.map(({ deps }) => deps)),
    stale: mergeStale(...planned.map(({ stale }) => stale)),
    declared,
  };
}
