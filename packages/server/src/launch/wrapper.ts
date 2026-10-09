import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ensureMode } from '../platform/secure.ts';

export const WRAPPER_NAME = 'hangar-run.sh';
export const WRAPPER_NAME_WIN = 'hangar-run.mjs';

/**
 * tmux 内で claude を包むスクリプト。
 * tmux で claude を直接起動すると異常終了時の出力が失われるので、
 * 標準エラーをログに複写し、終了コードを記録し、異常終了のときは Enter を待ってから閉じる。
 *
 * 標準エラーを写す tee はプロセス置換の中で動くので、bash は放っておくとその終わりを待たない。
 * ペインの先頭の bash が抜けると、カーネルが同じプロセス群へ SIGHUP を送るので、
 * 込んだ機械で tee が後回しになると、書きかけの tee が落ちて終わり際の標準エラーが消えていた
 * （Linux で負荷を掛けると 200 回中 74 回）。そこで tee は SIGHUP を無視する形で起こし、
 * bash は tee が書き終えるのを待ってから exit= を書く。
 * tee は書き手が全部閉じるまで終わらないので、claude の残した子が標準エラーを握り続けても、2 秒で見切る。
 * macOS の bash 3.2 でも動くように、プロセス置換を exec でつないで $! を取り、kill -0 で待つ（3.2 の wait はこれを待てない）。
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
    "trap '' HUP",
    'exec 3> >(tee -a "$LOG" >&2)',
    'tee_pid=$!',
    'trap - HUP',
    '"$@" 2>&3 3>&-',
    'code=$?',
    'exec 3>&-',
    'i=0',
    'while [ "$i" -lt 40 ] && kill -0 "$tee_pid" 2>/dev/null; do sleep 0.05; i=$((i+1)); done',
    'printf \'%s exit=%s\\n\' "$(stamp)" "$code" >> "$LOG"',
    'if [ "$code" -ne 0 ]; then',
    '  printf \'\\n[agent-hangar] 終了コード %s で終了しました。ログ: %s\\nEnter でこの画面を閉じます。\' "$code" "$LOG"',
    '  read -r _',
    'fi',
    'exit "$code"',
    '',
  ].join('\n');
}

/** Windows の包みの本体。同じディレクトリの hangar-run.mjs を読む。同梱版でも server.mjs の隣に置く。 */
export function wrapperScriptWin(): string {
  return fs.readFileSync(fileURLToPath(new URL('./hangar-run.mjs', import.meta.url)), 'utf8');
}

/**
 * <home>/bin に包みを置く。macOS と Linux は hangar-run.sh を 0o755 で、Windows は hangar-run.mjs を置く。中身が同じなら書かない。
 * macOS と Linux では、別のファイルに書いてから rename で入れ替える。
 * bash は台本を読みながら走るので、走っている run の包みをその場で書き換えると、
 * claude が終わったあと残りを新しい中身の途中から読み、構文の誤りで落ちる（exit= も残らない）。
 * rename なら、走っている bash は古い中身を開いたまま最後まで読める。
 * Windows の包みは node が最初に全部読むので、その場で書く。
 */
export function ensureWrapperScript(home: string, platform: NodeJS.Platform = process.platform): string {
  const dir = path.join(home, 'bin');
  const win = platform === 'win32';
  const file = path.join(dir, win ? WRAPPER_NAME_WIN : WRAPPER_NAME);
  const body = win ? wrapperScriptWin() : wrapperScript();
  fs.mkdirSync(dir, { recursive: true });
  if (!fs.existsSync(file) || fs.readFileSync(file, 'utf8') !== body) {
    if (win) fs.writeFileSync(file, body, { mode: 0o755 });
    else replaceFile(file, body);
  }
  ensureMode(file, 0o755, platform);
  return file;
}

/** 同じディレクトリの一時ファイルに書いてから rename で入れ替える。失敗したら一時ファイルを消して投げる。 */
function replaceFile(file: string, body: string): void {
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(tmp, body, { mode: 0o755 });
    fs.renameSync(tmp, file);
  } catch (e) {
    fs.rmSync(tmp, { force: true });
    throw e;
  }
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
