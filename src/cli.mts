import { isAbsolute, relative } from 'node:path';

import { linkPackageBins } from './link.mts';
import { toPkgName } from './name.mts';
import { log } from './output.mts';
import { report, reportSystemError } from './report.mts';
import { isEnvFailure, isLinked, type Outcome } from './result.mts';

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

  // 全局 bin 目录不在 PATH、包没装，都是得让人去处理的事，不能因为别的包链上了就报成功。
  // 依赖断着同样不算成功：命令起得来只说明参数校验跑过了，不是这个包能用
  return outcomes.some(
    (outcome) =>
      isEnvFailure(outcome) ||
      (isLinked(outcome) && (outcome.unresolved?.length ?? 0) > 0),
  )
    ? 1
    : 0;
}
