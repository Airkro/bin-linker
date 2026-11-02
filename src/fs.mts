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
 * 只解析最后一段，解析不了就给字面路径。
 *
 * `realpath` 会一路解析到根：pnpm 的全局 `node_modules` 整层常常是软链
 * （`global/v11/node_modules -> global/v11/<id>/node_modules`），解到底是一份
 * 按内容寻址命名、每次安装都换名字的目录。用它比对「链接指着的是不是这一份」，
 * 换一次安装就永远对不上。
 */
function resolveLink(target: string): Promise<string> {
  return fs.readlink(target).then(
    (points) =>
      path.resolve(path.dirname(target), points.replace(/^\/(?!\/)/, '/')),
    () => target,
  );
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

/** 这个条目算不算一个包：点号开头的是 pnpm 自己的元数据（`.bin`、`.modules.yaml`） */
export function isPackageEntry(name: string): boolean {
  return !name.startsWith('.');
}

/**
 * 这一层在不在，并且里头有没有东西：空目录与不存在的目录一样，都当「没有」。
 *
 * 只认非点号条目：层里总留着元数据，把 `.bin` 当成「有东西」，空壳层就永远挑得中，
 * 链过去命令照样起不来，依赖也按一张空表算。
 */
export async function hasEntries(dir: string): Promise<boolean> {
  const [stat, names] = await Promise.all([
    fs.stat(dir).catch(() => null),
    readDir(dir),
  ]);

  return (
    stat?.isDirectory() === true && names.some((name) => isPackageEntry(name))
  );
}

/**
 * 路径是不是目录；探不到（ENOENT、断链）一律当不是。
 *
 * 探得到的那份可能是个软链，要的是它指向的东西——`stat` 本来就跟到根。
 */
function isDir(target: string): Promise<boolean> {
  return fs.stat(target).then(
    (stat) => stat.isDirectory(),
    () => false,
  );
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

/**
 * 候选里第一份真在的；一份都没有时返回 null。
 *
 * 排在前面那份要是空壳软链（`global/v11/node_modules` 这种），就挑后面那份有内容的：
 * 链到空壳上命令照样起不来。
 */
async function firstPresent(targets: string[]): Promise<string | null> {
  for (const target of targets) {
    const present = await fs.access(target).then(
      () => true,
      () => false,
    );

    // 目录要挑有内容的：候选里的空壳（`global/v11/node_modules` 这类探得到、
    // 里头什么都没有的层）链过去命令照样起不来。文件不谈空壳，在就成
    const usable =
      present && (!(await isDir(target)) || (await hasEntries(target)));

    if (usable) {
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
 *
 * 所以链接本身解到根，候选只解最后一段：候选整层是软链时（`global/v11/node_modules`
 * 指进内容寻址目录），解到根会换名字，指着的其实是同一条软链也会被判成「不在位」，
 * 于是每次运行都重建一遍链接。
 */
export async function linkPointsTo(
  link: string,
  targets: string[],
): Promise<boolean> {
  const realLink = await fs.realpath(link).catch(() => null);

  if (realLink === null) {
    return false;
  }

  const [reals, links] = await Promise.all([
    Promise.all(targets.map((target) => resolvePath(target))),
    Promise.all(targets.map((target) => resolveLink(target))),
  ]);

  return reals.includes(realLink) || links.includes(realLink);
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

/**
 * 这个位置上的条目还在不在：`exists` 只说名字占没占住（断链也算），
 * `alive` 才是「连过去真能拿到东西」。
 *
 * 两件事得分开：名字都没占住是「要补」，名字占着而连不过去是「先撤再补」——
 * 后者光补补不上，`symlink` 对着已存在的条目一律 EEXIST。
 */
export async function probePath(
  link: string,
): Promise<{ exists: boolean; alive: boolean }> {
  const [exists, alive] = await Promise.all([
    fs.lstat(link).then(
      () => true,
      () => false,
    ),
    // `stat` 会一路跟下去：断了、指向的那份被删了，都算不在
    fs.stat(link).then(
      () => true,
      () => false,
    ),
  ]);

  return { exists, alive };
}
