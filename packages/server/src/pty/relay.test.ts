import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import WebSocket from 'ws';
import { TMUX, removeTestSocket, testSocketPath, waitFor } from '../../test/tmux.ts';
import { hangarMux } from '../tmux/servers.ts';
import { Tmux, type TmuxExec } from '../tmux/tmux.ts';
import { PtyRelay, type PtyProcess, type PtySpawn } from './relay.ts';

type Msg = { t: string; d?: string; message?: string };
type FakeProc = PtyProcess & { written: string[]; sizes: number[][]; killed: boolean; emitData: (d: string) => void; emitExit: () => void };
let server: http.Server;
let port: number;
let relay: PtyRelay;
const TOKEN = 'tok';

function fakeSpawn(): { spawn: PtySpawn; procs: FakeProc[] } {
  const procs: FakeProc[] = [];
  const spawn: PtySpawn = () => {
    let onData: (d: string) => void = () => {};
    let onExit: (e: { exitCode: number }) => void = () => {};
    const p = { pid: 1, written: [] as string[], sizes: [] as number[][], killed: false,
      onData: (cb: (d: string) => void) => { onData = cb; }, onExit: (cb: (e: { exitCode: number }) => void) => { onExit = cb; },
      write: (d: string) => { p.written.push(d); onData('echo:' + d); }, resize: (c: number, r: number) => { p.sizes.push([c, r]); }, kill: () => { p.killed = true; },
      emitData: (d: string) => onData(d), emitExit: () => onExit({ exitCode: 0 }) };
    procs.push(p);
    return p;
  };
  return { spawn, procs };
}

// port は許可する Origin の組み立てにしか使わない。この試験の ws クライアントは Origin を送らないので 0 で足りる。
async function listen(r: PtyRelay): Promise<void> {
  server = http.createServer((_q, res) => { res.statusCode = 404; res.end(); });
  r.attach(server, '/ws/pty');
  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', () => ok()));
  port = (server.address() as { port: number }).port;
}
/** トークンはヘッダで送る。クエリの token は受け付けない。 */
function connect(q: string, headers: Record<string, string> = { authorization: `Bearer ${TOKEN}` }): Promise<{ ws: WebSocket; msgs: Msg[]; closed: Promise<number> }> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/pty?${q}`, { headers });
    const msgs: Msg[] = [];
    const closed = new Promise<number>((r) => ws.on('close', (code) => r(code)));
    ws.on('message', (raw) => msgs.push(JSON.parse(raw.toString()) as Msg));
    ws.on('open', () => resolve({ ws, msgs, closed }));
    ws.on('error', reject);
  });
}
afterEach(async () => { relay?.close(); await new Promise<void>((r) => server?.close(() => r())); });

describe('PtyRelay（偽の spawn）', () => {
  const tmux = new Tmux({ tmuxPath: '/x/tmux', socketName: 'fake' });
  beforeEach(async () => { relay = new PtyRelay({ token: TOKEN, port: 0, tmux, resolveTab: (t) => (t === 't1' ? 'hangar-a' : null), spawn: fakeSpawn().spawn }); await listen(relay); });

  it('トークンが無ければ 401、知らないタブは 404', async () => {
    await expect(connect('tab=t1', {})).rejects.toThrow(/401/);
    await expect(connect(`tab=nope`)).rejects.toThrow(/404/);
  });
  it('クエリ文字列のトークンは受け付けない', async () => {
    // URL は Referer、代理のログ、シェルの履歴に残る。秘密をそこに置く経路を残さない。
    await expect(connect(`tab=t1&token=${TOKEN}`, {})).rejects.toThrow(/401/);
    // クッキーとヘッダはこれまでどおり通る。
    const viaCookie = await connect('tab=t1', { cookie: `hangar_token=${TOKEN}` });
    viaCookie.ws.close();
  });
  it('入出力とリサイズを中継し、切断で attach を殺す', async () => {
    const f = fakeSpawn();
    relay.close(); await new Promise<void>((r) => server.close(() => r()));
    relay = new PtyRelay({ token: TOKEN, port: 0, tmux, resolveTab: () => 'hangar-a', spawn: vi.fn(f.spawn) });
    await listen(relay);
    const { ws, msgs, closed } = await connect(`tab=t1`);
    await waitFor(() => f.procs.length === 1);
    ws.send(JSON.stringify({ t: 'resize', cols: 100, rows: 30 }));
    ws.send(JSON.stringify({ t: 'data', d: 'ls\r' }));
    ws.send('not json');
    await waitFor(() => msgs.length === 1);
    expect(msgs[0]).toEqual({ t: 'data', d: 'echo:ls\r' });
    expect(f.procs[0]!.sizes).toEqual([[100, 30]]);
    expect(relay.clientCount()).toBe(1);
    ws.close();
    await closed;
    await waitFor(() => f.procs[0]!.killed);
    expect(relay.clientCount()).toBe(0);
  });
  it('spawn の失敗は error を送って 1011 で閉じ、サーバは生きている', async () => {
    relay.close(); await new Promise<void>((r) => server.close(() => r()));
    relay = new PtyRelay({ token: TOKEN, port: 0, tmux, resolveTab: () => 'hangar-a', spawn: () => { throw new Error('posix_spawnp failed'); } });
    await listen(relay);
    const { msgs, closed } = await connect(`tab=t1`);
    expect(await closed).toBe(1011);
    expect(msgs[0]).toMatchObject({ t: 'error', message: expect.stringContaining('posix_spawnp') });
    const again = await connect(`tab=t1`);
    expect(await again.closed).toBe(1011);
  });
  it('close フレームに応えない相手でも、猶予のあとに pty を落とす', async () => {
    const f = fakeSpawn();
    relay.close(); await new Promise<void>((r) => server.close(() => r()));
    relay = new PtyRelay({ token: TOKEN, port: 0, tmux, resolveTab: () => 'hangar-a', spawn: f.spawn });
    await listen(relay);
    // close フレームに応えない相手。止まったタブや代理を挟んだときに起こる。
    const stalled = net.connect(port, '127.0.0.1');
    await new Promise<void>((r) => stalled.once('connect', r));
    stalled.write(`GET /ws/pty?tab=t1 HTTP/1.1\r\nHost: 127.0.0.1\r\nAuthorization: Bearer ${TOKEN}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n`);
    const upgraded = await new Promise<string>((r) => stalled.once('data', (d) => r(String(d))));
    expect(upgraded.startsWith('HTTP/1.1 101')).toBe(true);
    await waitFor(() => f.procs.length === 1);
    expect(relay.clientCount()).toBe(1);
    relay.close();
    expect(f.procs[0]!.killed).toBe(false);
    await waitFor(() => f.procs[0]!.killed, 3000);
    stalled.destroy();
  });
  it('note はその tmux 名に attach している接続にだけ 1 行を送る', async () => {
    const f = fakeSpawn();
    relay.close(); await new Promise<void>((r) => server.close(() => r()));
    relay = new PtyRelay({ token: TOKEN, port: 0, tmux, resolveTab: (t) => (t === 't1' ? 'hangar-a' : 'hangar-b'), spawn: f.spawn });
    await listen(relay);
    const one = await connect('tab=t1');
    const two = await connect('tab=t2');
    await waitFor(() => relay.clientCount() === 2);
    relay.note('hangar-a', '[hangar] x');
    await waitFor(() => one.msgs.length === 1);
    expect(one.msgs).toContainEqual({ t: 'data', d: '\r\n[hangar] x\r\n' });
    await new Promise((r) => setTimeout(r, 30));
    expect(two.msgs).not.toContainEqual({ t: 'data', d: '\r\n[hangar] x\r\n' });
    // 誰も attach していない名前には何も起きない。
    expect(() => relay.note('hangar-none', 'x')).not.toThrow();
    one.ws.close(); two.ws.close();
  });
  it('attach の前に、tmux に OSC 52 を外へ通させる', async () => {
    const f = fakeSpawn();
    relay.close(); await new Promise<void>((r) => server.close(() => r()));
    const clip = vi.spyOn(tmux, 'enableClipboard').mockImplementation(() => {});
    const spawn = vi.fn(f.spawn);
    relay = new PtyRelay({ token: TOKEN, port: 0, tmux, resolveTab: () => 'hangar-a', spawn });
    await listen(relay);
    const { ws } = await connect(`tab=t1`);
    await waitFor(() => f.procs.length === 1);
    expect(clip).toHaveBeenCalledTimes(1);
    expect(clip.mock.invocationCallOrder[0]!).toBeLessThan(spawn.mock.invocationCallOrder[0]!);
    clip.mockRestore();
    ws.close();
  });
  it('attach の前に、外の端末のための設定を tmux に入れる', async () => {
    const f = fakeSpawn();
    relay.close(); await new Promise<void>((r) => server.close(() => r()));
    const opts = vi.spyOn(tmux, 'ensureTerminalOptions').mockImplementation(() => {});
    const spawn = vi.fn(f.spawn);
    relay = new PtyRelay({ token: TOKEN, port: 0, tmux, resolveTab: () => 'hangar-a', spawn });
    await listen(relay);
    const { ws } = await connect(`tab=t1`);
    await waitFor(() => f.procs.length === 1);
    expect(opts).toHaveBeenCalledTimes(1);
    expect(opts.mock.invocationCallOrder[0]!).toBeLessThan(spawn.mock.invocationCallOrder[0]!);
    opts.mockRestore();
    ws.close();
  });
  it('専用のサーバの画面は -L hangar で、前の版が既定のサーバに作った画面はそのサーバで attach し、既定のサーバには設定を入れない', async () => {
    const f = fakeSpawn();
    relay.close(); await new Promise<void>((r) => server.close(() => r()));
    // 既定のサーバにだけ前の版の画面 hangar-0a0a が居る。
    const execCalls: string[][] = [];
    const exec: TmuxExec = (_file, args) => {
      execCalls.push(args);
      const own = args[0] === '-L';
      if ((own ? args[2] : args[0]) === 'list-sessions') return own ? { status: 0, stdout: 'hangar-1b1b\n', stderr: '' } : { status: 0, stdout: 'hangar-0a0a\nwork\n', stderr: '' };
      return { status: 0, stdout: '', stderr: '' };
    };
    const mux = hangarMux('/x/tmux', { exec, platform: 'darwin' });
    const spawn = vi.fn(f.spawn);
    relay = new PtyRelay({ token: TOKEN, port: 0, tmux: mux, resolveTab: (t) => (t === 'old' ? 'hangar-0a0a' : 'hangar-1b1b'), spawn });
    await listen(relay);
    const a = await connect('tab=old');
    await waitFor(() => f.procs.length === 1);
    expect(spawn.mock.calls[0]!.slice(0, 2)).toEqual(['/x/tmux', ['attach', '-t', '=hangar-0a0a']]);
    // サーバ全体のオプション（show-options、set-option、bind-key）を既定のサーバへ出していない。
    expect(execCalls.filter((c) => c[0] !== '-L' && c[0] !== 'list-sessions')).toEqual([]);
    const b = await connect('tab=new');
    await waitFor(() => f.procs.length === 2);
    expect(spawn.mock.calls[1]!.slice(0, 2)).toEqual(['/x/tmux', ['-L', 'hangar', 'attach', '-t', '=hangar-1b1b']]);
    expect(execCalls.some((c) => c[0] === '-L' && c[2] === 'show-options')).toBe(true);
    a.ws.close();
    b.ws.close();
  });
  it('プロセスの終了で接続を閉じる', async () => {
    const f = fakeSpawn();
    relay.close(); await new Promise<void>((r) => server.close(() => r()));
    relay = new PtyRelay({ token: TOKEN, port: 0, tmux, resolveTab: () => 'hangar-a', spawn: f.spawn });
    await listen(relay);
    const { closed } = await connect(`tab=t1`);
    await waitFor(() => f.procs.length === 1);
    f.procs[0]!.emitExit();
    expect(await closed).toBe(1000);
  });

  it('attach が終わったら onExit で知らせる。tmux の画面が閉じたかもしれないので、run の見張りを急がせる', async () => {
    const f = fakeSpawn();
    let exits = 0;
    relay.close(); await new Promise<void>((r) => server.close(() => r()));
    relay = new PtyRelay({ token: TOKEN, port: 0, tmux, resolveTab: () => 'hangar-a', spawn: f.spawn, onExit: () => { exits++; } });
    await listen(relay);
    const { closed } = await connect(`tab=t1`);
    await waitFor(() => f.procs.length === 1);
    f.procs[0]!.emitExit();
    await closed;
    expect(exits).toBe(1);
  });
});

describe.skipIf(!TMUX)('PtyRelay（実物の tmux と node-pty）', () => {
  const socketPath = testSocketPath();
  const tmux = new Tmux({ tmuxPath: TMUX ?? 'tmux', socketPath });
  afterAll(() => {
    tmux.killServer();
    removeTestSocket(socketPath);
  });
  it('tmux セッションに attach して入出力が通る', async () => {
    const { nodePtySpawn } = await import('./nodePty.ts');
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'hangar-pty-real-'));
    tmux.newSession({ name: 'hangar-pty-real', cwd, command: ['sh'] });
    relay = new PtyRelay({ token: TOKEN, port: 0, tmux, resolveTab: () => 'hangar-pty-real', spawn: nodePtySpawn });
    await listen(relay);
    const { ws, msgs } = await connect(`tab=x`);
    ws.send(JSON.stringify({ t: 'resize', cols: 80, rows: 24 }));
    ws.send(JSON.stringify({ t: 'data', d: 'echo hangar-pty-ok\r' }));
    await waitFor(() => msgs.some((m) => m.t === 'data' && (m.d ?? '').includes('hangar-pty-ok')), 8000);
    ws.close();
    // 切れるのは attach しているクライアントだけで、tmux セッションは残る。ここが壊れると利用者の作業が消える。
    await waitFor(() => tmux.hasSession('hangar-pty-real'));
    fs.rmSync(cwd, { recursive: true, force: true });
  });
  it('UI の Shift+Enter が送る ESC CR は、tmux を越えてそのまま中のアプリに届く', async () => {
    // Claude Code はこの列を改行として読む。tmux が素の CR に変えると送信になってしまう。
    const { nodePtySpawn } = await import('./nodePty.ts');
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'hangar-pty-real-'));
    const out = path.join(cwd, 'keys.txt');
    // 生の入力で 5 バイトを受け取り、16 進でファイルに書く。
    tmux.newSession({ name: 'hangar-pty-keys', cwd, command: ['sh', '-c', `stty raw -echo; dd bs=1 count=5 2>/dev/null | od -An -tx1 > ${out}; sleep 30`] });
    relay = new PtyRelay({ token: TOKEN, port: 0, tmux, resolveTab: () => 'hangar-pty-keys', spawn: nodePtySpawn });
    await listen(relay);
    const { ws, msgs } = await connect(`tab=x`);
    ws.send(JSON.stringify({ t: 'resize', cols: 80, rows: 24 }));
    await waitFor(() => msgs.some((m) => m.t === 'data'), 8000);
    ws.send(JSON.stringify({ t: 'data', d: 'a\x1b\rb\r' }));
    await waitFor(() => fs.existsSync(out) && fs.readFileSync(out, 'utf8').trim() !== '', 8000);
    expect(fs.readFileSync(out, 'utf8').trim().split(/\s+/)).toEqual(['61', '1b', '0d', '62', '0d']);
    ws.close();
    tmux.killSession('hangar-pty-keys');
    fs.rmSync(cwd, { recursive: true, force: true });
  }, 20000);
  it('中のアプリが OSC 52 で写したものが UI まで届く', async () => {
    const { nodePtySpawn } = await import('./nodePty.ts');
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'hangar-pty-real-'));
    // 利用者の ~/.tmux.conf に左右されないよう、tmux の既定の external に揃える。external のままでは届かない。
    tmux.newSession({ name: 'hangar-pty-osc52', cwd, command: ['sh', '-c', "read x; printf '\\033]52;c;aGVsbG8=\\007'; sleep 30"] });
    tmux.run('set-option', '-s', 'set-clipboard', 'external');
    relay = new PtyRelay({ token: TOKEN, port: 0, tmux, resolveTab: () => 'hangar-pty-osc52', spawn: nodePtySpawn });
    await listen(relay);
    const { ws, msgs } = await connect(`tab=x`);
    ws.send(JSON.stringify({ t: 'resize', cols: 80, rows: 24 }));
    // attach が済んでから書かせる。誰も attach していない間の OSC 52 は外へ出ない。
    await waitFor(() => msgs.some((m) => m.t === 'data'), 8000);
    ws.send(JSON.stringify({ t: 'data', d: 'go\r' }));
    await waitFor(() => msgs.some((m) => m.t === 'data' && (m.d ?? '').includes('\x1b]52;c;aGVsbG8=')), 8000);
    ws.close();
    tmux.killSession('hangar-pty-osc52');
    fs.rmSync(cwd, { recursive: true, force: true });
  }, 20000);
});
