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

function assignEnv(name: string, value: string | undefined) {
  if (value === undefined) {
    // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}

/** 临时改动环境变量跑一段逻辑，结束后原样还回去（原本没有的删掉） */
function withEnv<T>(vars: Record<string, string | undefined>, run: () => T): T {
  const saved = Object.keys(vars).map(
    (name) => [name, process.env[name]] as const,
  );

  try {
    for (const [name, value] of Object.entries(vars)) {
      assignEnv(name, value);
    }

    return run();
  } finally {
    for (const [name, value] of saved) {
      assignEnv(name, value);
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
      // stdin 显式给空：不给的话子进程继承调用方那条管道，
      // `sleep 30 | bin-linker` 这类调用里它会一直等着一个永远不结束的 stdin。
      const output = execSync(
        'pnpm --config.manage-package-manager-versions=false root -g',
        {
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'pipe'],
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
async function mtimeOrderedDirs(parent: string, names: string[]) {
  const dirs = await Promise.all(
    names.map(async (name) => {
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
 * 全局安装的两种布局，扫一遍盘就都拿到，且只扫一遍。
 *
 * - `layers`：装着包本体与依赖表的那些 `node_modules` 层，按优先级排好。
 * - `depots`：其中真的存在 `.pnpm/node_modules`（「这次安装看得见的全部包」那张平铺表）的层。
 *
 * 目录名跟 pnpm 版本号没有约定（pnpm 10 用 `10`，pnpm 11 换成 `v11`，每装一次再套一层
 * 内容寻址的哈希目录），所以不猜版本号，直接读盘 + 按 mtime 从新到旧。
 * 早前 `buildLayoutRoots`、`findGlobalDepotDir`、`resolveInRoot` 各扫一遍同一份目录，
 * 现在统一走这里。
 */
const layoutCache: {
  value?: Promise<{ layers: string[]; depots: string[] }>;
} = {};

function scanVersionDir(versionDir: string) {
  // `pnpm root -g` 有时直接给到 `<版本目录>/node_modules` 那一层，别再往下套一层
  const layers = [
    path.basename(versionDir) === 'node_modules'
      ? versionDir
      : path.join(versionDir, 'node_modules'),
  ];

  return readDir(versionDir).then(async (names) => {
    const subDirs =
      names.includes('node_modules') || names.length === 0
        ? []
        : await mtimeOrderedDirs(versionDir, names);

    for (const subDir of subDirs) {
      layers.push(path.join(subDir, 'node_modules'));
    }

    return layers;
  });
}

export function getLayout(): Promise<{ layers: string[]; depots: string[] }> {
  layoutCache.value ??= (async () => {
    const detected = getPnpmGlobalPath();
    const versionDirs = [
      ...new Set([
        ...(detected ? [detected] : []),
        ...(await mtimeOrderedDirs(
          pnpmGlobalRoot,
          await readDir(pnpmGlobalRoot),
        )),
      ]),
    ];
    const scanned = await Promise.all(
      versionDirs.map((dir) => scanVersionDir(dir)),
    );
    const layers = [...new Set(scanned.flat())];
    const present = await Promise.all(
      layers.map((layer) =>
        isDirectory(path.join(layer, '.pnpm', 'node_modules')),
      ),
    );

    return {
      layers,
      depots: layers
        .filter((_, index) => present[index])
        .map((layer) => path.join(layer, '.pnpm', 'node_modules')),
    };
  })();

  return layoutCache.value;
}

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
 * 解析全局包可能的安装位置，顺序即优先级（层按新到旧）。
 *
 * 返回**全部**候选而不是第一个：同一个包可能同时留在好几个版本目录里，
 * 其中一份的软链可能已经断了。挑哪一份要读了元数据才知道，交给调用方。
 * 每层只看两处固定位置，不扫目录：直接依赖在 `node_modules/<pkg>`，
 * 间接依赖常只在平铺的 `node_modules/.pnpm/node_modules/<pkg>`。
 */
export async function resolveGlobalPkgDirs(name: string): Promise<string[]> {
  const pkg = toPkgName(name);
  const { layers } = await getLayout();
  const found = await Promise.all(
    layers.flatMap((layer) =>
      [pkg, path.join('.pnpm', 'node_modules', pkg)].map((position) => {
        const dir = path.join(layer, position);

        return isDirectory(dir).then((ok) => (ok ? dir : null));
      }),
    ),
  );

  // 同一个真实目录可能被好几层认出来，去重且保持「新到旧」的顺序
  return [...new Set(found.filter(Boolean))] as string[];
}

/** 存放「全部已装包」的那一层（`.pnpm/node_modules`），包够不到自己的间接依赖就靠它补 */
export function resolveGlobalDepotDir(): Promise<string | null> {
  return getLayout().then(({ depots }) => depots[0] ?? null);
}
