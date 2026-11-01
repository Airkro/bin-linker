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

/** 全局根目录下的版本目录，按 mtime 从新到旧——最近装的最可能装着要找的包 */
async function getVersionDirs(): Promise<string[]> {
  const entries = await readDir(pnpmGlobalRoot);
  const dirs = await Promise.all(
    entries.map(async (name) => {
      const dir = path.join(pnpmGlobalRoot, name);

      return {
        dir,
        mtime: await fs.stat(dir).then(
          (stat) => stat.mtimeMs,
          () => 0,
        ),
      };
    }),
  );

  return dirs.toSorted((a, b) => b.mtime - a.mtime).map(({ dir }) => dir);
}

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
export function getPnpmGlobalPath(): string | null {
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
 * 在单个版本根目录中查找包，找不到时返回 null。
 * - pnpm 10：包直接位于根目录下，或 `<root>/node_modules/<pkg>`
 * - pnpm 11：包位于 `<root>/<virtualDir>/node_modules/<pkg>`
 */
async function resolveInRoot(
  root: string,
  pkg: string,
): Promise<string | null> {
  const fixed = await firstDirectory([
    path.join(root, pkg),
    path.join(root, 'node_modules', pkg),
  ]);

  if (fixed) {
    return fixed;
  }

  const entries = await readDir(root);

  return (
    (await firstDirectory(
      entries.map((entry) => path.join(root, entry, 'node_modules', pkg)),
    )) ?? null
  );
}

/**
 * 解析全局包的实际根目录，找不到时返回 null。
 *
 * 全局包可能由其它 pnpm 版本安装（`corepack use` 切版本、CI 镜像预装），
 * 所以先试当前版本与按版本号推断的候选根目录，再扫其余版本目录。
 */
export async function resolveGlobalPkgDir(pkg: string): Promise<string | null> {
  const candidates = [
    getPnpmGlobalPath(),
    // `pnpm root -g` 探测失败时按版本号从高到低推断
    ...['v11', '10', '9', '8', '7', '6', '5'].map((version) =>
      path.join(pnpmGlobalRoot, version),
    ),
  ].filter(Boolean) as string[];

  const allVersionDirs = await getVersionDirs();
  const versionDirs = allVersionDirs.filter((dir) => !candidates.includes(dir));

  for (const root of [...candidates, ...versionDirs]) {
    const found = await resolveInRoot(root, pkg);

    if (found) {
      return found;
    }
  }

  return null;
}

/**
 * 解析 pnpm 全局安装根里存放「全部已装包」的那一层（`.pnpm/node_modules`）。
 *
 * 真实包在 store 里，全局安装根只有一张软链表，平铺着全部依赖。
 * pnpm 11 每装一次在版本根下新建一个内容寻址目录，依赖表可能只在那里面，所以两层都探。
 */
export async function resolveGlobalDepotDir(): Promise<string | null> {
  const versionDirs = await getVersionDirs();
  const candidates = await Promise.all(
    versionDirs.map(async (versionDir) => {
      // 版本根自己的 node_modules 可能没有依赖表，pnpm 11 的把戏在内容寻址的子目录里
      const entries = await readDir(versionDir);
      const nested = entries.map((entry) => path.join(versionDir, entry));

      return [versionDir, ...nested].map((dir) =>
        path.join(dir, 'node_modules', '.pnpm', 'node_modules'),
      );
    }),
  );

  const depot = await firstDirectory(candidates.flat());

  return depot ?? null;
}
