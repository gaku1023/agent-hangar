import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import type { ServerEvent, SessionDto } from '@agent-hangar/shared';
import type { LiveSessionDto } from '@agent-hangar/shared';
import { saveCloudConfig } from './config/cloud.ts';
import { openDb } from './db/open.ts';
import { upsertShared } from './db/shared.ts';
import { IndexerService } from './indexer/service.ts';
import { checkProjectRoots } from './projects/registry.ts';
import { mangleCwd } from './provider/claude-code/discover.ts';
import { SummaryJob } from './summary/job.ts';
import type { Summarizer } from './summary/types.ts';
import { copyFixtureClaudeDir, SESSION_ALPHA } from '../test/fixtures.ts';
import { checkRoots, CLOSE_SUMMARY_WAIT_MS, CLOSE_UPLOAD_WAIT_MS, RUN_ENDED_SUMMARY_OPTS, startServer, stopUploader, waitForSummaryIdle, WS_PATHS } from './server.ts';

let home: string;
let claudeDir: string;
let ws: string;
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'hangar-home-'));
  claudeDir = copyFixtureClaudeDir();
  ws = fs.mkdtempSync(path.join(os.tmpdir(), 'hangar-ws-'));
});
afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(claudeDir, { recursive: true, force: true });
  fs.rmSync(ws, { recursive: true, force: true });
});

const tokenOf = () => fs.readFileSync(path.join(home, 'token'), 'utf8').trim();

/** 実際の Claude Code と同じ配置で、発言 1 つだけの本文ファイルを置く。 */
function writeTranscript(cwd: string, sessionId: string, text: string, uuid = 'u1'): void {
  const dir = path.join(claudeDir, 'projects', mangleCwd(cwd));
  fs.mkdirSync(dir, { recursive: true });
  const rec = { type: 'user', message: { role: 'user', content: text }, uuid, parentUuid: null, isSidechain: false, timestamp: '2026-09-01T10:00:00.000Z', cwd, sessionId };
  const file = path.join(dir, `${sessionId}.jsonl`);
  if (uuid === 'u1') fs.writeFileSync(file, JSON.stringify(rec) + '\n');
  else fs.appendFileSync(file, JSON.stringify(rec) + '\n');
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
  it('番人は attach している経路をすべて許す', () => {
    // 番人の集合から経路が抜けると、101 を返した直後の接続を番人が切ってしまう。
    // その状態は upgrade が失敗する経路からは観測できないので、ここで集合そのものを見る。
    expect([...WS_PATHS].sort()).toEqual(['/ws', '/ws/pty']);
  });

  it('WebSocket と keep-alive の接続が残っていても close は 2 秒以内に終わる', async () => {
    const s = await startServer({ port: 0, home, claudeDir, uiDist: path.join(home, 'no-dist') });
    expect(s.port).toBeGreaterThan(0);
    const token = fs.readFileSync(path.join(home, 'token'), 'utf8').trim();
    const ws = new WebSocket(`ws://127.0.0.1:${s.port}/ws`, { headers: { authorization: `Bearer ${token}` } });
    const ready = await new Promise<string>((resolve, reject) => { ws.once('message', (d) => resolve(String(d))); ws.once('error', reject); });
    expect(JSON.parse(ready).type).toBe('ready');
    // close フレームに応えない相手。ブラウザのタブが止まっているときや代理を挟むときに起こる。
    const stalled = net.connect(s.port, '127.0.0.1');
    await new Promise<void>((r) => stalled.once('connect', r));
    stalled.write(`GET /ws HTTP/1.1\r\nHost: 127.0.0.1\r\nAuthorization: Bearer ${token}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n`);
    const upgraded = await new Promise<string>((r) => stalled.once('data', (d) => r(String(d))));
    expect(upgraded.startsWith('HTTP/1.1 101')).toBe(true);
    // fetch は keep-alive で接続を残す。
    const health = await fetch(`http://127.0.0.1:${s.port}/health`);
    expect(health.status).toBe(200);
    await health.text();
    const result = await Promise.race([
      s.close().then(() => 'closed'),
      new Promise<string>((r) => setTimeout(() => r('timeout'), 2000)),
    ]);
    expect(result).toBe('closed');
    ws.terminate();
    stalled.destroy();
  });

  it('cloud.json が無ければ同期は off で、経路は動く', async () => {
    // 参加していない端末でも、同期の経路は 404 にならずに「off」を返す。
    // 実物のクラウドには一切触らない（cloud.json が無いので client は作られない）。
    const s = await startServer({ port: 0, home, claudeDir, uiDist: path.join(home, 'no-dist') });
    try {
      const token = tokenOf();
      const api = (p: string, init?: RequestInit) => fetch(`http://127.0.0.1:${s.port}${p}`, { ...init, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...(init?.headers ?? {}) } });
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
      expect(b.devices.some((d) => d.self)).toBe(true);
      expect(b.sync.state).toBe('off');
      const devices = await (await api('/api/devices')).json() as { self: boolean }[];
      expect(devices.some((d) => d.self)).toBe(true);
    } finally {
      await s.close();
    }
  });

  it('cloud.json があれば部品が組み上がり、繋がらなくても起動は終わる', async () => {
    // 宛先は誰も待ち受けていないループバックである。実物のクラウドには触らない。
    // ここで見たいのは、cloud.json から client と鍵と上げ下ろしの部品が組み上がり、
    // 状態が off ではなくなり、参加トークンが作れることである。
    saveCloudConfig(home, { url: 'http://127.0.0.1:9', joinSecret: 'test-secret', deviceToken: 'test-device-token', workerName: null, accountId: null, dbName: null, bucketName: null, joinedAt: 1 });
    const s = await startServer({ port: 0, home, claudeDir, uiDist: path.join(home, 'no-dist') });
    try {
      const token = tokenOf();
      const api = (p: string) => fetch(`http://127.0.0.1:${s.port}${p}`, { headers: { authorization: `Bearer ${token}` } });
      const status = await (await api('/api/sync/status')).json() as { state: string; url: string | null };
      // 繋がらないので idle にはならないが、off でもない（off は「参加していない」の意味である）。
      expect(status.state).not.toBe('off');
      expect(status.url).toBe('http://127.0.0.1:9');
      // 参加トークンは中身を見ない。秘密が差分やログに出ないようにする。
      const jt = await (await api('/api/sync/joinToken')).json() as { token: string | null };
      expect(typeof jt.token).toBe('string');
      expect((jt.token ?? '').length).toBeGreaterThan(0);
      // 設定の同期の部品も組み上がっている（未確認なので confirmed は false）。
      const preview = await (await api('/api/sync/config/preview')).json() as { entries: unknown[]; confirmed: boolean };
      expect(preview.confirmed).toBe(false);
      expect(Array.isArray(preview.entries)).toBe(true);
    } finally {
      await s.close();
    }
  });

  it('この PC で再開は、本文が無ければ 400 で理由を返す', async () => {
    // 経路が copyTranscriptForResume まで繋がっていることを、~/.claude を書き換えない側から確かめる。
    const s = await startServer({ port: 0, home, claudeDir, uiDist: path.join(home, 'no-dist') });
    try {
      const r = await fetch(`http://127.0.0.1:${s.port}/api/sessions/nope/resume-here`, {
        method: 'POST', headers: { authorization: `Bearer ${tokenOf()}`, 'content-type': 'application/json' }, body: JSON.stringify({ overwrite: false }),
      });
      expect(r.status).toBe(400);
      expect(await r.json()).toEqual({ error: 'このセッションの本文がありません' });
    } finally {
      await s.close();
    }
  });

  it('起動でヘッダのファイルを用意する。~/.agent-hangar を消しても使用量が静かに止まらない', async () => {
    // statusline はヘッダのファイルが読めなければ何も送らない。
    // 置き場ごと消した利用者のために、トークンと同じところで起動のたびに用意する。
    const header = path.join(home, 'statusline-header');
    expect(fs.existsSync(header)).toBe(false);
    const s = await startServer({ port: 0, home, claudeDir, uiDist: path.join(home, 'no-dist') });
    try {
      expect(fs.readFileSync(header, 'utf8')).toBe(`Authorization: Bearer ${tokenOf()}\n`);
      expect(fs.statSync(header).mode & 0o777).toBe(0o600);
    } finally {
      await s.close();
    }
  });

  it('トークンを作り直すと、ヘッダのファイルも次の起動で揃う', async () => {
    const header = path.join(home, 'statusline-header');
    const first = await startServer({ port: 0, home, claudeDir, uiDist: path.join(home, 'no-dist') });
    await first.close();
    const old = tokenOf();
    fs.rmSync(path.join(home, 'token'));
    const second = await startServer({ port: 0, home, claudeDir, uiDist: path.join(home, 'no-dist') });
    try {
      expect(tokenOf()).not.toBe(old);
      expect(fs.readFileSync(header, 'utf8')).toBe(`Authorization: Bearer ${tokenOf()}\n`);
    } finally {
      await second.close();
    }
  });

  it('/ws はクエリ文字列のトークンを受け付けない', async () => {
    // URL は Referer、代理のログ、シェルの履歴、ブラウザの履歴に残る。秘密をそこに置く経路を残さない。
    const s = await startServer({ port: 0, home, claudeDir, uiDist: path.join(home, 'no-dist') });
    const open = (url: string, headers: Record<string, string> = {}) => new Promise<WebSocket>((resolve, reject) => {
      const sock = new WebSocket(url, { headers });
      sock.once('open', () => resolve(sock));
      sock.once('error', reject);
    });
    try {
      await expect(open(`ws://127.0.0.1:${s.port}/ws?token=${tokenOf()}`)).rejects.toThrow(/401/);
      const viaHeader = await open(`ws://127.0.0.1:${s.port}/ws`, { authorization: `Bearer ${tokenOf()}` });
      viaHeader.terminate();
      const viaCookie = await open(`ws://127.0.0.1:${s.port}/ws`, { cookie: `hangar_token=${tokenOf()}` });
      viaCookie.terminate();
    } finally {
      await s.close();
    }
  });

  it('claudeDir を渡すと settings ではなくそれを読む', async () => {
    const s = await startServer({ port: 0, home, claudeDir, uiDist: path.join(home, 'no-dist') });
    try {
      const token = tokenOf();
      const r = await fetch(`http://127.0.0.1:${s.port}/api/sessions`, { headers: { authorization: `Bearer ${token}` } });
      expect(r.status).toBe(200);
      expect(((await r.json()) as unknown[]).length).toBe(3);
    } finally {
      await s.close();
    }
  });

  it('/ws 以外への upgrade 要求は握らずに切る', async () => {
    const s = await startServer({ port: 0, home, claudeDir, uiDist: path.join(home, 'no-dist') });
    try {
      const sock = net.connect(s.port, '127.0.0.1');
      await new Promise<void>((r) => sock.once('connect', r));
      sock.write('GET /nope HTTP/1.1\r\nHost: 127.0.0.1\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n');
      const closed = await Promise.race([
        new Promise<string>((r) => sock.once('close', () => r('closed'))),
        new Promise<string>((r) => setTimeout(() => r('hanging'), 2000)),
      ]);
      expect(closed).toBe('closed');
      sock.destroy();
    } finally {
      await s.close();
    }
  }, 20000);

  it('/ws/pty は PtyRelay が引き取り、無いタブには 404 を返す', async () => {
    // 番人に切られると応答が無いまま終わる。404 が返るのは relay が attach されている証拠である。
    const s = await startServer({ port: 0, home, claudeDir, uiDist: path.join(home, 'no-dist') });
    try {
      const sock = net.connect(s.port, '127.0.0.1');
      await new Promise<void>((r) => sock.once('connect', r));
      sock.write(`GET /ws/pty?tab=nope HTTP/1.1\r\nHost: 127.0.0.1\r\nAuthorization: Bearer ${tokenOf()}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n`);
      const first = await Promise.race([
        new Promise<string>((r) => sock.once('data', (d) => r(String(d)))),
        new Promise<string>((r) => setTimeout(() => r('応答なしで切られた'), 2000)),
      ]);
      expect(first.split('\r\n')[0]).toBe('HTTP/1.1 404 Not Found');
      sock.destroy();
    } finally {
      await s.close();
    }
  }, 20000);

  it('run の経路が載り、hangar の外で実行中のセッションの再開は 409 になる', async () => {
    const s = await startServer({ port: 0, home, claudeDir, uiDist: path.join(home, 'no-dist') });
    const token = tokenOf();
    const api = (p: string, init?: RequestInit) => fetch(`http://127.0.0.1:${s.port}${p}`, { ...init, headers: { authorization: `Bearer ${token}` } });
    try {
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
    } finally {
      await s.close();
    }
  }, 20000);

  it('起動後に現れたセッションにもプロジェクトを紐づけて配信する', async () => {
    const dir = path.join(ws, 'alpha');
    fs.mkdirSync(dir);
    // 起動時にプロジェクトが登録されるよう、ワークスペース配下のセッションを 1 つ置いておく。
    writeTranscript(dir, 'bbbbbbbb-0000-4000-8000-000000000001', 'first');
    fs.writeFileSync(path.join(home, 'settings.json'), JSON.stringify({ workspaceRoot: ws, claudeDir }));
    const s = await startServer({ port: 0, home, claudeDir, uiDist: path.join(home, 'no-dist') });
    const c = collector(s.port, tokenOf());
    try {
      await c.opened;
      writeTranscript(dir, 'bbbbbbbb-0000-4000-8000-000000000002', 'second');
      const ev = await c.waitFor((e): e is Extract<ServerEvent, { type: 'session.upsert' }> => e.type === 'session.upsert' && e.session.providerSessionId === 'bbbbbbbb-0000-4000-8000-000000000002');
      expect(ev.session.projectId).not.toBeNull();
      const proj = await c.waitFor((e): e is Extract<ServerEvent, { type: 'project.upsert' }> => e.type === 'project.upsert' && e.project.id === ev.session.projectId);
      expect(proj.project.name).toBe('alpha');
    } finally {
      c.close();
      await s.close();
    }
  }, 20000);

  it('どのルートにも属さないセッションが現れたら、黙って未割り当てにせず知らせる', async () => {
    const dir = path.join(ws, 'alpha');
    fs.mkdirSync(dir);
    writeTranscript(dir, 'bbbbbbbb-0000-4000-8000-000000000011', 'first');
    fs.writeFileSync(path.join(home, 'settings.json'), JSON.stringify({ workspaceRoot: ws, claudeDir }));
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'hangar-outside-'));
    const s = await startServer({ port: 0, home, claudeDir, uiDist: path.join(home, 'no-dist') });
    const c = collector(s.port, tokenOf());
    const toastCount = () => c.all().filter((e) => e.type === 'toast' && e.message.includes(outside)).length;
    try {
      await c.opened;
      // ワークスペースの外の cwd。どのルートにも当たらない。
      writeTranscript(outside, 'bbbbbbbb-0000-4000-8000-000000000012', 'stray');
      const ev = await c.waitFor((e): e is Extract<ServerEvent, { type: 'session.upsert' }> => e.type === 'session.upsert' && e.session.providerSessionId === 'bbbbbbbb-0000-4000-8000-000000000012');
      // 勝手にプロジェクトを作らない。設計どおり「未分類」に残す。
      expect(ev.session.projectId).toBeNull();
      const toast = await c.waitFor((e): e is Extract<ServerEvent, { type: 'toast' }> => e.type === 'toast' && e.message.includes(outside));
      expect(toast.level).toBe('info');
      // 同じセッションが伸びても、知らせるのは 1 度だけにする。
      writeTranscript(outside, 'bbbbbbbb-0000-4000-8000-000000000012', 'more', 'u2');
      await c.waitFor((e): e is Extract<ServerEvent, { type: 'transcript.appended' }> => e.type === 'transcript.appended' && e.sessionId === ev.session.id);
      await new Promise((r) => setTimeout(r, 500));
      expect(toastCount()).toBe(1);
    } finally {
      c.close();
      await s.close();
      fs.rmSync(outside, { recursive: true, force: true });
    }
  }, 20000);

  it('実行中の登録が消えたら要約の状態を done に書き替える', async () => {
    const s = await startServer({ port: 0, home, claudeDir, uiDist: path.join(home, 'no-dist') });
    const token = tokenOf();
    const stateOf = async (): Promise<string | null> => {
      const r = await fetch(`http://127.0.0.1:${s.port}/api/sessions`, { headers: { authorization: `Bearer ${token}` } });
      const list = (await r.json()) as SessionDto[];
      return list.find((x) => x.providerSessionId === SESSION_ALPHA)?.summary?.state ?? null;
    };
    try {
      expect(await stateOf()).toBe('in_progress');
      fs.rmSync(path.join(claudeDir, 'sessions', '12345.json'));
      await until(async () => ((await stateOf()) === 'done' ? true : null));
    } finally {
      await s.close();
    }
  }, 20000);
});

describe('ルートの復帰', () => {
  /** ルートが 1 つ消えている（resolved = 0）プロジェクトと、その配下の未分類セッションを作る。 */
  function fixture(dir: string) {
    const db = openDb(':memory:');
    upsertShared(db, 'projects', { id: 'p1', name: 'alpha', status: 'active', is_scratch: 0 }, 'd');
    upsertShared(db, 'project_roots', { id: 'r1', project_id: 'p1', device_id: 'd', path: dir, resolved: 0 }, 'd');
    upsertShared(db, 'sessions', { id: 's1', provider: 'claude-code', provider_session_id: 'u1', project_id: null, cwd: path.join(dir, 'sub'), home_device: 'd' }, 'd');
    return db;
  }
  const projectIdOf = (db: ReturnType<typeof openDb>) => (db.prepare('select project_id from sessions where id = ?').get('s1') as { project_id: string | null }).project_id;

  it('存在を確かめるだけでは、戻ったルートの配下のセッションは未分類のまま残る', () => {
    // 繰り越しの再現。checkProjectRoots は resolved を 1 に戻すが、配下のセッションには触れない。
    const db = fixture(ws);
    try {
      expect(checkProjectRoots(db, 'd')).toEqual({ unresolved: [], recovered: ['p1'] });
      expect(projectIdOf(db)).toBeNull();
    } finally {
      db.close();
    }
  });

  it('ルートが戻ったら未分類のセッションを紐づけ直して配る', () => {
    const db = fixture(ws);
    const sent: ServerEvent[] = [];
    try {
      const r = checkRoots({ db, deviceId: 'd', live: () => [], broadcast: (ev) => sent.push(ev) });
      expect(r.recovered).toEqual(['p1']);
      expect(projectIdOf(db)).toBe('p1');
      expect(sent.filter((e) => e.type === 'session.upsert').map((e) => (e as Extract<ServerEvent, { type: 'session.upsert' }>).session.id)).toEqual(['s1']);
      expect(sent.filter((e) => e.type === 'project.upsert').map((e) => (e as Extract<ServerEvent, { type: 'project.upsert' }>).project.id)).toEqual(['p1']);
    } finally {
      db.close();
    }
  });

  it('消えたルートの検出と project.unresolved の配信は前のまま', () => {
    const gone = path.join(ws, 'no-such-dir');
    const db = openDb(':memory:');
    const sent: ServerEvent[] = [];
    try {
      upsertShared(db, 'projects', { id: 'p1', name: 'alpha', status: 'active', is_scratch: 0 }, 'd');
      upsertShared(db, 'project_roots', { id: 'r1', project_id: 'p1', device_id: 'd', path: gone, resolved: 1 }, 'd');
      const r = checkRoots({ db, deviceId: 'd', live: () => [], broadcast: (ev) => sent.push(ev) });
      expect(r.unresolved).toEqual(['p1']);
      expect(sent).toEqual([{ type: 'project.unresolved', projectId: 'p1' }]);
    } finally {
      db.close();
    }
  });

  it('戻ったルートが無ければ紐づけ直しも配信もしない', () => {
    // 起動時の 1 回目はたいていここを通る。無駄に全件を舐めない。
    const db = openDb(':memory:');
    const sent: ServerEvent[] = [];
    try {
      upsertShared(db, 'projects', { id: 'p1', name: 'alpha', status: 'active', is_scratch: 0 }, 'd');
      upsertShared(db, 'project_roots', { id: 'r1', project_id: 'p1', device_id: 'd', path: ws, resolved: 1 }, 'd');
      upsertShared(db, 'sessions', { id: 's1', provider: 'claude-code', provider_session_id: 'u1', project_id: null, cwd: '/somewhere/else', home_device: 'd' }, 'd');
      expect(checkRoots({ db, deviceId: 'd', live: () => [], broadcast: (ev) => sent.push(ev) })).toEqual({ unresolved: [], recovered: [] });
      expect(sent).toEqual([]);
      expect(projectIdOf(db)).toBeNull();
    } finally {
      db.close();
    }
  });
});

describe('close の要約待ち', () => {
  it('走っている要約が終わるまで待つ', async () => {
    // 終了の途中で要約が書き込みに来ると、閉じた DB に触れてしまう。
    let finish = () => {};
    const job = { idle: () => new Promise<void>((r) => { finish = r; }) };
    let settled: boolean | null = null;
    const waiting = waitForSummaryIdle(job, 2000).then((v) => { settled = v; return v; });
    await new Promise((r) => setTimeout(r, 30));
    expect(settled).toBeNull();
    finish();
    expect(await waiting).toBe(true);
  });
  it('上限を超えたら諦めて閉じる', async () => {
    // 終わらない要約に終了が引きずられないよう、待ち時間には上限を置く。
    const job = { idle: () => new Promise<void>(() => {}) };
    const t = Date.now();
    expect(await waitForSummaryIdle(job, 50)).toBe(false);
    expect(Date.now() - t).toBeLessThan(2000);
  });
  it('待ち行列が空ならすぐ返る', async () => {
    const t = Date.now();
    expect(await waitForSummaryIdle({ idle: () => Promise.resolve() }, CLOSE_SUMMARY_WAIT_MS)).toBe(true);
    expect(Date.now() - t).toBeLessThan(1000);
    expect(CLOSE_SUMMARY_WAIT_MS).toBeGreaterThanOrEqual(1000);
  });
});

describe('close の本文の上げ待ち', () => {
  /** TranscriptUploader と同じ形の立て替え。idle が返るまで stop を呼んではいけない。 */
  const fakeUploader = () => {
    const calls: string[] = [];
    let finish = () => {};
    return {
      calls,
      finish: () => finish(),
      idle: () => new Promise<void>((r) => { finish = () => { calls.push('idle'); r(); }; }),
      stop: () => { calls.push('stop'); },
    };
  };

  it('走っている上げが終わってから止める', async () => {
    // デバウンスのタイマーが始めた上げは誰も約束を持たない。
    // 待たずに stop すると putFile が途中で切れ、その本文は次の起動までやり直しになる。
    const up = fakeUploader();
    let settled: boolean | null = null;
    const waiting = stopUploader(up, 2000).then((v) => { settled = v; return v; });
    await new Promise((r) => setTimeout(r, 30));
    expect(settled).toBeNull();
    expect(up.calls).toEqual([]);
    up.finish();
    expect(await waiting).toBe(true);
    // 上げ終わってから止める、という順でなければならない。
    expect(up.calls).toEqual(['idle', 'stop']);
  });

  it('上限を超えたら諦めて止める', async () => {
    // 大きな本文 1 件で hangar stop が固まらないようにする。
    const up = fakeUploader();
    const t = Date.now();
    expect(await stopUploader(up, 50)).toBe(false);
    expect(Date.now() - t).toBeLessThan(2000);
    // 諦めたときも必ず止める。
    expect(up.calls).toEqual(['stop']);
  });

  it('上げ手が無ければ何もしない', async () => {
    expect(await stopUploader(null)).toBe(true);
    // 上限は数秒に収める。終了が転送に引きずられない長さである。
    expect(CLOSE_UPLOAD_WAIT_MS).toBeGreaterThanOrEqual(1000);
    expect(CLOSE_UPLOAD_WAIT_MS).toBeLessThanOrEqual(5000);
  });
});

describe('要約の契機', () => {
  it('run の終了はレジストリが生きていると言っても要約を受け付ける', async () => {
    // tmux を落とした直後でも、~/.claude/sessions を 500 ミリ秒周期で読むキャッシュは
    // 必ず「生きている」と出る。run の終了を知っている側は、その判定を当てにしない。
    const db = openDb(':memory:');
    try {
      await new IndexerService({ db, deviceId: 'd', claudeDir, isRunning: () => false }).fullScan();
      const id = (db.prepare('select id from sessions where provider_session_id = ?').get(SESSION_ALPHA) as { id: string }).id;
      const live: LiveSessionDto[] = [{ sessionId: SESSION_ALPHA, status: 'idle', name: null, nameSource: null, cwd: ws, pid: 1 }];
      const summarizer: Summarizer = { id: 'lmstudio', available: async () => true, summarize: async () => ({ title: 'T', oneLiner: 'O', body: 'B', state: 'done', nextSteps: [] }) };
      const job = new SummaryJob({ db, deviceId: 'd', summarizers: () => [summarizer], live: () => live, hub: { broadcast: () => {} } });
      // セッションを開いたときの契機は、レジストリが生きていると言う間は受け付けない。
      expect(job.enqueue(id)).toBe(false);
      // run の終了の契機は受け付ける。こちらは run が終わったことを知っている。
      expect(job.enqueue(id, RUN_ENDED_SUMMARY_OPTS)).toBe(true);
      await job.idle();
      expect((db.prepare('select source from session_summaries where session_id = ?').get(id) as { source: string }).source).toBe('post_hoc');
      // 飛ばすのはレジストリの判定だけである。土台でなくなった後は、もう受け付けない。
      expect(job.enqueue(id, RUN_ENDED_SUMMARY_OPTS)).toBe(false);
    } finally {
      db.close();
    }
  });
});
