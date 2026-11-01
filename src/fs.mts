import { promises as fs } from 'node:fs';
import path from 'node:path';

export const isWindows = process.platform === 'win32';

/**
 * Windows 建软链必须指明类型。
 *
 * 链接的是**目录**（包本体、`node_modules` 里的依赖），只能给 `junction`：
 * `file` 类型对目录必失败，`dir` 类型又要开发者模式或管理员权限
 * （EPERM 那套提示原本就是在替这件事擦屁股）。junction 由文件系统层实现，免权限。
 * 只有真对着一个文件建链时才用 `file`。
 */
export function getLinkType(
  target?: string,
  platform = process.platform,
): 'file' | 'junction' | undefined {
  if (platform !== 'win32') {
    return undefined;
  }

  return target && path.extname(target) ? 'file' : 'junction';
}

/** 链接落在工程自己的 `node_modules` 里，与包管理器装出来的一致 */
export const localBinDir = path.resolve(process.cwd(), 'node_modules', '.bin');

export async function ensureDir(dir: string): Promise<boolean> {
  try {
    await fs.mkdir(dir, { recursive: true });

    return true;
  } catch {
    return false;
  }
}

/** 不存在的链接当它已经删掉了 */
async function unlinkIfPresent(link: string): Promise<void> {
  try {
    await fs.unlink(link);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw error;
    }
  }
}

/** 目标那一侧解析不到就按字面路径比：断掉的 store 链接不该让判定整段失效 */
async function resolveTargets(targets: string[]): Promise<string[]> {
  return Promise.all(
    targets.map((target) => fs.realpath(target).catch(() => target)),
  );
}

/**
 * 链接是否已经指着 `targets` 里的某一份。
 *
 * 先 `readlink` 确认它是个链接（普通目录会 EINVAL，也算要重建），再 `realpath`
 * 确认它没断：两边都解析不到就退回字面路径去比，一个指向同一路径的空壳会正好对得上，
 * 于是永远不重建。所以链接那一侧解析失败时一律判否。
 */
export async function linkPointsTo(link: string, targets: string[]): Promise<boolean> {
  const current = await fs.readlink(link).catch(() => null);

  // 不存在、或压根不是链接（普通目录会 EINVAL）：都算「要重建」
  if (!current) {
    return false;
  }

  // 字面路径对得上就不用再问文件系统（重跑时最常见的那条路）
  if (targets.includes(current)) {
    return true;
  }

  // 解析不到就说明这是个空壳（目标已经没了），别拿字面路径去比——那样正好对得上，永远不重建
  const realLink = await fs.realpath(link).catch(() => current);
  const realTargets = await resolveTargets(targets);

  return realTargets.includes(realLink);
}

/**
 * 把 `link` 指向 `targets` 里第一个能用的那一份，已经指着其中任意一份就跳过。
 *
 * `targets` 是同一个东西的多个候选安装位置（包可能同时留在几个版本目录里），
 * 判定与写入都只在这一处，别处不要再自己读一遍链接。
 */
export async function createSymlink(
  link: string,
  targets: string[],
): Promise<boolean> {
  // 重跑、`pnpm <cmd>` 前置钩子里链接已就位是常态，而 unlink + symlink 是两次写操作，
  // 还会让链接短暂消失
  if (await linkPointsTo(link, targets)) {
    return true;
  }

  await unlinkIfPresent(link);
  await fs.symlink(targets[0] as string, link, getLinkType(targets[0]));

  return true;
}

/** package.json 里用得着的那几个字段 */
export type PackageMeta = {
  bin?: string | Record<string, string>;
};

/** 读取包的 package.json，读不到或内容无效时返回 null */
export async function readPackageJson(
  pkgDir: string,
): Promise<PackageMeta | null> {
  try {
    const content = await fs.readFile(
      path.join(pkgDir, 'package.json'),
      'utf8',
    );

    return JSON.parse(content) as PackageMeta;
  } catch {
    return null;
  }
}
