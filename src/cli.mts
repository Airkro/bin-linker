import { isAbsolute, relative } from 'node:path';

import { linkPackageBins, type Outcome, type PkgResult } from './link.mts';
import { toPkgName } from './name.mts';
import { fmt, log } from './output.mts';

/**
 * 走到执行这一步的结果才有命令。
 *
 * 没找到包、包没有可执行文件、定位不了全局目录，这三种是「没干活」，只有原因没有命令。
 */
function isLinked(outcome: Outcome): outcome is PkgResult {
  return (
    !('notFound' in outcome) &&
    !('noBin' in outcome) &&
    !('globalBinDir' in outcome)
  );
}

/** 环境问题比「这个包链不上」更该让人去修，优先级最高 */
const ENV_FAILURES = new Set(['globalBinDir', 'notFound']);

/**
 * argv 里的一个入参 → 包名。
 *
 * 脚本里 `$(pwd)/node_modules/xxx` 这种写法很常见，但 `node_modules` 的实际位置
 * 是按包名拼的，留着绝对路径只会解析不到：工程内的先还原成相对路径（别留一串 `../..`），
 * 再取最后那几段（`@scope` 一起带上）。
 */
function readArg(arg: string): string {
  if (!isAbsolute(arg)) {
    return toPkgName(arg);
  }

  const rel = relative(process.cwd(), arg);

  return toPkgName(rel && !rel.startsWith('..') ? rel : arg);
}

/**
 * 播报一个包的结果。
 *
 * 每种处境只说一句，按「最该让人去修哪」排。
 * 「补全依赖」是对刚链接的命令的补充，要跟在本包结果后面说，别拖到后面去。
 */
function report(outcome: Outcome): void {
  if (isLinked(outcome)) {
    const { pkg, commands = [], depsLinked } = outcome;

    if (commands.length > 0) {
      log.info(
        `${fmt.pkg(pkg)}: 已链接 ${fmt.list(commands.map((cmd) => fmt.cmd(cmd)))}`,
      );

      // pnpm 全局布局下包够不到自己的间接依赖，这里在包里补了一层 node_modules 指回全局安装根，
      // 说明一下免得让人以为谁改动了 store。只在真有新链接时出现，重跑不会再刷一遍。
      if (depsLinked) {
        log.info(`已为 ${fmt.pkg(pkg)} 补全依赖链接（来自 pnpm 全局安装根）`);
      }
    }
  } else if (outcome.globalBinDir) {
    log.warn(`无法定位 ${fmt.pkg(outcome.pkg)} 的全局安装目录`);
    log.info(`请先把 pnpm 的全局 bin 目录加入 PATH: ${fmt.cmd('pnpm setup')}`);
  } else if (outcome.noBin) {
    log.warn(`包 ${fmt.pkg(outcome.pkg)} 没有可执行文件`);
  } else {
    log.warn(`找不到包: ${fmt.pkg(outcome.pkg)}`);
  }

  for (const { name, error } of isLinked(outcome)
    ? (outcome.errors ?? [])
    : []) {
    log.error(`链接 ${fmt.cmd(name)} 失败: ${error.message}`);
  }
}

/** 把系统错误翻成一句人能读懂的话 */
function reportSystemError({ code, message }: NodeJS.ErrnoException): void {
  switch (code) {
    case 'EPERM': {
      log.error(
        '需要管理员权限运行！在 Windows 上请以管理员身份运行命令提示符',
      );
      log.info(`提示: ${fmt.cmd('右键点击命令提示符 -> 以管理员身份运行')}`);
      break;
    }
    case 'ENOENT': {
      log.error('找不到指定的包或目录');
      log.info('请确保包已全局安装，可以使用以下命令安装:');
      log.info(fmt.cmd('pnpm add -g <package-name>'));
      break;
    }
    default: {
      log.error(`操作失败: ${message}`);
    }
  }
}

/** 链接 argv 里的包，把结果写进日志，并给出退出码 */
export async function run(): Promise<number> {
  // 先归一成包名再去重：`tool`、`tool`、`$(pwd)/node_modules/tool` 说的是同一个包，
  // 归一之前它们是三个不同的字符串，去重形同虚设（播报两遍、命令数翻倍）
  const packages = [
    ...new Set(
      process.argv
        .slice(2)
        .filter((arg) => !arg.startsWith('-'))
        .map((arg) => readArg(arg)),
    ),
  ];

  if (packages.length === 0) {
    log.warn('请指定要链接的包名');
    log.info('Usage: bin-linker <package-name> [<package-name>...]');

    // 没干活就是失败，跟「没链上任何命令」一个口径
    return 1;
  }

  let outcomes: Outcome[];

  try {
    outcomes = await linkPackageBins(packages);
  } catch (error) {
    reportSystemError(error as NodeJS.ErrnoException);

    return 1;
  }

  for (const outcome of outcomes) {
    report(outcome);
  }

  const linkedCount = outcomes.reduce(
    (total, outcome) =>
      total + (isLinked(outcome) ? (outcome.commands?.length ?? 0) : 0),
    0,
  );

  if (linkedCount === 0) {
    log.warn('没有链接任何命令');

    return 1;
  }

  if (outcomes.length > 1) {
    log.info(`共链接了 ${linkedCount} 个命令`);
  }

  // 全局 bin 目录不在 PATH、包没装，都是得让人去处理的事，不能因为别的包链上了就报成功
  const failed = outcomes.some((outcome) =>
    Object.keys(outcome).some((key) => ENV_FAILURES.has(key)),
  );

  return failed ? 1 : 0;
}
