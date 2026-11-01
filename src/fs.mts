import { promises as fs } from 'node:fs';
import path from 'node:path';

export const isWindows = process.platform === 'win32';

/**
 * Windows 建软链必须指明类型。
 *
 * 链接的是**目录**（包本体、`node_modules` 里的依赖），只能给 `junction`：
 * `file` 类型对目录必失败，`dir` 类型又要开发者模式或管理员权限
 * （EPERM 那套提示原本就是在替这件事擦屁股）。junction 由文件系统层实现，免权限。
 * 只有真对着一个文件建链时才用 `file`。
 */
export function getLinkType(
  target?: string,
  platform = process.platform,
): 'file' | 'junction' | undefined {
  if (platform !== 'win32') {
    return undefined;
  }

  return target && path.extname(target) ? 'file' : 'junction';
}

/** 链接落在工程自己的 `node_modules` 里，与包管理器装出来的一致 */
export const localBinDir = path.resolve(process.cwd(), 'node_modules', '.bin');

export async function ensureDir(dir: string): Promise<boolean> {
  try {
    await fs.mkdir(dir, { recursive: true });

    return true;
  } catch {
    return false;
  }
}

/** 建软链，覆盖已有的那一份 */
export async function createSymlink(
  target: string,
  link: string,
): Promise<boolean> {
  // 已经指着同一个目标就跳过：命令链接在重跑、`pnpm <cmd>` 前置钩子里是常态，
  // 而 unlink + symlink 是两次写操作，还会让链接短暂消失
  if ((await fs.readlink(link).catch(() => null)) === target) {
    return true;
  }

  // 不存在的链接当它已经删掉了
  try {
    await fs.unlink(link);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw error;
    }
  }

  await fs.symlink(target, link, getLinkType(target));

  return true;
}

/** package.json 里用得着的那几个字段 */
export type PackageMeta = {
  bin?: string | Record<string, string>;
  main?: string;
};

/** 读取包的 package.json，读不到或内容无效时返回 null */
export async function readPackageJson(
  pkgDir: string,
): Promise<PackageMeta | null> {
  try {
    const content = await fs.readFile(
      path.join(pkgDir, 'package.json'),
      'utf8',
    );

    return JSON.parse(content) as PackageMeta;
  } catch {
    return null;
  }
}
