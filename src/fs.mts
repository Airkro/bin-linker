import { promises as fs } from 'node:fs';
import { builtinModules, createRequire } from 'node:module';
import path from 'node:path';

/**
读目录，读不到时当作空目录：「不存在」与「没权限」在这里都是「没有」
*/
export function readDir(dir: string): Promise<string[]> {
  return fs.readdir(dir).catch((): string[] => []);
}

/**
解析软链，解析不到（断链、不存在）就按字面路径算
*/
export function resolvePath(target: string): Promise<string> {
  return fs.realpath(target).catch(() => target);
}

/**
只解析最后一段，解析不了就给字面路径。

`realpath` 会一路解析到根：pnpm 的全局 `node_modules` 整层常常是软链
（`global/v11/node_modules -> global/v11/<id>/node_modules`），解到底是一份
按内容寻址命名、每次安装都换名字的目录。用它比对「链接指着的是不是这一份」，
换一次安装就永远对不上。
*/
function resolveLink(target: string): Promise<string> {
  return fs
    .readlink(target)
    .then((points) =>
      path.resolve(path.dirname(target), points.replace(/^\/(?!\/)/, '/')),
    )
    .catch(() => target);
}

/**
package.json 里用得着的那几个字段
*/
export type PackageMeta = {
  bin?: string | Record<string, string>;
  exports?: unknown;
  dependencies?: Record<string, string>;
};

/**
读取包的 package.json，读不到或内容无效时返回 null
*/
export function readPackageJson(pkgDir: string): Promise<PackageMeta | null> {
  return fs
    .readFile(path.join(pkgDir, 'package.json'), 'utf8')
    .then((content) => JSON.parse(content) as PackageMeta)
    .catch(() => null);
}

/**
这些顶层条目是 `node` 自带的模块，不该去磁盘上找
*/
const builtin = new Set(
  builtinModules.flatMap((name) => [name, `node:${name}`]),
);

const isBuiltin = (name: string): boolean => builtin.has(name);

/**
`require('a/b')` 里的 `a`：带 scope 的连第一段一起算
*/
function rootOf(name: string): string {
  const [first = '', second = ''] = name.split('/', 2);

  return first.startsWith('@') ? `${first}/${second}` : first;
}

/**
`exports` 里的一条子路径：`./foo` 这种，能接住 `require('x/foo')`
*/
function isSubpath(key: string): boolean {
  return typeof key === 'string' && key.startsWith('./');
}

/**
这份 `package.json` 的 `exports` 是不是一条根入口都没给。

这种包的根（`require('x')`）在 node 里必然解析不了：`exports` 给的全是子路径，
就没有一条能接住包名本身。它本身不说明东西缺了（`@babel/runtime` 就是这么写的，
用的人只从子路径进），可「找不到」到底是这种正常情况、还是真缺了东西，
只有这份元数据分得清。
*/
function hasNoRootEntry(meta: PackageMeta): boolean {
  const { exports: entryExports } = meta;

  if (!entryExports || typeof entryExports !== 'object') {
    return false;
  }

  const declared = Array.isArray(entryExports)
    ? entryExports
    : Object.keys(entryExports);

  return !declared.includes('.') && declared.every((key) => isSubpath(key));
}

/**
解析到的东西是不是真在包自己的 `node_modules` 里。

两边都解到根再比：这条链上每一层都可能是软链（工程 `node_modules` 里那条指进 store），
拿字面路径比对的话，屋里那份也会被判成「在外头」。
*/
async function isInside(
  ownDir: string,
  name: string,
  found: string,
): Promise<boolean> {
  const dir = await resolvePath(path.join(ownDir, name));

  return !path.relative(dir, found).startsWith('..');
}

/**
解析一个说明符，返回它的真实路径；解析不到给 null
*/
function resolveTo(
  require: NodeJS.Require,
  specifier: string,
): Promise<string | null> {
  return Promise.try(() => require.resolve(specifier))
    .then((found) => resolvePath(found))
    .catch(() => null);
}

/**
包里那份依赖的元数据，读不到给 null
*/
function readMeta(pkgDir: string, name: string): Promise<PackageMeta | null> {
  return readPackageJson(path.join(pkgDir, 'node_modules', name));
}

/**
`pkgDir` 这个包跑起来之后，还够不够得着自己的依赖。

补依赖是照平铺表整张铺的，表本身对不对没人验过：链接指着上一次安装的版本目录、
版本目录里的那份被换掉、或者干脆只补了一半——每一种都能让命令照常启动
（参数校验在前），一 require 才炸。构建里看到的「绿」，就是这么来的。

只查两件事，都是「包自己声明的依赖」里能当场判死的：
- 根都解析不到的：这份依赖等于不存在；
- 解析到的东西在包自己的 `node_modules` 之外：它只是往上摸到了一份别人的
  （工程自己的 `node_modules` 就在上面），换成另一个工程就又不是这样了。

每个依赖再试一条子路径：根解析不到而子路径能解析，是「没给根入口」，不是缺。
*/
export async function findUnresolvedDeps(
  pkgDir: string,
  names: string[],
): Promise<string[]> {
  const entry = path.join(pkgDir, 'index.mjs');
  const require = createRequire(entry);
  const ownDir = path.join(pkgDir, 'node_modules');

  const broken = await Promise.all(
    names
      .map((name) => rootOf(name))
      .filter((name) => name && !isBuiltin(name))
      .map(async (name) => {
        const tail = name.split('/').at(-1) ?? name;
        const [found, sub] = await Promise.all([
          resolveTo(require, name),
          resolveTo(require, `${name}/${tail}`),
        ]);

        if (found === null) {
          const meta = await readMeta(pkgDir, name);

          return sub === null && !(meta && hasNoRootEntry(meta)) ? name : null;
        }

        const isContained = await isInside(ownDir, rootOf(name), found);

        return isContained ? null : name;
      }),
  );

  return broken.filter((name): name is string => name !== null);
}

/**
这个条目算不算一个包：点号开头的是 pnpm 自己的元数据（`.bin`、`.modules.yaml`）
*/
export function isPackageEntry(name: string): boolean {
  return !name.startsWith('.');
}

/**
这一层在不在，并且里头有没有东西：空目录与不存在的目录一样，都当「没有」。

只认非点号条目：层里总留着元数据，把 `.bin` 当成「有东西」，空壳层就永远挑得中，
链过去命令照样起不来，依赖也按一张空表算。
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
路径是不是目录；探不到（ENOENT、断链）一律当不是。

探得到的那份可能是个软链，要的是它指向的东西——`stat` 本来就跟到根。
*/
async function isDir(target: string): Promise<boolean> {
  try {
    const stat = await fs.stat(target);

    return stat.isDirectory();
  } catch {
    return false;
  }
}

/**
做一件事，成与不成互不牵连：返回 `null` 表示成了，否则是败因。

建命令链接、补依赖都是这个形状：一件事成不成不取决于旁边那件。
*/
export function settle(task: Promise<unknown>): Promise<Error | null> {
  return task.then(() => null).catch((error: Error) => error);
}

/**
建目录（含父级）。建不成就当它不存在，由后面那一步报错
*/
export async function ensureDir(dir: string): Promise<void> {
  await fs.mkdir(dir, { recursive: true }).catch(() => undefined);
}

/**
Windows 建软链必须指明类型。

链接的是**目录**（包本体、`node_modules` 里的依赖），只能给 `junction`：
`file` 类型对目录必失败，`dir` 类型又要开发者模式或管理员权限。
junction 由文件系统层实现，免权限。只有真对着一个文件建链时才用 `file`。
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
候选里第一份真在的；一份都没有时返回 null。

排在前面那份要是空壳软链（`global/v11/node_modules` 这种），就挑后面那份有内容的：
链到空壳上命令照样起不来。
*/
async function firstPresent(targets: string[]): Promise<string | null> {
  for (const target of targets) {
    const isPresent = await fs
      .access(target)
      .then(() => true)
      .catch(() => false);

    // 目录要挑有内容的：候选里的空壳（`global/v11/node_modules` 这类探得到、
    // 里头什么都没有的层）链过去命令照样起不来。文件不谈空壳，在就成
    const isUsable =
      isPresent && (!(await isDir(target)) || (await hasEntries(target)));

    if (isUsable) {
      return target;
    }
  }

  return null;
}

/**
链接是否已经指着 `targets` 里的某一份；不是链接（不存在、或是被解压进来的普通目录）就算没到位。

两边都必须解析成功才算数，字面路径对得上不算：链接是个空壳时（包被挪走了、
或上一次指到一份不存在的候选上），它的字面路径恰好等于某个候选，
拿字面路径去比就永远「已到位」，于是再也不重建——用户看到的就是一条断链。

所以链接本身解到根，候选只解最后一段：候选整层是软链时（`global/v11/node_modules`
指进内容寻址目录），解到根会换名字，指着的其实是同一条软链也会被判成「不在位」，
于是每次运行都重建一遍链接。
*/
export async function isLinkPointsTo(
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
把 `link` 指向 `targets` 里第一份真在的东西，已经指着其中任意一份就跳过。

`targets` 是同一个东西的多个候选位置（包可能同时留在几个版本目录里）。
重跑、`pnpm <cmd>` 前置钩子里链接已就位是常态，而 unlink + symlink
是两次写操作，还会让链接短暂消失。

建链的对象必须挑一份存在的：候选表里常有不存在的层（pnpm 12 的
`global/v11/node_modules` 就只是个空壳），照着排头建等于亲手做一条断链。
*/
export async function createSymlink(
  link: string,
  targets: string[],
): Promise<void> {
  if (await isLinkPointsTo(link, targets)) {
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
这个位置上的条目还在不在：`exists` 只说名字占没占住（断链也算），
`alive` 才是「连过去真能拿到东西」。

两件事得分开：名字都没占住是「要补」，名字占着而连不过去是「先撤再补」——
后者光补补不上，`symlink` 对着已存在的条目一律 EEXIST。
*/
export async function probePath(
  link: string,
): Promise<{ exists: boolean; alive: boolean }> {
  const [exists, alive] = await Promise.all([
    fs
      .lstat(link)
      .then(() => true)
      .catch(() => false),
    // `stat` 会一路跟下去：断了、指向的那份被删了，都算不在
    fs
      .stat(link)
      .then(() => true)
      .catch(() => false),
  ]);

  return { exists, alive };
}
