import { linkPackages } from './core.mjs';
import { fmt, log } from './output.mjs';

/**
 * 处理错误并返回退出码
 */
function handleError(err) {
  const errorHandlers = {
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

  (errorHandlers[err.code] || errorHandlers.default)();

  return 1;
}

/**
 * 显示使用说明
 */
function showUsage() {
  log.warn('请指定要链接的包名');
  log.info('用法: bin-linker <package-name> [<package-name>...]');

  return 0;
}

/**
 * 显示链接结果
 */
function showResults({ results }) {
  let linkedCount = 0;

  results.forEach((pkgResult) => {
    if (pkgResult.notFound) {
      log.warn(`找不到包: ${fmt.pkg(pkgResult.pkg)}`);
    } else if (pkgResult.noBin) {
      log.warn(`包 ${fmt.pkg(pkgResult.pkg)} 没有可执行文件`);
    } else if (pkgResult.commands.length > 0) {
      log.info(
        `${fmt.pkg(pkgResult.pkg)}: 已链接 ${fmt.list(pkgResult.commands.map((cmd) => fmt.cmd(cmd)))}`,
      );
      linkedCount += pkgResult.commands.length;
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
export async function run() {
  try {
    const packages = process.argv
      .slice(2)
      .filter((arg) => !arg.startsWith('-'));

    if (packages.length === 0) {
      return showUsage();
    }

    const result = await linkPackages(packages);

    return showResults(result);
  } catch (error) {
    return handleError(error);
  }
}
