/**
包名里可能带着路径（`$(pwd)/node_modules/cowsay` 这类写法并不少见），
但 `node_modules` 的位置是按包名拼的，带路径就拼不出来。
这里只取最后几段：`./node_modules/@scope/pkg` → `@scope/pkg`，`@scope/pkg` → `@scope/pkg`。
*/
export function toPkgName(input: string): string {
  const parts = input.split(/[/\\]/).filter(Boolean);
  const scopeIndex = parts.findLastIndex((part) => part.startsWith('@'));

  // 有 scope 就把它一起带上（`@scope` 本身就是最后一段时只有它）
  return scopeIndex === -1
    ? (parts.at(-1) ?? input)
    : parts.slice(scopeIndex).join('/');
}
