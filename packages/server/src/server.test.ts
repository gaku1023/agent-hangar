import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import type { ServerEvent, SessionDto, SyncStatusBody } from '@agent-hangar/shared';
import type { LiveSessionDto } from '@agent-hangar/shared';
import { Readable } from 'node:stream';
import { saveCloudConfig } from './config/cloud.ts';
import { dbPath } from './config/paths.ts';
import { D1_WRITES_PER_DEVICE_TOUCH, QuotaCounter } from './sync/quota.ts';
import { SyncStateStore } from './sync/state.ts';
import { openDb } from './db/open.ts';
import { upsertShared } from './db/shared.ts';
import { IndexerService } from './indexer/service.ts';
import { checkProjectRoots } from './projects/registry.ts';
import { mangleCwd } from './provider/claude-code/discover.ts';
import { SummaryJob } from './summary/job.ts';
import type { Summarizer } from './summary/types.ts';
import { copyFixtureClaudeDir, SESSION_ALPHA, SESSION_OTHER } from '../test/fixtures.ts';
import { BACKUP_GENERATIONS } from './sync/claudeConfig.ts';
import { checkRoots, CLOSE_DEADLINE_MS, configSyncActive, countingClient, sessionMemoBackupMessage, D1_WRITES_PER_FILE_DELETE, D1_WRITES_PER_FILE_PUT, installShutdown, pruneBackupFiles, RUN_ENDED_SUMMARY_OPTS, startServer, stopAfterIdle, stopUploader, STOP_WATCHDOG_MS, UPLOAD_SWEEP_MS, waitForSummaryIdle, WS_PATHS } from './server.ts';

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

/**
 * 本文をどこから上げるかの床（sync_state の transcriptsFrom）を先に置く。
 * サーバは行が無いときだけ刻むので、ここで置いた値がそのまま使われる。
 * 0 は床なしで、手元の本文を全部「まだ上がっていない」と数えさせる。
 */
const seedTranscriptFloor = (value: number): void => {
  const db = openDb(dbPath(home));
  try { new SyncStateStore(db).set('transcriptsFrom', value); } finally { db.close(); }
};

/** いま刻まれている床を読む。 */
const transcriptFloor = (): string | null => {
  const db = openDb(dbPath(home));
  try { return new SyncStateStore(db).get('transcriptsFrom'); } finally { db.close(); }
};

/** 床を刻まない古いサーバが先に走った跡を作る。進み具合だけがあり、床は無い。 */
const seedOldServerProgress = (): void => {
  const db = openDb(dbPath(home));
  try {
    const st = new SyncStateStore(db);
    st.set('lastSeq', 42);
    st.set('filesSeq', 7);
  } finally {
    db.close();
  }
};

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

  it('床が無ければ参加した時刻を保険で刻み、古いサーバが先に走った跡では床を消さない', async () => {
    // 実物で起きた筋である。
    // 床を刻まない古いサーバが先に起動して lastSeq と filesSeq を書いた端末で、
    // 新しいサーバが「もう同期した端末だから床は要らない」と判断し、過去の本文を全部上げてしまった。
    // 宛先は誰も待ち受けていないループバックである。実物のクラウドには触らない。
    const joinedAt = 1_700_000_000_000;
    saveCloudConfig(home, { url: 'http://127.0.0.1:9', joinSecret: 'test-secret', deviceToken: 'test-device-token', workerName: null, accountId: null, dbName: null, bucketName: null, joinedAt });
    seedOldServerProgress();
    const s = await startServer({ port: 0, home, claudeDir, uiDist: path.join(home, 'no-dist') });
    try {
      expect(transcriptFloor()).toBe(String(joinedAt));
    } finally {
      await s.close();
    }
  });

  it('websocket の sync.status が付録を運び、件数が減れば画面にも届く', async () => {
    // レビュアの再現筋である。
    // 付録を運ぶのが HTTP だけだと、サーバの取り残しが 0 になっても画面は 3 のまま固まる。
    // 諦めた本文の赤い行も、回復したあと消えなくなる。
    // 宛先は誰も待ち受けていないループバックである。実物のクラウドには触らない。
    saveCloudConfig(home, { url: 'http://127.0.0.1:9', joinSecret: 'test-secret', deviceToken: 'test-device-token', workerName: null, accountId: null, dbName: null, bucketName: null, joinedAt: 1 });
    // ここで見たいのは件数の届き方なので、床は落としておく（そうしないと取り残しは 0 から動かない）。
    seedTranscriptFloor(0);
    const s = await startServer({ port: 0, home, claudeDir, uiDist: path.join(home, 'no-dist') });
    const col = collector(s.port, tokenOf());
    try {
      const token = tokenOf();
      const api = (p: string, init?: RequestInit) => fetch(`http://127.0.0.1:${s.port}${p}`, { ...init, headers: { authorization: `Bearer ${token}` } });
      const statusNow = async () => (await (await api('/api/sync/status')).json()) as SyncStatusBody;
      // 取り残しが減る前の通知を拾ってしまわないように、必ず印より後ろだけを見る。
      const nextStatus = (mark: number) => until(async () => col.all().slice(mark).find((e): e is Extract<ServerEvent, { type: 'sync.status' }> => e.type === 'sync.status') ?? null);
      await col.opened;
      // 索引が済むと、まだ一度も上げていない本文が取り残しとして数えられる。
      const before = await until(async () => { const n = (await statusNow()).sweepPending; return n !== null && n > 0 ? n : null; });
      // focus は 202 を返すだけで本体を持たない。状態は websocket だけで届く。
      const mark1 = col.all().length;
      expect((await api('/api/sync/focus', { method: 'POST' })).status).toBe(202);
      const first = await nextStatus(mark1);
      expect(first.status.sweepPending).toBe(before);
      expect(first.status.skipped).toEqual([]);
      // 別の接続から台帳を直して、取り残しを 0 にする。
      const db = openDb(dbPath(home));
      try {
        const rows = db.prepare('select t.agent_id a, t.size z, s.provider_session_id u from transcript_files t join sessions s on s.id = t.session_id where t.device_id is null').all() as { a: string | null; z: number; u: string }[];
        expect(rows.length).toBeGreaterThan(0);
        const deviceId = (db.prepare('select id from devices limit 1').get() as { id: string }).id;
        const put = db.prepare('insert or replace into file_sync (key, kind, path, device_id, sha256, size, mtime, remote_seq, synced_at) values (?,?,?,?,?,?,?,?,?)');
        for (const r of rows) {
          const key = r.a === null ? `transcripts/${deviceId}/${r.u}.jsonl.gz` : `transcripts/${deviceId}/${r.u}/subagents/agent-${r.a}.jsonl.gz`;
          put.run(key, 'transcript', key, deviceId, 'x'.repeat(64), r.z, 1, 1, 1);
        }
      } finally { db.close(); }
      expect((await statusNow()).sweepPending).toBe(0);
      // ここが要である。websocket だけで届く状態が、減った件数を運ぶ。
      const mark2 = col.all().length;
      expect((await api('/api/sync/focus', { method: 'POST' })).status).toBe(202);
      const after = await nextStatus(mark2);
      expect(after.status.sweepPending).toBe(0);
      expect(after.status.skipped).toEqual([]);
    } finally {
      col.close();
      await s.close();
    }
  }, 20000);

  it('設定の同期を切って入れ直すと、取り込みの確認をもう一度求める', async () => {
    // ~/.claude を書き換える同期なので、入れるときには必ず確認を取る（決定 2）。
    // configPullConfirmed は sync_state に残り続けるので、切った時点で降ろさないと、
    // 気に入らなくて切った利用者が入れ直したときに無確認で ~/.claude が書き換わる。
    // 宛先は誰も待ち受けていないループバックである。実物のクラウドには触らない。
    saveCloudConfig(home, { url: 'http://127.0.0.1:9', joinSecret: 'test-secret', deviceToken: 'test-device-token', workerName: null, accountId: null, dbName: null, bucketName: null, joinedAt: 1 });
    const s = await startServer({ port: 0, home, claudeDir, uiDist: path.join(home, 'no-dist') });
    try {
      const token = tokenOf();
      const auth = { authorization: `Bearer ${token}` };
      const confirmed = async (): Promise<boolean> => {
        const r = await fetch(`http://127.0.0.1:${s.port}/api/sync/config/preview`, { headers: auth });
        return ((await r.json()) as { confirmed: boolean }).confirmed;
      };
      const setSync = async (on: boolean): Promise<void> => {
        const r = await fetch(`http://127.0.0.1:${s.port}/api/settings`, {
          method: 'PATCH', headers: { ...auth, 'content-type': 'application/json' }, body: JSON.stringify({ syncClaudeConfig: on }),
        });
        expect(r.status).toBe(200);
        expect(((await r.json()) as { syncClaudeConfig: boolean }).syncClaudeConfig).toBe(on);
      };

      await setSync(true);
      expect(await confirmed()).toBe(false);
      // 一度だけ確認して取り込む。相手の設定は 1 件も無いので、ここで外へは出ない。
      const pulled = await fetch(`http://127.0.0.1:${s.port}/api/sync/config/pull`, { method: 'POST', headers: auth });
      expect(pulled.status).toBe(200);
      expect(await confirmed()).toBe(true);

      // 切って入れ直す。
      await setSync(false);
      await setSync(true);
      expect(await confirmed()).toBe(false);
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
    expect(await waitForSummaryIdle({ idle: () => Promise.resolve() }, CLOSE_DEADLINE_MS)).toBe(true);
    expect(Date.now() - t).toBeLessThan(1000);
    expect(CLOSE_DEADLINE_MS).toBeGreaterThanOrEqual(1000);
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
    expect(CLOSE_DEADLINE_MS).toBeGreaterThanOrEqual(1000);
    expect(CLOSE_DEADLINE_MS).toBeLessThanOrEqual(5000);
  });
});

describe('close の同期の押し出し待ち', () => {
  /** SyncEngine と ClaudeConfigSync と同じ形の立て替え。idle が返るまで stop を呼んではいけない。 */
  const fakeJob = () => {
    const calls: string[] = [];
    let finish = () => {};
    return {
      calls,
      finish: () => finish(),
      idle: () => new Promise<void>((r) => { finish = () => { calls.push('idle'); r(); }; }),
      stop: () => { calls.push('stop'); },
    };
  };

  it('走っている押し出しが終わってから止める', async () => {
    const job = fakeJob();
    let settled: boolean | null = null;
    const waiting = stopAfterIdle(job, 'sync', 2000).then((v) => { settled = v; return v; });
    await new Promise((r) => setTimeout(r, 30));
    expect(settled).toBeNull();
    expect(job.calls).toEqual([]);
    job.finish();
    expect(await waiting).toBe(true);
    expect(job.calls).toEqual(['idle', 'stop']);
  });

  it('上限を超えたら警告して止める', async () => {
    // クラウドへ届かないときは毎回この道を通る。滅多に起きない保険ではない。
    const job = { ...fakeJob(), idle: () => new Promise<void>(() => {}) };
    const warned: string[] = [];
    const real = console.warn;
    console.warn = (...a: unknown[]) => { warned.push(a.map(String).join(' ')); };
    try {
      const t = Date.now();
      expect(await stopAfterIdle(job, 'sync', 50)).toBe(false);
      expect(Date.now() - t).toBeLessThan(2000);
    } finally {
      console.warn = real;
    }
    // 諦めたときも必ず止める。止めないと、止めたはずの同期が要求を出し続ける。
    expect(job.calls).toEqual(['stop']);
    // 黙って諦めない。どの仕事を待ち切れなかったかがログに残る。
    expect(warned.length).toBe(1);
    expect(warned[0]).toContain('[sync]');
    expect(warned[0]).toContain('50');
  });

  it('相手が無ければ何もしない', async () => {
    expect(await stopAfterIdle(null, 'config')).toBe(true);
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

describe('一時停止は外と話さない', () => {
  /** 受けた要求を記録するだけの立て替えの Worker。実物のクラウドには触らない。 */
  async function recorder(): Promise<{ url: string; seen: string[]; close: () => Promise<void> }> {
    const seen: string[] = [];
    const srv = http.createServer((req, res) => {
      seen.push(`${req.method} ${(req.url ?? '').split('?')[0]}`);
      req.resume();
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end('{"error":"no"}');
    });
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
    const port = (srv.address() as net.AddressInfo).port;
    return {
      url: `http://127.0.0.1:${port}`,
      seen,
      close: async () => { srv.closeAllConnections?.(); await new Promise<void>((r) => srv.close(() => r())); },
    };
  }

  /** startServer より先に DB を作って、同期を止めた状態にしておく。 */
  function presetPaused(): void {
    const db = openDb(dbPath(home));
    try { db.prepare("insert into sync_state (key, value) values ('paused', '1') on conflict(key) do update set value = '1'").run(); } finally { db.close(); }
  }

  it('止めていなければ起動でクラウドを叩く', async () => {
    // この確かめ方でクラウドとの往復が見えることを、先に固定しておく。
    const rec = await recorder();
    saveCloudConfig(home, { url: rec.url, joinSecret: 'test-secret', deviceToken: 'test-device-token', workerName: null, accountId: null, dbName: null, bucketName: null, joinedAt: 1 });
    const s = await startServer({ port: 0, home, claudeDir, uiDist: path.join(home, 'no-dist') });
    try {
      // 最初の同期は起動を待たせない（信号の受け口を /health より前に立てるためである）。
      // だから往復は startServer が返った少し後に出る。出るまで待つ。
      for (let i = 0; i < 300 && rec.seen.length === 0; i++) await new Promise((r) => setTimeout(r, 10));
      expect(rec.seen.length).toBeGreaterThan(0);
    } finally {
      await s.close();
      await rec.close();
    }
  });

  it('一時停止のあいだは、起動のファイルの取り込みも含めて 1 度も叩かない', async () => {
    // 「一時停止」は外と話すのをやめることである。無料枠 80% で自分から止まったときも同じである。
    // 止まっているあいだに R2 へ出入りする経路が残っていると、課金されない約束が崩れる。
    const rec = await recorder();
    saveCloudConfig(home, { url: rec.url, joinSecret: 'test-secret', deviceToken: 'test-device-token', workerName: null, accountId: null, dbName: null, bucketName: null, joinedAt: 1 });
    presetPaused();
    const s = await startServer({ port: 0, home, claudeDir, uiDist: path.join(home, 'no-dist') });
    try {
      const status = await (await fetch(`http://127.0.0.1:${s.port}/api/sync/status`, { headers: { authorization: `Bearer ${tokenOf()}` } })).json() as { state: string };
      expect(status.state).toBe('paused');
      expect(rec.seen).toEqual([]);
    } finally {
      await s.close();
      await rec.close();
    }
  });

  it('設定の同期は、切っているときと一時停止のあいだは押し出さない', () => {
    // fs.watch からの push も 60 秒ごとの push も、この判定を通ってから出る。
    expect(configSyncActive({ syncClaudeConfig: true, paused: false })).toBe(true);
    expect(configSyncActive({ syncClaudeConfig: true, paused: true })).toBe(false);
    expect(configSyncActive({ syncClaudeConfig: false, paused: false })).toBe(false);
    expect(configSyncActive({ syncClaudeConfig: false, paused: true })).toBe(false);
  });
});

/**
 * ファイルの出し入れの行数を Worker のスキーマから出し直す。
 * 無料枠が数えているのは文の数ではなく rows_written で、索引への書き込みも 1 行ずつ数える。
 * schema.ts は読むだけで、書き換えない。
 */
describe('ファイルの出し入れの勘定は Worker のスキーマから出す', () => {
  const schema = fs.readFileSync(new URL('../../cloud/src/schema.ts', import.meta.url), 'utf8');
  const filesBody = (): string => {
    const m = schema.match(/create table if not exists files \(([\s\S]*?)\)'/);
    if (!m?.[1]) throw new Error('files の create table が見つからない');
    return m[1];
  };
  /** files に張られた索引の数。明示の create index と、unique や text の主キーに SQLite が自分で張るもの。 */
  const filesIndexes = (): number => {
    const body = filesBody();
    const explicit = [...schema.matchAll(/create index if not exists (\w+) on (\w+)\(([^)]*)\)/g)].filter((m) => m[2] === 'files').length;
    // seq integer primary key は rowid そのものなので索引を増やさない。
    const pk = /integer primary key/.test(body) ? 0 : /primary key/.test(body) ? 1 : 0;
    return explicit + pk + (body.match(/ unique/g) ?? []).length;
  };
  /** autoincrement の表は insert のたびに sqlite_sequence の 1 行も動かす（delete では動かない）。 */
  const sequenceRow = (): number => (/autoincrement/.test(filesBody()) ? 1 : 0);

  it('files には索引が 2 つある（key の unique と files_kind）', () => {
    expect(filesIndexes()).toBe(2);
    expect(sequenceRow()).toBe(1);
  });

  it('PUT は delete と insert と devices の更新で 8 行である', () => {
    // packages/cloud/src/files.ts の batch は delete と insert と devices の更新の 3 文である。
    const del = 1 + filesIndexes();
    const ins = 1 + filesIndexes() + sequenceRow();
    expect(D1_WRITES_PER_FILE_PUT).toBe(del + ins + D1_WRITES_PER_DEVICE_TOUCH);
    expect(D1_WRITES_PER_FILE_PUT).toBe(8);
  });

  it('DELETE は本体と索引だけで 3 行である', () => {
    // devices は触らず、sqlite_sequence は delete では動かない。
    expect(D1_WRITES_PER_FILE_DELETE).toBe(1 + filesIndexes());
    expect(D1_WRITES_PER_FILE_DELETE).toBe(3);
  });
});

describe('セッションのメモの控えの知らせ', () => {
  it('どの端末に負けて、どこに残したかを言う', () => {
    // 控えはもうファイルになっている。知らせが無いと、利用者は消えたようにしか見えない。
    const m = sessionMemoBackupMessage({ sessionId: 's1', markdown: '手元のメモ', deviceName: 'mini', backupFile: '/tmp/backups/memos/session-s1-20260919-101112.md' });
    expect(m).toContain('mini');
    expect(m).toContain('/tmp/backups/memos/session-s1-20260919-101112.md');
    // 本文そのものはトーストに出さない（メモは長い文章になりうる）。
    expect(m).not.toContain('手元のメモ');
  });
});

describe('無料枠の勘定', () => {
  /** 呼ばれた名前を記録するだけの立て替え。中身は使わない。 */
  const stubClient = (calls: string[]) => ({
    health: async () => { calls.push('health'); return { ok: true, version: 'v' }; },
    pushChanges: async () => { calls.push('pushChanges'); return { seq: 1, accepted: 1, skipped: 0 }; },
    pullChanges: async () => { calls.push('pullChanges'); return { changes: [], nextSeq: 0, more: false }; },
    snapshot: async () => { calls.push('snapshot'); return { changes: [], nextAfter: null, seq: 0 }; },
    putFile: async () => { calls.push('putFile'); return { seq: 1 }; },
    getFile: async () => { calls.push('getFile'); return Readable.from([]); },
    listFiles: async () => { calls.push('listFiles'); return { files: [], nextSeq: 0, more: false }; },
    deleteFile: async () => { calls.push('deleteFile'); },
  });

  const counter = () => {
    const db = openDb(':memory:');
    return { db, quota: new QuotaCounter({ state: new SyncStateStore(db) }) };
  };

  it('エンジンが自分で数える経路には二重に掛けない', async () => {
    // push と pull と写しは SyncEngine が自分で数える。包みでも数えると 2 倍になる。
    const { db, quota } = counter();
    try {
      const calls: string[] = [];
      const c = countingClient(stubClient(calls), quota);
      await c.pushChanges([]);
      await c.pullChanges(0, 1);
      await c.snapshot(null, 1);
      expect(calls).toEqual(['pushChanges', 'pullChanges', 'snapshot']);
      expect(quota.today()).toEqual({ rows: 0, requests: 0 });
    } finally {
      db.close();
    }
  });

  it('ファイルの出し入れは要求と D1 の書き込みの両方を数える', async () => {
    // PUT /files/<鍵> は R2 に置くだけでなく D1 の files にも書く。
    // 要求の側しか数えないと、D1 の 80% の見張りが実際より遅れて効く。
    const { db, quota } = counter();
    try {
      const calls: string[] = [];
      const c = countingClient(stubClient(calls), quota);
      await c.putFile({ key: 'transcripts/d/u.jsonl.gz', path: 'projects/p/u.jsonl', kind: 'transcript', sha256: 'x', size: 1, mtime: 1, encrypted: true }, Readable.from([]));
      expect(quota.today()).toEqual({ rows: D1_WRITES_PER_FILE_PUT, requests: 1 });
      await c.getFile('transcripts/d/u.jsonl.gz');
      await c.listFiles(0, 1);
      await c.health();
      // 読むだけの経路は D1 に 1 行も書かない。
      expect(quota.today()).toEqual({ rows: D1_WRITES_PER_FILE_PUT, requests: 4 });
      await c.deleteFile('transcripts/d/u.jsonl.gz');
      expect(quota.today()).toEqual({ rows: D1_WRITES_PER_FILE_PUT + D1_WRITES_PER_FILE_DELETE, requests: 5 });
    } finally {
      db.close();
    }
  });

  it('数えるのは文の数ではなく行数である', () => {
    // 文の数（PUT が 3 文、DELETE が 1 文）で数えると、索引への書き込みが丸ごと抜ける。
    // 行数の出どころは下の「ファイルの出し入れの勘定は Worker のスキーマから出す」にある。
    expect(D1_WRITES_PER_FILE_PUT).toBeGreaterThan(3);
    expect(D1_WRITES_PER_FILE_DELETE).toBeGreaterThan(1);
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

/**
 * 本文は「クラウドを使い始めた後に動いたもの」だけを上げる。
 *
 * 利用者は先に hangar を使い、後からクラウドを足すので、参加の時点で何百件もの本文が手元にある。
 * それを全部上げても意味が薄いので、走査は使い始めた時刻で区切る。
 * 参加より前の本文を上げたくなったら、そのセッションを再開するか hangar cloud backfill を使う。
 * メタデータ（セッションの一覧、要約、プロジェクト、TODO、メモ）はこの区切りを見ない。
 */
describe('本文は使い始めた後に動いたものだけを上げる', () => {
  /** PUT された鍵を覚えるだけの立て替えの Worker。実物のクラウドには触らない。 */
  async function fileSink(): Promise<{ url: string; puts: string[]; close: () => Promise<void> }> {
    const puts: string[] = [];
    let seq = 0;
    const srv = http.createServer((req, res) => {
      const url = (req.url ?? '').split('?')[0] ?? '';
      const send = (body: unknown) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
      if (req.method === 'PUT' && url.startsWith('/files/')) {
        req.resume();
        req.on('end', () => { puts.push(decodeURIComponent(url.slice('/files/'.length))); send({ seq: ++seq }); });
        return;
      }
      req.resume();
      if (url === '/changes' && req.method === 'POST') return send({ seq: 0, accepted: 0, skipped: 0 });
      if (url === '/changes') return send({ changes: [], nextSeq: 0, more: false });
      if (url === '/rows') return send({ changes: [], nextAfter: null, seq: 0 });
      if (url === '/files') return send({ files: [], nextSeq: 0, more: false });
      return send({ ok: true, version: 'fake' });
    });
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
    const port = (srv.address() as net.AddressInfo).port;
    return {
      url: `http://127.0.0.1:${port}`,
      puts,
      close: async () => { srv.closeAllConnections?.(); await new Promise<void>((r) => srv.close(() => r())); },
    };
  }

  /** 3 件の本文が索引された状態を作る。クラウドはまだ無い。 */
  async function indexWithoutCloud(): Promise<void> {
    const first = await startServer({ port: 0, home, claudeDir, uiDist: path.join(home, 'no-dist') });
    try {
      await until(async () => {
        const db = openDb(dbPath(home));
        try { return (db.prepare('select count(*) c from transcript_files').get() as { c: number }).c === 3 ? true : null; } finally { db.close(); }
      });
    } finally {
      await first.close();
    }
  }

  /**
   * 本文が最後に動いた時刻を決める。索引する前に置くので、台帳にはこの値がそのまま入る。
   * only を渡すと、パスにその文字列を含む本文だけを動かす。
   *
   * 索引した後で動かすと、次の起動の全走査が変化を見て索引を作り直し、
   * その場で noteChanged が鳴って 30 秒の窓に載る。
   * すると走査が拾ったのか窓が開いたのかを見分けられず、試験が時々転ぶ。
   */
  function setTranscriptMtime(mtime: number, only?: string): void {
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
    walk(path.join(claudeDir, 'projects'));
  }

  const suffixes = (keys: string[]): string[] => keys.map((k) => k.replace(/^transcripts\/[^/]+\//, '')).sort();

  it('参加より前に止まっていた本文は上げず、その後に動いた本文だけを上げる', async () => {
    // 参加の前後を、本文が最後に動いた時刻で作り分ける。
    // alpha の 2 件は参加より前で止まっていて、other の 1 件は参加より後に動いている。
    const base = Date.now();
    setTranscriptMtime(base - 120_000);
    setTranscriptMtime(base - 60_000, SESSION_OTHER);
    await indexWithoutCloud();
    // 後からクラウドに参加する。刻むのはサーバだが、時刻を決めたいのでここで置いておく。
    seedTranscriptFloor(base - 90_000);

    const sink = await fileSink();
    saveCloudConfig(home, { url: sink.url, joinSecret: 'test-secret', deviceToken: 'test-device-token', workerName: null, accountId: null, dbName: null, bucketName: null, joinedAt: 1 });
    const s = await startServer({ port: 0, home, claudeDir, uiDist: path.join(home, 'no-dist') });
    try {
      await until(async () => (sink.puts.length >= 1 ? sink.puts : null));
      // 参加より前で止まっている 2 件（alpha の本文と subagent）は上がらない。
      await new Promise((r) => setTimeout(r, 300));
      expect(suffixes(sink.puts)).toEqual([`${SESSION_OTHER}.jsonl.gz`]);
      // 画面に出す「未送信の本文」も、上がる予定の無い 2 件を数えない。
      const token = tokenOf();
      const status = await (await fetch(`http://127.0.0.1:${s.port}/api/sync/status`, { headers: { authorization: `Bearer ${token}` } })).json() as SyncStatusBody;
      expect(status.sweepPending).toBe(0);
    } finally {
      await s.close();
      await sink.close();
    }
  }, 20000);

  it('床を落とせば、参加より前の本文も上がる', async () => {
    // hangar cloud backfill が書くのがこの 0 である。
    setTranscriptMtime(Date.now() - 60_000);
    await indexWithoutCloud();
    seedTranscriptFloor(0);

    const sink = await fileSink();
    saveCloudConfig(home, { url: sink.url, joinSecret: 'test-secret', deviceToken: 'test-device-token', workerName: null, accountId: null, dbName: null, bucketName: null, joinedAt: 1 });
    const s = await startServer({ port: 0, home, claudeDir, uiDist: path.join(home, 'no-dist') });
    try {
      const keys = await until(async () => (sink.puts.length >= 3 ? sink.puts : null));
      expect(suffixes(keys)).toEqual([`${SESSION_ALPHA}.jsonl.gz`, `${SESSION_ALPHA}/subagents/agent-abc123.jsonl.gz`, `${SESSION_OTHER}.jsonl.gz`].sort());
      // 上げ終わったものを上げ直さない。
      await new Promise((r) => setTimeout(r, 300));
      expect(sink.puts.length).toBe(3);
    } finally {
      await s.close();
      await sink.close();
    }
  }, 20000);

  it('走査の間隔は設定の同期と揃えてある', () => {
    // 片方だけ直すと、また兄弟の経路が食い違う。
    expect(UPLOAD_SWEEP_MS).toBe(60_000);
  });
});

/**
 * 控えの世代。
 * 刈っていたのは設定の取り込みの分だけで、本文（transcripts）とメモ（memos）は溜まり続けていた。
 * 設定の控えと同じ作法で、新しい方から数えて上限までを残す。
 */
describe('控えの世代を刈る', () => {
  const seed = (dir: string, n: number, ext: string): string[] => {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const names: string[] = [];
    for (let i = 0; i < n; i++) {
      // 名前は辞書順と時刻の順が一致しない形にする（本文の控えは <uuid>-<時刻>、メモは session-<ID>-<時刻> である）。
      const name = `z${(n - i).toString().padStart(3, '0')}-20260101-00${i.toString().padStart(4, '0')}${ext}`;
      const f = path.join(dir, name);
      fs.writeFileSync(f, `${i}\n`, { mode: 0o600 });
      const t = new Date(1_700_000_000_000 + i * 1000);
      fs.utimesSync(f, t, t);
      names.push(name);
    }
    return names;
  };

  it('新しい方から数えて上限までを残し、古い控えを消す', () => {
    const dir = path.join(home, 'backups', 'transcripts');
    const names = seed(dir, BACKUP_GENERATIONS + 5, '.jsonl');
    expect(pruneBackupFiles(path.join(home, 'backups'), 'transcripts', BACKUP_GENERATIONS)).toBe(5);
    expect(fs.readdirSync(dir).sort()).toEqual(names.slice(5).sort());
    // もう一度刈っても、上限以下なら何も消さない。
    expect(pruneBackupFiles(path.join(home, 'backups'), 'transcripts', BACKUP_GENERATIONS)).toBe(0);
    expect(fs.readdirSync(dir).length).toBe(BACKUP_GENERATIONS);
  });

  it('入れ物が無くても、上限が 0 以下でも壊れない', () => {
    expect(pruneBackupFiles(path.join(home, 'backups'), 'nope', BACKUP_GENERATIONS)).toBe(0);
    const dir = path.join(home, 'backups', 'memos');
    seed(dir, 3, '.md');
    // 上限は 1 未満にしない。控えを全部消す刈り込みは作らない。
    expect(pruneBackupFiles(path.join(home, 'backups'), 'memos', 0)).toBe(2);
    expect(fs.readdirSync(dir).length).toBe(1);
  });

  it('入れ物の中のディレクトリは消さない', () => {
    const dir = path.join(home, 'backups', 'transcripts');
    seed(dir, BACKUP_GENERATIONS + 3, '.jsonl');
    fs.mkdirSync(path.join(dir, 'keep-me'), { recursive: true });
    expect(pruneBackupFiles(path.join(home, 'backups'), 'transcripts', BACKUP_GENERATIONS)).toBe(3);
    expect(fs.existsSync(path.join(dir, 'keep-me'))).toBe(true);
  });

  it('入れ物がシンボリックリンクなら、リンクの先を消さずに断る', () => {
    // 書く側（copy.ts の resolveUnder）はリンクを 1 区切りも辿らない。消す側も揃える。
    const outside = path.join(home, 'outside');
    fs.mkdirSync(outside, { recursive: true });
    const victims = seed(outside, 3, '.jsonl');
    fs.mkdirSync(path.join(home, 'backups'), { recursive: true });
    fs.symlinkSync(outside, path.join(home, 'backups', 'transcripts'));
    expect(() => pruneBackupFiles(path.join(home, 'backups'), 'transcripts', 1)).toThrow(/シンボリックリンク/);
    // リンクの先は 1 件も消えていない。
    expect(fs.readdirSync(outside).sort()).toEqual(victims.sort());
  });

  it('控えの種類に区切りや上の階層を混ぜられない', () => {
    expect(() => pruneBackupFiles(path.join(home, 'backups'), '../..', 1)).toThrow(/形が不正/);
    expect(() => pruneBackupFiles(path.join(home, 'backups'), 'a/b', 1)).toThrow(/形が不正/);
  });

  it('起動のときに、本文とメモの控えを上限まで刈る', async () => {
    const tr = path.join(home, 'backups', 'transcripts');
    const memos = path.join(home, 'backups', 'memos');
    const trNames = seed(tr, BACKUP_GENERATIONS + 7, '.jsonl');
    const memoNames = seed(memos, BACKUP_GENERATIONS + 4, '.md');
    const s = await startServer({ port: 0, home, claudeDir, uiDist: path.join(home, 'no-dist') });
    try {
      expect(fs.readdirSync(tr).sort()).toEqual(trNames.slice(7).sort());
      expect(fs.readdirSync(memos).sort()).toEqual(memoNames.slice(4).sort());
    } finally {
      await s.close();
    }
  });
});
