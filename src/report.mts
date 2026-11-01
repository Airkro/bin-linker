import { fmt, log } from './output.mts';
import { isLinked, type Outcome } from './result.mts';

/**
 * 播报一个包的结果。
 *
 * 每种处境只说一句，按「最该让人去修哪」排。
 * 「补全依赖」是对刚链接的命令的补充，要跟在本包结果后面说，别拖到后面去。
 */
export function report(outcome: Outcome): void {
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
export function reportSystemError({ code, message }: NodeJS.ErrnoException): void {
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
