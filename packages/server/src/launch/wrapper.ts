import fs from 'node:fs';
import path from 'node:path';

export const WRAPPER_NAME = 'hangar-run.sh';

/**
 * tmux 内で claude を包むスクリプト。
 * tmux で claude を直接起動すると異常終了時の出力が失われるので、
 * 標準エラーをログに複写し、終了コードを記録し、異常終了のときは Enter を待ってから閉じる。
 */
export function wrapperScript(): string {
  return [
    '#!/usr/bin/env bash',
    '# agent-hangar: claude をラップして終了コードと標準エラーをログに残す。',
    '# 使い方: hangar-run.sh <logfile> <command> [args...]',
    'LOG="$1"; shift',
    'mkdir -p "$(dirname "$LOG")"',
    'stamp() { date -u +%Y-%m-%dT%H:%M:%SZ; }',
    'printf \'%s start pid=%s cmd=%s\\n\' "$(stamp)" "$$" "$1" >> "$LOG"',
    '"$@" 2> >(tee -a "$LOG" >&2)',
    'code=$?',
    'printf \'%s exit=%s\\n\' "$(stamp)" "$code" >> "$LOG"',
    'if [ "$code" -ne 0 ]; then',
    '  printf \'\\n[agent-hangar] 終了コード %s で終了しました。ログ: %s\\nEnter でこの画面を閉じます。\' "$code" "$LOG"',
    '  read -r _',
    'fi',
    'exit "$code"',
    '',
  ].join('\n');
}

/** <home>/bin/hangar-run.sh を 0o755 で置く。中身が同じなら書かない。 */
export function ensureWrapperScript(home: string): string {
  const dir = path.join(home, 'bin');
  const file = path.join(dir, WRAPPER_NAME);
  const body = wrapperScript();
  fs.mkdirSync(dir, { recursive: true });
  if (!fs.existsSync(file) || fs.readFileSync(file, 'utf8') !== body) fs.writeFileSync(file, body, { mode: 0o755 });
  if ((fs.statSync(file).mode & 0o777) !== 0o755) fs.chmodSync(file, 0o755);
  return file;
}

/** run のログの置き場所。 */
export function runLogPath(home: string, runId: string): string {
  return path.join(home, 'logs', `run-${runId}.log`);
}
