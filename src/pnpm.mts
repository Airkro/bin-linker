import { execSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** 读目录，读不到时当作空目录：「不存在」与「没权限」在这里都是「没有候选」 */
async function readDir(dir: string): Promise<string[]> {
  return fs.readdir(dir).catch((): string[] => []);
}

async function isDirectory(dir: string): Promise<boolean> {
  return fs
    .stat(dir)
    .then((stat) => stat.isDirectory())
    .catch(() => false);
}

/** 返回第一个真实存在的目录（软链按其指向算） */
export async function firstDirectory(
  dirs: Array<string | null | undefined>,
): Promise<string | undefined> {
  for (const dir of dirs) {
    if (dir && (await isDirectory(dir))) {
      return dir;
    }
  }

  return undefined;
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

/**
 * `pnpm root -g` 的全局根目录，查询失败（pnpm 不在 PATH 或校验不通过）时返回 null，
 * 由调用方回退到遍历 `<pnpmHome>/global` 自行查找。
 */
function queryPnpmGlobalPath(): string | null {
  const { PATH: originalPath, PNPM_HOME: pnpmHome } = process.env;
  // pnpm 10/11 都会校验全局 bin 目录是否在 PATH，否则连 `root -g` 也报错
  const env = {
    PATH: [
      ...new Set([
        ...([
          pnpmHome,
          pnpmHome && path.join(pnpmHome, 'bin'),
          path.join(getPnpmHome(), 'bin'),
        ].filter(Boolean) as string[]),
        ...(originalPath ? originalPath.split(path.delimiter) : []),
      ]),
    ].join(path.delimiter),
    // pnpm 传给子进程的值，会盖掉这里补进 PATH 的目录，让校验直接失败
    npm_config_global_bin_dir: undefined,
    // corepack 在 CI 置位时才不交互式问「是否下载」
    CI: 'true',
    // 更新检查是背景网络请求，断网时能把一次查询拖成分钟级
    npm_config_update_notifier: 'false',
  };

  return withEnv(env, () => {
    try {
      // pnpm 11 起会按附近的 packageManager 声明重启成另一个版本（甚至现下），
      // 查全局目录用不着版本切换，显式关掉。
      // stdin 给空管道：corepack shim 会等到 stdin 结束，继承调用方的会一直等下去。
      const output = execSync(
        'pnpm --config.manage-package-manager-versions=false root -g',
        {
          encoding: 'utf8',
          stdio: 'pipe',
        },
      );
      const paths = output
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => path.isAbsolute(line));

      return paths.at(-1) ?? output.trim();
    } catch {
      return null;
    }
  });
}

let globalPathCache: { value: string | null } | undefined;

/**
 * 查询结果只可能是「本机 pnpm 现在长什么样」，一次进程里问一遍就够：
 * 每次查询等于 fork 一次 pnpm，一个包能问三四遍。失败（null）也记，
 * pnpm 不在 PATH 这种事不会在进程活着的几百毫秒里变好。
 */
export function getPnpmGlobalPath(): string | null {
  globalPathCache ??= { value: queryPnpmGlobalPath() };

  return globalPathCache.value;
}

/**
 * 判断 pnpm 的全局 bin 目录是否不在 PATH 中。
 *
 * pnpm 10 起 bin 目录不在 PATH 时 `pnpm i -g` 与 `pnpm root -g` 都会直接报错，
 * 全局包实际上可能已装好，只是无法通过 pnpm 查询到。
 */
export function isPnpmBinDirMissingFromPath(): boolean {
  const { PATH: pathEnv, npm_config_global_bin_dir: globalBinDir } =
    process.env;
  const configuredBinDir = globalBinDir || getPnpmHome();

  return [configuredBinDir, path.join(configuredBinDir, 'bin')].every(
    (dir) =>
      !(pathEnv ?? '')
        .split(path.delimiter)
        .map((entry) => path.resolve(entry || '.'))
        .includes(path.resolve(dir)),
  );
}

/**
 * 按 mtime 从新到旧排好目录下的子目录，读不到或不是目录的排掉。
 * 一次全局安装会新建一个版本目录（pnpm 11 下还多一个内容寻址的哈希目录），
 * 旧的仍在；最近改动的那个最可能装着要找的东西。
 */
async function mtimeOrderedDirs(
  parent: string,
  entries: string[],
): Promise<string[]> {
  const dirs = await Promise.all(
    entries.map(async (name) => {
      const dir = path.join(parent, name);

      return {
        dir,
        mtime: await fs.stat(dir).then(
          (stat) => (stat.isDirectory() ? stat.mtimeMs : -1),
          () => -1,
        ),
      };
    }),
  );

  return dirs
    .filter(({ mtime }) => mtime >= 0)
    .toSorted((a, b) => b.mtime - a.mtime)
    .map(({ dir }) => dir);
}

/**
 * 全局根目录下的版本目录，按 mtime 从新到旧——最近装的最可能装着要找的包。
 *
 * 查一个包要连着问好几遍（候选根、依赖表、包定位），读的都是同一个目录，
 * 记一次就够；进程内 pnpm 不会中途多装一个版本。
 */
let versionDirsCache: { value: Promise<string[]> } | undefined;

function getVersionDirs(): Promise<string[]> {
  versionDirsCache ??= {
    value: readDir(pnpmGlobalRoot).then((entries) =>
      mtimeOrderedDirs(pnpmGlobalRoot, entries),
    ),
  };

  return versionDirsCache.value;
}

/**
 * 布局根：包那层 `node_modules` 所在的位置。
 *
 * 一律从 `<pnpmHome>/global` 下现存的版本目录出发（按 mtime 从新到旧），
 * `pnpm root -g` 问到结果时排第一位。
 *
 * 早前这里写死过 `v11`、`10` … `5` 一串版本号去猜，可目录名跟版本号并没有约定
 * （pnpm 10 用 `10`，pnpm 11 换成了 `v11`），下一个谁知道。反正后面本来就要扫一遍
 * 版本目录，直接读盘比猜准，也不会在 pnpm 升级后整段失效。
 */
async function buildLayoutRoots(): Promise<string[]> {
  const detected = getPnpmGlobalPath();
  const versionDirs = await getVersionDirs();

  // 查询结果就是最新那个版本目录时版本号清单里已经有它，留两份等于把同一份布局探两遍
  return [...new Set([...(detected ? [detected] : []), ...versionDirs])];
}

let layoutRootsCache: { value: Promise<string[]> } | undefined;

function getLayoutRoots(): Promise<string[]> {
  layoutRootsCache ??= { value: buildLayoutRoots() };

  return layoutRootsCache.value;
}

/**
 * 包名里可能带着路径（`$(pwd)/node_modules/cowsay` 这类写法并不少见），
 * 但 `node_modules` 的位置是按包名拼的，带路径就拼不出来了。
 * 这里只取最后一段：`./node_modules/@scope/pkg` → `@scope/pkg`，`@scope/pkg` → `@scope/pkg`。
 */
export function normalizePkgName(name: string): string {
  const parts = name.split('/').filter(Boolean);
  const scopeIndex = parts.findLastIndex((part) => part.startsWith('@'));

  // 有 scope 就把它一起带上（`@scope` 本身就是最后一段时只有它）
  return scopeIndex === -1
    ? (parts.at(-1) ?? name)
    : parts.slice(scopeIndex).join('/');
}

/**
 * 在一个布局根里找包，只在两处固定位置看，不扫目录。
 *
 * - `node_modules/<pkg>`：直接依赖的位置。`pnpm root -g` 给的常是
 *   `<版本目录>/node_modules`，那种写法这里也兜住。
 * - `node_modules/.pnpm/node_modules/<pkg>`：虚拟布局把「这次安装看得见的全部包」
 *   平铺在这一层，间接依赖常常只在这里出现。
 *
 * 真实包在 store 里时这两处都是指向它的软链，`stat` 会跟过去，
 * 所以「能不能 stat 到一个目录」就是「这个位置有没有这个包」。
 */
async function packageInLayout(
  root: string,
  pkg: string,
): Promise<string | null> {
  const bases =
    path.basename(root) === 'node_modules' ? [path.dirname(root)] : [root];
  const found = await firstDirectory(
    bases.flatMap((base) => [
      path.join(base, 'node_modules', pkg),
      path.join(base, 'node_modules', '.pnpm', 'node_modules', pkg),
    ]),
  );

  return found ?? null;
}

/**
 * 在单个布局根目录中查找包，找不到时返回 null。
 *
 * 布局差异都藏在目录名里，先把根目录上的线索读一次，后面全按线索走：
 * - 根目录下有 `node_modules`：pnpm 10 布局，包在 `node_modules/<pkg>`。
 * - 没有 `node_modules`、子目录是内容寻址的哈希名：pnpm 11 布局，包在
 *   `<根>/<hash>/node_modules/<pkg>`。多个哈希目录只有一个是当前安装，
 *   其余是旧版本残留，按 mtime 从新到旧依次试。
 *
 * 早前这里对任何目录都无条件 `readdir(root)`，再拼 `<entry>/node_modules/<pkg>`
 * 逐个 stat 到底，一次找不到包就把整个 store 扫一遍。
 */
async function resolveInRoot(
  root: string,
  pkg: string,
): Promise<string | null> {
  const direct = await packageInLayout(root, pkg);

  if (direct) {
    return direct;
  }

  const entries = await readDir(root);

  if (entries.includes('node_modules')) {
    return null;
  }

  const subRoots = await mtimeOrderedDirs(root, entries);
  const found = await firstDirectory(
    subRoots.flatMap((subRoot) => [
      path.join(subRoot, 'node_modules', pkg),
      path.join(subRoot, 'node_modules', '.pnpm', 'node_modules', pkg),
    ]),
  );

  return found ?? null;
}

/**
 * 解析全局包可能的安装位置，顺序即优先级（版本目录按新到旧）。
 *
 * 返回**全部**候选而不是第一个：同一个包可能同时留在好几个版本目录里，
 * 其中一份的软链可能已经断了。挑哪一份要读了元数据才知道，交给调用方。
 */
export async function resolveGlobalPkgDirs(name: string): Promise<string[]> {
  const pkg = normalizePkgName(name);
  const roots = await getLayoutRoots();
  const found = await Promise.all(
    roots.map((root) => resolveInRoot(root, pkg)),
  );

  // 同一个真实目录可能在多处被认出来，去重且保持「新到旧」的顺序
  return [...new Set(found.filter(Boolean))] as string[];
}

/**
 * 解析 pnpm 全局安装根里存放「全部已装包」的那一层（`.pnpm/node_modules`）。
 *
 * 真实包在 store 里，全局安装根只有一张软链表，平铺着全部依赖。
 * pnpm 11 每装一次在版本根下新建一个内容寻址目录，依赖表可能只在那里面，所以两层都探。
 */
async function findGlobalDepotDir(): Promise<string | null> {
  const candidates: string[] = [];

  for (const versionDir of await getVersionDirs()) {
    candidates.push(
      path.join(versionDir, 'node_modules', '.pnpm', 'node_modules'),
    );

    for (const subDir of await mtimeOrderedDirs(
      versionDir,
      await readDir(versionDir),
    )) {
      candidates.push(
        path.join(subDir, 'node_modules', '.pnpm', 'node_modules'),
      );
    }
  }

  const depot = await firstDirectory(candidates);

  return depot ?? null;
}

let depotDirCache: { value: Promise<string | null> } | undefined;

/** 答案与包无关，每个包都问一遍纯属浪费，记一次就够 */
export function resolveGlobalDepotDir(): Promise<string | null> {
  depotDirCache ??= { value: findGlobalDepotDir() };

  return depotDirCache.value;
}
