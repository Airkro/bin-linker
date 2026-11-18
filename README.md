# bin-linker

[![npm][npm-badge]][npm-url]
[![github][github-badge]][github-url]
![node][node-badge]

[npm-url]: https://www.npmjs.com/package/bin-linker
[npm-badge]: https://img.shields.io/npm/v/bin-linker.svg?style=flat-square&logo=npm
[github-url]: https://github.com/Airkro/bin-linker
[github-badge]: https://img.shields.io/npm/l/bin-linker.svg?style=flat-square&colorB=blue&logo=github
[node-badge]: https://img.shields.io/node/v/bin-linker.svg?style=flat-square&colorB=green&logo=node.js

## Installation

```bash
npm install bin-linker --save-dev
```

## Usage

```bash
bin-linker <package-name> [<package-name>...]
```

链的是 pnpm 全局安装里的那份包，落到工程的 `node_modules`：声明了 `bin` 的连命令一起链到
`.bin`，没有 `bin` 的按库链入、不产生命令。两种都会把包自己够不到的依赖补回它目录里的
`node_modules`（pnpm 全局布局下间接依赖默认是断的）。

工程里同名的那份会被换成全局这一份：本来就是一条链接的，撤下来重指；`npm install`
解压进来的那份目录，整份删掉再链。位置上的东西看着不像一个包（里头没有 `package.json`，
或名字是 `@scope`、`.bin` 这一类）时不会替你删，会报错让你先自己处理。

## 与 `pnpm link <目录>` 的区别

pnpm 12 的 `pnpm link` 也能把全局安装里的那份包链进工程：有 `bin` 的会连命令一起链到
`.bin`，没有 `bin` 的按库链入。两者的差别在工程里留下什么。

`pnpm link` 往 `package.json` 和 `pnpm-lock.yaml` 里写一条 `link:` 路径，指向那个目录——
所以你得先知道那个目录在哪，而这份声明会把当前这台机器的路径带进工程。全局那份包换了版本，
目录名就跟着变，工程里这条链接指着空处；这一步不报错，`pnpm install` 照样报成功，
链接坏了要等用到时才看得见。

`bin-linker` 按包名去找全局那一份，每次运行重新找一遍，工程里只动 `node_modules`：
`package.json` 和 lockfile 都不改。全局升级之后重跑一次就够；`node_modules` 被重装清掉了，
也是重跑一次。

想让工程长期记住「就用这一份」，用 `pnpm link`；只想在当前这台机器上把全局装的包借进工程用，
用 `bin-linker`。
