import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { COMPAT_VERSION, type ServerEvent, type SyncStatusBody } from '@agent-hangar/shared';
import { saveCloudConfig } from '../config/cloud.ts';
import { dbPath } from '../config/paths.ts';
import { openDb } from '../db/open.ts';
import { upsertShared } from '../db/shared.ts';
import type { NoticeEvent } from '../events/publisher.ts';
import { IndexerService } from '../indexer/service.ts';
import { BACKUP_GENERATIONS } from '../sync/claudeConfig.ts';
import { MEMO_BACKUP_KEEP_COUNT, MEMO_BACKUP_KEEP_DAYS } from '../sync/pruneBackups.ts';
import { memoLossHandlers, toastVia } from '../sync/notices.ts';
import { SyncStateStore } from '../sync/state.ts';
import { answerAll, fakeWorker, fileSink, recorder, refuse, type Answer, type Seen } from '../../test/fake-worker.ts';
import { copyFixtureClaudeDir, SESSION_ALPHA, SESSION_OTHER } from '../../test/fixtures.ts';
import { bootHome, type HomeParts } from './home.ts';
import { bootSync, UPLOAD_SWEEP_MS, type SyncParts } from './sync.ts';

/**
 * 同期の組み立て（boot/sync.ts）だけを起こして確かめる。
 * 待ち受けも、索引の見張りも、run も起こさない。画面へ配る口は、配られたものを貯めるだけの立て替えである。
 * 宛先は、誰も待ち受けていないループバックか、手元の立て替えの Worker である。実物のクラウドには触らない。
 */

let home: string;
let claudeDir: string;
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'hangar-home-'));
  claudeDir = copyFixtureClaudeDir();
});
afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(claudeDir, { recursive: true, force: true });
});

const joinTo = (url: string, joinedAt = 1): void => saveCloudConfig(home, { url, joinSecret: 'test-secret', deviceToken: 'test-device-token', workerName: null, accountId: null, dbName: null, bucketName: null, joinedAt });
/** 誰も待ち受けていないループバック。 */
const NOWHERE = 'http://127.0.0.1:9';

/**
 * 本文をどこから上げるかの床（sync_state の transcriptsFrom）を先に置く。
 * 組み立ては行が無いときだけ刻むので、ここで置いた値がそのまま使われる。
 * 0 は床なしで、手元の本文を全部「まだ上がっていない」と数えさせる。
 */
const seedTranscriptFloor = (value: number): void => {
  const db = openDb(dbPath(home));
  try { new SyncStateStore(db).set('transcriptsFrom', value); } finally { db.close(); }
};
/** 組み立てより先に DB を作って、同期を止めた状態にしておく。 */
function presetPaused(): void {
  const db = openDb(dbPath(home));
  try { db.prepare("insert into sync_state (key, value) values ('paused', '1') on conflict(key) do update set value = '1'").run(); } finally { db.close(); }
}

/** 条件が満たされるまで一定間隔で試す。 */
async function until<T>(fn: () => T | null | Promise<T | null>, ms = 8000): Promise<T> {
  const limit = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v !== null) return v;
    if (Date.now() > limit) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 20));
  }
}

type Booted = {
  h: HomeParts; sync: SyncParts; sent: NoticeEvent[];
  /** HTTP の GET /api/sync/status が返すのと同じ形。 */
  status(): SyncStatusBody;
  /** 利用者が押した「今すぐ同期」。HTTP の POST /api/sync/now と同じく、済んだ時点の状態を返す。 */
  pressSyncNow(): Promise<SyncStatusBody>;
  toasts(): Extract<ServerEvent, { type: 'toast' }>[];
  close(): Promise<void>;
};
const booted: Booted[] = [];
afterEach(async () => { for (const b of booted.splice(0)) await b.close(); });

/** 置き場と同期だけを組む。start を渡さなければ、組むだけで走らせない。 */
function boot(o: { start?: boolean; index?: boolean } = {}): Booted {
  const h = bootHome({ home, claudeDir });
  const sent: NoticeEvent[] = [];
  const hub = { broadcast: (ev: NoticeEvent) => { sent.push(ev); } };
  const sync = bootSync(h, { hub, toast: toastVia(hub) }, { memoPath: (id) => path.join(home, 'projects', id, 'memo.md') });
  const status = (): SyncStatusBody => ({ ...sync.engine.status(), skipped: sync.feed.skipped(), sweepPending: sync.feed.sweep(), oncePass: sync.feed.oncePass() });
  let closed = false;
  const b: Booted = {
    h, sync, sent, status,
    pressSyncNow: async () => { await sync.syncNow(); return status(); },
    toasts: () => sent.filter((e): e is Extract<ServerEvent, { type: 'toast' }> => e.type === 'toast'),
    close: async () => {
      if (closed) return;
      closed = true;
      sync.stopTimers();
      await sync.drain(() => 2000);
      h.stop();
    },
  };
  booted.push(b);
  if (o.start) sync.start();
  return b;
}

/** 見本の 3 件の本文を、同期を組む前の DB に索引しておく。全体の起動では、索引が先に済んでいる。 */
async function indexFixture(): Promise<void> {
  const db = openDb(dbPath(home));
  try { await new IndexerService({ db, deviceId: 'd', claudeDir, isRunning: () => false }).fullScan(); } finally { db.close(); }
}

describe('同期の組み立て', () => {
  it('言語を en にすると、保持期間を書けない理由と、メモの競合の知らせが英語になる', () => {
    fs.writeFileSync(path.join(claudeDir, 'settings.json'), '{ broken');
    fs.writeFileSync(path.join(home, 'settings.json'), JSON.stringify({ language: 'en' }));
    const b = boot();
    const reason = b.sync.retention.current().unwritableReason;
    expect(reason).not.toBeNull();
    expect(reason).not.toMatch(/[\u3040-\u30ff\u4e00-\u9fff]/);
    // 置き場の言語の関数が、知らせにも渡っている。
    memoLossHandlers({ memoPath: () => path.join(home, 'projects', 'p1', 'memo.md'), toast: toastVia({ broadcast: (ev) => { b.sent.push(ev); } }), pruneMemos: () => {}, language: b.h.language })
      .onMemoConflict({ projectId: 'p1', markdown: 'x', deviceName: 'mini' });
    expect(b.toasts().at(-1)!.message).toMatch(/^The note had a conflict\. Your local content is kept in memo\.conflict-mini-/);
  });

  it('cloud.json が無ければ同期は off で、部品は動く', async () => {
    // 参加していない端末でも、同期の口は落ちずに「off」を返す。
    // 実物のクラウドには一切触らない（cloud.json が無いので client は作られない）。
    const b = boot({ start: true });
    expect(b.status()).toMatchObject({ state: 'off', url: null, pending: expect.any(Number), skipped: [], sweepPending: null, oncePass: false });
    // 参加していないので、参加トークンも設定の同期も無い。
    expect(b.sync.joinToken()).toBeNull();
    expect(b.sync.configSync).toBeNull();
    expect(b.sync.uploader).toBeNull();
    expect(() => b.sync.engine.onFocus()).not.toThrow();
    await expect(b.sync.syncNow()).resolves.toBeUndefined();
    expect(() => b.sync.unconfirmConfigPull()).not.toThrow();
    expect(b.sync.cloudUsage.current()).toBeNull();
  });

  it('cloud.json があれば部品が組み上がり、繋がらなくても起動は終わる', () => {
    // ここで見たいのは、cloud.json から client と鍵と上げ下ろしの部品が組み上がり、
    // 状態が off ではなくなり、参加トークンが作れることである。
    joinTo(NOWHERE);
    const b = boot({ start: true });
    // 繋がらないので idle にはならないが、off でもない（off は「参加していない」の意味である）。
    expect(b.status().state).not.toBe('off');
    expect(b.status().url).toBe(NOWHERE);
    // 参加トークンは中身を見ない。秘密が差分やログに出ないようにする。
    const jt = b.sync.joinToken();
    expect(typeof jt).toBe('string');
    expect((jt ?? '').length).toBeGreaterThan(0);
    // 設定の同期の部品も組み上がっている（未確認なので confirmed は false）。
    const preview = b.sync.configSync!.preview();
    expect(preview.confirmed).toBe(false);
    expect(Array.isArray(preview.entries)).toBe(true);
    expect(b.sync.uploader).not.toBeNull();
  });

  it('cloud.json が壊れていれば、未参加と同じに扱わずに、止めたまま知らせる', () => {
    // 参加し直すと別の joinSecret が入り、既存の暗号化ファイルを誰も復号できなくなる。
    fs.writeFileSync(path.join(home, 'cloud.json'), '{ not json');
    const logged: string[] = [];
    const real = console.error;
    console.error = (...a: unknown[]) => { logged.push(a.map(String).join(' ')); };
    try {
      const b = boot();
      expect(b.status().state).toBe('off');
    } finally {
      console.error = real;
    }
    expect(logged.some((l) => l.includes('cloud.json を読めませんでした'))).toBe(true);
  });

  it('床が無ければ参加した時刻を保険で刻み、古いサーバが先に走った跡では床を消さない', () => {
    // 実物で起きた筋である。
    // 床を刻まない古いサーバが先に起動して lastSeq と filesSeq を書いた端末で、
    // 新しいサーバが「もう同期した端末だから床は要らない」と判断し、過去の本文を全部上げてしまった。
    const joinedAt = 1_700_000_000_000;
    joinTo(NOWHERE, joinedAt);
    {
      // 床を刻まない古いサーバが先に走った跡を作る。進み具合だけがあり、床は無い。
      const db = openDb(dbPath(home));
      try {
        const st = new SyncStateStore(db);
        st.set('lastSeq', 42);
        st.set('filesSeq', 7);
      } finally { db.close(); }
    }
    const b = boot();
    expect(b.sync.syncState.get('transcriptsFrom')).toBe(String(joinedAt));
  });

  it('joinedAt の無い cloud.json でも、床なし（0）にはせず今の時刻を床にする', () => {
    // 床の行が無い DB（作り直した DB、cloud.json だけを写した試しの HANGAR_HOME）で床なしにすると、手元の本文を全部上げてしまう。
    joinTo(NOWHERE, 0);
    const before = Date.now();
    const b = boot();
    expect(Number(b.sync.syncState.get('transcriptsFrom'))).toBeGreaterThanOrEqual(before);
  });

  it('参加していない端末では、床を刻まない', () => {
    const b = boot();
    expect(b.sync.syncState.get('transcriptsFrom')).toBeNull();
  });

  it('websocket の sync.status が付録を運び、件数が減れば画面にも届く', async () => {
    // レビュアの再現筋である。
    // 付録を運ぶのが HTTP だけだと、サーバの取り残しが 0 になっても画面は 3 のまま固まる。
    // 諦めた本文の赤い行も、回復したあと消えなくなる。
    joinTo(NOWHERE);
    // ここで見たいのは件数の届き方なので、床は落としておく（そうしないと取り残しは 0 から動かない）。
    seedTranscriptFloor(0);
    await indexFixture();
    const b = boot({ start: true });
    const isStatus = (e: NoticeEvent): e is Extract<ServerEvent, { type: 'sync.status' }> => e.type === 'sync.status';
    // 取り残しが減る前の通知を拾ってしまわないように、必ず印より後ろだけを見る。
    const nextStatus = (mark: number) => until(() => b.sent.slice(mark).find(isStatus) ?? null);
    // 索引が済んでいると、まだ一度も上げていない本文が取り残しとして数えられる。
    const before = b.status().sweepPending!;
    expect(before).toBeGreaterThan(0);
    // focus は本体を持たない。状態は配る口だけで届く。
    const mark1 = b.sent.length;
    b.sync.engine.onFocus();
    const first = await nextStatus(mark1);
    expect(first.status.sweepPending).toBe(before);
    expect(first.status.skipped).toEqual([]);
    // 台帳を直して、取り残しを 0 にする。
    const { db } = b.h;
    const rows = db.prepare('select t.agent_id a, t.size z, s.provider_session_id u from transcript_files t join sessions s on s.id = t.session_id where t.device_id is null').all() as { a: string | null; z: number; u: string }[];
    expect(rows.length).toBeGreaterThan(0);
    const deviceId = b.h.device.id;
    const put = db.prepare('insert or replace into file_sync (key, kind, path, device_id, sha256, size, mtime, remote_seq, synced_at) values (?,?,?,?,?,?,?,?,?)');
    for (const r of rows) {
      const key = r.a === null ? `transcripts/${deviceId}/${r.u}.jsonl.gz` : `transcripts/${deviceId}/${r.u}/subagents/agent-${r.a}.jsonl.gz`;
      put.run(key, 'transcript', key, deviceId, 'x'.repeat(64), r.z, 1, 1, 1);
    }
    expect(b.status().sweepPending).toBe(0);
    // ここが要である。配る口だけで届く状態が、減った件数を運ぶ。
    const mark2 = b.sent.length;
    b.sync.engine.onFocus();
    const after = await nextStatus(mark2);
    expect(after.status.sweepPending).toBe(0);
    expect(after.status.skipped).toEqual([]);
  }, 20000);

  it('設定の取り込みの確認は、一度取り込めば立ち、降ろせばもう一度求める', async () => {
    // 設定の同期を切ったときに降ろす口である（config/settingsUpdate.ts が呼ぶ）。
    joinTo(NOWHERE);
    const b = boot();
    const confirmed = (): boolean => b.sync.configSync!.preview().confirmed;
    expect(confirmed()).toBe(false);
    // 一度だけ確認して取り込む。相手の設定は 1 件も無いので、ここで外へは出ない。
    await b.sync.configSync!.pull();
    expect(confirmed()).toBe(true);
    b.sync.unconfirmConfigPull();
    expect(confirmed()).toBe(false);
  });

  it('設定の同期の入り切りは、いまの設定と確認の印から表示へ載せ直す', () => {
    joinTo(NOWHERE);
    const b = boot();
    b.h.settings.current = { ...b.h.settings.current, syncClaudeConfig: true };
    b.sync.publishConfigSync();
    expect(b.status().claudeConfig).toEqual({ enabled: true, confirmed: false });
  });

  it('走査の間隔は設定の同期と揃えてある', () => {
    // 片方だけ直すと、また兄弟の経路が食い違う。
    expect(UPLOAD_SWEEP_MS).toBe(60_000);
  });

  it('起動のときに、本文の控えを上限まで刈り、メモの控えは件数を超えた古いものだけ刈る', () => {
    const seed = (dir: string, n: number, ext: string): string[] => {
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      const names: string[] = [];
      for (let i = 0; i < n; i++) {
        const name = `z${(n - i).toString().padStart(3, '0')}-20260101-00${i.toString().padStart(4, '0')}${ext}`;
        const f = path.join(dir, name);
        fs.writeFileSync(f, `${i}\n`, { mode: 0o600 });
        const t = new Date(1_700_000_000_000 + i * 1000);
        fs.utimesSync(f, t, t);
        names.push(name);
      }
      return names;
    };
    const tr = path.join(home, 'backups', 'transcripts');
    const memos = path.join(home, 'backups', 'memos');
    const trNames = seed(tr, BACKUP_GENERATIONS + 7, '.jsonl');
    /** 更新時刻が at の控えを n 件置く。 */
    const seedAged = (n: number, prefix: string, at: number): string[] => {
      fs.mkdirSync(memos, { recursive: true, mode: 0o700 });
      const names: string[] = [];
      for (let i = 0; i < n; i++) {
        const name = `session-${prefix}${i}-20260101-000000.md`;
        fs.writeFileSync(path.join(memos, name), `${i}\n`, { mode: 0o600 });
        fs.utimesSync(path.join(memos, name), new Date(at), new Date(at));
        names.push(name);
      }
      return names;
    };
    // 件数の内なら、どれだけ古くても残る。件数を超えた分のうち、保つ日数より古い控えだけが消える。
    const fresh = seedAged(MEMO_BACKUP_KEEP_COUNT, 'new', Date.now() - 86_400_000);
    seedAged(3, 'old', Date.now() - (MEMO_BACKUP_KEEP_DAYS + 1) * 86_400_000);
    boot({ start: true });
    expect(fs.readdirSync(tr).sort()).toEqual(trNames.slice(7).sort());
    expect(fs.readdirSync(memos).sort()).toEqual(fresh.sort());
  });

  it('止めた後は、定期の仕事も通信も残さない', async () => {
    const rec = await recorder();
    try {
      joinTo(rec.url);
      const b = boot({ start: true });
      await until(() => (rec.seen.length > 0 ? true : null));
      await b.close();
      const settled = rec.seen.length;
      await new Promise((r) => setTimeout(r, 200));
      expect(rec.seen.length).toBe(settled);
    } finally {
      await rec.close();
    }
  });
});

describe('一時停止は外と話さない', () => {
  it('止めていなければ起動でクラウドを叩く', async () => {
    // この確かめ方でクラウドとの往復が見えることを、先に固定しておく。
    const rec = await recorder();
    try {
      joinTo(rec.url);
      boot({ start: true });
      // 最初の同期は起動を待たせない。だから往復は start が返った少し後に出る。出るまで待つ。
      await until(() => (rec.seen.length > 0 ? true : null), 3000);
      expect(rec.seen.length).toBeGreaterThan(0);
    } finally {
      await booted[0]?.close();
      await rec.close();
    }
  });

  it('一時停止のあいだは、起動のファイルの取り込みも含めて 1 度も叩かない', async () => {
    // 「一時停止」は外と話すのをやめることである。Cloudflare の上限で退いている間も同じである。
    // 止まっているあいだに R2 へ出入りする経路が残っていると、課金されない約束が崩れる。
    const rec = await recorder();
    try {
      joinTo(rec.url);
      presetPaused();
      const b = boot({ start: true });
      // 止めていない回なら往復が出るだけの間を置く。
      await new Promise((r) => setTimeout(r, 300));
      expect(b.status().state).toBe('paused');
      expect(rec.seen).toEqual([]);
    } finally {
      await booted[0]?.close();
      await rec.close();
    }
  });

  it('一時停止のあいだでも、今すぐ同期を押した 1 回だけは叩き、停止に戻る', async () => {
    // 利用者が自分で押した 1 回は通す。メタデータだけでなく、本文と設定の出し入れ（/files）まで巡る。
    const rec = await recorder();
    try {
      joinTo(rec.url);
      presetPaused();
      // 全体の起動では索引が先に済んでいて、送る行（セッション）がある。送る行が無いと、メタデータの送信（/changes）は出ない。
      await indexFixture();
      const b = boot({ start: true });
      expect(rec.seen).toEqual([]);
      // 応答はメタデータの送受信が済んだ時点で返る。押しても止めた状態は変わらない。
      expect((await b.pressSyncNow()).state).toBe('paused');
      expect(rec.seen.some((r) => r.endsWith('/changes'))).toBe(true);
      // 残り（ファイルの取り込み）は裏で続く。出るまで待つ。
      await until(() => (rec.seen.some((r) => r.includes('/files')) ? true : null), 3000);
      // 1 巡が終わったら、もう叩かない。
      await until(() => (b.status().oncePass ? null : true));
      const settled = rec.seen.length;
      await new Promise((r) => setTimeout(r, 300));
      expect(rec.seen.length).toBe(settled);
      expect(b.status().state).toBe('paused');
    } finally {
      await booted[0]?.close();
      await rec.close();
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
  /**
   * 本文が最後に動いた時刻を決める。索引する前に置くので、台帳にはこの値がそのまま入る。
   * only を渡すと、パスにその文字列を含む本文だけを動かす。
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
  const ALL = [`${SESSION_ALPHA}.jsonl.gz`, `${SESSION_ALPHA}/subagents/agent-abc123.jsonl.gz`, `${SESSION_OTHER}.jsonl.gz`].sort();

  it('参加より前に止まっていた本文は上げず、その後に動いた本文だけを上げる', async () => {
    // 参加の前後を、本文が最後に動いた時刻で作り分ける。
    // alpha の 2 件は参加より前で止まっていて、other の 1 件は参加より後に動いている。
    const base = Date.now();
    setTranscriptMtime(base - 120_000);
    setTranscriptMtime(base - 60_000, SESSION_OTHER);
    await indexFixture();
    seedTranscriptFloor(base - 90_000);
    const sink = await fileSink();
    try {
      joinTo(sink.url);
      const b = boot({ start: true });
      await until(() => (sink.puts.length >= 1 ? sink.puts : null));
      // 参加より前で止まっている 2 件（alpha の本文と subagent）は上がらない。
      await new Promise((r) => setTimeout(r, 300));
      expect(suffixes(sink.puts)).toEqual([`${SESSION_OTHER}.jsonl.gz`]);
      // 画面に出す「未送信の本文」も、上がる予定の無い 2 件を数えない。
      expect(b.status().sweepPending).toBe(0);
    } finally {
      await booted[0]?.close();
      await sink.close();
    }
  }, 20000);

  it('床を落とせば、参加より前の本文も上がる', async () => {
    // hangar cloud backfill が書くのがこの 0 である。
    setTranscriptMtime(Date.now() - 60_000);
    await indexFixture();
    seedTranscriptFloor(0);
    const sink = await fileSink();
    try {
      joinTo(sink.url);
      boot({ start: true });
      const keys = await until(() => (sink.puts.length >= 3 ? sink.puts : null));
      expect(suffixes(keys)).toEqual(ALL);
      // 上げ終わったものを上げ直さない。
      await new Promise((r) => setTimeout(r, 300));
      expect(sink.puts.length).toBe(3);
    } finally {
      await booted[0]?.close();
      await sink.close();
    }
  }, 20000);

  it('一時停止のあいだは上げず、今すぐ同期を押した 1 回で取り残しを上げきる', async () => {
    setTranscriptMtime(Date.now() - 60_000);
    await indexFixture();
    seedTranscriptFloor(0);
    presetPaused();
    const sink = await fileSink();
    try {
      joinTo(sink.url);
      const b = boot({ start: true });
      // 止まっているあいだは、起動の走査も上げない。
      await new Promise((r) => setTimeout(r, 300));
      expect(sink.puts).toEqual([]);
      // 応答が返る時点では本文がまだ残っている。状態は paused のままなので、進んでいることは oncePass で伝える。
      expect(await b.pressSyncNow()).toMatchObject({ state: 'paused', oncePass: true });
      const keys = await until(() => (sink.puts.length >= 3 ? sink.puts : null));
      expect(suffixes(keys)).toEqual(ALL);
      // 上げきっても、同期は止めたままである。
      const status = await until(() => { const st = b.status(); return st.sweepPending === 0 && st.oncePass === false ? st : null; });
      expect(status.state).toBe('paused');
    } finally {
      await booted[0]?.close();
      await sink.close();
    }
  }, 20000);
});

describe('互換の版', () => {
  const metaCalls = (seen: Seen[]): number => seen.filter((r) => r.path === '/changes' || r.path === '/rows').length;
  let w: Awaited<ReturnType<typeof fakeWorker>> | null = null;
  const worker = async (answer: (method: string, path: string) => Answer) => {
    w = await fakeWorker(answer);
    joinTo(w.url);
    return w;
  };
  afterEach(async () => {
    for (const b of booted.splice(0)) await b.close();
    await w?.close();
    w = null;
  });

  it('Worker に版が古いと断られたら、同期を止めて、この PC の hangar を上げるよう出す', async () => {
    const floor = COMPAT_VERSION + 1;
    const wk = await worker(() => refuse(floor));
    const b = boot({ start: true });
    const st = await until(() => { const v = b.status(); return v.state === 'error' ? v : null; });
    expect(st.error).toContain('この PC の hangar');
    expect(st.error).toContain(`${floor} 以上`);
    // 今すぐ同期を押せば 1 度だけ試し直す。まだ合わないので止まったまま。
    const before = metaCalls(wk.seen);
    const after = await b.pressSyncNow();
    expect(after.state).toBe('error');
    expect(after.error).toContain('この PC の hangar');
    expect(metaCalls(wk.seen)).toBeGreaterThan(before);
  });

  it('一時停止中に今すぐ同期で断られたら理由を出し、もう一度押せばまた試し直す', async () => {
    const floor = COMPAT_VERSION + 1;
    const wk = await worker(() => refuse(floor));
    presetPaused();
    const b = boot({ start: true });
    expect(wk.seen).toEqual([]);
    const first = await b.pressSyncNow();
    expect(first.state).toBe('error');
    expect(first.error).toContain('この PC の hangar');
    expect(first.paused).toBe(true);
    // 1 巡の残り（本文と設定の出し入れ）が終わるまで待つ。
    await until(() => (b.status().oncePass ? null : true));
    // 断られた後は、メタデータ以外の道（本文、設定、使用量）へ出ない。
    expect(wk.seen.filter((r) => r.path !== '/changes' && r.path !== '/rows')).toEqual([]);
    // 何も同期していないのに「1 回だけ同期しました」を出さず、版の文で知らせる。
    const toast = await until(() => b.toasts().find((e) => e.message.includes('この PC の hangar')) ?? null);
    expect(toast.level).toBe('error');
    expect(b.toasts().some((e) => e.message.includes('1 回だけ同期しました'))).toBe(false);
    const before = metaCalls(wk.seen);
    const second = await b.pressSyncNow();
    expect(second.state).toBe('error');
    expect(metaCalls(wk.seen)).toBeGreaterThan(before);
  });

  it('Worker が版を名乗れば同期は動き、要求にはこの PC の版を載せる', async () => {
    const wk = await worker(answerAll(String(COMPAT_VERSION)));
    const b = boot({ start: true });
    const st = await until(() => { const v = b.status(); return v.lastPullAt !== null ? v : null; });
    expect(st.error).toBeNull();
    expect(st.state).not.toBe('error');
    expect(wk.seen.length).toBeGreaterThan(0);
    for (const r of wk.seen) expect(r.compat, `${r.method} ${r.path}`).toBe(String(COMPAT_VERSION));
  });

  it('Worker が版の見出しを返さなければ（版 0）、同期を止めて Worker を上げるよう出す', async () => {
    await worker(answerAll(undefined));
    const b = boot({ start: true });
    const st = await until(() => { const v = b.status(); return v.state === 'error' ? v : null; });
    expect(st.error).toContain('Worker');
    expect(st.error).toContain('今すぐ同期');
  });

  describe('上限で退く', () => {
    /** Worker が D1 の上限を 429 と決まった本文で返す（段 1 の PR 6 の Worker の形）。 */
    const limitAnswer = (): Answer => ({ status: 429, body: { error: 'limit', limit: 'd1-write', resetAt: Date.now() + 86_400_000 } });
    /** Workers の 1 日の要求の上限。Cloudflare が Worker の手前で、JSON でない本文で返す。 */
    const requestsAnswer = (): Answer => ({ status: 429, body: null, raw: 'error code: 1027' });
    const onceToasts = (b: Booted): string[] => b.toasts().map((e) => e.message).filter((m) => m.includes('1 回だけ同期しました'));
    /** 1 巡の終わり（done）が配る知らせが届くだけの間を置く。 */
    const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 300));
    afterEach(() => { vi.useRealTimers(); });

    it('退いていて利用者は止めていないときの今すぐ同期は、1 巡の道に回らず、1 回だけの知らせも出さない', async () => {
      const wk = await worker(() => limitAnswer());
      const b = boot({ start: true });
      await until(() => { const v = b.status(); return v.state === 'paused' && v.limitedUntil !== null ? v : null; });
      const before = wk.seen.length;
      const mark = b.sent.length;
      const after = await b.pressSyncNow();
      expect(after.state).toBe('paused');
      expect(after.limitedUntil).not.toBeNull();
      // 試し直したのはメタデータの送受信である。
      // 印を外して試す間は止まっていないので、使用量も 1 度取り直す（本文と設定の道へは出ない）。
      expect(metaCalls(wk.seen.slice(before))).toBeGreaterThan(0);
      await settle();
      expect(wk.seen.slice(before).filter((r) => r.path !== '/changes' && r.path !== '/rows' && r.path !== '/usage')).toEqual([]);
      // 利用者は止めていないので、一時停止のまま頼まれた 1 巡（PausedPass）には回らない。
      expect(b.sent.slice(mark).some((e) => e.type === 'sync.status' && e.status.oncePass)).toBe(false);
      expect(b.sent.some((e) => e.type === 'sync.status' && e.status.oncePass)).toBe(false);
      expect(onceToasts(b)).toEqual([]);
    });

    it('一時停止中に頼んだ 1 巡のメタデータが上限で断られたら、本文、設定、使用量の道へ出ない', async () => {
      const wk = await worker(() => requestsAnswer());
      presetPaused();
      const b = boot({ start: true });
      expect(wk.seen).toEqual([]);
      const first = await b.pressSyncNow();
      expect(first.state).toBe('paused');
      expect(metaCalls(wk.seen)).toBeGreaterThan(0);
      // 1 巡の残り（本文と設定の出し入れ、使用量）が終わるまで待つ。
      await until(() => (b.status().oncePass ? null : true));
      await settle();
      // 上限で退いた後は、1 巡の最中でもメタデータ以外の道（本文の降ろし、設定の押し出し、本文の上げ、使用量）へ出ない。
      expect(wk.seen.filter((r) => r.path !== '/changes' && r.path !== '/rows')).toEqual([]);
    });

    it('一時停止中に頼んだ 1 巡が上限で断られたら、その終わりに成功や残りの件数の知らせを重ねない', async () => {
      // 時計は実時間なので、UTC の 0 時から 10 分の猶予（黙って退く）に当たらないよう、昼の 12 時に合わせる。
      // 偽にするのは Date だけで、時計は実時間と同じ速さで進める（待ちの timeout や until の期限を壊さない）。
      vi.useFakeTimers({ toFake: ['Date'], shouldAdvanceTime: true });
      vi.setSystemTime(Date.UTC(2026, 9, 9, 12, 0, 0));
      await worker(() => limitAnswer());
      presetPaused();
      // 送れずに残る行を 1 つ作る。上限で早く抜けなければ「残りました」の知らせが出る形にする。
      const db = openDb(dbPath(home));
      try { upsertShared(db, 'projects', { id: 'p-limit', name: 'p-limit', status: 'active', is_scratch: 0 }, 'test'); } finally { db.close(); }
      const b = boot({ start: true });
      await b.pressSyncNow();
      await until(() => (b.status().oncePass ? null : true));
      await settle();
      const st = b.status();
      expect(st.state).toBe('paused');
      expect(st.pending).toBeGreaterThan(0);
      expect(onceToasts(b)).toEqual([]);
      // 知らせは、止めたのは利用者だと分かる文の 1 件だけである。
      expect(b.toasts().map((e) => e.message).filter((m) => m.includes('Cloudflare'))).toEqual(['Cloudflare の無料枠の上限に達したので、同期できませんでした。同期は一時停止のままです']);
    });
  });
});

describe('作り直した設定の同期の組み立て', () => {
  it('cloud.json が無ければ作らない', () => {
    expect(boot().sync.configBundle).toBeNull();
  });

  it('cloud.json があれば組み、スイッチは既定で切で、切のあいだは何も送らず、クラウドにも触らない', async () => {
    joinTo(NOWHERE);
    fs.writeFileSync(path.join(claudeDir, 'CLAUDE.md'), '# rules');
    const b = boot({ start: true });
    const bundle = b.sync.configBundle!;
    expect(bundle).not.toBeNull();
    expect(bundle.dto()).toMatchObject({ enabled: false, approval: 'each', incoming: 0 });
    expect(await bundle.send()).toEqual({ sent: false, items: 0 });
    expect(await bundle.receive()).toEqual({ fetched: 0, failed: 0 });
    await bundle.tick();
    expect(b.h.db.prepare('select count(*) n from config_snapshots').get()).toEqual({ n: 0 });
    // 手元の項目は読めるので、入れる前に何が出るかは見せられる。
    expect(bundle.outgoing().items.map((i) => i.id)).toEqual(['file:CLAUDE.md']);
  });

  it('スイッチは旧実装の syncClaudeConfig と別で、承諾の仕方は設定から読む', () => {
    joinTo(NOWHERE);
    const b = boot();
    const bundle = b.sync.configBundle!;
    b.h.settings.current = { ...b.h.settings.current, syncClaudeConfig: true };
    expect(bundle.dto().enabled).toBe(false);
    b.h.settings.current = { ...b.h.settings.current, configBundleSync: true, configApproval: 'auto' };
    expect(bundle.dto()).toMatchObject({ enabled: true, approval: 'auto' });
  });

  it('配る層へ、状態の組み方を渡す', () => {
    joinTo(NOWHERE);
    const h = bootHome({ home, claudeDir });
    const sent: NoticeEvent[] = [];
    const hub = { broadcast: (ev: NoticeEvent) => { sent.push(ev); } };
    const setConfigSync = vi.fn();
    const sync = bootSync(h, { hub, toast: toastVia(hub), publisher: { setConfigSync } as never }, { memoPath: (id) => path.join(home, 'projects', id, 'memo.md') });
    expect(setConfigSync).toHaveBeenCalledTimes(1);
    const read = setConfigSync.mock.calls[0]![0] as () => unknown;
    expect(read()).toMatchObject({ enabled: false, approval: 'each' });
    sync.stopTimers();
    h.stop();
  });

  it('参加していない端末では、組み方は常に null を返す', () => {
    const h = bootHome({ home, claudeDir });
    const hub = { broadcast: () => {} };
    const setConfigSync = vi.fn();
    const sync = bootSync(h, { hub, toast: toastVia(hub), publisher: { setConfigSync } as never }, { memoPath: (id) => path.join(home, 'projects', id, 'memo.md') });
    expect((setConfigSync.mock.calls[0]![0] as () => unknown)()).toBeNull();
    sync.stopTimers();
    h.stop();
  });
});
