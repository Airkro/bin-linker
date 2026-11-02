import path from 'node:path';

import { promises as fs } from 'node:fs';

import { createSymlink, ensureDir, findUnresolvedDeps, settle } from './fs.mts';
import { isBinDirMissingFromPath } from './pnpm.mts';
import { planPackageLinks, type BinEntry, type LinkPlan } from './plan.mts';
import type { Failure, Outcome, PkgResult } from './result.mts';

const projectDir = process.cwd();
/**
链接落在工程自己的 `node_modules` 里，与包管理器装出来的一致
*/
const localBinDir = path.join(projectDir, 'node_modules', '.bin');

/**
Windows 的 EPERM 只能靠管理员权限解决，交给 CLI 统一提示，别在这里吞掉
*/
function toFailure(name: string, error: unknown): Failure {
  const { code } = error as NodeJS.ErrnoException;

  if (code === 'EPERM' && process.platform === 'win32') {
    throw error;
  }

  return { name, error: error as Error };
}

/**
把可执行文件逐个链进工程的 `node_modules/.bin`。

一个失败不影响其余命令：包本身已经就位，赔掉一个命令而已。
*/
async function linkBinEntries(
  plan: LinkPlan,
): Promise<{ commands: string[]; errors: Failure[] }> {
  const attempts = await Promise.all(
    plan.binEntries.map(([name, relPath]) =>
      settle(
        createSymlink(path.join(localBinDir, name), [
          path.join(plan.pkgDir, relPath),
        ]),
      ),
    ),
  );
  const commands: string[] = [];
  const errors: Failure[] = [];

  attempts.forEach((error, index) => {
    const [name] = plan.binEntries[index] as BinEntry;

    if (error) {
      // 单个命令没链上而已，包与其余命令照常
      errors.push(toFailure(name, error));
    } else {
      commands.push(name);
    }
  });

  return { commands, errors };
}

/**
把计划里缺的依赖补进包自己的 `node_modules`，返回是否真的补上了东西。

补不上不算错误：命令链接已经建好，缺哪个依赖交给运行时照实报错。
*/
async function hasLinkDeps(plan: LinkPlan): Promise<boolean> {
  if (plan.deps.length === 0 && plan.stale.length === 0) {
    return false;
  }

  // 断链先撤：它占着位置，`symlink` 一律 EEXIST，后面再想补就永远补不上。
  // 撤不掉说明正在有人动这棵树，把这一条交下去照实报错。
  const removed = await Promise.all(
    plan.stale.map((link) =>
      fs
        .unlink(link)
        .then(() => null)
        .catch((error: NodeJS.ErrnoException) => error),
    ),
  );
  // 依赖目录也是 store 里的真实目录，Windows 上与包本体一样建目录链接。
  // 有一个补上就算这一趟有收获，其余交给运行时。
  const attempts = await Promise.all(
    plan.deps.map(({ link, target }) => settle(createSymlink(link, [target]))),
  );

  return [...removed, ...attempts].includes(null);
}

/**
铺好链接要落的目录，返回真的铺出来的那些。

工程可能刚 `npm init`，一个 `node_modules` 都没有；store 里那个包也可能从没建过
`node_modules`。软链不会替谁建父目录，缺一层就 ENOENT——报出来只是一句
「no such file or directory」，看着像包没装，其实是目录没铺。

只返回建成功的：已经在那儿的目录不该被 unlink 掉，那是别人的东西。
建不成也不挡事，真需要它时建链自己会照实报错。
*/
async function prepareDirs(plan: LinkPlan): Promise<string[]> {
  const dirs = [
    localBinDir,
    path.dirname(plan.pkgLink),
    ...plan.deps.map(({ link }) => path.dirname(link)),
  ];
  const made = await Promise.allSettled(dirs.map((dir) => ensureDir(dir)));

  return dirs.filter((_, index) => made[index]?.status === 'fulfilled');
}

/**
收尾：这一趟为落链接铺出来的目录，没人用得上就撤掉，别在工程里留空壳。

只有空目录才删得掉，里面已经有东西时 `rmdir` 自己会失败，这里不必先探一遍。
*/
async function dropEmptyDirs(dirs: string[]): Promise<void> {
  for (const dir of dirs.toReversed()) {
    await fs.rmdir(dir).catch(() => undefined);
  }
}

/**
补完之后再验一遍：包里那份依赖是不是真够得着。

补依赖是照平铺表铺的，铺没铺对没人验过。命令能起来不等于包能用——很多包先做参数校验，
依赖要等到后面某条 require 才炸。构建里那句「projectPath should not be empty」
就是这么把断链糊过去的：CI 一路绿灯，用户手里一跑就崩。

只在这一次真动过依赖时才查：什么都没动说明上一趟已经铺好，再验一遍等于每次启动
把几百个依赖重解析一遍。
*/
async function verifyDeps(
  pkgDir: string,
  declared: string[],
): Promise<string[]> {
  return declared.length === 0
    ? []
    : findUnresolvedDeps(pkgDir, declared).catch(() => []);
}

/**
执行一份计划：包本体 → 命令与依赖并行
*/
async function runPlan(pkg: string, plan: LinkPlan): Promise<PkgResult> {
  // 包本体与全部命令都落在工程自己的 node_modules 里。
  // 候选位置按新到旧一起交给链接：任意一份已到位就不重建，要建就建最新那份。
  const madeDirs = await prepareDirs(plan);

  await createSymlink(plan.pkgLink, plan.pkgDirs);

  // 补依赖与建命令链接互不相干，并行：补依赖要读 store 那张表，动辄几十个 syscall。
  // 补依赖是附赠的，补不上不影响已建好的命令链接。
  const [depsLinked, linkResult] = await Promise.all([
    hasLinkDeps(plan),
    linkBinEntries(plan),
  ]);

  // 这一趟没动过依赖，包里那份到底够不够得着就没底了——照清单当场验一遍，
  // 别把「命令起来了」当成「包能用了」
  const unresolved = depsLinked
    ? []
    : await verifyDeps(plan.pkgDir, plan.declared);

  // 一件都没落下就把铺出来的目录撤掉：工程里不该多出空的 node_modules
  await dropEmptyDirs(madeDirs);

  return { pkg, ...linkResult, depsLinked, unresolved };
}

async function linkPackageBin(pkg: string): Promise<Outcome> {
  const outcome = await planPackageLinks(pkg, projectDir);

  if ('pkgLink' in outcome) {
    return runPlan(pkg, outcome);
  }

  // 全局 bin 目录不在 PATH 时 pnpm 自身的全局目录查询也会失效，
  // 一处候选都没有多半是「环境没配好」，不是「包没安装」。
  return outcome.pkgDirs.length === 0 && isBinDirMissingFromPath()
    ? { pkg, pkgDirs: outcome.pkgDirs, globalBinDir: true }
    : outcome;
}

export async function linkPackageBins(packages: string[]): Promise<Outcome[]> {
  // 一个包出错只赔上它自己：别让某个包的意外把整次运行炸掉
  return Promise.all(
    packages.map((pkg) =>
      linkPackageBin(pkg).catch((error: unknown) => ({
        pkg,
        errors: [toFailure(pkg, error)],
      })),
    ),
  );
}
