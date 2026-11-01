// 复现 miniprogram-ci 加载 moment 失败的现场。
//
// miniprogram-ci 只把 moment-timezone 写进自己的依赖，moment 是 moment-timezone 的依赖。
// pnpm 全局安装时，moment-timezone 落在全局安装根这一层（`<pnpmHome>/global/<ver>/node_modules/.pnpm`），
// 与 miniprogram-ci 的虚拟目录（store 里 `<hash>/node_modules/miniprogram-ci`）隔着好几级目录。
// node 从 miniprogram-ci 的真实路径往上找 moment 时够不到那一层，moment 立刻 MODULE_NOT_FOUND——
// 这不是软链造成的，直接用真实路径也一样。除非工程自己装了 moment，才轮得到工程那一份兜底。
//
// 用法：node check-moment.cjs <miniprogram-ci 路径> [cwd] [--depot]
// cwd 省略时用当前目录。传了 cwd 就站在那个目录里建模，
// 用来观察「项目自己装了一份依赖」时能不能接住。
// 传 --depot 时额外把 pnpm 的 hoisted 层补进祖先链再做一次，
// 用来区分「软链路径丢了祖先链」和「包本身就没装 moment」两种断法：
// 补上之后仍解析不到，就不是路径问题。
const { createRequire } = require('node:module');
const fs = require('node:fs');
const path = require('node:path');

const args = process.argv.slice(2);
const flags = args.filter((arg) => arg.startsWith('--'));
const positional = args.filter((arg) => !arg.startsWith('--'));

const link = path.resolve(positional[0] ?? 'node_modules/miniprogram-ci');
const cwd = path.resolve(positional[1] ?? process.cwd());

if (!fs.existsSync(path.join(link, 'package.json'))) {
  console.error(`✗ 找不到 ${link}，先跑 node lib/index.mjs miniprogram-ci`);
  process.exit(2);
}

// 站在 cwd 里引用那个软链，祖先链才是运行时真实的祖先链
const entry = path.relative(
  cwd,
  path.join(link, 'dist', 'ci', 'miniapp', 'upload.js'),
);
const req = createRequire(path.resolve(cwd, entry));

console.log(`cwd:   ${cwd}`);
console.log(`entry: ${entry}`);
console.log(`real:  ${fs.realpathSync(link)}`);

// checkBuildArgument 直接 require moment；upload.js 用的是 moment-timezone，
// 后者自己也 require moment，两条路殊途同归到同一个 moment 上。
// 只要 moment 能被接住，这条依赖链就是通的。
function check(label, resolveRequire) {
  try {
    console.log(`✓ ${label} moment -> ${resolveRequire.resolve('moment')}`);
    return true;
  } catch (error) {
    console.error(`✗ ${label} moment 解析失败 (${error.code})`);
    return false;
  }
}

if (!check('', req)) {
  console.error(
    '\n依赖断了：moment 只躺在全局安装根那一层，不在 miniprogram-ci 的祖先链上，',
  );
  console.error('落到小程序工程里就是 miniprogram-ci 一 require moment 就崩。');
  process.exitCode = 1;
}

// 再把全局安装根那一层补进祖先链试一次：软链路径上找不到、补上却能找到，
// 就是祖先链的问题；两处都找不到，说明这个包压根没装全依赖，换个方向查。
if (flags.includes('--depot')) {
  // 那一层就在全局安装根下：`<pnpmHome>/global/<ver>/node_modules/.pnpm/node_modules`。
  // 逐个版本目录找，软链本身只指着其中一份。
  const home = process.env.PNPM_HOME ?? process.env.XDG_DATA_HOME ?? '';
  const depots = [];

  for (const version of ['v11', '10', '9', '8', '7']) {
    const versionRoot = path.join(home, 'global', version);

    if (fs.existsSync(versionRoot)) {
      for (const dir of fs.readdirSync(versionRoot)) {
        depots.push(
          path.join(versionRoot, dir, 'node_modules', '.pnpm', 'node_modules'),
        );
      }
    }
  }

  const depot = depots.find((candidate) => fs.existsSync(candidate));

  if (depot) {
    console.log(`depot: ${fs.realpathSync(depot)}`);

    if (!check('[depot]', createRequire(path.join(depot, 'probe.js')))) {
      console.error(
        '✗ 全局安装根那一层也没有 moment：这个包本身就没装全依赖。',
      );
    }
  } else {
    console.log('- 没找到全局安装根那一层，跳过');
  }
}
