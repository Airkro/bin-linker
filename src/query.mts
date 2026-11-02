import { execSync } from 'node:child_process';
import path from 'node:path';

import { getGlobalBinDirs } from './pnpm.mts';

/**
 * 子进程用的环境：别改本进程，回滚一份全局状态的代价比设一次子进程环境大得多。
 *
 * - `PATH`：pnpm 10 起会校验全局 bin 目录在不在里面，不在就连 `root -g` 也报错
 * - `npm_config_global_bin_dir`：pnpm 传给子进程的值会盖掉这里补的，校验直接失败
 * - `CI`：corepack 在 CI 置位时才不弹「是否下载」
 * - `npm_config_update_notifier`：更新检查是后台网络请求，断网时能把查询拖成分钟级
 */
function queryEnv(): Record<string, string> {
  const bins = [
    ...getGlobalBinDirs(),
    ...(process.env.PATH ?? '').split(path.delimiter),
  ];
  const {
    CI: _ignoredCi,
    npm_config_global_bin_dir: _ignoredBinDir,
    ...inherited
  } = process.env as Record<string, string | undefined>;

  return {
    ...(inherited as Record<string, string>),
    PATH: [...new Set(bins.filter(Boolean))].join(path.delimiter),
    CI: 'true',
    npm_config_update_notifier: 'false',
  };
}

/**
 * `pnpm root -g` 给出的全局根目录。
 *
 * 查询失败（pnpm 不在 PATH、校验不通过）时返回 null，布局再回退到遍历
 * `<pnpmHome>/global` 自行查找。
 */
export function queryGlobalRoot(): string | null {
  try {
    // pnpm 11 起会按附近的 packageManager 声明重启成另一个版本（甚至现下），
    // 查全局目录用不着版本切换，显式关掉。
    // stdin 必须是 'ignore'：继承（或给 pipe）时 corepack shim 会一直等
    // 一个永不关闭的管道，`sleep 30 | bin-linker` 就是这么卡住的。
    const output = execSync(
      'pnpm --config.manage-package-manager-versions=false root -g',
      { encoding: 'utf8', env: queryEnv(), stdio: ['ignore', 'pipe', 'pipe'] },
    );

    // 结果未必在最后一行：pnpm 的 `[WARN]` 走 stdout，可能排在路径后面
    return (
      output
        .split(/\r?\n/)
        .map((line) => line.trim())
        .findLast((line) => path.isAbsolute(line)) ?? null
    );
  } catch {
    return null;
  }
}
