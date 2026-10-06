import fs from 'node:fs';
import path from 'node:path';

/**
 * 偽のコマンドを置く。macOS と Linux は sh のスクリプト、Windows は .cmd である。
 * .cmd は引数の改行や引用符を正しく渡せないので、決まった引数（-V など）で呼ぶ道具の代役にだけ使う。
 */
export function writeFakeTool(dir: string, name: string, body: { sh: string; cmd: string }, mode = 0o755): string {
  fs.mkdirSync(dir, { recursive: true });
  if (process.platform === 'win32') {
    const p = path.join(dir, `${name}.cmd`);
    fs.writeFileSync(p, `@echo off\r\n${body.cmd}\r\n`);
    return p;
  }
  const p = path.join(dir, name);
  fs.writeFileSync(p, `#!/bin/sh\n${body.sh}\n`, { mode });
  fs.chmodSync(p, mode);
  return p;
}
