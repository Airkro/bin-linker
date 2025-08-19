# 代码生成规则

优先使用最新语法，如 ESM, esnext
for循环不要使用continue语句
不添加/删除箭头函数的括号
不将function转化为箭头函数
不要修改.xxx((...args) => callback(...args))的传参方式
简化代码时，不要只为将中间函数、变量合并，而是针对逻辑简化
Forbidden typescript non-null assertion
尽量简化逻辑,减少代码量，但也要保证可读性
简化代码，但拆分复杂逻辑到多个函数
简单的逻辑没有必要注释
