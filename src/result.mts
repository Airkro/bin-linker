/** 单个命令 / 单个依赖的成败 */
export type Failure = { name: string; error: Error };

/** 一个包干完活的结论：链接成了哪些命令、补了依赖没有、哪些没成 */
export type PkgResult = {
  pkg: string;
  /** 链接成功的命令名 */
  commands?: string[];
  /** 本次补上了包自己解析不到的依赖 */
  depsLinked?: boolean;
  /** 补完之后仍解析不到的依赖：命令起得来，包一 require 就炸 */
  unresolved?: string[];
  errors?: Failure[];
};

/**
 * 没装上：全局目录里压根没有这个包，或它没有可执行文件。
 *
 * 这两种是「没干活」，只有原因没有命令；前者能修（`pnpm setup` 或装上），
 * 后者只能换一个包——CLI 给的提示完全不同。
 */
export type LocateFailure = {
  pkg: string;
  /** 探过的候选位置，留在结论里便于定位「探的是哪儿」 */
  pkgDirs: string[];
  noBin?: boolean;
  notFound?: boolean;
  globalBinDir?: boolean;
};

/**
 * 每个包只能落在一种处境里。
 *
 * 处处都是 `?` 的对象谁都能拼出一个自相矛盾的结果（「找不到包」又「没有可执行文件」），
 * 读的人还得记住哪些字段互斥；用联合类型把这份约定交给编译器，下游照着取就行。
 *
 * 判据只在这一个文件里：`locateFailed`、`isLinked`、`isEnvFailure` 与类型定义摆在一起，
 * 别处想加一种失败原因，得先过这里。
 */
export type Outcome = LocateFailure | PkgResult;

/** 没干活的那几种：没命令，只有原因 */
export function locateFailed(outcome: Outcome): outcome is LocateFailure {
  return (
    'notFound' in outcome || 'noBin' in outcome || 'globalBinDir' in outcome
  );
}

/** 走到执行这一步的结果才有命令可念 */
export function isLinked(outcome: Outcome): outcome is PkgResult {
  return !locateFailed(outcome);
}

/**
 * 环境问题比「这个包链不上」更该让人去修，得算进退出码。
 *
 * `noBin` 不算：包里没命令是包自己的事，装了别的包照样能跑。
 */
export function isEnvFailure(outcome: Outcome): boolean {
  return (
    locateFailed(outcome) &&
    (outcome.notFound === true || outcome.globalBinDir === true)
  );
}
