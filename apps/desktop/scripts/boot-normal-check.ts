// CI の「Node のある Mac で、殻が同梱のサーバを起こし、本当の画面へ移る」段の判定。macOS の台本（ci-boot-normal-macos.sh）が呼ぶ。
// 殻（build した .app、release では署名した .app）を起こした後、次を順に確かめる。
//   1. 127.0.0.1:<ポート>/health が ok と ready を返す（索引づけまで済む）。
//   2. 殻が settings.json の nodePath の Node を選び、.app の中の同梱サーバを起こした（desktop.log の node … server … の行）。
//   3. サーバは殻の子で、殻の server_command が渡す環境（HANGAR_UI_DIST、HANGAR_PARENT_PID、HANGAR_PORT、HANGAR_HOME、足した PATH）を持つ。
//   4. 鍵付きの GET / が、HANGAR_UI_DIST の index.html をそのまま返し、そこから読む資産も返る。
//   5. 殻が画面をサーバへ移し（navigating to the server）、WebKit の通信のプロセスがサーバへつないだ（UI は起動の時に WebSocket を張る）。
//      起動画面の頁は tauri の中の頁で、サーバへはつながない。なので、サーバへのつなぎはサーバの頁のものである。
//      起動画面の書き出し（HANGAR_BOOT_PROBE）は、失敗の札が出ていれば落とし、読み込みの合図を描いていれば記録に書く。
//      合図は必須にしない。サーバが起動画面の読み込みより先に用意できると、殻は合図を打たずに画面を移す（lib.rs の boot の drawing）。
//      CI の空のホームでは索引が 0.1 秒で済み、起動画面は何も書かないうちに移った（2026-10-11）。
//   6. 殻が消えると、サーバも自分で降りる（HANGAR_PARENT_PID の見張り）。
// 使い方:
//   node --experimental-strip-types scripts/boot-normal-check.ts run --port <n> --hangar-home <dir> --server-dir <dir> --node <path>
//     --shell-pid <pid> --user-home <dir> --path-base <PATH> --probe <file> --timeout <秒> [--shot <png>]
//     通れば 0、落ちれば 1、使い方が違えば 2 で終わる。
// 書き出しを必須にしないので、配布の build から書き出しの口を外しても、この段は落ちない。
// CI の段は npm ci の後でなくても動くよう、Node が型を剥がすだけで動く書き方（import は node: だけ）にしておく。
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export type DesktopLog = { node: string | null; serverDir: string | null; serverPid: number | null; navigated: boolean; failure: string | null };

/** 殻の記録の行（`<ミリ秒> [desktop] <文>`）から、起動の道筋を拾う。同じ種類の行が複数あれば最後のものを採る。 */
export function readDesktopLog(text: string): DesktopLog {
  const out: DesktopLog = { node: null, serverDir: null, serverPid: null, navigated: false, failure: null };
  for (const line of text.split('\n')) {
    const m = line.match(/^\d+ \[desktop\] (.*)$/);
    if (!m) continue;
    const body = m[1]!;
    const ns = body.match(/^node (.+) server (.+)$/);
    if (ns) {
      out.node = ns[1]!;
      out.serverDir = ns[2]!;
      continue;
    }
    const pid = body.match(/^server pid (\d+)$/);
    if (pid) out.serverPid = Number(pid[1]);
    else if (body === 'navigating to the server') out.navigated = true;
    else if (body.startsWith('boot failed ')) out.failure = body;
  }
  return out;
}

/** /health の答えを読む。真偽値の true だけを真と読む。 */
export function judgeHealth(raw: string | null): { ok: boolean; ready: boolean } {
  if (raw === null) return { ok: false, ready: false };
  try {
    const v = JSON.parse(raw) as { ok?: unknown; ready?: unknown };
    return { ok: v.ok === true, ready: v.ready === true };
  } catch {
    return { ok: false, ready: false };
  }
}

export type Verdict = { done: boolean; ok: boolean; message: string };

/** 起動画面の書き出し（loading/boot.js の report）を読む。読み込みの合図を描いたら（印が ready）通す。 */
export function judgeReady(raw: string | null): Verdict {
  if (raw === null) return { done: false, ok: false, message: '頁はまだ何も書いていない' };
  let d: { level?: unknown; kind?: unknown; title?: unknown; detail?: unknown };
  try {
    d = JSON.parse(raw) as typeof d;
  } catch {
    return { done: false, ok: false, message: '書き出しを読めない' };
  }
  if (d.level === 'ready') return { done: true, ok: true, message: '起動画面が読み込みの合図を描いた' };
  if (d.level === 'error') return { done: true, ok: false, message: `起動画面が失敗の札を出した（${String(d.kind)}）: ${String(d.title)} / ${String(d.detail)}` };
  return { done: false, ok: false, message: '頁は待っている間の画面のまま' };
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * `ps -E -ww -o command=` の 1 行（引数の後に環境が空白区切りで続く）に、期待した変数と値があるかを見る。
 * 値の途中で切れた一致（7 と 77 など）は一致と見ない。食い違いを文で返す。
 */
export function envMismatches(psLine: string, want: Record<string, string>): string[] {
  const out: string[] = [];
  for (const [k, v] of Object.entries(want)) {
    if (new RegExp(`(?:^| )${escape(k)}=${escape(v)}(?= |$)`).test(psLine)) continue;
    const got = psLine.match(new RegExp(`(?:^| )${escape(k)}=(\\S*)`));
    out.push(got ? `${k} が ${got[1]}（期待は ${v}）` : `${k} が無い（期待は ${v}）`);
  }
  return out;
}

/** 殻がサーバの PATH の後ろへ足す置き場。src-tauri/src/server.rs の augmented_path の写しで、試験が突き合わせる。 */
export function extraPathDirs(userHome: string): string[] {
  return [`${userHome}/.local/bin`, '/opt/homebrew/bin', '/usr/local/bin', `${userHome}/.claude/local`];
}

/** 殻が受け継いだ PATH に置き場を足した、サーバの PATH。元の並びは変えず、既にあるものは足さない。 */
export function expectedServerPath(base: string, userHome: string): string {
  const out = base.split(':').filter((s) => s !== '');
  for (const d of extraPathDirs(userHome)) if (!out.includes(d)) out.push(d);
  return out.join(':');
}

/** index.html が読み込む最初の資産（/assets/ の下）のパス。 */
export function firstAsset(html: string): string | null {
  return html.match(/(?:src|href)="(\/assets\/[^"]+)"/)?.[1] ?? null;
}

/** `lsof -F pc` の出力から、サーバへつないでいる WebKit のプロセスを挙げる。サーバ自身は除く。 */
export function webkitClients(lsof: string, serverPid: number): { pid: number; command: string }[] {
  const out: { pid: number; command: string }[] = [];
  let pid: number | null = null;
  for (const line of lsof.split('\n')) {
    if (line.startsWith('p')) pid = Number(line.slice(1));
    else if (line.startsWith('c') && pid !== null && pid !== serverPid && line.includes('WebKit')) {
      out.push({ pid, command: line.slice(1) });
    }
  }
  return out;
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function read(file: string): string | null {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

/** 外のコマンドの標準出力。終了コードが 0 でなくても出力は返す（lsof は何も無いと 1 で終わる）。 */
function output(cmd: string, args: string[]): string {
  try {
    return execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  } catch (e) {
    return String((e as { stdout?: unknown }).stdout ?? '');
  }
}

async function get(url: string): Promise<{ status: number; body: string } | null> {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(3000) });
    return { status: r.status, body: await r.text() };
  } catch {
    return null;
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type Args = {
  port: number;
  hangarHome: string;
  serverDir: string;
  node: string;
  shellPid: number;
  userHome: string;
  pathBase: string;
  probe: string;
  timeoutS: number;
  shot: string | null;
};

function parseArgs(argv: string[]): Args | null {
  const [cmd, ...rest] = argv;
  if (cmd !== 'run') return null;
  const opt: Record<string, string> = {};
  for (let i = 0; i < rest.length; i += 2) {
    const k = rest[i]!;
    const v = rest[i + 1];
    if (!k.startsWith('--') || v === undefined) return null;
    opt[k.slice(2)] = v;
  }
  const num = (s: string | undefined) => (s === undefined ? NaN : Number(s));
  const a = {
    port: num(opt.port),
    hangarHome: opt['hangar-home'] ?? '',
    serverDir: opt['server-dir'] ?? '',
    node: opt.node ?? '',
    shellPid: num(opt['shell-pid']),
    userHome: opt['user-home'] ?? '',
    pathBase: opt['path-base'] ?? '',
    probe: opt.probe ?? '',
    timeoutS: num(opt.timeout),
    shot: opt.shot ?? null,
  };
  if (!Number.isInteger(a.port) || !Number.isInteger(a.shellPid) || !(a.timeoutS > 0)) return null;
  if (!a.hangarHome || !a.serverDir || !a.node || !a.userHome || !a.pathBase || !a.probe) return null;
  return a;
}

class Failed extends Error {}

async function run(a: Args): Promise<void> {
  const say = (s: string) => process.stdout.write(`${s}\n`);
  const deadline = Date.now() + a.timeoutS * 1000;
  const logFile = path.join(a.hangarHome, 'desktop.log');
  const desktop = () => readDesktopLog(read(logFile) ?? '');
  const base = `http://127.0.0.1:${a.port}`;
  // 待つ輪。殻の失敗の行、殻の終わり、上限のどれかで落とす。
  const until = async (what: string, step: () => Promise<string | null>): Promise<void> => {
    let last = '';
    for (;;) {
      const fail = desktop().failure;
      if (fail) throw new Failed(`殻が起動に失敗した: ${fail}`);
      const why = await step();
      if (why === null) return;
      last = why;
      if (!alive(a.shellPid)) throw new Failed(`${what}の前に殻が終わった（${last}）`);
      if (Date.now() >= deadline) throw new Failed(`${a.timeoutS} 秒待っても${what}（${last}）`);
      await sleep(250);
    }
  };

  // 1. /health が ok と ready を返すまで。
  await until('/health が ok と ready を返さない', async () => {
    const r = await get(`${base}/health`);
    if (!r) return 'まだ応えない';
    const h = judgeHealth(r.status === 200 ? r.body : null);
    if (!h.ok) return `答えが ${r.status} ${r.body.slice(0, 200)}`;
    return h.ready ? null : '索引づけの途中';
  });
  say('/health が ok と ready を返した');

  // 2. 殻が nodePath の Node で、.app の中の同梱サーバを起こした。
  const log = desktop();
  if (log.node !== a.node) throw new Failed(`殻が nodePath の Node を使っていない（使ったのは ${String(log.node)}、指したのは ${a.node}）`);
  if (log.serverDir !== a.serverDir) throw new Failed(`殻が起こしたサーバの置き場が ${String(log.serverDir)}（期待は ${a.serverDir}）`);
  if (log.serverPid === null) throw new Failed('殻が起こしたサーバの pid が desktop.log に無い（4177 の別のサーバを採ったかもしれない）');
  const serverPid = log.serverPid;
  say(`殻が使った Node: ${log.node}（${output(a.node, ['--version']).trim()}）`);
  say(`同梱サーバ: ${log.serverDir}（pid ${serverPid}）`);

  // 3. サーバは殻の子で、殻の server_command が渡す環境を持つ。
  const ppid = Number(output('ps', ['-o', 'ppid=', '-p', String(serverPid)]).trim());
  if (ppid !== a.shellPid) throw new Failed(`サーバ（pid ${serverPid}）の親が ${ppid}（殻は ${a.shellPid}）`);
  const ps = output('ps', ['-E', '-ww', '-o', 'command=', '-p', String(serverPid)]).trim();
  const want = {
    HANGAR_UI_DIST: path.join(a.serverDir, 'ui'),
    HANGAR_PARENT_PID: String(a.shellPid),
    HANGAR_PORT: String(a.port),
    HANGAR_HOME: a.hangarHome,
    PATH: expectedServerPath(a.pathBase, a.userHome),
  };
  const wrong = envMismatches(ps, want);
  if (wrong.length > 0) throw new Failed(`サーバの環境が殻の渡すものと違う: ${wrong.join('、')}`);
  say(`サーバの環境: ${Object.entries(want).map(([k, v]) => `${k}=${v}`).join(' ')}`);

  // 4. 鍵付きの GET / が HANGAR_UI_DIST の index.html を返し、そこから読む資産も返る。
  const token = (read(path.join(a.hangarHome, 'token')) ?? '').trim();
  if (!token) throw new Failed('サーバが入場の鍵（token）を書いていない');
  const page = await get(`${base}/?t=${encodeURIComponent(token)}`);
  const index = read(path.join(a.serverDir, 'ui', 'index.html'));
  if (!page || page.status !== 200) throw new Failed(`鍵付きの GET / が ${page ? page.status : '応えない'}`);
  if (index === null || page.body !== index) throw new Failed('GET / の中身が同梱の ui/index.html と違う');
  const asset = firstAsset(page.body);
  if (!asset) throw new Failed('index.html に /assets/ の資産が見当たらない');
  const got = await get(`${base}${asset}`);
  if (!got || got.status !== 200) throw new Failed(`資産 ${asset} が ${got ? got.status : '応えない'}`);
  say(`UI: GET / は同梱の index.html、${asset} も 200`);

  // 5. 殻が画面をサーバへ移し、WebKit がサーバへつないだ。起動画面が失敗の札を出していれば落とす。
  let ready: Verdict = judgeReady(null);
  let clients: { pid: number; command: string }[] = [];
  await until('画面がサーバへ移らない', async () => {
    ready = judgeReady(read(a.probe));
    if (ready.done && !ready.ok) throw new Failed(ready.message);
    if (!desktop().navigated) return '殻が画面をまだ移していない';
    clients = webkitClients(output('lsof', ['-nP', `-iTCP@127.0.0.1:${a.port}`, '-sTCP:ESTABLISHED', '-F', 'pc']), serverPid);
    if (clients.length === 0) return '殻は画面を移したが、WebKit がサーバへつないでいない';
    return null;
  });
  say(ready.ok ? ready.message : `起動画面は読み込みの合図を描く前に移った（書き出し: ${ready.message}）`);
  say(`画面がサーバへ移った（${clients.map((c) => `${c.command} pid ${c.pid}`).join('、')} がつないでいる）`);

  // 画面を撮る。描き終わるのを少し待つ。ランナーで画面の収録が許されていなければ撮れない。撮れなくても落とさない。
  if (a.shot) {
    await sleep(2000);
    try {
      execFileSync('screencapture', ['-x', a.shot], { stdio: 'ignore' });
      say(fs.existsSync(a.shot) && fs.statSync(a.shot).size > 0 ? `画面を撮った: ${path.basename(a.shot)}` : '::warning::画面を撮れなかった');
    } catch (e) {
      say(`::warning::画面を撮れなかった（${(e as Error).message}）`);
    }
  }

  // 6. 殻が消えると、サーバも自分で降りる（HANGAR_PARENT_PID の見張りは 5 秒ごと、降りるときの番犬は 8 秒）。
  process.kill(a.shellPid, 'SIGTERM');
  const gone = Date.now() + 20_000;
  while (alive(serverPid) && Date.now() < gone) await sleep(250);
  if (alive(serverPid)) throw new Failed(`殻が終わって 20 秒たっても、サーバ（pid ${serverPid}）が残っている`);
  say('殻を止めると、サーバも降りた');
}

async function main(argv: string[]): Promise<number> {
  const a = parseArgs(argv);
  if (!a) {
    process.stderr.write(
      '使い方: boot-normal-check.ts run --port <n> --hangar-home <dir> --server-dir <dir> --node <path> --shell-pid <pid> --user-home <dir> --path-base <PATH> --probe <file> --timeout <秒> [--shot <png>]\n',
    );
    return 2;
  }
  try {
    await run(a);
    return 0;
  } catch (e) {
    if (!(e instanceof Failed)) throw e;
    process.stderr.write(`${e.message}\n`);
    return 1;
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then((code) => process.exit(code));
}
