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

/**
 * Node の台本で動く偽のコマンドを置く。台本は `<name>.mjs` に書き、writeFakeTool の包みからいまの Node で起こす。
 * 標準出力へ大きく書いてすぐ終わる claude のように、sh では真似にくい振る舞いに使う。
 */
export function writeFakeNodeTool(dir: string, name: string, script: string): string {
  fs.mkdirSync(dir, { recursive: true });
  const js = path.join(dir, `${name}.mjs`);
  fs.writeFileSync(js, script);
  return writeFakeTool(dir, name, { sh: `exec "${process.execPath}" "${js}" "$@"`, cmd: `"${process.execPath}" "${js}" %*` });
}

/** 標準出力へ text を書き、書き切るのを待たずに終わる台本。claude --help の終わり方を真似る。 */
export function writeAndExitScript(text: string, code = 0): string {
  return `process.stdout.write(${JSON.stringify(text)});\nprocess.exit(${code});\n`;
}
