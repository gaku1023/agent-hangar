import fs from 'node:fs';
import path from 'node:path';

/**
 * 実物の claude の代わり。
 * 受け取った引数と環境変数 HANGAR_RUN_ID を NUL 区切りで argsFile に記録して、待ってから終わる。
 * 注入するシステムプロンプトのように改行を含む引数があるため、行区切りではなく NUL 区切りで記録する。
 */
export function writeFakeClaude(
  dir: string,
  opts: { exitCode?: number; sleepSec?: number } = {},
): { bin: string; argsFile: string } {
  const argsFile = path.join(dir, 'args.bin');
  const bin = path.join(dir, 'fake-claude');
  const script = [
    '#!/bin/sh',
    `: > "${argsFile}"`,
    `for a in "$@"; do printf '%s\\000' "$a" >> "${argsFile}"; done`,
    `printf '%s\\000' "$HANGAR_RUN_ID" >> "${argsFile}"`,
    `sleep ${opts.sleepSec ?? 30}`,
    `exit ${opts.exitCode ?? 0}`,
    '',
  ].join('\n');
  fs.writeFileSync(bin, script, { mode: 0o755 });
  return { bin, argsFile };
}

/**
 * writeFakeClaude が記録した引数を読む。
 * 末尾の区切りが生む空要素を 1 つだけ捨てるので、返る配列の最後の要素は必ず HANGAR_RUN_ID の値になる。
 */
export function readArgs(argsFile: string): string[] {
  const parts = fs.readFileSync(argsFile, 'utf8').split('\0');
  if (parts.length > 0 && parts[parts.length - 1] === '') parts.pop();
  return parts;
}
