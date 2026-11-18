/**
单个命令 / 单个依赖的成败
*/
export type Failure = { name: string; error: Error };

/**
一个包干完活的结论：链接成了哪些命令、补了依赖没有、哪些没成
*/
export type PkgResult = {
  pkg: string;
  /**
  链接成功的命令名
  */
  commands?: string[];
  /**
  这个包只提供库：它自己没声明 `bin`，一条命令也不会有，链上本体就是干完了活
  */
  libraryOnly?: boolean;
  /**
  本次补上了包自己解析不到的依赖
  */
  depsLinked?: boolean;
  /**
  补完之后仍解析不到的依赖：命令起得来，包一 require 就炸
  */
  unresolved?: string[];
  errors?: Failure[];
};

/**
没装上：全局目录里压根没有这个包，或环境没配好到探不出任何一层布局。

两种都是「没干活」，只有原因没有命令，而修法不同——一个去装，一个去配。
*/
export type LocateFailure = {
  pkg: string;
  /**
  探过的候选位置，留在结论里便于定位「探的是哪儿」
  */
  pkgDirs: string[];
  notFound?: boolean;
  globalBinDir?: boolean;
};

/**
每个包只能落在一种处境里。

处处都是 `?` 的对象谁都能拼出一个自相矛盾的结果（「找不到包」又「补了依赖」），
读的人还得记住哪些字段互斥；用联合类型把这份约定交给编译器，下游照着取就行。

判据只在这一个文件里：`isLocateFailed`、`isLinked`、`isEnvFailure` 与类型定义摆在一起，
别处想加一种失败原因，得先过这里。
*/
export type Outcome = LocateFailure | PkgResult;

/**
没干活的那几种：没命令，只有原因
*/
export function isLocateFailed(outcome: Outcome): outcome is LocateFailure {
  return 'notFound' in outcome || 'globalBinDir' in outcome;
}

/**
走到执行这一步的结果才有命令可念
*/
export function isLinked(outcome: Outcome): outcome is PkgResult {
  return !isLocateFailed(outcome);
}

/**
环境问题比「这个包链不上」更该让人去修，得算进退出码。

包自己没命令不在这儿报：它作为库被链进工程了，这一趟是有收获的。
*/
export function isEnvFailure(outcome: Outcome): boolean {
  return (
    isLocateFailed(outcome) &&
    (outcome.notFound === true || outcome.globalBinDir === true)
  );
}
