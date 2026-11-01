import os from 'node:os';
import path from 'node:path';

/**
 * 借一份干净的 pnpm 主目录。
 *
 * 全平台归一成 XDG 布局：pnpm 自己就认 `XDG_DATA_HOME`，用不着替它猜家目录，
 * 也不用手写一遍各平台的默认值再跟它对齐。Windows 上 `pnpm setup` 设的正是 `PNPM_HOME`。
 */
export function getPnpmHome(): string {
  const { PNPM_HOME: pnpmHome } = process.env;

  if (pnpmHome) {
    return pnpmHome;
  }

  return path.join(
    process.env.XDG_DATA_HOME ?? path.join(os.homedir(), '.local', 'share'),
    'pnpm',
  );
}

/** pnpm 10 起会校验的那个目录：全局 bin 目录本身与它下面的 `bin` */
export function getGlobalBinDirs(): string[] {
  const binDir = process.env.npm_config_global_bin_dir || getPnpmHome();

  return [binDir, path.join(binDir, 'bin')];
}

/**
 * 判断 pnpm 的全局 bin 目录是否不在 PATH 中。
 *
 * pnpm 10 起 bin 目录不在 PATH 时 `pnpm i -g` 与 `pnpm root -g` 都会直接报错，
 * 全局包实际上可能已装好，只是无法通过 pnpm 查询到。
 */
export function isBinDirMissingFromPath(): boolean {
  const entries = new Set(
    (process.env.PATH ?? '')
      .split(path.delimiter)
      .map((entry) => path.resolve(entry || '.')),
  );

  return getGlobalBinDirs().every((dir) => !entries.has(path.resolve(dir)));
}
