import { describe, expect, it } from 'vitest';

import {
  isEnvFailure,
  isLinked,
  isLocateFailed,
  type Outcome,
} from '../src/result.mts';

/**
三种「没干活」与两种「干了活」的结论，判据只该落在自己那一档
*/
const cases: [Outcome, boolean, boolean, boolean][] = [
  [{ pkg: 'a', pkgDirs: [], notFound: true }, true, false, true],
  [{ pkg: 'b', pkgDirs: [], globalBinDir: true }, true, false, true],
  // 包里没有命令是包自己的事：不算环境问题，装了别的包照样能跑
  [{ pkg: 'c', pkgDirs: [], noBin: true }, true, false, false],
  [{ pkg: 'd', commands: ['d'] }, false, true, false],
  [{ pkg: 'e', errors: [] }, false, true, false],
];

describe('outcome predicates', () => {
  it.each(cases)('classifies %o', (outcome, failed, linked, envFailure) => {
    // 三个判据必须互斥且覆盖：一条结论不能被同时判成「没干活」和「链上了」
    expect(isLocateFailed(outcome)).toBe(failed);
    expect(isLinked(outcome)).toBe(linked);
    expect(isEnvFailure(outcome)).toBe(envFailure);
  });
});
