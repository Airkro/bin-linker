import { promises as fs } from 'node:fs';
import path from 'node:path';

export const isWindows = process.platform === 'win32';

/** Windows 建软链必须指明类型：链的是可执行文件，用 file */
export function getLinkType(platform = process.platform): 'file' | undefined {
  return platform === 'win32' ? 'file' : undefined;
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

/** 建软链，覆盖已有的那一份；链接指向的文件不存在时报错 */
export async function createSymlink(
  target: string,
  link: string,
): Promise<boolean> {
  const exists = await fs.access(target).then(
    () => true,
    () => false,
  );

  if (!exists) {
    throw new Error(`目标不存在: ${target}`);
  }

  // 不存在的链接当它已经删掉了
  try {
    await fs.unlink(link);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw error;
    }
  }

  await fs.symlink(target, link, getLinkType());

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
