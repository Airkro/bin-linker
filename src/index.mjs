#!/usr/bin/env node
import { run } from './cli.mjs';
import { log } from './output.mjs';

/**
 * 处理未捕获的异常
 */
function handleUncaughtError(error) {
  log.error(`程序错误: ${error.message}`);
  process.exitCode = 1;
}

// 注册全局错误处理器
process.on('uncaughtException', handleUncaughtError);
process.on('unhandledRejection', handleUncaughtError);

// 运行CLI并处理退出码
run()
  .then((exitCode) => {
    process.exitCode = exitCode;
  })
  .catch((error) => {
    log.error(`执行失败: ${error.message}`);
    process.exitCode = 1;
  });
