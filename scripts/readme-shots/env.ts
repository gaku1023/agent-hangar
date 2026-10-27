// 撮影用の環境。一時ディレクトリの中に HOME、hangar の置き場、Claude の置き場、tmux のソケットを作り、
// 4177 以外の空いたポートでサーバを起こす。利用者の実データには触らない。
import { type ChildProcess, execFileSync, spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PAST, PROJECTS } from './data.mjs';
import { TranscriptWriter, transcriptPath } from './transcript.mjs';

export const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

export type Env = {
  root: string;
  home: string;
  hangarHome: string;
  claudeDir: string;
  workspace: string;
  gates: string;
  tmuxTmp: string;
  token: string;
  port: number;
  base: string;
  server: ChildProcess | null;
  /** 過去の会話の id（PAST の添字順）。 */
  pastIds: string[];
  /** プロジェクトの dir から cwd へ。 */
  cwdOf: Record<string, string>;
};

/** ビルド済みかを確かめる。無ければ案内を出して止まる（台本は長い build をしない）。 */
export function requireBuilt(): void {
  const dist = path.join(REPO, 'packages/ui/dist/index.html');
  if (!fs.existsSync(dist)) {
    console.error('packages/ui/dist がありません。先に `npm run build` を実行してください。');
    process.exit(1);
  }
}

export function requireTools(): { tmux: string; ffmpeg: string } {
  const find = (n: string): string | null => {
    for (const d of ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin']) if (fs.existsSync(path.join(d, n))) return path.join(d, n);
    return null;
  };
  const ffmpeg = find('ffmpeg');
  if (!ffmpeg) {
    console.error('ffmpeg が見つかりません。GIF を作るのに要ります。`brew install ffmpeg` で入れてください。');
    process.exit(1);
  }
  const tmux = find('tmux');
  if (!tmux) {
    console.error('tmux が見つかりません。`brew install tmux` で入れてください。');
    process.exit(1);
  }
  return { tmux, ffmpeg };
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => {
      const p = (s.address() as net.AddressInfo).port;
      s.close(() => (p === 4177 ? reject(new Error('4177 を引いた')) : resolve(p)));
    });
  });
}

/** 一時ディレクトリを作り、見本のデータを置く。 */
export async function prepare(tools: { tmux: string }): Promise<Env> {
  // tmux のソケットのパスは 104 バイトまでなので、短い場所に作る。
  const root = fs.mkdtempSync('/tmp/hgshots-');
  const home = path.join(root, 'home');
  const e: Env = {
    root,
    home,
    hangarHome: path.join(home, '.agent-hangar'),
    claudeDir: path.join(home, '.claude'),
    workspace: path.join(home, 'workspace'),
    gates: path.join(root, 'gates'),
    tmuxTmp: path.join(root, 'tmux'),
    token: crypto.randomBytes(16).toString('hex'),
    port: await freePort(),
    base: '',
    server: null,
    pastIds: [],
    cwdOf: {},
  };
  e.base = `http://127.0.0.1:${e.port}`;
  for (const d of [e.hangarHome, e.claudeDir, e.workspace, e.gates, e.tmuxTmp, path.join(root, 'bin')]) fs.mkdirSync(d, { recursive: true });
  fs.chmodSync(e.hangarHome, 0o700);
  fs.writeFileSync(path.join(e.hangarHome, 'token'), e.token, { mode: 0o600 });
  fs.writeFileSync(path.join(e.hangarHome, 'settings.json'), JSON.stringify({
    workspaceRoot: e.workspace,
    claudeDir: e.claudeDir,
    tmuxPath: tools.tmux,
    claudePath: path.join(root, 'bin/claude'),
    language: 'ja',
    autoDone: false,
    autoPark: false,
    remoteControl: false,
    summaryEngine: 'off',
    toolsResolved: true,
  }, null, 2));
  // 偽の claude の包み。ここに差した場所を設定と HANGAR_CLAUDE_BIN の両方で指す。
  const wrapper = path.join(root, 'bin/claude');
  fs.writeFileSync(wrapper, `#!/bin/sh\nexec "${process.execPath}" "${path.join(REPO, 'scripts/readme-shots/fake-claude.mjs')}" "$@"\n`, { mode: 0o755 });

  for (const p of PROJECTS) {
    const dir = path.join(e.workspace, p.dir);
    fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'README.md'), `# ${p.name}\n`);
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: p.name, version: '1.0.0' }, null, 2));
    e.cwdOf[p.dir] = fs.realpathSync(dir);
  }

  // 過去の会話。最後の発言が minutesAgo 分前になるように時刻を置く。
  const now = Date.now();
  for (const s of PAST) {
    const id = crypto.randomUUID();
    e.pastIds.push(id);
    const cwd = e.cwdOf[s.project]!;
    const file = transcriptPath(e.claudeDir, cwd, id);
    const turns = s.turns.length;
    const last = now - s.minutesAgo * 60_000;
    let t = last - turns * 90_000;
    const tw = new TranscriptWriter({ file, sessionId: id, cwd, title: s.title });
    for (const [userText, tools, reply] of s.turns) {
      tw.user(userText, t);
      t += 5_000;
      for (const [name, input, result] of tools) {
        const tid = tw.toolUse(name, input, t);
        t += 2_000;
        tw.toolResult(tid, result, t);
        t += 3_000;
      }
      tw.text(reply, t, true);
      t += 20_000;
    }
    const when = new Date(last);
    fs.utimesSync(file, when, when);
  }
  return e;
}

export function startServer(e: Env): void {
  const env: Record<string, string> = {
    PATH: '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin',
    HOME: e.home,
    LANG: 'ja_JP.UTF-8',
    TMPDIR: path.join(e.root, 'tmp'),
    TMUX_TMPDIR: e.tmuxTmp,
    HANGAR_HOME: e.hangarHome,
    HANGAR_CLAUDE_DIR: e.claudeDir,
    HANGAR_CLAUDE_BIN: path.join(e.root, 'bin/claude'),
    HANGAR_PORT: String(e.port),
    HANGAR_UI_DIST: path.join(REPO, 'packages/ui/dist'),
    HANGAR_OS_LANGUAGE: 'ja',
    READMESHOTS_GATES: e.gates,
  };
  fs.mkdirSync(env.TMPDIR!, { recursive: true });
  const log = fs.openSync(path.join(e.root, 'server.log'), 'a');
  e.server = spawn(process.execPath, ['--import', 'tsx', path.join(REPO, 'packages/server/src/main.ts')], {
    cwd: path.join(REPO, 'packages/server'),
    env,
    stdio: ['ignore', log, log],
  });
}

export async function waitHealthy(e: Env, ms = 60_000): Promise<void> {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try {
      const r = await fetch(`${e.base}/health`);
      if (r.ok) return;
    } catch { /* まだ起きていない */ }
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`サーバが起きません。ログ: ${path.join(e.root, 'server.log')}`);
}

export async function api<T = unknown>(e: Env, method: string, p: string, body?: unknown): Promise<T> {
  const r = await fetch(`${e.base}/api${p}`, {
    method,
    headers: { authorization: `Bearer ${e.token}`, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`${method} ${p} -> ${r.status} ${text.slice(0, 300)}`);
  return (text ? JSON.parse(text) : null) as T;
}

/** 自分が起こしたサーバと、自分の専用ソケットの tmux だけを止めて、一時ディレクトリを消す。 */
export async function teardown(e: Env, tools: { tmux: string }, keep = false): Promise<void> {
  if (e.server && e.server.exitCode === null) {
    e.server.kill('SIGTERM');
    await new Promise((r) => { e.server!.once('exit', r); setTimeout(r, 8000); });
    if (e.server.exitCode === null) e.server.kill('SIGKILL');
  }
  // この環境の専用の tmux（TMUX_TMPDIR の下の hangar ソケット）。名指しで止める。
  const sock = path.join(e.tmuxTmp, `tmux-${os.userInfo().uid}`, 'hangar');
  if (fs.existsSync(sock)) {
    try { execFileSync(tools.tmux, ['-S', sock, 'kill-server'], { stdio: 'ignore' }); } catch { /* 既に無い */ }
  }
  if (!keep) fs.rmSync(e.root, { recursive: true, force: true });
  else console.log(`一時ディレクトリを残しました: ${e.root}`);
}
