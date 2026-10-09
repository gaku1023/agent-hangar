import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import type { CompatDto, ReadinessDto, ServerEvent, SessionDto, SyncStatusBody } from '@agent-hangar/shared';
import type { LiveSessionDto } from '@agent-hangar/shared';
import { COMPAT_HEADER, COMPAT_VERSION } from '@agent-hangar/shared';
import { saveCloudConfig } from './config/cloud.ts';
import { dbPath } from './config/paths.ts';
import { SyncStateStore } from './sync/state.ts';
import { DbBackupError } from './db/backup.ts';
import { openDb } from './db/open.ts';
import { upsertShared } from './db/shared.ts';
import { IndexerService } from './indexer/service.ts';
import { checkProjectRoots } from './projects/registry.ts';
import { mangleCwd } from './provider/claude-code/discover.ts';
import { SummaryJob } from './summary/job.ts';
import type { Summarizer } from './summary/types.ts';
import { copyFixtureClaudeDir, SESSION_ALPHA, SESSION_OTHER } from '../test/fixtures.ts';
import { dbVersionOf, LATEST_DB_VERSION, seedDbAt } from '../test/oldDb.ts';
import { BACKUP_GENERATIONS } from './sync/claudeConfig.ts';
import { checkRoots, CLOSE_DEADLINE_MS, configSyncActive, syncHalted, sessionMemoBackupMessage, installShutdown, pruneBackupFiles, RUN_ENDED_SUMMARY_OPTS, startServer, stopAfterIdle, stopUploader, STOP_WATCHDOG_MS, UPLOAD_SWEEP_MS, waitForSummaryIdle, WS_PATHS } from './server.ts';
import { writeFakeTool } from '../test/fake-bin.ts';
import { VERIFIED_CLAUDE_VERSION } from './provider/claude-code/compat/version.ts';
import { expectMode, posixIt } from '../test/platform.ts';

/** 見本の登録の pid は実在しない。Windows の既定は動いていない pid の登録を読まないので、試験では全部読ませる。 */
const ALL_ALIVE = (): boolean => false;

let home: string;
let claudeDir: string;
let ws: string;
let prevClaudeBin: string | undefined;
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'hangar-home-'));
  claudeDir = copyFixtureClaudeDir();
  ws = fs.mkdtempSync(path.join(os.tmpdir(), 'hangar-ws-'));
  // サーバは起動の裏で claude --help と --version を読む。手元の本物の claude を起こさないよう、無いパスに向ける。
  // 偽の claude を使う試験は、この値を上書きする。
  prevClaudeBin = process.env.HANGAR_CLAUDE_BIN;
  process.env.HANGAR_CLAUDE_BIN = path.join(home, 'no-claude');
});
afterEach(() => {
  if (prevClaudeBin === undefined) delete process.env.HANGAR_CLAUDE_BIN; else process.env.HANGAR_CLAUDE_BIN = prevClaudeBin;
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

/** startServer より先に DB を作って、同期を止めた状態にしておく。 */
function presetPaused(): void {
  const db = openDb(dbPath(home));
  try { db.prepare("insert into sync_state (key, value) values ('paused', '1') on conflict(key) do update set value = '1'").run(); } finally { db.close(); }
}

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

  it('DB の控えが取れなければ、マイグレーションを当てずに起動を止める', async () => {
    // 1 つ前の版までの DB を置き、控えの置き場（backups/db）を通常のファイルにして作れなくする。
    const file = path.join(home, 'hangar.db');
    seedDbAt(file, LATEST_DB_VERSION - 1);
    fs.mkdirSync(path.join(home, 'backups'), { recursive: true });
    fs.writeFileSync(path.join(home, 'backups', 'db'), 'x');
    await expect(startServer({ port: 0, home, claudeDir, registryIsGone: ALL_ALIVE, uiDist: path.join(home, 'no-dist') })).rejects.toBeInstanceOf(DbBackupError);
    expect(dbVersionOf(file)).toBe(LATEST_DB_VERSION - 1);
  });

  it('WebSocket と keep-alive の接続が残っていても close は 2 秒以内に終わる', async () => {
    const s = await startServer({ port: 0, home, claudeDir, registryIsGone: ALL_ALIVE, uiDist: path.join(home, 'no-dist') });
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
    const s = await startServer({ port: 0, home, claudeDir, registryIsGone: ALL_ALIVE, uiDist: path.join(home, 'no-dist') });
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
    const s = await startServer({ port: 0, home, claudeDir, registryIsGone: ALL_ALIVE, uiDist: path.join(home, 'no-dist') });
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
    const s = await startServer({ port: 0, home, claudeDir, registryIsGone: ALL_ALIVE, uiDist: path.join(home, 'no-dist') });
    try {
      expect(transcriptFloor()).toBe(String(joinedAt));
    } finally {
      await s.close();
    }
  });

  it('joinedAt の無い cloud.json でも、床なし（0）にはせず今の時刻を床にする', async () => {
    // 床の行が無い DB（作り直した DB、cloud.json だけを写した試しの HANGAR_HOME）で床なしにすると、手元の本文を全部上げてしまう。
    // 宛先は誰も待ち受けていないループバックである。実物のクラウドには触らない。
    saveCloudConfig(home, { url: 'http://127.0.0.1:9', joinSecret: 'test-secret', deviceToken: 'test-device-token', workerName: null, accountId: null, dbName: null, bucketName: null, joinedAt: 0 });
    const before = Date.now();
    const s = await startServer({ port: 0, home, claudeDir, registryIsGone: ALL_ALIVE, uiDist: path.join(home, 'no-dist') });
    try {
      expect(Number(transcriptFloor())).toBeGreaterThanOrEqual(before);
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
    const s = await startServer({ port: 0, home, claudeDir, registryIsGone: ALL_ALIVE, uiDist: path.join(home, 'no-dist') });
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
    const s = await startServer({ port: 0, home, claudeDir, registryIsGone: ALL_ALIVE, uiDist: path.join(home, 'no-dist') });
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
    const s = await startServer({ port: 0, home, claudeDir, registryIsGone: ALL_ALIVE, uiDist: path.join(home, 'no-dist') });
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
    const s = await startServer({ port: 0, home, claudeDir, registryIsGone: ALL_ALIVE, uiDist: path.join(home, 'no-dist') });
    try {
      expect(fs.readFileSync(header, 'utf8')).toBe(`Authorization: Bearer ${tokenOf()}\n`);
      expectMode(header, 0o600);
    } finally {
      await s.close();
    }
  });

  it('トークンを作り直すと、ヘッダのファイルも次の起動で揃う', async () => {
    const header = path.join(home, 'statusline-header');
    const first = await startServer({ port: 0, home, claudeDir, registryIsGone: ALL_ALIVE, uiDist: path.join(home, 'no-dist') });
    await first.close();
    const old = tokenOf();
    fs.rmSync(path.join(home, 'token'));
    const second = await startServer({ port: 0, home, claudeDir, registryIsGone: ALL_ALIVE, uiDist: path.join(home, 'no-dist') });
    try {
      expect(tokenOf()).not.toBe(old);
      expect(fs.readFileSync(header, 'utf8')).toBe(`Authorization: Bearer ${tokenOf()}\n`);
    } finally {
      await second.close();
    }
  });

  // 偽の claude は sh の case で引数を見るので、Windows では飛ばす。
  posixIt('claude --help のサブコマンドで包みを書き直し、/api/compat と準備の確かめが版とずれを返す。閉じると compat.json に残る', async () => {
    const bin = writeFakeTool(path.join(home, 'bin'), 'claude', {
      sh: 'case "$1" in --version) echo "9.9.9 (Claude Code)" ;; --help) printf "Usage: claude\\n\\nCommands:\\n  agents [options]  Manage background agents\\n  newcmd            Something new\\n" ;; esac',
      cmd: '',
    });
    const prev = process.env.HANGAR_CLAUDE_BIN;
    process.env.HANGAR_CLAUDE_BIN = bin;
    try {
      const s = await startServer({ port: 0, home, claudeDir, registryIsGone: ALL_ALIVE, uiDist: path.join(home, 'no-dist') });
      try {
        const script = path.join(home, 'shell', 'claude.zsh');
        await until(async () => (fs.readFileSync(script, 'utf8').includes('    agents|newcmd) command claude') ? true : null));
        const res = await fetch(`http://127.0.0.1:${s.port}/api/compat`, { headers: { authorization: `Bearer ${tokenOf()}` } });
        const body = (await res.json()) as CompatDto;
        expect(body.verifiedVersion).toBe(VERIFIED_CLAUDE_VERSION);
        expect(body.localVersion).toBe('9.9.9');
        expect(body.drifts.map((d) => d.value)).toEqual(expect.arrayContaining(['subcommand.added=newcmd', 'subcommand.removed=purge']));
        // 確認リストが読む要約にも、同じずれの件数が載る。
        const ready = (await (await fetch(`http://127.0.0.1:${s.port}/api/readiness`, { headers: { authorization: `Bearer ${tokenOf()}` } })).json()) as ReadinessDto;
        expect(ready.compat.verifiedVersion).toBe(VERIFIED_CLAUDE_VERSION);
        expect(ready.compat.driftCount).toBeGreaterThanOrEqual(body.drifts.length);
      } finally {
        await s.close();
      }
      const saved = JSON.parse(fs.readFileSync(path.join(home, 'compat.json'), 'utf8')) as { entries: { value: string }[] };
      expect(saved.entries.map((e) => e.value)).toContain('subcommand.added=newcmd');
    } finally {
      if (prev === undefined) delete process.env.HANGAR_CLAUDE_BIN; else process.env.HANGAR_CLAUDE_BIN = prev;
    }
    // until の上限（8 秒）より長くし、失敗したときに until の言葉で落ちるようにする。
  }, 15_000);

  // 偽の claude は sh の case で引数を見るので、Windows では飛ばす。
  posixIt('前の記録と手元の claude の版が違えば、読んだ版で記録を空にし、その版を compat.json に残す', async () => {
    fs.writeFileSync(path.join(home, 'compat.json'), JSON.stringify({
      version: 1, localVersion: '1.0.0',
      entries: [{ contract: 'transcript', value: 'type=old', version: '1.0.0', count: 3, firstSeenAt: 1, lastSeenAt: 1 }],
    }));
    const bin = writeFakeTool(path.join(home, 'bin'), 'claude', { sh: 'case "$1" in --version) echo "9.9.9 (Claude Code)" ;; esac', cmd: '' });
    const prev = process.env.HANGAR_CLAUDE_BIN;
    process.env.HANGAR_CLAUDE_BIN = bin;
    try {
      const s = await startServer({ port: 0, home, claudeDir, registryIsGone: ALL_ALIVE, uiDist: path.join(home, 'no-dist') });
      try {
        const body = (await (await fetch(`http://127.0.0.1:${s.port}/api/compat`, { headers: { authorization: `Bearer ${tokenOf()}` } })).json()) as CompatDto;
        expect(body.localVersion).toBe('9.9.9');
        expect(body.drifts.map((d) => d.value)).not.toContain('type=old');
      } finally {
        await s.close();
      }
      const saved = JSON.parse(fs.readFileSync(path.join(home, 'compat.json'), 'utf8')) as { localVersion: unknown; entries: { value: string }[] };
      expect(saved.localVersion).toBe('9.9.9');
      expect(saved.entries.map((e) => e.value)).not.toContain('type=old');
    } finally {
      if (prev === undefined) delete process.env.HANGAR_CLAUDE_BIN; else process.env.HANGAR_CLAUDE_BIN = prev;
    }
  }, 15_000);

  // 偽の claude は sh の case と sleep を使うので、Windows では飛ばす。
  posixIt('版の変化で記録を空にしても、先に読み終えた claude --help のずれは数え直して残す', async () => {
    fs.writeFileSync(path.join(home, 'compat.json'), JSON.stringify({
      version: 1, localVersion: '1.0.0',
      entries: [{ contract: 'transcript', value: 'type=old', version: '1.0.0', count: 3, firstSeenAt: 1, lastSeenAt: 1 }],
    }));
    // --help が先に終わり、そのずれを記録した後で --version が届いて記録を空にする順にする。
    const bin = writeFakeTool(path.join(home, 'bin'), 'claude', {
      sh: 'case "$1" in --version) sleep 1; echo "9.9.9 (Claude Code)" ;; --help) printf "Usage: claude\\n\\nCommands:\\n  agents [options]  Manage background agents\\n  newcmd            Something new\\n" ;; esac',
      cmd: '',
    });
    process.env.HANGAR_CLAUDE_BIN = bin;
    const s = await startServer({ port: 0, home, claudeDir, registryIsGone: ALL_ALIVE, uiDist: path.join(home, 'no-dist') });
    try {
      const script = path.join(home, 'shell', 'claude.zsh');
      await until(async () => (fs.readFileSync(script, 'utf8').includes('    agents|newcmd) command claude') ? true : null));
      // 版の読み取り（1 秒）が終わり、記録を空にし終えるのを待つ。
      await new Promise((res) => setTimeout(res, 1_500));
      const body = (await (await fetch(`http://127.0.0.1:${s.port}/api/compat`, { headers: { authorization: `Bearer ${tokenOf()}` } })).json()) as CompatDto;
      expect(body.localVersion).toBe('9.9.9');
      const values = body.drifts.map((d) => d.value);
      expect(values).not.toContain('type=old');
      expect(values).toContain('subcommand.added=newcmd');
    } finally {
      await s.close();
    }
  }, 15_000);

  // 偽の claude は sh の case で引数を見るので、Windows では飛ばす。
  posixIt('設定の claudePath が空でも、準備の確かめの手元の版は /api/compat と同じ引き方（環境変数）で読む', async () => {
    fs.writeFileSync(path.join(home, 'settings.json'), JSON.stringify({ claudePath: null }));
    const bin = writeFakeTool(path.join(home, 'bin'), 'claude', { sh: 'case "$1" in --version) echo "9.9.9 (Claude Code)" ;; esac', cmd: '' });
    const prev = process.env.HANGAR_CLAUDE_BIN;
    process.env.HANGAR_CLAUDE_BIN = bin;
    try {
      const s = await startServer({ port: 0, home, claudeDir, registryIsGone: ALL_ALIVE, uiDist: path.join(home, 'no-dist') });
      try {
        const auth = { authorization: `Bearer ${tokenOf()}` };
        const ready = (await (await fetch(`http://127.0.0.1:${s.port}/api/readiness`, { headers: auth })).json()) as ReadinessDto;
        const compat = (await (await fetch(`http://127.0.0.1:${s.port}/api/compat`, { headers: auth })).json()) as CompatDto;
        // 道具の行は設定の claudePath を見るので空のまま。互換の要約だけがサーバの引き方に従う。
        expect(ready.tools.claude.path).toBeNull();
        expect(compat.localVersion).toBe('9.9.9');
        expect(ready.compat.localVersion).toBe(compat.localVersion);
      } finally {
        await s.close();
      }
    } finally {
      if (prev === undefined) delete process.env.HANGAR_CLAUDE_BIN; else process.env.HANGAR_CLAUDE_BIN = prev;
    }
  }, 15_000);

  it('試験の準備は claude を無いパスに向け、手元の本物の claude を起こさない', async () => {
    const s = await startServer({ port: 0, home, claudeDir, registryIsGone: ALL_ALIVE, uiDist: path.join(home, 'no-dist') });
    try {
      const body = (await (await fetch(`http://127.0.0.1:${s.port}/api/compat`, { headers: { authorization: `Bearer ${tokenOf()}` } })).json()) as CompatDto;
      expect(body.localVersion).toBeNull();
    } finally {
      await s.close();
    }
  });

  it('claude のパスが普通のファイルの下を指しても（ENOTDIR）、サーバは落ちず、/api/compat は手元の版を null で返す', async () => {
    const plain = path.join(home, 'plain');
    fs.writeFileSync(plain, 'not a directory\n');
    const prev = process.env.HANGAR_CLAUDE_BIN;
    process.env.HANGAR_CLAUDE_BIN = path.join(plain, 'claude');
    try {
      const s = await startServer({ port: 0, home, claudeDir, registryIsGone: ALL_ALIVE, uiDist: path.join(home, 'no-dist') });
      try {
        // 起動のときの裏の読み取り（--help と --version）が終わるのを待つ。ここで投げると、捕まらない拒否で Node ごと落ちる。
        await new Promise((res) => setTimeout(res, 500));
        const auth = { authorization: `Bearer ${tokenOf()}` };
        const res = await fetch(`http://127.0.0.1:${s.port}/api/compat`, { headers: auth });
        expect(res.status).toBe(200);
        expect(((await res.json()) as CompatDto).localVersion).toBeNull();
        // 閉じるまで生きていて、ほかの経路も答える。
        expect((await fetch(`http://127.0.0.1:${s.port}/api/readiness`, { headers: auth })).status).toBe(200);
      } finally {
        await s.close();
      }
    } finally {
      if (prev === undefined) delete process.env.HANGAR_CLAUDE_BIN; else process.env.HANGAR_CLAUDE_BIN = prev;
    }
  }, 15_000);

  // 偽の claude は sh の case と sleep を使うので、Windows では飛ばす。
  posixIt('claude のパスを変えた後に、前のパスの遅い読み取りが届いても、包みと手元の版は新しいパスのまま', async () => {
    const slow = writeFakeTool(path.join(home, 'slow'), 'claude', {
      sh: 'case "$1" in --version) sleep 2; echo "1.0.0 (Claude Code)" ;; --help) sleep 2; printf "Commands:\\n  oldcmd  Old\\n" ;; esac',
      cmd: '',
    });
    const fast = writeFakeTool(path.join(home, 'fast'), 'claude', {
      sh: 'case "$1" in --version) echo "9.9.9 (Claude Code)" ;; --help) printf "Commands:\\n  newcmd  New\\n" ;; esac',
      cmd: '',
    });
    // claudePath を設定で渡す。HANGAR_CLAUDE_BIN があると設定より先に効くので外す。
    fs.writeFileSync(path.join(home, 'settings.json'), JSON.stringify({ claudePath: slow }));
    const prev = process.env.HANGAR_CLAUDE_BIN;
    delete process.env.HANGAR_CLAUDE_BIN;
    try {
      const s = await startServer({ port: 0, home, claudeDir, registryIsGone: ALL_ALIVE, uiDist: path.join(home, 'no-dist') });
      try {
        const auth = { authorization: `Bearer ${tokenOf()}` };
        const r = await fetch(`http://127.0.0.1:${s.port}/api/settings`, {
          method: 'PATCH', headers: { ...auth, 'content-type': 'application/json' }, body: JSON.stringify({ claudePath: fast }),
        });
        expect(r.status).toBe(200);
        const script = path.join(home, 'shell', 'claude.zsh');
        await until(async () => (fs.readFileSync(script, 'utf8').includes('    newcmd) command claude') ? true : null));
        // 前のパスの読み取り（2 秒）が終わるのを待ってから確かめる。
        await new Promise((res) => setTimeout(res, 3_000));
        const text = fs.readFileSync(script, 'utf8');
        expect(text).toContain('    newcmd) command claude');
        expect(text).not.toContain('oldcmd');
        const body = (await (await fetch(`http://127.0.0.1:${s.port}/api/compat`, { headers: auth })).json()) as CompatDto;
        expect(body.localVersion).toBe('9.9.9');
      } finally {
        await s.close();
      }
    } finally {
      if (prev === undefined) delete process.env.HANGAR_CLAUDE_BIN; else process.env.HANGAR_CLAUDE_BIN = prev;
    }
  }, 20_000);

  it('/ws はクエリ文字列のトークンを受け付けない', async () => {
    // URL は Referer、代理のログ、シェルの履歴、ブラウザの履歴に残る。秘密をそこに置く経路を残さない。
    const s = await startServer({ port: 0, home, claudeDir, registryIsGone: ALL_ALIVE, uiDist: path.join(home, 'no-dist') });
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
    const s = await startServer({ port: 0, home, claudeDir, registryIsGone: ALL_ALIVE, uiDist: path.join(home, 'no-dist') });
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
    const s = await startServer({ port: 0, home, claudeDir, registryIsGone: ALL_ALIVE, uiDist: path.join(home, 'no-dist') });
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
    const s = await startServer({ port: 0, home, claudeDir, registryIsGone: ALL_ALIVE, uiDist: path.join(home, 'no-dist') });
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
    const s = await startServer({ port: 0, home, claudeDir, registryIsGone: ALL_ALIVE, uiDist: path.join(home, 'no-dist') });
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
    const s = await startServer({ port: 0, home, claudeDir, registryIsGone: ALL_ALIVE, uiDist: path.join(home, 'no-dist') });
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
    const s = await startServer({ port: 0, home, claudeDir, registryIsGone: ALL_ALIVE, uiDist: path.join(home, 'no-dist') });
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

  it('起動後にワークスペース直下の新しいフォルダのセッションが現れたら、その場でプロジェクトにする', async () => {
    const alpha = path.join(ws, 'alpha');
    fs.mkdirSync(alpha);
    writeTranscript(alpha, 'bbbbbbbb-0000-4000-8000-000000000021', 'first');
    fs.writeFileSync(path.join(home, 'settings.json'), JSON.stringify({ workspaceRoot: ws, claudeDir }));
    const s = await startServer({ port: 0, home, claudeDir, uiDist: path.join(home, 'no-dist') });
    const c = collector(s.port, tokenOf());
    try {
      await c.opened;
      // 起動の後で作ったフォルダ。起動時の全走査には載っていない。
      const fresh = path.join(ws, 'fresh');
      fs.mkdirSync(path.join(fresh, 'src'), { recursive: true });
      writeTranscript(path.join(fresh, 'src'), 'bbbbbbbb-0000-4000-8000-000000000022', 'hello');
      const ev = await c.waitFor((e): e is Extract<ServerEvent, { type: 'session.upsert' }> => e.type === 'session.upsert' && e.session.providerSessionId === 'bbbbbbbb-0000-4000-8000-000000000022' && e.session.projectId !== null);
      const proj = await c.waitFor((e): e is Extract<ServerEvent, { type: 'project.upsert' }> => e.type === 'project.upsert' && e.project.id === ev.session.projectId);
      expect(proj.project).toMatchObject({ name: 'fresh', path: fresh });
      // ワークスペースの中なので、未分類の知らせは出さない。
      expect(c.all().some((e) => e.type === 'toast' && e.message.includes(fresh))).toBe(false);
    } finally {
      c.close();
      await s.close();
    }
  }, 20000);

  it('実行中の登録が消えたら要約の状態を done に書き替える', async () => {
    const s = await startServer({ port: 0, home, claudeDir, registryIsGone: ALL_ALIVE, uiDist: path.join(home, 'no-dist') });
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
  it('実行中の登録が消えたら、答えを待っていた問いを消す。再開した直後に前の問いが出ない', async () => {
    const s = await startServer({ port: 0, home, claudeDir, registryIsGone: ALL_ALIVE, uiDist: path.join(home, 'no-dist') });
    const db = openDb(dbPath(home));
    try {
      const id = (db.prepare("select id from sessions where provider = 'claude-code' and provider_session_id = ?").get(SESSION_ALPHA) as { id: string }).id;
      db.prepare('insert or replace into session_activity (session_id, tool, summary, tool_id, question, updated_at) values (?,?,?,?,?,?)').run(id, 'AskUserQuestion', 'AskUserQuestion', 'toolu_1', 'どちらにしますか？', 1);
      const questionOf = () => (db.prepare('select question from session_activity where session_id = ?').get(id) as { question: string | null } | undefined)?.question;
      expect(questionOf()).toBe('どちらにしますか？');
      fs.rmSync(path.join(claudeDir, 'sessions', '12345.json'));
      await until(async () => (questionOf() === null ? true : null));
      // 最後の呼び出しは残す。消すのは問いだけである。
      expect(db.prepare('select tool from session_activity where session_id = ?').get(id)).toEqual({ tool: 'AskUserQuestion' });
    } finally {
      db.close();
      await s.close();
    }
  }, 20000);
  it('印を付けたセッションは、動きが変わるたびに行ごと配り直す。休みになれば parked が立ち、作業中に戻れば外れる', async () => {
    // UI は live.update から動きしか直せない。行を配り直さないと、休みになっても実行中の札に残る。
    // 偽の pid（12345）を生きていることにする。Windows の既定の判定では、無い pid の行は読み捨てられる。
    const s = await startServer({ port: 0, home, claudeDir, registryIsGone: ALL_ALIVE, uiDist: path.join(home, 'no-dist') });
    const token = tokenOf();
    const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
    const c = collector(s.port, token);
    try {
      await c.opened;
      const list = (await (await fetch(`http://127.0.0.1:${s.port}/api/sessions`, { headers })).json()) as SessionDto[];
      const alpha = list.find((x) => x.providerSessionId === SESSION_ALPHA)!;
      const put = await fetch(`http://127.0.0.1:${s.port}/api/sessions/${alpha.id}/state`, { method: 'PUT', headers, body: JSON.stringify({ status: 'paused', note: '明日見る', returnOn: '2099-01-01' }) });
      expect(put.status).toBe(200);
      const reg = path.join(claudeDir, 'sessions', '12345.json');
      const rec = JSON.parse(fs.readFileSync(reg, 'utf8')) as Record<string, unknown>;
      // 印より前に起動したプロセスが、休みになった。
      const upsertAfter = (from: number, pred: (x: SessionDto) => boolean) =>
        c.waitFor((e): e is Extract<ServerEvent, { type: 'session.upsert' }> => e.type === 'session.upsert' && e.session.id === alpha.id && c.all().indexOf(e) >= from && pred(e.session));
      let from = c.all().length;
      fs.writeFileSync(reg, JSON.stringify({ ...rec, status: 'idle', procStart: 'Tue Sep  1 10:00:00 2026' }));
      expect((await upsertAfter(from, (x) => x.live === 'idle')).session.parked).toBe(true);
      from = c.all().length;
      fs.writeFileSync(reg, JSON.stringify({ ...rec, status: 'busy', procStart: 'Tue Sep  1 10:00:00 2026' }));
      expect((await upsertAfter(from, (x) => x.live === 'busy')).session.parked).toBe(false);
    } finally {
      c.close();
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

  it('止めていなければ起動でクラウドを叩く', async () => {
    // この確かめ方でクラウドとの往復が見えることを、先に固定しておく。
    const rec = await recorder();
    saveCloudConfig(home, { url: rec.url, joinSecret: 'test-secret', deviceToken: 'test-device-token', workerName: null, accountId: null, dbName: null, bucketName: null, joinedAt: 1 });
    const s = await startServer({ port: 0, home, claudeDir, registryIsGone: ALL_ALIVE, uiDist: path.join(home, 'no-dist') });
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
    const s = await startServer({ port: 0, home, claudeDir, registryIsGone: ALL_ALIVE, uiDist: path.join(home, 'no-dist') });
    try {
      const status = await (await fetch(`http://127.0.0.1:${s.port}/api/sync/status`, { headers: { authorization: `Bearer ${tokenOf()}` } })).json() as { state: string };
      expect(status.state).toBe('paused');
      expect(rec.seen).toEqual([]);
    } finally {
      await s.close();
      await rec.close();
    }
  });

  it('一時停止のあいだでも、今すぐ同期を押した 1 回だけは叩き、停止に戻る', async () => {
    // 利用者が自分で押した 1 回は通す。メタデータだけでなく、本文と設定の出し入れ（/files）まで巡る。
    const rec = await recorder();
    saveCloudConfig(home, { url: rec.url, joinSecret: 'test-secret', deviceToken: 'test-device-token', workerName: null, accountId: null, dbName: null, bucketName: null, joinedAt: 1 });
    presetPaused();
    const s = await startServer({ port: 0, home, claudeDir, registryIsGone: ALL_ALIVE, uiDist: path.join(home, 'no-dist') });
    const call = (p: string, method = 'GET') => fetch(`http://127.0.0.1:${s.port}${p}`, { method, headers: { authorization: `Bearer ${tokenOf()}`, origin: `http://127.0.0.1:${s.port}` } });
    try {
      expect(rec.seen).toEqual([]);
      const now = await call('/api/sync/now', 'POST');
      expect(now.status).toBe(200);
      // 応答はメタデータの送受信が済んだ時点で返る。押しても止めた状態は変わらない。
      expect(((await now.json()) as { state: string }).state).toBe('paused');
      expect(rec.seen.some((r) => r.endsWith('/changes'))).toBe(true);
      // 残り（ファイルの取り込み）は裏で続く。出るまで待つ。
      for (let i = 0; i < 300 && !rec.seen.some((r) => r.includes('/files')); i++) await new Promise((r) => setTimeout(r, 10));
      expect(rec.seen.some((r) => r.includes('/files'))).toBe(true);
      // 1 巡が終わったら、もう叩かない。
      let settled = rec.seen.length;
      for (let i = 0; i < 50; i++) { await new Promise((r) => setTimeout(r, 20)); if (rec.seen.length === settled && i > 10) break; settled = rec.seen.length; }
      await new Promise((r) => setTimeout(r, 300));
      expect(rec.seen.length).toBe(settled);
      expect(((await (await call('/api/sync/status')).json()) as { state: string }).state).toBe('paused');
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
    const first = await startServer({ port: 0, home, claudeDir, registryIsGone: ALL_ALIVE, uiDist: path.join(home, 'no-dist') });
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
    const s = await startServer({ port: 0, home, claudeDir, registryIsGone: ALL_ALIVE, uiDist: path.join(home, 'no-dist') });
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
    const s = await startServer({ port: 0, home, claudeDir, registryIsGone: ALL_ALIVE, uiDist: path.join(home, 'no-dist') });
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

  it('一時停止のあいだは上げず、今すぐ同期を押した 1 回で取り残しを上げきる', async () => {
    setTranscriptMtime(Date.now() - 60_000);
    await indexWithoutCloud();
    seedTranscriptFloor(0);
    {
      const db = openDb(dbPath(home));
      try { db.prepare("insert into sync_state (key, value) values ('paused', '1') on conflict(key) do update set value = '1'").run(); } finally { db.close(); }
    }

    const sink = await fileSink();
    saveCloudConfig(home, { url: sink.url, joinSecret: 'test-secret', deviceToken: 'test-device-token', workerName: null, accountId: null, dbName: null, bucketName: null, joinedAt: 1 });
    const s = await startServer({ port: 0, home, claudeDir, registryIsGone: ALL_ALIVE, uiDist: path.join(home, 'no-dist') });
    const call = (p: string, method = 'GET') => fetch(`http://127.0.0.1:${s.port}${p}`, { method, headers: { authorization: `Bearer ${tokenOf()}`, origin: `http://127.0.0.1:${s.port}` } });
    try {
      // 止まっているあいだは、起動の走査も上げない。
      await new Promise((r) => setTimeout(r, 300));
      expect(sink.puts).toEqual([]);
      const now = await call('/api/sync/now', 'POST');
      expect(now.status).toBe(200);
      // 応答が返る時点では本文がまだ残っている。状態は paused のままなので、進んでいることは oncePass で伝える。
      expect(await now.json()).toMatchObject({ state: 'paused', oncePass: true });
      const keys = await until(async () => (sink.puts.length >= 3 ? sink.puts : null));
      expect(suffixes(keys)).toEqual([`${SESSION_ALPHA}.jsonl.gz`, `${SESSION_ALPHA}/subagents/agent-abc123.jsonl.gz`, `${SESSION_OTHER}.jsonl.gz`].sort());
      // 上げきっても、同期は止めたままである。
      const status = await until(async () => {
        const st = await (await call('/api/sync/status')).json() as SyncStatusBody;
        return st.sweepPending === 0 && st.oncePass === false ? st : null;
      });
      expect(status.state).toBe('paused');
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
    const s = await startServer({ port: 0, home, claudeDir, registryIsGone: ALL_ALIVE, uiDist: path.join(home, 'no-dist') });
    try {
      expect(fs.readdirSync(tr).sort()).toEqual(trNames.slice(7).sort());
      expect(fs.readdirSync(memos).sort()).toEqual(memoNames.slice(4).sort());
    } finally {
      await s.close();
    }
  });
});

describe('互換の版', () => {
  type Seen = { method: string; path: string; compat: string | undefined };
  /** raw があれば JSON にせずそのまま返す（Cloudflare が Worker の手前で返す error 1027 のような本文）。 */
  type Answer = { status: number; body: unknown; compat?: string; raw?: string };

  /** 決まった応答を返す立て替えの Worker。受けた要求と、載っていた版の見出しを記録する。実物のクラウドには触らない。 */
  async function fakeWorker(answer: (method: string, path: string) => Answer): Promise<{ url: string; seen: Seen[]; close: () => Promise<void> }> {
    const seen: Seen[] = [];
    const srv = http.createServer((req, res) => {
      const p = (req.url ?? '').split('?')[0]!;
      const h = req.headers[COMPAT_HEADER];
      seen.push({ method: req.method ?? '', path: p, compat: Array.isArray(h) ? h[0] : h });
      req.resume();
      const a = answer(req.method ?? '', p);
      res.writeHead(a.status, { 'content-type': a.raw === undefined ? 'application/json' : 'text/plain', ...(a.compat === undefined ? {} : { [COMPAT_HEADER]: a.compat }) });
      res.end(a.raw ?? JSON.stringify(a.body));
    });
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
    const port = (srv.address() as net.AddressInfo).port;
    return {
      url: `http://127.0.0.1:${port}`,
      seen,
      close: async () => { srv.closeAllConnections?.(); await new Promise<void>((r) => srv.close(() => r())); },
    };
  }

  /** 下限を上げた Worker の断り。 */
  const refuse = (floor: number): Answer => ({ status: 426, body: { error: 'upgrade required', minCompat: floor, compat: floor }, compat: String(floor) });
  const joinTo = (url: string): void => saveCloudConfig(home, { url, joinSecret: 'test-secret', deviceToken: 'test-device-token', workerName: null, accountId: null, dbName: null, bucketName: null, joinedAt: 1 });
  const syncStatus = async (port: number): Promise<SyncStatusBody> => (await (await fetch(`http://127.0.0.1:${port}/api/sync/status`, { headers: { authorization: `Bearer ${tokenOf()}` } })).json()) as SyncStatusBody;
  const pressSyncNow = async (port: number): Promise<SyncStatusBody> => {
    const r = await fetch(`http://127.0.0.1:${port}/api/sync/now`, { method: 'POST', headers: { authorization: `Bearer ${tokenOf()}`, origin: `http://127.0.0.1:${port}` } });
    expect(r.status).toBe(200);
    return (await r.json()) as SyncStatusBody;
  };
  const metaCalls = (seen: Seen[]): number => seen.filter((r) => r.path === '/changes' || r.path === '/rows').length;

  it('版で止まっている間は、本文と設定の出し入れも止める。頼まれた 1 巡の最中でも止める', () => {
    expect(syncHalted({ paused: false, oncePass: false, compatBlocked: false, limited: false })).toBe(false);
    expect(syncHalted({ paused: true, oncePass: false, compatBlocked: false, limited: false })).toBe(true);
    expect(syncHalted({ paused: true, oncePass: true, compatBlocked: false, limited: false })).toBe(false);
    expect(syncHalted({ paused: false, oncePass: false, compatBlocked: true, limited: false })).toBe(true);
    expect(syncHalted({ paused: true, oncePass: true, compatBlocked: true, limited: false })).toBe(true);
    expect(syncHalted({ paused: false, oncePass: false, compatBlocked: false, limited: true })).toBe(true);
    expect(syncHalted({ paused: true, oncePass: true, compatBlocked: false, limited: true })).toBe(true);
  });

  it('Worker に版が古いと断られたら、同期を止めて、この PC の hangar を上げるよう出す', async () => {
    const floor = COMPAT_VERSION + 1;
    const w = await fakeWorker(() => refuse(floor));
    joinTo(w.url);
    const s = await startServer({ port: 0, home, claudeDir, registryIsGone: ALL_ALIVE, uiDist: path.join(home, 'no-dist') });
    try {
      const st = await until(async () => { const v = await syncStatus(s.port); return v.state === 'error' ? v : null; });
      expect(st.error).toContain('この PC の hangar');
      expect(st.error).toContain(`${floor} 以上`);
      // 今すぐ同期を押せば 1 度だけ試し直す。まだ合わないので止まったまま。
      const before = metaCalls(w.seen);
      const after = await pressSyncNow(s.port);
      expect(after.state).toBe('error');
      expect(after.error).toContain('この PC の hangar');
      expect(metaCalls(w.seen)).toBeGreaterThan(before);
    } finally {
      await s.close();
      await w.close();
    }
  });

  it('一時停止中に今すぐ同期で断られたら理由を出し、もう一度押せばまた試し直す', async () => {
    const floor = COMPAT_VERSION + 1;
    const w = await fakeWorker(() => refuse(floor));
    joinTo(w.url);
    presetPaused();
    const s = await startServer({ port: 0, home, claudeDir, registryIsGone: ALL_ALIVE, uiDist: path.join(home, 'no-dist') });
    const c = collector(s.port, tokenOf());
    try {
      await c.opened;
      expect(w.seen).toEqual([]);
      const first = await pressSyncNow(s.port);
      expect(first.state).toBe('error');
      expect(first.error).toContain('この PC の hangar');
      // 1 巡の残り（本文と設定の出し入れ）が終わるまで待つ。
      await until(async () => { const v = await syncStatus(s.port); return v.oncePass ? null : v; });
      // 断られた後は、メタデータ以外の道（本文、設定、使用量）へ出ない。
      expect(w.seen.filter((r) => r.path !== '/changes' && r.path !== '/rows')).toEqual([]);
      // 何も同期していないのに「1 回だけ同期しました」を出さず、版の文で知らせる。
      const toast = await c.waitFor((e): e is Extract<ServerEvent, { type: 'toast' }> => e.type === 'toast' && e.message.includes('この PC の hangar'));
      expect(toast.level).toBe('error');
      expect(c.all().some((e) => e.type === 'toast' && e.message.includes('1 回だけ同期しました'))).toBe(false);
      const before = metaCalls(w.seen);
      const second = await pressSyncNow(s.port);
      expect(second.state).toBe('error');
      expect(metaCalls(w.seen)).toBeGreaterThan(before);
    } finally {
      c.close();
      await s.close();
      await w.close();
    }
  });

  it('Worker が版の見出しを返さない間（版 0）も同期は動き、要求にはこの PC の版を載せる', async () => {
    const w = await fakeWorker((method, p) => {
      if (p === '/rows') return { status: 200, body: { changes: [], nextAfter: null, seq: 0 } };
      if (p === '/changes' && method === 'GET') return { status: 200, body: { changes: [], nextSeq: 0, more: false } };
      if (p === '/changes') return { status: 200, body: { seq: 0, accepted: 0, skipped: 0 } };
      if (p === '/files') return { status: 200, body: { files: [], nextSeq: 0, more: false } };
      if (p.startsWith('/files/') && method === 'PUT') return { status: 201, body: { seq: 1 } };
      if (p === '/usage') return { status: 200, body: { configured: false } };
      return { status: 404, body: { error: 'not found' } };
    });
    joinTo(w.url);
    const s = await startServer({ port: 0, home, claudeDir, registryIsGone: ALL_ALIVE, uiDist: path.join(home, 'no-dist') });
    try {
      const st = await until(async () => { const v = await syncStatus(s.port); return v.lastPullAt !== null ? v : null; });
      expect(st.error).toBeNull();
      expect(st.state).not.toBe('error');
      expect(w.seen.length).toBeGreaterThan(0);
      for (const r of w.seen) expect(r.compat, `${r.method} ${r.path}`).toBe(String(COMPAT_VERSION));
    } finally {
      await s.close();
      await w.close();
    }
  });

  describe('上限で退く', () => {
    /** Worker が D1 の上限を 429 と決まった本文で返す（段 1 の PR 6 の Worker の形）。 */
    const limitAnswer = (): Answer => ({ status: 429, body: { error: 'limit', limit: 'd1-write', resetAt: Date.now() + 86_400_000 } });
    /** Workers の 1 日の要求の上限。Cloudflare が Worker の手前で、JSON でない本文で返す。 */
    const requestsAnswer = (): Answer => ({ status: 429, body: null, raw: 'error code: 1027' });
    const isToast = (e: ServerEvent): e is Extract<ServerEvent, { type: 'toast' }> => e.type === 'toast';
    const onceToasts = (c: ReturnType<typeof collector>): string[] => c.all().filter(isToast).map((e) => e.message).filter((m) => m.includes('1 回だけ同期しました'));
    /** 1 巡の終わり（done）が配る知らせが届くだけの間を置く。 */
    const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 300));

    it('退いていて利用者は止めていないときの今すぐ同期は、1 巡の道に回らず、1 回だけの知らせも出さない', async () => {
      const w = await fakeWorker(() => limitAnswer());
      joinTo(w.url);
      const s = await startServer({ port: 0, home, claudeDir, registryIsGone: ALL_ALIVE, uiDist: path.join(home, 'no-dist') });
      const c = collector(s.port, tokenOf());
      try {
        await c.opened;
        await until(async () => { const v = await syncStatus(s.port); return v.state === 'paused' && v.limitedUntil !== null ? v : null; });
        const before = w.seen.length;
        const after = await pressSyncNow(s.port);
        expect(after.state).toBe('paused');
        expect(after.limitedUntil).not.toBeNull();
        // 試し直したのはメタデータの送受信である。
        // 印を外して試す間は止まっていないので、使用量も 1 度取り直す（本文と設定の道へは出ない）。
        expect(metaCalls(w.seen.slice(before))).toBeGreaterThan(0);
        await settle();
        expect(w.seen.slice(before).filter((r) => r.path !== '/changes' && r.path !== '/rows' && r.path !== '/usage')).toEqual([]);
        // 利用者は止めていないので、一時停止のまま頼まれた 1 巡（PausedPass）には回らない。
        expect(c.all().some((e) => e.type === 'sync.status' && e.status.oncePass)).toBe(false);
        expect(onceToasts(c)).toEqual([]);
      } finally {
        c.close();
        await s.close();
        await w.close();
      }
    });

    it('一時停止中に頼んだ 1 巡のメタデータが上限で断られたら、本文、設定、使用量の道へ出ない', async () => {
      const w = await fakeWorker(() => requestsAnswer());
      joinTo(w.url);
      presetPaused();
      const s = await startServer({ port: 0, home, claudeDir, registryIsGone: ALL_ALIVE, uiDist: path.join(home, 'no-dist') });
      try {
        expect(w.seen).toEqual([]);
        const first = await pressSyncNow(s.port);
        expect(first.state).toBe('paused');
        expect(metaCalls(w.seen)).toBeGreaterThan(0);
        // 1 巡の残り（本文と設定の出し入れ、使用量）が終わるまで待つ。
        await until(async () => { const v = await syncStatus(s.port); return v.oncePass ? null : v; });
        await settle();
        // 上限で退いた後は、1 巡の最中でもメタデータ以外の道（本文の降ろし、設定の押し出し、本文の上げ、使用量）へ出ない。
        expect(w.seen.filter((r) => r.path !== '/changes' && r.path !== '/rows')).toEqual([]);
      } finally {
        await s.close();
        await w.close();
      }
    });

    it('一時停止中に頼んだ 1 巡が上限で断られたら、その終わりに成功や残りの件数の知らせを重ねない', async () => {
      const w = await fakeWorker(() => limitAnswer());
      joinTo(w.url);
      presetPaused();
      // 送れずに残る行を 1 つ作る。上限で早く抜けなければ「残りました」の知らせが出る形にする。
      const db = openDb(dbPath(home));
      try { upsertShared(db, 'projects', { id: 'p-limit', name: 'p-limit', status: 'active', is_scratch: 0 }, 'test'); } finally { db.close(); }
      const s = await startServer({ port: 0, home, claudeDir, registryIsGone: ALL_ALIVE, uiDist: path.join(home, 'no-dist') });
      const c = collector(s.port, tokenOf());
      try {
        await c.opened;
        await pressSyncNow(s.port);
        await until(async () => { const v = await syncStatus(s.port); return v.oncePass ? null : v; });
        await settle();
        const st = await syncStatus(s.port);
        expect(st.state).toBe('paused');
        expect(st.pending).toBeGreaterThan(0);
        expect(onceToasts(c)).toEqual([]);
      } finally {
        c.close();
        await s.close();
        await w.close();
      }
    });
  });
});
