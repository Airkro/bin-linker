import pc from 'picocolors';

export const log = {
  info: (msg: string) => console.log(pc.green('✓'), msg),
  error: (msg: string) => console.error(pc.red('✗'), pc.red(msg)),
  warn: (msg: string) => console.warn(pc.yellow('!'), pc.yellow(msg)),
};

export const fmt = {
  pkg: (name: string) => pc.cyan(name),
  list: (items?: string[]) => items?.join(', ') || '',
  cmd: (text: string) => pc.magenta(text),
  path: (text: string) => pc.yellow(text),
};
