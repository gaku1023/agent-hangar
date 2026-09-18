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

/** 残す run のログの件数。個人用の道具なので、件数の上限だけで足りる。 */
export const MAX_RUN_LOGS = 50;

type LogFile = { name: string; path: string; runId: string; mtime: number };

/** logs ディレクトリの run-<id>.log を、日時付きで拾う。読めないものは黙って飛ばす。 */
function listRunLogs(dir: string): LogFile[] {
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  const out: LogFile[] = [];
  for (const name of names) {
    const m = /^run-(.+)\.log$/.exec(name);
    if (!m) continue;
    const full = path.join(dir, name);
    try {
      const st = fs.statSync(full);
      if (!st.isFile()) continue;
      out.push({ name, path: full, runId: m[1]!, mtime: st.mtimeMs });
    } catch {
      continue;
    }
  }
  return out;
}

/**
 * 古い run のログを落とす。放っておくと run のたびに増え続けるためである。
 * 新しいものから max 件を残し、動いている run のログは古くても残す。
 * 走っている claude が書いている先を消すと、その run の記録が途中で切れる。
 * 消せた名前を返す。
 */
export function pruneRunLogs(home: string, aliveRunIds: Iterable<string>, max = MAX_RUN_LOGS): string[] {
  const dir = path.join(home, 'logs');
  const alive = new Set(aliveRunIds);
  // 新しい順に数える。日時が同じなら名前で並べて、どれが残るかを決めておく。
  const files = listRunLogs(dir).sort((a, b) => b.mtime - a.mtime || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const removed: string[] = [];
  let kept = 0;
  for (const f of files) {
    if (alive.has(f.runId) || kept < max) {
      kept++;
      continue;
    }
    try {
      fs.rmSync(f.path, { force: true });
      removed.push(f.name);
    } catch {
      // 消せないログは次の起動でまた当たる。掃除の失敗で起動を止めない。
    }
  }
  return removed;
}
