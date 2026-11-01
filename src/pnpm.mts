import { execSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** 读目录，读不到时当作空目录：「不存在」与「没权限」在这里都是「没有候选」 */
function readDir(dir: string): Promise<string[]> {
  return fs.readdir(dir).catch((): string[] => []);
}

function isDirectory(dir: string): Promise<boolean> {
  return fs.stat(dir).then(
    (stat) => stat.isDirectory(),
    () => false,
  );
}

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

/** pnpm 全局根目录（`<pnpmHome>/global`），其下每个版本目录对应一次全局安装 */
export const pnpmGlobalRoot = path.join(getPnpmHome(), 'global');

/** 临时改动环境变量跑一段逻辑，结束后原样还回去（原本没有的删掉） */
function withEnv<T>(vars: Record<string, string | undefined>, run: () => T): T {
  const saved = Object.keys(vars).map(
    (name) => [name, process.env[name]] as const,
  );

  try {
    for (const [name, value] of Object.entries(vars)) {
      if (value === undefined) {
        // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
        delete process.env[name];
      } else {
        process.env[name] = value;
      }
    }

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

/** pnpm 10/11 都会校验全局 bin 目录是否在 PATH，否则连 `root -g` 也报错 */
function pathWithPnpmBins(pnpmHome: string | undefined): string {
  const { PATH: originalPath } = process.env;
  const entries = [
    pnpmHome,
    pnpmHome && path.join(pnpmHome, 'bin'),
    path.join(getPnpmHome(), 'bin'),
    ...(originalPath ?? '').split(path.delimiter),
  ].filter(Boolean);

  return [...new Set(entries)].join(path.delimiter);
}

/**
 * `pnpm root -g` 给出的全局根目录；查询失败（pnpm 不在 PATH 或校验不通过）时返回 null，
 * 由调用方回退到遍历 `<pnpmHome>/global` 自行查找。
 */
function queryPnpmGlobalPath(): string | null {
  const { PNPM_HOME: pnpmHome } = process.env;

  return withEnv(
    {
      PATH: pathWithPnpmBins(pnpmHome),
      // pnpm 传给子进程的值，会盖掉这里补进 PATH 的目录，让校验直接失败
      npm_config_global_bin_dir: undefined,
      // corepack 在 CI 置位时才不交互式问「是否下载」
      CI: 'true',
      // 更新检查是背景网络请求，断网时能把一次查询拖成分钟级
      npm_config_update_notifier: 'false',
    },
    () => {
      try {
        // pnpm 11 起会按附近的 packageManager 声明重启成另一个版本（甚至现下），
        // 查全局目录用不着版本切换，显式关掉。
        // stdin 显式给空：不给的话子进程继承调用方那条管道，
        // `sleep 30 | bin-linker` 这类调用里它会一直等着一个永远不结束的 stdin。
        const output = execSync(
          'pnpm --config.manage-package-manager-versions=false root -g',
          { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
        );
        const paths = output
          .split(/\r?\n/)
          .map((line) => line.trim())
          .filter((line) => path.isAbsolute(line));

        return paths.at(-1) ?? output.trim();
      } catch {
        return null;
      }
    },
  );
}

/**
 * 查询结果只可能是「本机 pnpm 现在长什么样」，一次进程里问一遍就够：
 * 每次查询等于 fork 一次 pnpm，一个包能问三四遍。失败（null）也记，
 * pnpm 不在 PATH 这种事不会在进程活着的几百毫秒里变好。
 */
export const getPnpmGlobalPath = ((): (() => string | null) => {
  let cache: { value: string | null } | undefined;

  return () => {
    cache ??= { value: queryPnpmGlobalPath() };

    return cache.value;
  };
})();

/**
 * 判断 pnpm 的全局 bin 目录是否不在 PATH 中。
 *
 * pnpm 10 起 bin 目录不在 PATH 时 `pnpm i -g` 与 `pnpm root -g` 都会直接报错，
 * 全局包实际上可能已装好，只是无法通过 pnpm 查询到。
 */
export function isBinDirMissingFromPath(): boolean {
  const { npm_config_global_bin_dir: globalBinDir } = process.env;
  const configuredBinDir = globalBinDir || getPnpmHome();
  const entries = new Set(
    (process.env.PATH ?? '')
      .split(path.delimiter)
      .map((entry) => path.resolve(entry || '.')),
  );

  return [configuredBinDir, path.join(configuredBinDir, 'bin')].every(
    (dir) => !entries.has(path.resolve(dir)),
  );
}

/** 一个目录下按 mtime 从新到旧排好的子目录，文件与读不到的排掉 */
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
 * 全部布局根，顺序即优先级：`pnpm root -g` 给出的排最前，其余版本目录按 mtime 从新到旧，
 * 每层再带上自己的子目录（pnpm 11 的内容寻址哈希目录）。
 *
 * 这两层是「包那层 `node_modules` 可能落在哪」的全部来源，包定位与依赖表探测都从这里出发。
 * 早前这里写死过 `v11`、`10` … `5` 一串版本号去猜，可目录名跟版本号并没有约定
 * （pnpm 10 用 `10`，pnpm 11 换成了 `v11`），下一个谁知道。直接读盘比猜准，
 * 也不会在 pnpm 升级后整段失效。
 */
export const getLayoutRoots = ((): (() => Promise<string[]>) => {
  let cache: Promise<string[]> | undefined;

  return () => {
    cache ??= (async () => {
      const detected = getPnpmGlobalPath();
      const versions = await dirsByMtime(pnpmGlobalRoot);
      const subDirs = await Promise.all(
        versions.map((dir) => dirsByMtime(dir)),
      );

      // 查询结果常就是某个版本目录，留两份等于把同一份布局探两遍
      return [
        ...new Set([
          ...(detected ? [detected] : []),
          ...versions,
          ...subDirs.flat(),
        ]),
      ];
    })();

    return cache;
  };
})();

/**
 * 包名里可能带着路径（`$(pwd)/node_modules/cowsay` 这类写法并不少见），
 * 但 `node_modules` 的位置是按包名拼的，带路径就拼不出来了。
 * 这里只取最后几段：`./node_modules/@scope/pkg` → `@scope/pkg`，`@scope/pkg` → `@scope/pkg`。
 * 归一放在「去重」之前做，不然同一个包的几种写法会各链一遍。
 */
export function toPkgName(input: string): string {
  const parts = input.split('/').filter(Boolean);
  const scopeIndex = parts.findLastIndex((part) => part.startsWith('@'));

  // 有 scope 就把它一起带上（`@scope` 本身就是最后一段时只有它）
  return scopeIndex === -1
    ? (parts.at(-1) ?? input)
    : parts.slice(scopeIndex).join('/');
}

/**
 * 一个布局根的 `node_modules` 层：本身就是 node_modules 时原样，否则挂在它下面。
 * `pnpm root -g` 给的常是 `<版本目录>/node_modules`，那种写法也兜住。
 */
function nodeModulesIn(root: string): string {
  return path.basename(root) === 'node_modules'
    ? root
    : path.join(root, 'node_modules');
}

/**
 * 一个布局根里包可能待的两处固定位置，只此两处、不扫目录：
 * `node_modules`（直接依赖）与 `node_modules/.pnpm/node_modules`
 * （虚拟布局平铺的「这次安装看得见的全部包」，间接依赖常常只在这里出现）。
 */
function packageDirsIn(root: string): string[] {
  const nodeModules = nodeModulesIn(root);

  return [nodeModules, path.join(nodeModules, '.pnpm', 'node_modules')];
}

/** 一个布局根的依赖表：`.pnpm/node_modules` 那一层平铺着全部已装包 */
function depotDirIn(root: string): string {
  return path.join(nodeModulesIn(root), '.pnpm', 'node_modules');
}

/**
 * 布局给出的两处线索，按布局根的优先级排好：
 * 包可能落在哪些目录、以及依赖表在哪。
 *
 * 两者是同一份布局的两个答案，一次算完、记一次：早前各自遍历一遍布局根、
 * 各自拼一遍 `.pnpm/node_modules`，走的是同一条路。
 */
export const getLayout = ((): (() => Promise<{
  layers: string[][];
  depots: string[];
}>) => {
  let cache: Promise<{ layers: string[][]; depots: string[] }> | undefined;

  return () => {
    cache ??= getLayoutRoots().then((roots) => ({
      layers: roots.map((root) => packageDirsIn(root)),
      depots: roots.map((root) => depotDirIn(root)),
    }));

    return cache;
  };
})();

/**
 * 解析全局包可能的安装位置，顺序即优先级（布局根按新到旧，每根内直接依赖优先）。
 *
 * 返回**全部**候选而不是第一个：同一个包可能同时留在好几个版本目录里，
 * 其中一份的软链可能已经断了。挑哪一份要读了元数据才知道，交给调用方。
 */
export async function findPackageDirs(pkg: string): Promise<string[]> {
  const { layers } = await getLayout();
  const found = await Promise.all(
    layers.flat().map((dir) => isDirectory(path.join(dir, pkg))),
  );

  // 同一个真实目录可能被好几个根认出来，去重且保持「新到旧」的顺序
  return [...new Set(layers.flat().filter((_, index) => found[index]))].map(
    (dir) => path.join(dir, pkg),
  );
}

/**
 * 解析 pnpm 全局安装根里存放「全部已装包」的那一层（`.pnpm/node_modules`）。
 *
 * 真实包在 store 里，包本身够不到这一层，那里平铺着全部依赖。
 * 候选顺序与包定位共用同一份布局，pnpm 11 的内容寻址目录也一并覆盖。
 * 答案与包无关，每个包都问一遍纯属浪费。
 */
export const resolveDepotDir = ((): (() => Promise<string | null>) => {
  let cache: Promise<string | null> | undefined;

  return () => {
    cache ??= getLayout().then(async ({ depots }) => {
      for (const dir of depots) {
        if (await isDirectory(dir)) {
          return dir;
        }
      }

      return null;
    });

    return cache;
  };
})();
