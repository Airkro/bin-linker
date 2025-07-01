import pc from 'picocolors';

export const log = {
  info: (msg) => console.log(pc.green('✓'), msg),
  error: (msg) => console.error(pc.red('✗'), pc.red(msg)),
  warn: (msg) => console.warn(pc.yellow('!'), pc.yellow(msg)),
};

export const fmt = {
  pkg: (name) => pc.cyan(name),
  list: (items) => items?.join(', ') || '',
  cmd: (text) => pc.magenta(text),
  path: (text) => pc.yellow(text),
};
