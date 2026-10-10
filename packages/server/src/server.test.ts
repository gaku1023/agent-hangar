import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import type { CompatDto, ServerEvent, SessionDto, SyncStatusBody } from '@agent-hangar/shared';
import { COMPAT_VERSION } from '@agent-hangar/shared';
import { saveCloudConfig } from './config/cloud.ts';
import { dbPath, ensureHome, readOrCreateDevice } from './config/paths.ts';
import { SyncStateStore } from './sync/state.ts';
import { DbBackupError } from './db/backup.ts';
import { DbTooOldError, openDb } from './db/open.ts';
import { upsertShared } from './db/shared.ts';
import { ensureSession } from './indexer/indexFile.ts';
import { mangleCwd } from './provider/claude-code/transcript/discover.ts';
import { answerAll, fakeWorker, fileSink } from '../test/fake-worker.ts';
import { copyFixtureClaudeDir, SESSION_ALPHA, SESSION_OTHER } from '../test/fixtures.ts';
import { BASELINE_DB_VERSION, dbVersionOf, LATEST_DB_VERSION, seedDbAt, withPendingMigration } from '../test/oldDb.ts';
import { CLOSE_DEADLINE_MS, installShutdown, startServer, STOP_WATCHDOG_MS } from './server.ts';
import { writeFakeTool } from '../test/fake-bin.ts';
import { expectMode, posixDescribe, posixIt } from '../test/platform.ts';

/**
 * サーバを丸ごと起こす端到端の試験。
 * ここに置くのは、全体を起動しないと確かめられない振る舞いだけである。
 * 起動して止まる、認証と WebSocket の経路、同期が 1 巡する、実行中の登録の出入り、起こし直しで続きから動く、の 5 つである。
 * 全体の起動は重いので、起動の回数を絞ってある。同じ起動で確かめられるものは、1 度の起動を分け合う。
 *
 * 部品ごとの振る舞いは、組み立て関数の試験（boot/*.test.ts）と、業務の関数の試験（projects/、sync/、sessions/ など）にある。
 * 配るイベントの数と順は events/delivery.test.ts が、同じく全体を起こして押さえている。
 */

/** 見本の登録の pid は実在しない。Windows の既定は動いていない pid の登録を読まないので、試験では全部読ませる。 */
const ALL_ALIVE = (): boolean => false;

/** 試験 1 回ぶん（または describe 1 つぶん）の置き場。 */
type Dirs = { home: string; claudeDir: string; ws: string; cleanup(): void };
/**
 * 置き場を作る。
 * サーバは起動の裏で claude --help と --version を読む。手元の本物の claude を起こさないよう、無いパスに向ける。
 * 偽の claude を使う試験は、設定の claudePath で渡す（環境変数は設定より先に効くので、その試験は環境変数を外す）。
 */
function makeDirs(): Dirs {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'hangar-home-'));
  const claudeDir = copyFixtureClaudeDir();
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'hangar-ws-'));
  const prevClaudeBin = process.env.HANGAR_CLAUDE_BIN;
  process.env.HANGAR_CLAUDE_BIN = path.join(home, 'no-claude');
  return {
    home, claudeDir, ws,
    cleanup: () => {
      if (prevClaudeBin === undefined) delete process.env.HANGAR_CLAUDE_BIN; else process.env.HANGAR_CLAUDE_BIN = prevClaudeBin;
      fs.rmSync(home, { recursive: true, force: true });
      fs.rmSync(claudeDir, { recursive: true, force: true });
      fs.rmSync(ws, { recursive: true, force: true });
    },
  };
}

const tokenIn = (home: string): string => fs.readFileSync(path.join(home, 'token'), 'utf8').trim();
const start = (d: Dirs) => startServer({ port: 0, home: d.home, claudeDir: d.claudeDir, registryIsGone: ALL_ALIVE, uiDist: path.join(d.home, 'no-dist') });
const joinTo = (home: string, url: string): void => saveCloudConfig(home, { url, joinSecret: 'test-secret', deviceToken: 'test-device-token', workerName: null, accountId: null, dbName: null, bucketName: null, joinedAt: 1 });

/** 実際の Claude Code と同じ配置で、発言 1 つだけの本文ファイルを置く。 */
function writeTranscript(claudeDir: string, cwd: string, sessionId: string, text: string): void {
  const dir = path.join(claudeDir, 'projects', mangleCwd(cwd));
  fs.mkdirSync(dir, { recursive: true });
  const rec = { type: 'user', message: { role: 'user', content: text }, uuid: 'u1', parentUuid: null, isSidechain: false, timestamp: '2026-09-01T10:00:00.000Z', cwd, sessionId };
  fs.writeFileSync(path.join(dir, `${sessionId}.jsonl`), JSON.stringify(rec) + '\n');
}

/** 配信を貯めておき、条件に合うものが来るまで待つ。待ち始める前に来たものも見る。 */
function collector(port: number, token: string) {
  const sock = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers: { authorization: `Bearer ${token}` } });
  const seen: ServerEvent[] = [];
  const waiters = new Set<() => void>();
  sock.on('message', (d) => { seen.push(JSON.parse(String(d)) as ServerEvent); for (const w of [...waiters]) w(); });
  const opened = new Promise<void>((resolve, reject) => { sock.once('open', () => resolve()); sock.once('error', reject); });
  return {
    opened,
    all: () => seen as readonly ServerEvent[],
    close: () => sock.terminate(),
    waitFor<T extends ServerEvent>(pred: (e: ServerEvent) => e is T, ms = 8000): Promise<T> {
      return new Promise<T>((resolve, reject) => {
        const check = () => { const hit = seen.find(pred); if (hit) { waiters.delete(check); clearTimeout(timer); resolve(hit); } };
        const timer = setTimeout(() => { waiters.delete(check); reject(new Error(`event not seen: ${JSON.stringify(seen.map((e) => e.type))}`)); }, ms);
        waiters.add(check);
        check();
      });
    },
  };
}

/** 条件が満たされるまで一定間隔で試す。 */
async function until<T>(fn: () => Promise<T | null>, ms = 8000): Promise<T> {
  const limit = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v !== null) return v;
    if (Date.now() > limit) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 100));
  }
}

describe('startServer', () => {
  /**
   * 参加していない端末を 1 度だけ起こし、載っている経路と配線を順に確かめる。
   * 下の it は上から順に走る。登録を消す確かめと、設定を書き替える確かめと、止める確かめは、後ろに置く。
   */
  describe('参加していない端末を起動して確かめる', () => {
    let d: Dirs;
    let s: { close(): Promise<void>; port: number };
    let token: string;
    let closed = false;
    let headerBefore = true;
    const api = (p: string, init?: RequestInit) => fetch(`http://127.0.0.1:${s.port}${p}`, { ...init, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...(init?.headers ?? {}) } });
    beforeAll(async () => {
      d = makeDirs();
      headerBefore = fs.existsSync(path.join(d.home, 'statusline-header'));
      s = await start(d);
      token = tokenIn(d.home);
    }, 30_000);
    afterAll(async () => {
      if (!closed) await s.close();
      d.cleanup();
    });

    it('cloud.json が無ければ同期は off で、経路は動く', async () => {
      // 参加していない端末でも、同期の経路は 404 にならずに「off」を返す。
      // 実物のクラウドには一切触らない（cloud.json が無いので client は作られない）。
      expect(s.port).toBeGreaterThan(0);
      const status = await (await api('/api/sync/status')).json() as { state: string; url: string | null; pending: number; skipped: unknown[] };
      expect(status).toMatchObject({ state: 'off', url: null, pending: expect.any(Number) });
      expect(status.skipped).toEqual([]);
      // 参加していないので、参加トークンも設定の同期も無い。
      expect(await (await api('/api/sync/joinToken')).json()).toEqual({ token: null });
      expect((await api('/api/sync/config/preview')).status).toBe(404);
      expect((await api('/api/sync/config/pull', { method: 'POST' })).status).toBe(404);
      expect((await api('/api/sync/focus', { method: 'POST' })).status).toBe(202);
      expect((await api('/api/sync/now', { method: 'POST' })).status).toBe(200);
      // 自端末は起動のたびに devices へ書き込まれる。
      const b = await (await api('/api/bootstrap')).json() as { devices: { id: string; self: boolean }[]; sync: { state: string } };
      expect(b.devices.some((x) => x.self)).toBe(true);
      expect(b.sync.state).toBe('off');
      const devices = await (await api('/api/devices')).json() as { self: boolean }[];
      expect(devices.some((x) => x.self)).toBe(true);
    });

    it('この PC で再開は、本文が無ければ 400 で理由を返す', async () => {
      // 経路が copyTranscriptForResume まで繋がっていることを、~/.claude を書き換えない側から確かめる。
      const r = await api('/api/sessions/nope/resume-here', { method: 'POST', body: JSON.stringify({ overwrite: false }) });
      expect(r.status).toBe(400);
      expect(await r.json()).toEqual({ error: 'このセッションのトランスクリプトがありません' });
    });

    it('起動でヘッダのファイルを用意する。~/.agent-hangar を消しても使用量が静かに止まらない', () => {
      // statusline はヘッダのファイルが読めなければ何も送らない。
      // 置き場ごと消した利用者のために、トークンと同じところで起動のたびに用意する。
      const header = path.join(d.home, 'statusline-header');
      expect(headerBefore).toBe(false);
      expect(fs.readFileSync(header, 'utf8')).toBe(`Authorization: Bearer ${token}\n`);
      expectMode(header, 0o600);
    });

    it('試験の準備は claude を無いパスに向け、手元の本物の claude を起こさない', async () => {
      const body = (await (await api('/api/compat')).json()) as CompatDto;
      expect(body.localVersion).toBeNull();
      // 準備の確かめも答える。
      expect((await api('/api/readiness')).status).toBe(200);
    });

    it('/ws はクエリ文字列のトークンを受け付けない', async () => {
      // URL は Referer、代理のログ、シェルの履歴、ブラウザの履歴に残る。秘密をそこに置く経路を残さない。
      const open = (url: string, headers: Record<string, string> = {}) => new Promise<WebSocket>((resolve, reject) => {
        const sock = new WebSocket(url, { headers });
        sock.once('open', () => resolve(sock));
        sock.once('error', reject);
      });
      await expect(open(`ws://127.0.0.1:${s.port}/ws?token=${token}`)).rejects.toThrow(/401/);
      const viaHeader = await open(`ws://127.0.0.1:${s.port}/ws`, { authorization: `Bearer ${token}` });
      viaHeader.terminate();
      const viaCookie = await open(`ws://127.0.0.1:${s.port}/ws`, { cookie: `hangar_token=${token}` });
      viaCookie.terminate();
    });

    it('トークンの無い要求は、HTTP の経路でも断る', async () => {
      expect((await fetch(`http://127.0.0.1:${s.port}/api/sessions`)).status).toBe(401);
      // 準備完了の合図（/health）だけは、トークンが無くても返す。
      expect((await fetch(`http://127.0.0.1:${s.port}/health`)).status).toBe(200);
    });

    it('claudeDir を渡すと settings ではなくそれを読む', async () => {
      const r = await api('/api/sessions');
      expect(r.status).toBe(200);
      expect(((await r.json()) as unknown[]).length).toBe(3);
    });

    it('/ws 以外への upgrade 要求は握らずに切る', async () => {
      const sock = net.connect(s.port, '127.0.0.1');
      await new Promise<void>((r) => sock.once('connect', r));
      sock.write('GET /nope HTTP/1.1\r\nHost: 127.0.0.1\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n');
      const result = await Promise.race([
        new Promise<string>((r) => sock.once('close', () => r('closed'))),
        new Promise<string>((r) => setTimeout(() => r('hanging'), 2000)),
      ]);
      expect(result).toBe('closed');
      sock.destroy();
    }, 20000);

    it('/ws/pty は PtyRelay が引き取り、無いタブには 404 を返す', async () => {
      // 番人に切られると応答が無いまま終わる。404 が返るのは relay が attach されている証拠である。
      const sock = net.connect(s.port, '127.0.0.1');
      await new Promise<void>((r) => sock.once('connect', r));
      sock.write(`GET /ws/pty?tab=nope HTTP/1.1\r\nHost: 127.0.0.1\r\nAuthorization: Bearer ${token}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n`);
      const first = await Promise.race([
        new Promise<string>((r) => sock.once('data', (x) => r(String(x)))),
        new Promise<string>((r) => setTimeout(() => r('応答なしで切られた'), 2000)),
      ]);
      expect(first.split('\r\n')[0]).toBe('HTTP/1.1 404 Not Found');
      sock.destroy();
    }, 20000);

    it('run の経路が載り、hangar の外で実行中のセッションの再開は 409 になる', async () => {
      const runs = await api('/api/runs');
      expect(runs.status).toBe(200);
      expect(await runs.json()).toEqual({ runs: [], tabs: [] });
      const list = (await (await api('/api/sessions')).json()) as SessionDto[];
      const alpha = list.find((x) => x.providerSessionId === SESSION_ALPHA)!;
      // フィクスチャの登録ファイルが alpha を実行中にしている。
      // isLive が結ばれていないと、ここは cwd が無いことによる 400 になってしまう。
      const r = await api(`/api/sessions/${alpha.id}/resume`, { method: 'POST' });
      expect(r.status).toBe(409);
      expect(((await r.json()) as { error: string }).error).toContain('hangar の外');
    }, 20000);

    it('実行中の登録が消えたら要約の状態を done に書き替える', async () => {
      // 登録の見張り、出入りの受け手、土台の要約、一覧の読み直しが、端から端まで結ばれていることを見る。
      const stateOf = async (): Promise<string | null> => {
        const list = (await (await api('/api/sessions')).json()) as SessionDto[];
        return list.find((x) => x.providerSessionId === SESSION_ALPHA)?.summary?.state ?? null;
      };
      const c = collector(s.port, token);
      try {
        await c.opened;
        expect(await stateOf()).toBe('in_progress');
        fs.rmSync(path.join(d.claudeDir, 'sessions', '12345.json'));
        await until(async () => ((await stateOf()) === 'done' ? true : null));
        // 画面にも、実行中の一覧の変化と、そのセッションの行が届く。
        await c.waitFor((e): e is Extract<ServerEvent, { type: 'live.update' }> => e.type === 'live.update' && e.live.length === 0);
        await c.waitFor((e): e is Extract<ServerEvent, { type: 'session.upsert' }> => e.type === 'session.upsert' && e.session.providerSessionId === SESSION_ALPHA && e.session.live === null);
      } finally {
        c.close();
      }
    }, 20000);

    // 偽の claude は sh の case で引数を見るので、Windows では飛ばす。
    posixIt('設定で claude のパスを変えると、包みと手元の版が新しいパスに揃う', async () => {
      // 設定の書き替えが、動いている部品（手元の claude の読み取り、包みの本体）まで行き渡ることを見る。
      const fast = writeFakeTool(path.join(d.home, 'fast'), 'claude', {
        sh: 'case "$1" in --version) echo "9.9.9 (Claude Code)" ;; --help) printf "Commands:\\n  newcmd  New\\n" ;; esac',
        cmd: '',
      });
      // HANGAR_CLAUDE_BIN があると設定より先に効くので外す。置き場の片付けが元に戻す。
      delete process.env.HANGAR_CLAUDE_BIN;
      const r = await api('/api/settings', { method: 'PATCH', body: JSON.stringify({ claudePath: fast }) });
      expect(r.status).toBe(200);
      const script = path.join(d.home, 'shell', 'claude.zsh');
      await until(async () => (fs.readFileSync(script, 'utf8').includes('    newcmd) command claude') ? true : null));
      const body = (await (await api('/api/compat')).json()) as CompatDto;
      expect(body.localVersion).toBe('9.9.9');
      expect(body.drifts.map((x) => x.value)).toContain('subcommand.added=newcmd');
    }, 15_000);

    it('WebSocket と keep-alive の接続が残っていても close は 2 秒以内に終わる', async () => {
      const ws = new WebSocket(`ws://127.0.0.1:${s.port}/ws`, { headers: { authorization: `Bearer ${token}` } });
      const ready = await new Promise<string>((resolve, reject) => { ws.once('message', (x) => resolve(String(x))); ws.once('error', reject); });
      expect(JSON.parse(ready).type).toBe('ready');
      // close フレームに応えない相手。ブラウザのタブが止まっているときや代理を挟むときに起こる。
      const stalled = net.connect(s.port, '127.0.0.1');
      await new Promise<void>((r) => stalled.once('connect', r));
      stalled.write(`GET /ws HTTP/1.1\r\nHost: 127.0.0.1\r\nAuthorization: Bearer ${token}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n`);
      const upgraded = await new Promise<string>((r) => stalled.once('data', (x) => r(String(x))));
      expect(upgraded.startsWith('HTTP/1.1 101')).toBe(true);
      // fetch は keep-alive で接続を残す。
      const health = await fetch(`http://127.0.0.1:${s.port}/health`);
      expect(health.status).toBe(200);
      await health.text();
      closed = true;
      const result = await Promise.race([
        s.close().then(() => 'closed'),
        new Promise<string>((r) => setTimeout(() => r('timeout'), 2000)),
      ]);
      expect(result).toBe('closed');
      ws.terminate();
      stalled.destroy();
      // 閉じた後は、もう待ち受けていない。
      await expect(fetch(`http://127.0.0.1:${s.port}/health`)).rejects.toThrow();
      // 記録の残りも書き出してある。
      expect(fs.existsSync(path.join(d.home, 'hangar.db'))).toBe(true);
    });
  });

  describe('1 回ずつ起動して確かめる', () => {
    let d: Dirs;
    beforeEach(() => { d = makeDirs(); });
    afterEach(() => { d.cleanup(); });

    it('DB の控えが取れなければ、マイグレーションを当てずに起動を止める', async () => {
      // いまの版の DB を置き、控えの置き場（backups/db）を通常のファイルにして作れなくする。
      // 当てるものがあるように、仮の次の版を足して起こす。
      const file = path.join(d.home, 'hangar.db');
      seedDbAt(file, LATEST_DB_VERSION);
      fs.mkdirSync(path.join(d.home, 'backups'), { recursive: true });
      fs.writeFileSync(path.join(d.home, 'backups', 'db'), 'x');
      await withPendingMigration(() => expect(start(d)).rejects.toBeInstanceOf(DbBackupError));
      expect(dbVersionOf(file)).toBe(LATEST_DB_VERSION);
    });

    /** 置き場の中の全ファイルの中身。起動を断ったときに、何も書き換えていないことを見る。 */
    const snapshot = (dir: string): Record<string, string> => Object.fromEntries(
      fs.readdirSync(dir, { recursive: true, withFileTypes: true })
        .filter((e) => e.isFile())
        .map((e) => { const p = path.join(e.parentPath, e.name); return [path.relative(dir, p), fs.readFileSync(p).toString('base64')]; }),
    );
    /** 起動のときに読み替えが入る設定（古い鍵と知らない言語）。読み替えて書き戻せば中身が変わる。 */
    const rewrittenSettings = (d: Dirs): string => JSON.stringify({ workspaceRoot: d.ws, claudeDir: d.claudeDir, syncClaudeConfig: true, language: 'xx' });

    it('起点より古い DB で起動を断るときは、置き場のファイルを 1 つも書き換えない', async () => {
      // 前の版のアプリへ戻す利用者が、読み替え済みの設定や作り直した置き場の物を掴まされないようにする。
      ensureHome(d.home);
      fs.writeFileSync(path.join(d.home, 'token'), 'old-token');
      readOrCreateDevice(d.home);
      fs.writeFileSync(path.join(d.home, 'settings.json'), rewrittenSettings(d));
      seedDbAt(path.join(d.home, 'hangar.db'), BASELINE_DB_VERSION - 1);
      const before = snapshot(d.home);
      await expect(start(d)).rejects.toBeInstanceOf(DbTooOldError);
      expect(snapshot(d.home)).toEqual(before);
    });

    it('ポートが塞がっていて起動を断るときは、設定のファイルを書き換えない', async () => {
      const busy = net.createServer();
      await new Promise<void>((r) => busy.listen(0, '127.0.0.1', r));
      try {
        const port = (busy.address() as net.AddressInfo).port;
        const settings = path.join(d.home, 'settings.json');
        fs.writeFileSync(settings, rewrittenSettings(d));
        await expect(startServer({ port, home: d.home, claudeDir: d.claudeDir, registryIsGone: ALL_ALIVE, uiDist: path.join(d.home, 'no-dist') })).rejects.toThrow(/EADDRINUSE/);
        expect(fs.readFileSync(settings, 'utf8')).toBe(rewrittenSettings(d));
      } finally {
        await new Promise((r) => busy.close(r));
      }
    });

    it('起動が通れば、読み替えた設定を書き戻す', async () => {
      const settings = path.join(d.home, 'settings.json');
      fs.writeFileSync(settings, rewrittenSettings(d));
      const s = await start(d);
      try {
        const saved = JSON.parse(fs.readFileSync(settings, 'utf8')) as Record<string, unknown>;
        expect(saved.syncClaudeConfig).toBeUndefined();
        expect(saved.language).toBeUndefined();
        expect(saved.toolsResolved).toBe(true);
      } finally {
        await s.close();
      }
    });

    it('起動後に現れたセッションにもプロジェクトを紐づけて配信する', async () => {
      // 本文の見張り、索引、紐づけ、配る層、WebSocket が、端から端まで結ばれていることを見る。
      const dir = path.join(d.ws, 'alpha');
      fs.mkdirSync(dir);
      // 起動時にプロジェクトが登録されるよう、ワークスペース配下のセッションを 1 つ置いておく。
      writeTranscript(d.claudeDir, dir, 'bbbbbbbb-0000-4000-8000-000000000001', 'first');
      fs.writeFileSync(path.join(d.home, 'settings.json'), JSON.stringify({ workspaceRoot: d.ws, claudeDir: d.claudeDir }));
      const s = await start(d);
      const c = collector(s.port, tokenIn(d.home));
      try {
        await c.opened;
        writeTranscript(d.claudeDir, dir, 'bbbbbbbb-0000-4000-8000-000000000002', 'second');
        const ev = await c.waitFor((e): e is Extract<ServerEvent, { type: 'session.upsert' }> => e.type === 'session.upsert' && e.session.providerSessionId === 'bbbbbbbb-0000-4000-8000-000000000002');
        expect(ev.session.projectId).not.toBeNull();
        const proj = await c.waitFor((e): e is Extract<ServerEvent, { type: 'project.upsert' }> => e.type === 'project.upsert' && e.project.id === ev.session.projectId);
        expect(proj.project.name).toBe('alpha');
      } finally {
        c.close();
        await s.close();
      }
    }, 20000);

    /**
     * 本文は「クラウドを使い始めた後に動いたもの」だけを上げる。
     * 止めて起こし直しても索引が残り、後からクラウドに参加した 2 度目の起動が、続きから同期することを見る。
     */
    it('参加より前に止まっていた本文は上げず、その後に動いた本文だけを上げる', async () => {
      /** 本文が最後に動いた時刻を決める。索引する前に置くので、台帳にはこの値がそのまま入る。 */
      const setTranscriptMtime = (mtime: number, only?: string): void => {
        const at = new Date(mtime);
        const walk = (dir: string): void => {
          for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
            const f = path.join(dir, e.name);
            if (e.isDirectory()) { walk(f); continue; }
            if (!e.name.endsWith('.jsonl')) continue;
            if (only !== undefined && !f.includes(only)) continue;
            fs.utimesSync(f, at, at);
          }
        };
        walk(path.join(d.claudeDir, 'projects'));
      };
      const countOf = (table: string): number => {
        const db = openDb(dbPath(d.home));
        try { return (db.prepare(`select count(*) c from ${table}`).get() as { c: number }).c; } finally { db.close(); }
      };
      // 参加の前後を、本文が最後に動いた時刻で作り分ける。
      // alpha の 2 件は参加より前で止まっていて、other の 1 件は参加より後に動いている。
      const base = Date.now();
      setTranscriptMtime(base - 120_000);
      setTranscriptMtime(base - 60_000, SESSION_OTHER);
      // 1 度目の起動。クラウドはまだ無い。3 件の本文が索引された状態を作って止める。
      const first = await start(d);
      const firstToken = tokenIn(d.home);
      try {
        await until(async () => (countOf('transcript_files') === 3 ? true : null));
      } finally {
        await first.close();
      }
      // 後からクラウドに参加する。刻むのはサーバだが、時刻を決めたいのでここで置いておく。
      {
        const db = openDb(dbPath(d.home));
        try { new SyncStateStore(db).set('transcriptsFrom', base - 90_000); } finally { db.close(); }
      }
      const sink = await fileSink();
      joinTo(d.home, sink.url);
      // 2 度目の起動。同じ置き場で、同じ端末として続きから動く。
      const s = await start(d);
      try {
        expect(tokenIn(d.home)).toBe(firstToken);
        expect(countOf('devices')).toBe(1);
        expect(countOf('sessions')).toBe(3);
        await until(async () => (sink.puts.length >= 1 ? sink.puts : null));
        // 参加より前で止まっている 2 件（alpha の本文と subagent）は上がらない。
        await new Promise((r) => setTimeout(r, 300));
        expect(sink.puts.map((k) => k.replace(/^transcripts\/[^/]+\//, '')).sort()).toEqual([`${SESSION_OTHER}.jsonl.gz`]);
        // 画面に出す「未送信の本文」も、上がる予定の無い 2 件を数えない。
        const status = await (await fetch(`http://127.0.0.1:${s.port}/api/sync/status`, { headers: { authorization: `Bearer ${tokenIn(d.home)}` } })).json() as SyncStatusBody;
        expect(status.sweepPending).toBe(0);
      } finally {
        await s.close();
        await sink.close();
      }
    }, 20000);
  });

  /** クラウドに参加した端末を 1 度だけ起こす。宛先は手元の立て替えの Worker で、実物のクラウドには触らない。 */
  describe('クラウドに参加した端末を起動して確かめる', () => {
    let d: Dirs;
    let w: Awaited<ReturnType<typeof fakeWorker>>;
    let s: { close(): Promise<void>; port: number };
    let token: string;
    const api = (p: string, init?: RequestInit) => fetch(`http://127.0.0.1:${s.port}${p}`, { ...init, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', origin: `http://127.0.0.1:${s.port}`, ...(init?.headers ?? {}) } });
    const syncStatus = async (): Promise<SyncStatusBody> => (await (await api('/api/sync/status')).json()) as SyncStatusBody;
    beforeAll(async () => {
      d = makeDirs();
      w = await fakeWorker(answerAll(String(COMPAT_VERSION)));
      joinTo(d.home, w.url);
      s = await start(d);
      token = tokenIn(d.home);
    }, 30_000);
    afterAll(async () => {
      await s.close();
      await w.close();
      d.cleanup();
    });

    it('Worker が版を名乗れば同期は動き、要求にはこの PC の版を載せる', async () => {
      const st = await until(async () => { const v = await syncStatus(); return v.lastPullAt !== null ? v : null; });
      expect(st.error).toBeNull();
      expect(st.state).not.toBe('error');
      expect(w.seen.length).toBeGreaterThan(0);
      for (const r of w.seen) expect(r.compat, `${r.method} ${r.path}`).toBe(String(COMPAT_VERSION));
      // 索引が書いた行を送り、相手の変更と本文の一覧を取りに行っている。メタデータと本文の両方の道が 1 巡する。
      expect(w.seen.some((r) => r.method === 'POST' && r.path === '/changes')).toBe(true);
      expect(w.seen.some((r) => r.method === 'GET' && r.path === '/files')).toBe(true);
    });

    it('今すぐ同期を押せば、メタデータの送受信が済んだ時点の状態を返す', async () => {
      const before = w.seen.length;
      const r = await api('/api/sync/now', { method: 'POST' });
      expect(r.status).toBe(200);
      expect(((await r.json()) as SyncStatusBody).state).not.toBe('error');
      expect(w.seen.slice(before).some((x) => x.path === '/changes' || x.path === '/rows')).toBe(true);
    });

    it('websocket の sync.status が付録を運ぶ', async () => {
      // 付録を運ぶのが HTTP だけだと、サーバの取り残しが 0 になっても画面は前の値のまま固まる。
      const c = collector(s.port, token);
      try {
        await c.opened;
        const mark = c.all().length;
        // 同期し終えた直後の focus は間を空けるので、状態を配らせるには今すぐ同期を押す。
        expect((await api('/api/sync/now', { method: 'POST' })).status).toBe(200);
        const ev = await until(async () => c.all().slice(mark).find((e): e is Extract<ServerEvent, { type: 'sync.status' }> => e.type === 'sync.status') ?? null);
        expect(ev.status.sweepPending).toBe((await syncStatus()).sweepPending);
        expect(ev.status.skipped).toEqual([]);
        expect(ev.status.oncePass).toBe(false);
      } finally {
        c.close();
      }
    });

    it('参加トークンを作れる', async () => {
      // 参加トークンは中身を見ない。秘密が差分やログに出ないようにする。
      const jt = await (await api('/api/sync/joinToken')).json() as { token: string | null };
      expect(typeof jt.token).toBe('string');
      expect((jt.token ?? '').length).toBeGreaterThan(0);
    });
  });
});

/**
 * 起動の手続きと止める手続きの配線。
 * 組み立て関数の試験は部品を 1 つずつ起こすので、startServer が呼び忘れた手続きは拾えない。ここで全体を起こして見る。
 */
describe('起動と停止の手続きの配線', () => {
  let d: Dirs;
  beforeEach(() => { d = makeDirs(); });
  afterEach(() => { d.cleanup(); });

  it('起動の手続きが済むまでは準備完了を名乗らない。未分類のセッションは、起動の途中も済んだ後も知らせず、一覧にそのまま出す', async () => {
    // 索引は 20 件ごとにイベントループへ譲る。起動の途中を外から見られるよう、どのルートにも属さない本文を多めに置く。
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'hangar-outside-'));
    for (let i = 0; i < 200; i++) writeTranscript(d.claudeDir, outside, `cccccccc-0000-4000-8000-${i.toString().padStart(12, '0')}`, 'stray');
    fs.writeFileSync(path.join(d.home, 'settings.json'), JSON.stringify({ workspaceRoot: d.ws, claudeDir: d.claudeDir }));
    // 起動の途中に叩けるよう、空いているポートを先に決めておく。
    const port = await new Promise<number>((resolve) => { const srv = net.createServer(); srv.listen(0, '127.0.0.1', () => { const p = (srv.address() as net.AddressInfo).port; srv.close(() => resolve(p)); }); });
    const ready: boolean[] = [];
    let c: ReturnType<typeof collector> | null = null;
    let done = false;
    const startup = startServer({ port, home: d.home, claudeDir: d.claudeDir, registryIsGone: ALL_ALIVE, uiDist: path.join(d.home, 'no-dist') });
    const watching = (async () => {
      while (!done) {
        try {
          const r = await fetch(`http://127.0.0.1:${port}/health`);
          if (r.status === 200) {
            ready.push(((await r.json()) as { ready: boolean }).ready);
            // 待ち受けが始まったら、起動の途中から知らせを受ける。
            c ??= collector(port, tokenIn(d.home));
          }
        } catch { /* まだ待ち受けていない。 */ }
        await new Promise((r) => setImmediate(r));
      }
    })();
    const s = await startup;
    try {
      // 解決した時点で、もう準備完了を名乗っている。
      const after = (await (await fetch(`http://127.0.0.1:${port}/health`)).json()) as { ready: boolean };
      done = true;
      await watching;
      expect(after.ready).toBe(true);
      // 起動の途中は /health が返っても、準備完了は名乗らない。
      expect(ready[0]).toBe(false);
      expect(c).not.toBeNull();
      const col = c as unknown as ReturnType<typeof collector>;
      await col.opened;
      const strayToasts = () => col.all().filter((e) => e.type === 'toast' && e.message.includes(outside)).length;
      // 済んだ後に現れた未分類も、知らせは流さない（toast は操作の結果だけ。一覧にそのまま出る）。
      const before = col.all().filter((e) => e.type === 'transcript.appended').length;
      writeTranscript(d.claudeDir, outside, 'cccccccc-0000-4000-8000-999999999999', 'late');
      for (let i = 0; i < 100 && col.all().filter((e) => e.type === 'transcript.appended').length === before; i++) await new Promise((r) => setTimeout(r, 100));
      expect(col.all().filter((e) => e.type === 'transcript.appended').length).toBeGreaterThan(before);
      await new Promise((r) => setTimeout(r, 300));
      expect(strayToasts()).toBe(0);
    } finally {
      done = true;
      (c as ReturnType<typeof collector> | null)?.close();
      await s.close();
      fs.rmSync(outside, { recursive: true, force: true });
    }
  }, 30_000);

  it('閉じた後にメモのファイルが書かれても、DB のメモは変わらない', async () => {
    const dir = path.join(d.ws, 'alpha');
    fs.mkdirSync(dir);
    writeTranscript(d.claudeDir, dir, 'bbbbbbbb-0000-4000-8000-000000000031', 'first');
    fs.writeFileSync(path.join(d.home, 'settings.json'), JSON.stringify({ workspaceRoot: d.ws, claudeDir: d.claudeDir }));
    const memoOf = (projectId: string): string | undefined => {
      const db = openDb(dbPath(d.home));
      try { return (db.prepare('select markdown m from project_memos where project_id = ?').get(projectId) as { m: string } | undefined)?.m; } finally { db.close(); }
    };
    // 止め忘れた監視は、取り込みの失敗を黙って飲むので、DB を見るだけでは分からない。開いたままのファイルの監視の数でも見る。
    const fileWatches = (): number => process.getActiveResourcesInfo().filter((n) => /fsevent|fswatch/i.test(n)).length;
    // 前の試験が閉じた監視は、少し遅れて数から消える。数が落ち着いてから数える。
    const settled = async (): Promise<number> => {
      for (let last = fileWatches(), same = 0; ; ) {
        await new Promise((r) => setTimeout(r, 50));
        const now = fileWatches();
        same = now === last ? same + 1 : 0;
        last = now;
        if (same >= 6) return now;
      }
    };
    const watchesBefore = await settled();
    const s = await start(d);
    expect(fileWatches()).toBeGreaterThan(watchesBefore);
    let projectId = '';
    let file = '';
    try {
      const headers = { authorization: `Bearer ${tokenIn(d.home)}`, 'content-type': 'application/json', origin: `http://127.0.0.1:${s.port}` };
      const projects = (await (await fetch(`http://127.0.0.1:${s.port}/api/projects`, { headers })).json()) as { id: string; name: string }[];
      projectId = projects.find((p) => p.name === 'alpha')!.id;
      const put = await fetch(`http://127.0.0.1:${s.port}/api/projects/${projectId}/memo`, { method: 'PUT', headers, body: JSON.stringify({ markdown: 'one' }) });
      expect(put.status).toBe(200);
      file = path.join(d.home, 'projects', projectId, 'memo.md');
      expect(fs.readFileSync(file, 'utf8')).toBe('one');
      // 動いている間は、ファイルの外部編集を監視で取り込む。この確かめ方で取り込みが見えることを、先に固定しておく。
      await new Promise((r) => setTimeout(r, 50));
      fs.writeFileSync(file, 'two');
      await until(async () => (memoOf(projectId) === 'two' ? true : null));
    } finally {
      await s.close();
    }
    // 閉じた後の書き込み。監視が残っていると、閉じた DB へ取り込みに行く。
    await new Promise((r) => setTimeout(r, 50));
    fs.writeFileSync(file, 'three');
    await new Promise((r) => setTimeout(r, 800));
    expect(memoOf(projectId)).toBe('two');
    // メモの監視も、索引と設定の監視も、1 つも残っていない。
    expect(await settled()).toBe(watchesBefore);
  }, 20_000);

  /**
   * tmux は偽のコマンドにする。呼ばれた引数を記録し、list-sessions には隣のファイルの名前を返すだけで、本物の tmux には触らない。
   * 偽のコマンドは sh で書くので、Windows では飛ばす。
   */
  posixDescribe('偽の tmux で起動して確かめる', () => {
    const RUN_LOST = 'dead0001';
    const RUN_ENDS = 'b0b00001';
    const RUN_STAYS = 'a11ce001';
    const fakeTmux = (name: string, sessions: string[]) => {
      const dir = path.join(d.home, name);
      const bin = writeFakeTool(dir, 'tmux', {
        sh: `echo "$*" >> "${dir}/calls.log"\ncase "$1" in list-sessions) cat "${dir}/sessions.txt" ;; show-options) exit 1 ;; esac\nexit 0`,
        cmd: '',
      });
      const setSessions = (list: string[]): void => { fs.writeFileSync(path.join(dir, 'sessions.txt'), list.map((n) => `${n}\n`).join('')); };
      setSessions(sessions);
      return { bin, setSessions, calls: (): string[] => (fs.existsSync(path.join(dir, 'calls.log')) ? fs.readFileSync(path.join(dir, 'calls.log'), 'utf8').split('\n').filter(Boolean) : []) };
    };
    /** 前回の起動が残した run の行を置く。どれも終わりを書かれていない。 */
    const seedRuns = (ids: string[]): void => {
      ensureHome(d.home);
      const device = readOrCreateDevice(d.home);
      const db = openDb(dbPath(d.home));
      try {
        const sessionId = ensureSession(db, 'dddddddd-0000-4000-8000-000000000001', d.ws, device.id);
        for (const id of ids) upsertShared(db, 'runs', { id, session_id: sessionId, device_id: device.id, kind: 'start', tmux_name: `hangar-${id}`, pid: null, launch_params: '{}', started_at: 1, ended_at: null, end_reason: null, heartbeat_at: 1 }, device.id);
      } finally { db.close(); }
    };
    const endReasonOf = (id: string): string | null => {
      const db = openDb(dbPath(d.home));
      try { return (db.prepare('select end_reason r from runs where id = ?').get(id) as { r: string | null }).r; } finally { db.close(); }
    };
    /** 端末の中継へ繋ぎ、相手が閉じるまで待つ。偽の tmux はすぐ終わるので、中継も閉じる。 */
    const attachOnce = (port: number, tab: string): Promise<void> => new Promise<void>((resolve, reject) => {
      const sock = new WebSocket(`ws://127.0.0.1:${port}/ws/pty?tab=${tab}`, { headers: { authorization: `Bearer ${tokenIn(d.home)}` } });
      sock.once('close', () => resolve());
      sock.once('error', reject);
    });

    it('起動で、tmux に残っていない run を lost で閉じ、その後も run の終了を見張る', async () => {
      const tmux = fakeTmux('tmux-a', [`hangar-${RUN_ENDS}`, `hangar-${RUN_STAYS}`]);
      seedRuns([RUN_LOST, RUN_ENDS, RUN_STAYS]);
      fs.writeFileSync(path.join(d.home, 'settings.json'), JSON.stringify({ tmuxPath: tmux.bin }));
      const s = await start(d);
      try {
        // 起動の手続きの中で済んでいる。待たずに見る。
        expect(endReasonOf(RUN_LOST)).toBe('lost');
        expect(endReasonOf(RUN_ENDS)).toBeNull();
        expect(endReasonOf(RUN_STAYS)).toBeNull();
        const alive = async (): Promise<string[]> => ((await (await fetch(`http://127.0.0.1:${s.port}/api/runs`, { headers: { authorization: `Bearer ${tokenIn(d.home)}` } })).json()) as { runs: { id: string }[] }).runs.map((r) => r.id).sort();
        expect(await alive()).toEqual([RUN_STAYS, RUN_ENDS].sort());
        // tmux から 1 つ消える。見張りが動いていれば、次の周期で終わりを拾う。
        tmux.setSessions([`hangar-${RUN_STAYS}`]);
        await until(async () => (endReasonOf(RUN_ENDS) !== null ? true : null));
        expect(await alive()).toEqual([RUN_STAYS]);
        expect(endReasonOf(RUN_STAYS)).toBeNull();
      } finally {
        await s.close();
      }
    }, 20_000);

    it('設定で tmux のパスを替えると、run の見張りも端末の中継も新しいパスを使う', async () => {
      const a = fakeTmux('tmux-a', [`hangar-${RUN_STAYS}`]);
      const b = fakeTmux('tmux-b', [`hangar-${RUN_STAYS}`]);
      seedRuns([RUN_STAYS]);
      fs.writeFileSync(path.join(d.home, 'settings.json'), JSON.stringify({ tmuxPath: a.bin }));
      const s = await start(d);
      const attaches = (calls: string[]): string[] => calls.filter((x) => x.startsWith('attach'));
      const lists = (calls: string[]): number => calls.filter((x) => x.startsWith('list-sessions')).length;
      try {
        // 替える前は、中継は前のパスの tmux で繋ぐ。
        await attachOnce(s.port, RUN_STAYS);
        expect(attaches(a.calls())).toEqual([`attach -t =hangar-${RUN_STAYS}`]);
        expect(b.calls()).toEqual([]);
        const r = await fetch(`http://127.0.0.1:${s.port}/api/settings`, {
          method: 'PATCH', headers: { authorization: `Bearer ${tokenIn(d.home)}`, 'content-type': 'application/json', origin: `http://127.0.0.1:${s.port}` }, body: JSON.stringify({ tmuxPath: b.bin }),
        });
        expect(r.status).toBe(200);
        // 新しい attach は新しいパスを使う。前のパスへは、もう繋ぎに行かない。
        await attachOnce(s.port, RUN_STAYS);
        expect(attaches(b.calls())).toEqual([`attach -t =hangar-${RUN_STAYS}`]);
        expect(attaches(a.calls()).length).toBe(1);
        // run の見張りも、次の周期から新しいパスで一覧を取る。前のパスの一覧は、もう増えない。
        await until(async () => (lists(b.calls()) > 0 ? true : null));
        const settled = lists(a.calls());
        await new Promise((res) => setTimeout(res, 2_500));
        expect(lists(a.calls())).toBe(settled);
        // 包みの本体にも、新しいパスが入る。
        expect(fs.readFileSync(path.join(d.home, 'shell', 'claude.zsh'), 'utf8')).toContain(b.bin);
      } finally {
        await s.close();
      }
    }, 30_000);
  });
});

describe('終了の時間の予算', () => {
  /** .app の猶予は Rust の現物から読む。写しを持つと、片方だけ直されて必ず食い違う。 */
  const rust = fs.readFileSync(new URL('../../../apps/desktop/src-tauri/src/server.rs', import.meta.url), 'utf8');
  const secs = (re: RegExp): number => {
    const m = re.exec(rust);
    expect(m).not.toBeNull();
    return Number(m![1]);
  };

  it('close の締め切り < サーバの番犬 < .app の猶予、の順になっている', () => {
    const graceMs = secs(/pub const STOP_GRACE: Duration = Duration::from_secs\((\d+)\)/) * 1000;
    const rustWatchdogMs = secs(/pub const SERVER_WATCHDOG_SECS: u64 = (\d+);/) * 1000;
    // 番犬が close() を切ると、db.close() まで届かない（WAL が残る）。
    expect(CLOSE_DEADLINE_MS).toBeLessThan(STOP_WATCHDOG_MS);
    // .app が番犬より先に殺すと、サーバは自分で降りられない。
    expect(STOP_WATCHDOG_MS).toBeLessThan(graceMs);
    // Rust が持つ写しは、正本と同じ値でなければならない。
    expect(rustWatchdogMs).toBe(STOP_WATCHDOG_MS);
    // ⌘Q から消えるまでが長くならない値に収める。普段はそもそも待ちが出ない。
    expect(CLOSE_DEADLINE_MS).toBeLessThanOrEqual(5_000);
  });
});

describe('終了の受け口', () => {
  const host = () => {
    const handlers = new Map<string, () => void>();
    const exits: number[] = [];
    return {
      handlers, exits,
      opts: {
        on: (sig: 'SIGINT' | 'SIGTERM', h: () => void) => { handlers.set(sig, h); },
        exit: (c: number) => { exits.push(c); },
        // 番犬は測らない回では張らない。実時間に寄りかからないようにする。
        setTimeout: ((): NodeJS.Timeout => ({ unref: () => undefined }) as unknown as NodeJS.Timeout) as unknown as typeof setTimeout,
      },
    };
  };

  it('起動が終わる前に SIGTERM が来ても close() が走る', async () => {
    // /health は startServer の解決より早く 200 を返し、.app はそれを準備完了の合図にしている。
    // 解決を待ってから受け口を立てると、その窓で届いた信号が close() を 1 行も走らせずにプロセスを殺す。
    const h = host();
    let closed = 0;
    let ready: (s: { close(): Promise<void> }) => void = () => {};
    const startup = new Promise<{ close(): Promise<void> }>((r) => { ready = r; });
    installShutdown(startup, h.opts);
    // 受け口は startServer を待たずに立っている。
    expect([...h.handlers.keys()].sort()).toEqual(['SIGINT', 'SIGTERM']);

    h.handlers.get('SIGTERM')!();
    expect(closed).toBe(0);
    expect(h.exits).toEqual([]);

    // 起動が終わったところで初めて閉じられる。
    ready({ close: async () => { closed++; } });
    await new Promise((r) => setTimeout(r, 10));
    expect(closed).toBe(1);
    expect(h.exits).toEqual([0]);
  });

  // .app が起動から数秒で終わる件を切り分けるため、何で止まったかを desktop.log に残す。
  it('止まった理由を 1 行残す', async () => {
    const lines: string[] = [];
    const h = host();
    const stop = installShutdown(Promise.resolve({ close: async () => {} }), { ...h.opts, log: (l) => lines.push(l) });
    h.handlers.get('SIGTERM')!();
    stop('parent gone');
    await new Promise((r) => setTimeout(r, 10));
    expect(lines).toEqual(['[shutdown] SIGTERM']);
  });

  it('信号が重なっても close() は 1 度だけ走る', async () => {
    const h = host();
    let closed = 0;
    installShutdown(Promise.resolve({ close: async () => { closed++; } }), h.opts);
    h.handlers.get('SIGTERM')!();
    h.handlers.get('SIGINT')!();
    h.handlers.get('SIGTERM')!();
    await new Promise((r) => setTimeout(r, 10));
    expect(closed).toBe(1);
    expect(h.exits).toEqual([0]);
  });

  it('起動そのものが転んでも降りる', async () => {
    const h = host();
    installShutdown(Promise.reject(new Error('listen EADDRINUSE')), h.opts);
    h.handlers.get('SIGTERM')!();
    await new Promise((r) => setTimeout(r, 10));
    expect(h.exits).toEqual([0]);
  });

  it('後始末が終わらなくても番犬が降ろす', async () => {
    const handlers = new Map<string, () => void>();
    const exits: number[] = [];
    installShutdown(Promise.resolve({ close: () => new Promise<void>(() => {}) }), {
      on: (sig, hh) => { handlers.set(sig, hh); },
      exit: (c) => { exits.push(c); },
      watchdogMs: 20,
    });
    handlers.get('SIGTERM')!();
    await new Promise((r) => setTimeout(r, 80));
    expect(exits).toEqual([0]);
  });
});
