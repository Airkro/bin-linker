import { linkPackageBins, type PkgResult } from './core.mts';
import { fmt, log } from './output.mts';

/** 处理错误并返回退出码 */
function handleError(err: NodeJS.ErrnoException): number {
  switch (err.code) {
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
      log.error(`操作失败: ${err.message}`);
    }
  }

  return 1;
}

/** 把单个包的结果写进日志，返回链接成功的命令数 */
function report(result: PkgResult): number {
  const { pkg, commands = [], errors, depsLinked } = result;

  if (result.notFound) {
    log.warn(`找不到包: ${fmt.pkg(pkg)}`);

    return 0;
  }

  if (result.globalBinDir) {
    log.warn(`无法定位 ${fmt.pkg(pkg)} 的全局安装目录`);
    log.info(`请先把 pnpm 的全局 bin 目录加入 PATH: ${fmt.cmd('pnpm setup')}`);

    return 0;
  }

  if (result.noBin) {
    log.warn(`包 ${fmt.pkg(pkg)} 没有可执行文件`);

    return 0;
  }

  if (commands.length > 0) {
    log.info(
      `${fmt.pkg(pkg)}: 已链接 ${fmt.list(commands.map((cmd) => fmt.cmd(cmd)))}`,
    );

    // pnpm 全局布局下包够不到自己的间接依赖，这里顺手补齐了，说明一下免得让人以为谁改动了 store
    if (depsLinked) {
      log.info(`已为 ${fmt.pkg(pkg)} 补全依赖链接（来自 pnpm 全局安装根）`);
    }
  }

  for (const { name, error } of errors ?? []) {
    log.error(`链接 ${fmt.cmd(name)} 失败: ${error.message}`);
  }

  return commands.length;
}

/** 链接 argv 里的包，把结果写进日志，并给出退出码 */
export async function run(): Promise<number> {
  const packages = process.argv.slice(2).filter((arg) => !arg.startsWith('-'));

  if (packages.length === 0) {
    log.warn('请指定要链接的包名');
    log.info('Usage: bin-linker <package-name> [<package-name>...]');

    return 0;
  }

  try {
    const { results } = await linkPackageBins(packages);
    const linkedCount = results.reduce(
      (total, result) => total + report(result),
      0,
    );

    if (!linkedCount) {
      log.warn('没有链接任何命令');
    } else if (results.length > 1) {
      log.info(`共链接了 ${linkedCount} 个命令`);
    }

    // 全局 bin 目录不在 PATH 是环境问题，比「这个包链接失败」更该让人去修
    return results.some(({ globalBinDir }) => globalBinDir) || !linkedCount
      ? 1
      : 0;
  } catch (error) {
    return handleError(error as NodeJS.ErrnoException);
  }
}
