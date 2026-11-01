import { describe, expect, it } from 'vitest';

import { toPkgName } from '../src/name.mts';

describe('toPkgName', () => {
  it('normalizes package names that carry a path', () => {
    // `$(pwd)/node_modules/cowsay`、`./node_modules/@scope/pkg` 都得还原成包名，
    // node_modules 的位置是按包名拼的
    expect(toPkgName('cowsay')).toBe('cowsay');
    expect(toPkgName('./node_modules/cowsay')).toBe('cowsay');
    expect(toPkgName('/a/b/node_modules/@scope/pkg')).toBe('@scope/pkg');
    expect(toPkgName('@scope/pkg')).toBe('@scope/pkg');
    // 只剩 scope 一段（用户手抖）时别丢成空串
    expect(toPkgName('@scope')).toBe('@scope');
    // 空串这种退化输入别抛，原样回去，交给「找不到包」报
    expect(toPkgName('')).toBe('');
  });
});
