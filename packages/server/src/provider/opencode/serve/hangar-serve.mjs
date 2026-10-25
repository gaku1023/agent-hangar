// agent-hangar: opencode serve を tmux（Windows は psmux）の画面の中で起こす包み。
// 使い方: node hangar-serve.mjs <spec.json>
// spec は hangar が 0600 で書く。起こす場所、引数、作業フォルダ、環境（合言葉と hangar の MCP の秘密を含む）、ログと状態のファイルの場所を持つ。
// 読んだらすぐ消す。秘密を argv にも tmux のセッションの環境にも載せないためである（serve/pane.ts）。
// serve の出力はログに書き、起こした serve の pid と終わりを状態のファイルに書く。serve が終わったら自分も終わる。
// 依存を持たない。hangar が置いた 1 ファイルだけで動く。
import { spawn } from 'node:child_process';
import fs from 'node:fs';

const [specFile] = process.argv.slice(2);
if (!specFile) {
  process.stderr.write('usage: hangar-serve.mjs <spec.json>\n');
  process.exit(2);
}

let spec;
try {
  spec = JSON.parse(fs.readFileSync(specFile, 'utf8'));
} catch (e) {
  process.stderr.write(`[agent-hangar] could not read the serve spec: ${e.message}\n`);
  process.exit(2);
} finally {
  try { fs.rmSync(specFile, { force: true }); } catch { /* 残った分は hangar が消す。 */ }
}

/** ログの上限。越えたら末尾だけを残して書き直す。起動の失敗の理由を読むのに要るのは末尾だけである。 */
const LOG_MAX = 256 * 1024;
const LOG_KEEP = 8 * 1024;
let logged = 0;
const append = (text) => {
  try {
    fs.appendFileSync(spec.log, text, { mode: 0o600 });
    logged += Buffer.byteLength(text);
    if (logged > LOG_MAX) {
      const tail = fs.readFileSync(spec.log).subarray(-LOG_KEEP);
      fs.writeFileSync(spec.log, tail, { mode: 0o600 });
      logged = tail.length;
    }
  } catch { /* ログを書けなくても serve は動かし続ける。 */ }
};

/** 状態のファイルを書く。読み手が書きかけを読まないよう、別のファイルに書いてから入れ替える。 */
const state = (s) => {
  const tmp = `${spec.state}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(tmp, `${JSON.stringify(s)}\n`, { mode: 0o600 });
    fs.renameSync(tmp, spec.state);
  } catch { /* 書けなければ hangar は時間切れで諦める。 */ }
};

// .cmd と .bat は cmd.exe 越しにしか起こせない（spawn.ts と同じ）。場所は空白を含みうるので引用で包む。
const child = spawn(spec.shell ? `"${spec.bin}"` : spec.bin, spec.args, {
  cwd: spec.cwd,
  env: spec.env,
  stdio: ['ignore', 'pipe', 'pipe'],
  windowsHide: true,
  shell: spec.shell === true,
});
child.stdout.on('data', (d) => append(d.toString('utf8')));
child.stderr.on('data', (d) => append(d.toString('utf8')));
child.on('spawn', () => state({ pid: child.pid }));
let done = false;
const finish = (code) => {
  if (done) return;
  done = true;
  state({ pid: child.pid ?? null, exit: code });
  process.exit(code);
};
child.on('error', (e) => {
  append(`\n[agent-hangar] spawn failed: ${e.message}\n`);
  if (child.pid === undefined) finish(127);
});
child.on('close', (code, signal) => finish(code ?? (signal ? 1 : 0)));
// 画面に打たれた Ctrl+C では止めない。serve を止めるのは hangar が serve の pid に送る信号で、包みは serve の終わりを待って終わる。
process.on('SIGINT', () => {});
