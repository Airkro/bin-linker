import { promises as fs } from 'node:fs';
import path from 'node:path';

/** 读目录，读不到时当作空目录：「不存在」与「没权限」在这里都是「没有」 */
export function readDir(dir: string): Promise<string[]> {
  return fs.readdir(dir).catch((): string[] => []);
}

/** 解析软链，解析不到（断链、不存在）就按字面路径算 */
export function resolvePath(target: string): Promise<string> {
  return fs.realpath(target).catch(() => target);
}

/**
 * Windows 建软链必须指明类型。
 *
 * 链接的是**目录**（包本体、`node_modules` 里的依赖），只能给 `junction`：
 * `file` 类型对目录必失败，`dir` 类型又要开发者模式或管理员权限。
 * junction 由文件系统层实现，免权限。只有真对着一个文件建链时才用 `file`。
 */
export function getLinkType(
  target: string,
  platform = process.platform,
): 'file' | 'junction' | undefined {
  if (platform !== 'win32') {
    return undefined;
  }

  return path.extname(target) ? 'file' : 'junction';
}

function isMissing(error: NodeJS.ErrnoException): boolean {
  return error.code === 'ENOENT';
}

export function ensureDir(dir: string): Promise<boolean> {
  return fs.mkdir(dir, { recursive: true }).then(
    () => true,
    () => false,
  );
}

/**
 * 链接是否已经指着 `targets` 里的某一份。
 *
 * `readlink` 先确认它确实是个链接（不存在、或是被解压进来的普通目录都要重建），
 * 字面路径对得上就省掉文件系统解析。只有两边都还在时才比真实路径：
 * 链接解析不到说明它是空壳，拿字面路径去比正好对得上，于是永远不重建。
 */
export async function linkPointsTo(
  link: string,
  targets: string[],
): Promise<boolean> {
  const current = await fs.readlink(link).catch(() => null);

  if (!current) {
    return false;
  }

  if (targets.includes(current)) {
    return true;
  }

  const [realLink, realTargets] = await Promise.all([
    fs.realpath(link).catch(() => null),
    Promise.all(targets.map((target) => resolvePath(target))),
  ]);

  return realLink !== null && realTargets.includes(realLink);
}

/**
 * 把 `link` 指向 `targets` 里第一个能用的那一份，已经指着其中任意一份就跳过。
 *
 * `targets` 是同一个东西的多个候选位置（包可能同时留在几个版本目录里）。
 * 重跑、`pnpm <cmd>` 前置钩子里链接已就位是常态，而 unlink + symlink
 * 是两次写操作，还会让链接短暂消失。
 */
export async function createSymlink(
  link: string,
  targets: string[],
): Promise<void> {
  if (await linkPointsTo(link, targets)) {
    return;
  }

  // 不存在的链接当它已经删掉了
  await fs.unlink(link).catch((error: NodeJS.ErrnoException) => {
    if (!isMissing(error)) {
      throw error;
    }
  });

  const [target] = targets as [string];

  await fs.symlink(target, link, getLinkType(target));
}

/** package.json 里用得着的那几个字段 */
export type PackageMeta = {
  bin?: string | Record<string, string>;
};

/** 读取包的 package.json，读不到或内容无效时返回 null */
export function readPackageJson(pkgDir: string): Promise<PackageMeta | null> {
  return fs
    .readFile(path.join(pkgDir, 'package.json'), 'utf8')
    .then((content) => JSON.parse(content) as PackageMeta)
    .catch(() => null);
}
