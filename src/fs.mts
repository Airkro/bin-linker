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

/** 这一层在不在，并且里头有没有东西：空目录与不存在的目录一样，都当「没有」 */
export async function hasEntries(dir: string): Promise<boolean> {
  const [stat, names] = await Promise.all([
    fs.stat(dir).catch(() => null),
    readDir(dir),
  ]);

  return stat?.isDirectory() === true && names.length > 0;
}

/**
 * 做一件事，成与不成互不牵连：返回 `null` 表示成了，否则是败因。
 *
 * 建命令链接、补依赖都是这个形状：一件事成不成不取决于旁边那件。
 */
export function settle(task: Promise<unknown>): Promise<Error | null> {
  return task.then(
    () => null,
    (error: Error) => error,
  );
}

/** 建目录（含父级）。建不成就当它不存在，由后面那一步报错 */
export async function ensureDir(dir: string): Promise<void> {
  await fs.mkdir(dir, { recursive: true }).catch(() => undefined);
}

/**
 * Windows 建软链必须指明类型。
 *
 * 链接的是**目录**（包本体、`node_modules` 里的依赖），只能给 `junction`：
 * `file` 类型对目录必失败，`dir` 类型又要开发者模式或管理员权限。
 * junction 由文件系统层实现，免权限。只有真对着一个文件建链时才用 `file`。
 */
function getLinkType(
  target: string,
  platform = process.platform,
): 'file' | 'junction' | undefined {
  if (platform !== 'win32') {
    return undefined;
  }

  return path.extname(target) ? 'file' : 'junction';
}

/** 候选里第一份真在的；一份都没有时返回 null */
async function firstPresent(targets: string[]): Promise<string | null> {
  for (const target of targets) {
    const present = await fs.access(target).then(
      () => true,
      () => false,
    );

    if (present) {
      return target;
    }
  }

  return null;
}

/**
 * 链接是否已经指着 `targets` 里的某一份；不是链接（不存在、或是被解压进来的普通目录）就算没到位。
 *
 * 两边都必须解析成功才算数，字面路径对得上不算：链接是个空壳时（包被挪走了、
 * 或上一次指到一份不存在的候选上），它的字面路径恰好等于某个候选，
 * 拿字面路径去比就永远「已到位」，于是再也不重建——用户看到的就是一条断链。
 */
export async function linkPointsTo(
  link: string,
  targets: string[],
): Promise<boolean> {
  const [realLink, realTargets] = await Promise.all([
    fs.realpath(link).catch(() => null),
    Promise.all(targets.map((target) => resolvePath(target))),
  ]);

  return realLink !== null && realTargets.includes(realLink);
}

/**
 * 把 `link` 指向 `targets` 里第一份真在的东西，已经指着其中任意一份就跳过。
 *
 * `targets` 是同一个东西的多个候选位置（包可能同时留在几个版本目录里）。
 * 重跑、`pnpm <cmd>` 前置钩子里链接已就位是常态，而 unlink + symlink
 * 是两次写操作，还会让链接短暂消失。
 *
 * 建链的对象必须挑一份存在的：候选表里常有不存在的层（pnpm 12 的
 * `global/v11/node_modules` 就只是个空壳），照着排头建等于亲手做一条断链。
 */
export async function createSymlink(
  link: string,
  targets: string[],
): Promise<void> {
  if (await linkPointsTo(link, targets)) {
    return;
  }

  const target = await firstPresent(targets);

  if (!target) {
    throw new Error(`候选位置都不存在: ${targets.join(', ')}`);
  }

  // 不存在的链接当它已经删掉了
  await fs.unlink(link).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== 'ENOENT') {
      throw error;
    }
  });

  await fs.symlink(target, link, getLinkType(target));
}
