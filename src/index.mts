import { run } from './cli.mts';
import { log } from './output.mts';

/** 兜住未捕获的异常：只留一句人能读的，退出码交给平台 */
function handleUncaughtError(error: Error): void {
  log.error(`程序错误: ${error.message}`);
  process.exitCode = 1;
}

process.on('uncaughtException', handleUncaughtError);
process.on('unhandledRejection', handleUncaughtError);

run()
  .then((exitCode) => {
    process.exitCode = exitCode;
  })
  .catch((error: Error) => {
    log.error(`执行失败: ${error.message}`);
    process.exitCode = 1;
  });
