// agent-hangar: claude を包んで、終了コードと標準エラーをログに残す。hangar-run.sh の Windows 版。
// 使い方: node hangar-run.mjs <logfile> <command> [args...]
// tmux で claude を直に起こすと、異常終了のときの出力がペインごと消える。
// 標準エラーをログに複写し、終了コードを記録し、異常終了のときは Enter を待ってから閉じる。
// 依存を持たない。hangar が置いた 1 ファイルだけで動く。
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const [log, cmd, ...args] = process.argv.slice(2);
if (!log || !cmd) {
  process.stderr.write('usage: hangar-run.mjs <logfile> <command> [args...]\n');
  process.exit(2);
}

const stamp = () => new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
// ログを書けなくても claude は起こす。書けないことは 1 度だけ画面に出す。
let warned = false;
const cannotLog = (e) => {
  if (warned) return;
  warned = true;
  process.stderr.write(`[agent-hangar] ログを書けません（${e.message}）。このまま続けます。\n`);
};
try { fs.mkdirSync(path.dirname(log), { recursive: true }); } catch (e) { cannotLog(e); }
const append = (text) => {
  try { fs.appendFileSync(log, text); } catch (e) { cannotLog(e); }
};
append(`${stamp()} start pid=${process.pid} cmd=${cmd}\n`);

const finish = (code) => {
  append(`${stamp()} exit=${code}\n`);
  if (code === 0) process.exit(0);
  process.stdout.write(`\n[agent-hangar] 終了コード ${code} で終了しました。ログ: ${log}\nEnter でこの画面を閉じます。`);
  process.stdin.resume();
  process.stdin.once('data', () => process.exit(code));
  // 入力が閉じている（つなぐ端末が無い）ときは待たずに終わる。
  process.stdin.once('end', () => process.exit(code));
};

// HANGAR_UNSET_ENV に ; 区切りで挙げた変数は、claude に渡さない。tmux のセッションはサーバの環境を継ぐので、足さないだけでは外れない（launch/command.ts）。
for (const name of (process.env.HANGAR_UNSET_ENV ?? '').split(';').filter(Boolean)) delete process.env[name];
delete process.env.HANGAR_UNSET_ENV;

// 標準入力と標準出力は端末をそのまま渡す。標準エラーだけ受け取って、画面とログの両方へ流す。
const child = spawn(cmd, args, { stdio: ['inherit', 'inherit', 'pipe'], windowsHide: false });
child.stderr.on('data', (d) => {
  process.stderr.write(d);
  append(d);
});
child.on('error', (e) => {
  append(`${stamp()} spawn failed: ${e.message}\n`);
  process.stderr.write(`[agent-hangar] 起動できませんでした: ${e.message}\n`);
  finish(127);
});
child.on('close', (code, signal) => finish(code ?? (signal ? 1 : 0)));
// Ctrl+C は子が受けて自分で終わる。包みが先に死ぬと終了コードを記録できない。
process.on('SIGINT', () => {});
