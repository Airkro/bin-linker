import { linkPackageBins } from './core.mts';
import { fmt, log } from './output.mts';

/**
 * 处理错误并返回退出码
 */
function handleError(err: NodeJS.ErrnoException): number {
  const handlers = {
    EPERM: () => {
      log.error(
        '需要管理员权限运行！在 Windows 上请以管理员身份运行命令提示符',
      );
      log.info(`提示: ${fmt.cmd('右键点击命令提示符 -> 以管理员身份运行')}`);
    },
    ENOENT: () => {
      log.error('找不到指定的包或目录');
      log.info('请确保包已全局安装，可以使用以下命令安装:');
      log.info(fmt.cmd('pnpm add -g <package-name>'));
    },
    default: () => log.error(`操作失败: ${err.message}`),
  };

  const key = err.code as keyof typeof handlers;
  const handler =
    err.code && key in handlers ? handlers[key] : handlers.default;
  handler();

  return 1;
}

/**
 * 显示使用说明
 */
function showUsage(): number {
  log.warn('请指定要链接的包名');
  log.info('Usage: bin-linker <package-name> [<package-name>...]');

  return 0;
}

/**
 * 显示链接结果
 */
function showResults({
  results,
}: {
  results: Array<{
    pkg: string;
    commands?: string[];
    notFound?: boolean;
    noBin?: boolean;
    errors?: Array<{ name: string; error: Error }>;
  }>;
}): number {
  let linkedCount = 0;

  results.forEach((pkgResult) => {
    if (pkgResult.notFound) {
      log.warn(`找不到包: ${fmt.pkg(pkgResult.pkg)}`);
    } else if (pkgResult.noBin) {
      log.warn(`包 ${fmt.pkg(pkgResult.pkg)} 没有可执行文件`);
    } else if ((pkgResult.commands?.length ?? 0) > 0) {
      const commands = pkgResult.commands as string[];
      log.info(
        `${fmt.pkg(pkgResult.pkg)}: 已链接 ${fmt.list(
          commands.map((cmd: string) => fmt.cmd(cmd)),
        )}`,
      );
      linkedCount += commands.length;
    }

    pkgResult.errors?.forEach(({ name, error }) => {
      log.error(`链接 ${fmt.cmd(name)} 失败: ${error.message}`);
    });
  });

  if (!linkedCount) {
    log.warn('没有链接任何命令');
  } else if (results.length > 1) {
    log.info(`共链接了 ${linkedCount} 个命令`);
  }

  return linkedCount ? 0 : 1;
}

/**
 * CLI主函数
 */
export async function run(): Promise<number> {
  try {
    const packages = process.argv
      .slice(2)
      .filter((arg) => !arg.startsWith('-'));

    if (packages.length === 0) {
      return showUsage();
    }

    const result = await linkPackageBins(packages);

    return showResults(result);
  } catch (error) {
    return handleError(error as NodeJS.ErrnoException);
  }
}
