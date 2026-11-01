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

/** 一个布局根下包可能待的两处固定位置，顺序即优先级；依赖表就是后面那一处 */
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

async function isDirectory(dir: string): Promise<boolean> {
  return fs.stat(dir).then(
    (stat) => stat.isDirectory(),
    () => false,
  );
}

/** 布局给出的两份答案：包可能落在哪些目录、依赖表在哪一层 */
export type PnpmLayout = {
  /** 包可能落在的目录，顺序即优先级 */
  candidates: string[];
  /** 「全部已装包」平铺的那一层，包自己够不到的依赖在这里 */
  depot: string | null;
};

async function readLayout(): Promise<PnpmLayout> {
  const roots = await findLayoutRoots();
  const layers = roots.map((root) => layersIn(root));
  const depots = layers.map(([, depot]) => depot);
  const found = await Promise.all(depots.map((dir) => isDirectory(dir)));
  const index = found.indexOf(true);

  return {
    candidates: layers.flat(),
    depot: index === -1 ? null : (depots[index] as string),
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
