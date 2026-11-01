// 复现 miniprogram-ci 加载 moment 失败的现场。
//
// pnpm 全局安装出来的包，只有「根级依赖」被软链进 <global>/<ver>/node_modules，
// 剩下的传递依赖全躺在 hoisted 层 `.pnpm/node_modules`。这一层能不能被找到，
// 取决于 require 时用的是哪条路径：
//   - 全局目录下的真实路径：`.pnpm/node_modules` 正好在祖先链上，能解析；
//   - 项目里的软链路径：祖先链换成「项目/node_modules」，那层被直接跳过，
//     moment 立刻 MODULE_NOT_FOUND。
// 所以 bin-linker 把 miniprogram-ci 软链进项目之后，它连 moment 都 require 不动。
//
// 用法：node check-moment.cjs <miniprogram-ci 路径> [cwd]
// cwd 省略时用当前目录。传了 cwd 就站在那个目录里建模，
// 用来观察「项目自己装了一份依赖」时能不能接住。
const { createRequire } = require('node:module');
const fs = require('node:fs');
const path = require('node:path');

const link = path.resolve(process.argv[2] ?? 'node_modules/miniprogram-ci');
const cwd = path.resolve(process.argv[3] ?? process.cwd());

if (!fs.existsSync(path.join(link, 'package.json'))) {
  console.error(`✗ 找不到 ${link}，先跑 node lib/index.mjs miniprogram-ci`);
  process.exit(2);
}

// 站在 cwd 里引用那个软链，祖先链才是运行时真实的祖先链
const entry = path.relative(cwd, path.join(link, 'dist', 'ci', 'miniapp', 'upload.js'));
const req = createRequire(path.resolve(cwd, entry));

console.log(`cwd:   ${cwd}`);
console.log(`entry: ${entry}`);
console.log(`real:  ${fs.realpathSync(link)}`);

// checkBuildArgument 直接 require moment；upload.js 用的是 moment-timezone，
// 后者自己也 require moment，两条路殊途同归到同一个 moment 上。
// 只要 moment 能被接住，这条依赖链就是通的。
try {
  console.log(`✓ moment -> ${req.resolve('moment')}`);
} catch (error) {
  console.error(`✗ moment 解析失败 (${error.code})`);
  console.error('\n依赖断了：pnpm 的 hoisted 层 .pnpm/node_modules 不在软链路径的祖先链上，');
  console.error('落到小程序工程里就是 miniprogram-ci 一 require moment 就崩。');
  process.exitCode = 1;
}
