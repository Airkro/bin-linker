import { execSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { readDir } from './fs.mts';

/** pnpm 主目录（`PNPM_HOME` 或其平台默认值） */
export function getPnpmHome(platform = process.platform): string {
  const {
    PNPM_HOME: pnpmHome,
    LOCALAPPDATA: localAppData,
    XDG_DATA_HOME: xdgDataHome,
  } = process.env;

  if (pnpmHome) {
    return pnpmHome;
  }

  if (platform === 'win32') {
    return path.join(
      localAppData ?? path.join(os.homedir(), 'AppData', 'Local'),
      'pnpm',
    );
  }

  if (platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'pnpm');
  }

  return path.join(
    xdgDataHome ?? path.join(os.homedir(), '.local', 'share'),
    'pnpm',
  );
}

/** pnpm 10 起会校验的那个目录：全局 bin 目录本身与它下面的 `bin` */
function globalBinDirs(): string[] {
  const binDir = process.env.npm_config_global_bin_dir || getPnpmHome();

  return [binDir, path.join(binDir, 'bin')];
}

/**
 * 判断 pnpm 的全局 bin 目录是否不在 PATH 中。
 *
 * pnpm 10 起 bin 目录不在 PATH 时 `pnpm i -g` 与 `pnpm root -g` 都会直接报错，
 * 全局包实际上可能已装好，只是无法通过 pnpm 查询到。
 */
export function isBinDirMissingFromPath(): boolean {
  const entries = new Set(
    (process.env.PATH ?? '')
      .split(path.delimiter)
      .map((entry) => path.resolve(entry || '.')),
  );

  return globalBinDirs().every((dir) => !entries.has(path.resolve(dir)));
}

/**
 * 借一份临时的环境跑一件事，结束后原样还回去（原本没有的删掉）。
 *
 * 查询全局根得先把环境摆对：
 * - `PATH`：pnpm 10 起会校验全局 bin 目录在不在里面，不在就连 `root -g` 也报错
 * - `npm_config_global_bin_dir`：pnpm 传给子进程的值会盖掉这里补的，校验直接失败
 * - `CI`：corepack 在 CI 置位时才不弹「是否下载」
 * - `npm_config_update_notifier`：更新检查是后台网络请求，断网时能把查询拖成分钟级
 */
function withQueryEnv<T>(run: () => T): T {
  const bins = [
    ...globalBinDirs(),
    ...(process.env.PATH ?? '').split(path.delimiter),
  ];
  const patch: Record<string, string | undefined> = {
    PATH: [...new Set(bins.filter(Boolean))].join(path.delimiter),
    npm_config_global_bin_dir: undefined,
    CI: 'true',
    npm_config_update_notifier: 'false',
  };
  const saved = Object.keys(patch).map(
    (name) => [name, process.env[name]] as const,
  );

  Object.assign(process.env, patch);

  try {
    return run();
  } finally {
    for (const [name, value] of saved) {
      if (value === undefined) {
        // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
        delete process.env[name];
      } else {
        process.env[name] = value;
      }
    }
  }
}

/**
 * `pnpm root -g` 给出的全局根目录；查询失败（pnpm 不在 PATH、校验不通过）时返回 null，
 * 布局再回退到遍历 `<pnpmHome>/global` 自行查找。
 */
function queryGlobalRoot(): string | null {
  return withQueryEnv(() => {
    try {
      // pnpm 11 起会按附近的 packageManager 声明重启成另一个版本（甚至现下），
      // 查全局目录用不着版本切换，显式关掉。
      // stdin 必须是 'ignore'：继承（或给 pipe）时 corepack shim 会一直等
      // 一个永不关闭的管道，`sleep 30 | bin-linker` 就是这么卡住的。
      const output = execSync(
        'pnpm --config.manage-package-manager-versions=false root -g',
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
      );

      return (
        output
          .split(/\r?\n/)
          .map((line) => line.trim())
          .findLast((line) => path.isAbsolute(line)) ?? null
      );
    } catch {
      return null;
    }
  });
}

/** 包名里可能带着路径（`$(pwd)/node_modules/cowsay` 这类写法并不少见），
 * 但 `node_modules` 的位置是按包名拼的，带路径就拼不出来。
 * 这里只取最后几段：`./node_modules/@scope/pkg` → `@scope/pkg`，`@scope/pkg` → `@scope/pkg`。
 */
export function toPkgName(input: string): string {
  const parts = input.split('/').filter(Boolean);
  const scopeIndex = parts.findLastIndex((part) => part.startsWith('@'));

  // 有 scope 就把它一起带上（`@scope` 本身就是最后一段时只有它）
  return scopeIndex === -1
    ? (parts.at(-1) ?? input)
    : parts.slice(scopeIndex).join('/');
}

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

/** 按 mtime 从新到旧排好的子目录，文件与读不到的排掉 */
async function dirsByMtime(dir: string): Promise<string[]> {
  const names = await readDir(dir);
  const entries = await Promise.all(
    names.map(async (name) => {
      const child = path.join(dir, name);
      const mtime = await fs.stat(child).then(
        (stat) => (stat.isDirectory() ? stat.mtimeMs : -1),
        () => -1,
      );

      return { child, mtime };
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
