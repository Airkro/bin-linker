import { execSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// 常量定义
export const isWindows = process.platform === 'win32';

/**
 * 计算 pnpm 主目录（PNPM_HOME 或其平台默认值）。
 */
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
    return localAppData
      ? path.join(localAppData, 'pnpm')
      : path.join(os.homedir(), 'AppData', 'Local', 'pnpm');
  }

  if (platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'pnpm');
  }

  return path.join(
    xdgDataHome ?? path.join(os.homedir(), '.local', 'share'),
    'pnpm',
  );
}

/**
 * pnpm 全局根目录（`<pnpmHome>/global`）。
 * pnpm 10 与 pnpm 11 使用不同的版本子目录（如 `5`、`v11`），
 * 全局包实际安装在其下的某个版本目录中。
 */
export const pnpmGlobalRoot = path.join(getPnpmHome(), 'global');

/**
 * corepack 的 shim 会把 stdin 读进内存再转给真实的包管理器
 * （`dist/lib/corepack.cjs` 里等的是 `process.stdin` 的 `end`）。
 * 父进程留着 stdin 不关时，子进程就一直等下去——CI 里就是这么挂满 10 分钟后
 * 被当成「无输出」掐掉的（构建 cnb-951-1k6b80tj6）。查询不需要输入，给个空 stdin。
 */
const execOptions = { encoding: 'utf8', stdio: 'pipe' } as const;

/**
 * corepack 在 `CI` 置位时不会交互式问「是否下载」，而是直接去下载。
 * 显式把 `CI` 交给它，别让它的行为取决于 runner 有没有设置这个变量。
 */
const CI_ENV = 'CI';

/**
 * 查询版本、`npm_config_*` 这类东西都不该触发 pnpm 的更新检查：
 * 那是一次背景网络请求，断网时会把「查一下全局目录」拖成分钟级。
 */
const NO_UPDATE_NOTIFIER_ENV = 'npm_config_update_notifier';

/**
 * pnpm 10 / pnpm 11 都会校验全局 bin 目录是否在 PATH，否则连 `root -g` 也报错。
 * 查询时临时把 pnpm 的相关目录补进 PATH，并清掉 `npm_config_global_bin_dir`：
 * 那个变量是 pnpm 传给自己子进程的，只有当父进程已经校验过 PATH 才成立；
 * 由 bin-linker 发起查询时它会盖掉这里补的目录，让校验直接失败。
 * 结束后恢复调用方的环境变量。
 *
 * 返回 `pnpm root -g` 的全局根目录；查询失败（pnpm 不在 PATH 或校验不通过）
 * 时返回 null，由调用方回退到遍历 `<pnpmHome>/global` 自行查找。
 */
export function getPnpmGlobalPath(): string | null {
  const {
    PATH: originalPath,
    npm_config_global_bin_dir: originalGlobalBinDir,
    CI: originalCi,
    PNPM_HOME: pnpmHome,
  } = process.env;
  const configuredBinDirs = [pnpmHome, pnpmHome && path.join(pnpmHome, 'bin')];

  const defaultHome = getPnpmHome();

  const pathEntries = (process.env.PATH ?? '').split(path.delimiter);
  process.env.PATH = [
    ...new Set([
      ...configuredBinDirs,
      path.join(defaultHome, 'bin'),
      ...pathEntries,
    ]),
  ].join(path.delimiter);
  delete process.env.npm_config_global_bin_dir;
  process.env[CI_ENV] = 'true';
  process.env[NO_UPDATE_NOTIFIER_ENV] = 'false';

  try {
    const output = execSync('pnpm root -g', execOptions);
    const paths = output
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => path.isAbsolute(line));

    return paths.at(-1) ?? output.trim();
  } catch {
    // `pnpm root -g` 失败（如 pnpm 不在 PATH 或 pnpm 11 校验不通过）时
    // 不抛出，返回 null，让 resolveGlobalPkgDir 回退到自行遍历全局根目录。
    return null;
  } finally {
    if (originalPath === undefined) {
      delete process.env.PATH;
    } else {
      process.env.PATH = originalPath;
    }

    if (originalGlobalBinDir === undefined) {
      delete process.env.npm_config_global_bin_dir;
    } else {
      process.env.npm_config_global_bin_dir = originalGlobalBinDir;
    }

    if (originalCi === undefined) {
      delete process.env.CI;
    } else {
      process.env.CI = originalCi;
    }

    delete process.env[NO_UPDATE_NOTIFIER_ENV];
  }
}

/**
 * 收集候选的全局根目录。
 *
 * `pnpm root -g` 在 pnpm 10 下对全局 bin 目录不在 PATH 时会直接失败，
 * 而 pnpm 10 的全局布局是 `<pnpmHome>/global/<ver>/node_modules`；
 * pnpm 11 的全局根则统一为 `<pnpmHome>/global/v11`。
 * 因此探测失败时按版本号从高到低推断候选根目录。
 */
function getPnpmGlobalCandidates(): string[] {
  const versionDirs = ['v11', '10', '9', '8', '7', '6', '5'].map((version) =>
    path.join(pnpmGlobalRoot, version),
  );

  const detected = getPnpmGlobalPath();

  return [...new Set([detected, ...versionDirs])].filter((dir): dir is string =>
    Boolean(dir),
  );
}

/**
 * 判断 pnpm 的全局 bin 目录是否不在 PATH 中。
 *
 * pnpm 10 起（pnpm 10 校验 `PNPM_HOME`，pnpm 11 校验 `PNPM_HOME/bin`），
 * bin 目录不在 PATH 时 `pnpm i -g` 与 `pnpm root -g` 都会直接报错，
 * 全局包实际上可能已装好，只是无法通过 pnpm 查询到。
 */
export function isPnpmBinDirMissingFromPath(): boolean {
  const { PATH: pathEnv, npm_config_global_bin_dir: globalBinDir } =
    process.env;
  const configuredBinDir = globalBinDir || getPnpmHome();
  const pathEntries = (pathEnv ?? '')
    .split(path.delimiter)
    .map((entry) => path.resolve(entry || '.'));

  return ![configuredBinDir, path.join(configuredBinDir, 'bin')].some((dir) =>
    pathEntries.includes(path.resolve(dir)),
  );
}

export function getSymlinkType(
  platform = process.platform,
): 'file' | undefined {
  return platform === 'win32' ? 'file' : undefined;
}

export const localBinDir = path.resolve(process.cwd(), 'node_modules', '.bin');

/**
 * 确保目录存在，如果不存在则创建
 */
export async function ensureDir(dir: string): Promise<boolean> {
  try {
    await fs.mkdir(dir, { recursive: true });

    return true;
  } catch {
    return false;
  }
}

/**
 * 检查文件是否存在
 */
const fileExists = async (filePath: string): Promise<boolean> =>
  fs
    .access(filePath)
    .then(() => true)
    .catch(() => false);

/**
 * 检查路径是否为目录
 */
async function isDirectory(dirPath: string): Promise<boolean> {
  try {
    const stat = await fs.stat(dirPath);

    return stat.isDirectory();
  } catch {
    return false;
  }
}

/**
 * 在单个全局版本根目录中查找包。
 *
 * 兼容 pnpm 10 与 pnpm 11 的不同布局：
 * - pnpm 10：`pnpm root -g` 返回的是 `<root>/<pkg>` 所在的
 *   `<pnpmHome>/global/<ver>/node_modules`，因此包直接位于根目录下；
 *   而遍历版本目录（`<pnpmHome>/global/<ver>`）时，包位于
 *   `<root>/node_modules/<pkg>`。
 * - pnpm 11：包位于 `<root>/<virtualDir>/node_modules/<pkg>`
 *   （`virtualDir` 为内容寻址的哈希目录名，不固定）。
 * 依次尝试三种布局，找不到时返回 null。
 */
async function resolveInVersionDir(
  root: string,
  pkg: string,
): Promise<string | null> {
  // pnpm 10：包直接位于根目录下（root 即 `pnpm root -g` 返回的 node_modules 目录）
  const direct = path.join(root, pkg);
  if (await isDirectory(direct)) {
    return direct;
  }

  // pnpm 10：遍历版本目录时，包位于 <root>/node_modules/<pkg>
  const nodeModules = path.join(root, 'node_modules', pkg);
  if (await isDirectory(nodeModules)) {
    return nodeModules;
  }

  // pnpm 11：包位于 <root>/<virtualDir>/node_modules/<pkg>
  const entries = await fs.readdir(root).catch(() => []);
  for (const entry of entries) {
    const candidate = path.join(root, entry, 'node_modules', pkg);
    if (await isDirectory(candidate)) {
      return candidate;
    }
  }

  return null;
}

/**
 * 解析全局包的实际根目录。
 *
 * 当前 pnpm 的 `pnpm root -g` 只返回当前版本的全局根目录
 * （pnpm 10 为 `<pnpmHome>/global/<ver>`，pnpm 11 为
 * `<pnpmHome>/global/v11`）。
 * 由于 `corepack use` 切换 pnpm 版本时全局目录随之改变，而全局包可能由
 * 其它 pnpm 版本安装（例如 CI 镜像预装的包），因此这里会同时遍历
 * `<pnpmHome>/global` 下所有版本的目录，依次尝试两种布局，
 * 以兼容 pnpm 10 与 pnpm 11，找不到包时返回 null。
 */
export async function resolveGlobalPkgDir(pkg: string): Promise<string | null> {
  const pnpmGlobalPaths = getPnpmGlobalCandidates();

  // 优先使用 `pnpm root -g` 的结果（当前 pnpm 版本的全局根目录），
  // 其次是推断出的版本目录。查找 pnpm 10 / pnpm 11 两种布局，命中即返回。
  for (const pnpmGlobalPath of pnpmGlobalPaths) {
    const found = await resolveInVersionDir(pnpmGlobalPath, pkg);

    if (found) {
      return found;
    }
  }

  // `pnpm root -g` 失败或在其目录中未找到时，遍历 <pnpmHome>/global 下
  // 所有版本子目录（如 `5`、`v11`）自行查找。全局包可能由其它 pnpm 版本
  // 安装（例如 CI 镜像预装的包），而 `corepack use` 切换 pnpm 版本时
  // 全局目录随之改变，需要跨版本查找。
  const versionDirs = await fs.readdir(pnpmGlobalRoot).catch(() => []);
  for (const entry of versionDirs) {
    const root = path.join(pnpmGlobalRoot, entry);

    if (!pnpmGlobalPaths.includes(root)) {
      const resolved = await resolveInVersionDir(root, pkg);

      if (resolved) {
        return resolved;
      }
    }
  }

  return null;
}

/**
 * 读取包的package.json文件
 */
export async function readPackageJson(
  pkg: string,
): Promise<{ bin?: string | Record<string, string> } | null> {
  const pkgDir = await resolveGlobalPkgDir(pkg);

  if (!pkgDir) {
    return null;
  }

  const pkgPath = path.join(pkgDir, 'package.json');

  if (!(await fileExists(pkgPath))) {
    return null;
  }

  try {
    const content = await fs.readFile(pkgPath, 'utf8');

    return JSON.parse(content);
  } catch {
    return null;
  }
}

/**
 * 创建符号链接
 */
export async function createSymlink(
  target: string,
  link: string,
): Promise<boolean> {
  // 检查目标是否存在
  if (!(await fileExists(target))) {
    throw new Error(`目标不存在: ${target}`);
  }

  // 如果链接已存在，先删除
  await fs.unlink(link).catch((error) => {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw error;
    } // 忽略文件不存在的错误
  });

  // 在 Windows 上使用 file 类型，因为我们链接的是可执行文件
  const type = getSymlinkType();

  await fs.symlink(target, link, type);

  return true;
}
