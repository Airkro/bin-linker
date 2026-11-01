import { promises as fs } from 'node:fs';
import path from 'node:path';

import { hasEntries, isPackageEntry, readDir } from './fs.mts';
import { getPnpmHome } from './pnpm.mts';
import { queryGlobalRoot } from './query.mts';

/** 一个布局根的 `node_modules` 层：本身就是 node_modules 时原样，否则挂在它下面 */
function nodeModulesIn(root: string): string {
  return path.basename(root) === 'node_modules'
    ? root
    : path.join(root, 'node_modules');
}

/** 一个布局根下包可能待的两处固定位置，顺序即优先级 */
function layersIn(root: string): [nodeModules: string, depot: string] {
  const nodeModules = nodeModulesIn(root);

  return [nodeModules, path.join(nodeModules, '.pnpm', 'node_modules')];
}

/**
 * 一个子目录的 mtime；文件、读不到的（`pnpm` 读到一半就删掉了）给 -1。
 *
 * 读到的可能是软链，要的是它指向的目录的 mtime：`pnpm global add` 装完之后
 * 还会在版本目录里改一次 `lastKnownGood` 软链，那一下落的 mtime 比内容本身新得多。
 * 按软链自己那条排，刚装好这个包的目录会沉到后面去，挑中它前面那份没有这个包的
 * 旧布局，补依赖算出来是零（`Cannot find module 'moment'` 就是这么断的）。
 */
async function mtimeOf(child: string): Promise<number> {
  const stat = await fs.stat(child).catch(() => null);

  if (stat === null) {
    return -1;
  }

  // 软链读的是它指向的目录；指到文件上、或那份已经不在了，都当它不在这儿
  const target =
    typeof stat.isSymbolicLink === 'function' && stat.isSymbolicLink()
      ? await fs.stat(child).catch(() => null)
      : stat;

  return target?.isDirectory() === true ? target.mtimeMs : -1;
}

/** 按 mtime 从新到旧排好的子目录，文件与读不到的排掉 */
async function dirsByMtime(dir: string): Promise<string[]> {
  const names = await readDir(dir);
  const entries = await Promise.all(
    names.map(async (name) => {
      const child = path.join(dir, name);

      return { child, mtime: await mtimeOf(child) };
    }),
  );

  return entries
    .filter(({ mtime }) => mtime >= 0)
    .toSorted((a, b) => b.mtime - a.mtime)
    .map(({ child }) => child);
}

/**
 * 布局根，顺序即优先级：`pnpm root -g` 给出的排最前，其余版本目录按 mtime 从新到旧，
 * 每层再带上自己的子目录（pnpm 11 的内容寻址哈希目录）。
 *
 * 早前这里写死过 `v11`、`10` … `5` 一串版本号去猜，可目录名跟版本号并没有约定
 * （pnpm 10 用 `10`，pnpm 11 换成了 `v11`），下一个谁知道。直接读盘比猜准。
 */
async function findLayoutRoots(): Promise<string[]> {
  const versions = await dirsByMtime(path.join(getPnpmHome(), 'global'));
  const nested = await Promise.all(versions.map((dir) => dirsByMtime(dir)));
  const detected = queryGlobalRoot();

  // 查询结果常就是某个版本目录，留两份等于把同一份布局探两遍
  return [
    ...new Set([
      ...(detected ? [detected] : []),
      ...versions,
      ...nested.flat(),
    ]),
  ];
}

/** 布局给出的一份答案：包可能落在哪些目录，以及每个目录对应的依赖表 */
export type PnpmLayout = {
  /**
   * 包可能落在的目录，顺序即优先级。
   *
   * 依赖表不能全进程只挑一个：全局安装根下常有好几层（每装一次多一个内容寻址目录），
   * 各层各有一张表。`pkgDir` 只是「别名表 + 真实包都在」的那一层，真实包可能由另一层补全，
   * 所以每层都还带着自己的依赖表——补哪个包，就用它自己那层的表。
   */
  layers: { pkgDir: string; depot: string | null }[];
};

/**
 * 平铺表是不是一份「别名」：里面的条目都是指向别处的软链。
 *
 * pnpm 12 起 `pnpm global add` 会在布局根的 `node_modules` 里铺一张表，条目全部软链回
 * 内容寻址目录（`global/v11/<id>/node_modules/.pnpm/node_modules`）。它列出的包一个不少，
 * 但那些软链全都**相对那张表**解析——照着它把依赖链进包的 store 目录里，
 * 每一条都会落空（`Cannot find module 'moment'` 就是这么来的）。
 */
async function isAliasTable(dir: string): Promise<boolean> {
  const entries = await readDir(dir);
  const names = entries.filter(isPackageEntry);

  const links = await Promise.all(
    names.map((name) =>
      // 条目可能刚被 pnpm 删掉（正在切版本）：当它不是软链
      fs.lstat(path.join(dir, name)).then(
        (stat) => stat.isSymbolicLink(),
        () => false,
      ),
    ),
  );

  return links.every(Boolean);
}

/**
 * 某一层里「全部已装包」平铺在哪，返回能找到的全部，顺序即优先级。
 *
 * pnpm 10/11 平铺在 `.pnpm/node_modules`，pnpm 12 起 public hoist 到布局根自己的
 * `node_modules` 顶层，同时**留着一份** `.pnpm/node_modules`：两份都得看。
 * 顶层那份只有直接装的几个包，间接依赖（miniprogram-ci 的 moment）只在 `.pnpm/node_modules` 里；
 * 而顶层那份又可能是上面那种别名表，链进去必然落空。表按「能不能直接当链接目标」筛：
 * 别名表整张跳过，其余照单全收（包不会在两张表里是两份不同的实物，先到先得就够）。
 */
async function depotsIn([nodeModules, nested]: [string, string]): Promise<
  string[]
> {
  const found = await Promise.all(
    [nodeModules, nested].map(async (dir) =>
      (await hasEntries(dir)) && !(await isAliasTable(dir)) ? dir : null,
    ),
  );

  return found.filter((dir) => dir !== null);
}

async function readLayout(): Promise<PnpmLayout> {
  const roots = await findLayoutRoots();
  const layers = await Promise.all(
    roots.map(async (root) => {
      const places = layersIn(root);
      const pkgDir = places[0];
      const depots = await depotsIn(places);

      // 一个平铺层就是一层：包探到这儿来，缺的依赖就按这层的表算。
      // 一处都没有时（包可能就待在这层里）也得留这一层，不能凭空消失
      return (depots.length > 0 ? depots : [null]).map((depot) => ({
        pkgDir,
        depot,
      }));
    }),
  );

  // 不同根可能落到同一层（查询结果就是某个版本目录本身），同一个「目录 + 表」只留一份
  return {
    layers: [
      ...new Map(
        layers
          .flat()
          .map((layer) => [`${layer.pkgDir}\0${layer.depot}`, layer]),
      ).values(),
    ],
  };
}

/** 查询结果只可能是「本机 pnpm 现在长什么样」，一次进程里算一遍就够 */
export const getLayout = (() => {
  let cache: Promise<PnpmLayout> | undefined;

  return () => {
    cache ??= readLayout();

    return cache;
  };
})();
