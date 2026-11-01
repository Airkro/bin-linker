import { promises as fs } from 'node:fs';
import path from 'node:path';

import { readDir } from './fs.mts';
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
 * 按 mtime 从新到旧排好的子目录，文件与读不到的排掉。
 *
 * 目录可能在被读到的下一瞬就没了（`pnpm` 正在切版本），`stat` 失败一律当作不存在。
 */
async function dirsByMtime(dir: string): Promise<string[]> {
  const names = await readDir(dir);
  const entries = await Promise.all(
    names.map(async (name) => {
      const child = path.join(dir, name);
      const stat = await fs.stat(child).catch(() => null);

      return { child, mtime: stat?.isDirectory() ? stat.mtimeMs : -1 };
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

/** 目录存在且里头有东西 */
async function hasEntries(dir: string): Promise<boolean> {
  const [stat, names] = await Promise.all([
    fs.stat(dir).catch(() => null),
    readDir(dir),
  ]);

  return stat?.isDirectory() === true && names.length > 0;
}

/** 布局给出的一份答案：包可能落在哪些目录，以及每个目录对应的依赖表 */
export type PnpmLayout = {
  /**
   * 包可能落在的目录，顺序即优先级；每处都带着自己那一层的依赖表。
   *
   * 依赖表不能全进程只挑一个：全局安装根下常有好几层（每装一次多一个内容寻址目录），
   * 各层各有一张表。拿 mtime 最新那层的表去补另一层的包，缺的依赖永远算不对——
   * 那层可能只装了零星几个包（CI 上连着跑上百次构建就是这样），
   * 于是「缺哪些」算出来是零，包一 require 间接依赖就断。
   */
  layers: { pkgDir: string; depot: string | null }[];
};

/**
 * 某一层里「全部已装包」平铺在哪。
 *
 * 两处都算：pnpm 10/11 平铺在 `.pnpm/node_modules`，pnpm 12 起改成 public hoist 到
 * 布局根自己的 `node_modules` 顶层，同时留一个空的 `.pnpm/node_modules` 空壳。
 * 只认「目录在不在」会挑中空壳。
 */
async function depotIn([nodeModules, nested]: [string, string]): Promise<
  string | null
> {
  for (const dir of [nodeModules, nested]) {
    if (await hasEntries(dir)) {
      return dir;
    }
  }

  return null;
}

async function readLayout(): Promise<PnpmLayout> {
  const roots = await findLayoutRoots();
  const layers = await Promise.all(
    roots.map(async (root) => {
      const places = layersIn(root);

      return { pkgDir: places[0], depot: await depotIn(places) };
    }),
  );

  // 不同根可能落到同一层（查询结果就是某个版本目录本身），同一层只留一份
  return {
    layers: [...new Map(layers.map((layer) => [layer.pkgDir, layer])).values()],
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
