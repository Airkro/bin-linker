import { run } from './cli.mts';
import { log } from './output.mts';

/**
兜住没接住的异常：只留一句人能读的，退出码交给平台
*/
function fail(error: Error): void {
  log.error(`程序错误: ${error.message}`);
  process.exitCode = 1;
}

process.on('uncaughtException', fail);
process.on('unhandledRejection', fail);

run()
  .then((exitCode) => {
    process.exitCode = exitCode;
  })
  .catch(fail);
