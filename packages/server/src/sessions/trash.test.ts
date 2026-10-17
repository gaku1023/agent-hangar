import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ChangeOut } from '@agent-hangar/shared';
import { FakeCloudClient } from '../../test/fake-cloud.ts';
import { FakeTimers } from '../../test/fake-timers.ts';
import { openDb, type Db } from '../db/open.ts';
import { upsertShared } from '../db/shared.ts';
import { indexFile } from '../indexer/indexFile.ts';
import { IndexerService } from '../indexer/service.ts';
import { assignSessions, mergeProjects } from '../projects/registry.ts';
import { mangleCwd } from '../provider/claude-code/transcript/discover.ts';
import { applyRemoteBatch } from '../sync/apply.ts';
import { SyncStateStore } from '../sync/state.ts';
import { TranscriptUploader } from '../sync/uploader.ts';
import { aggregateUsage, localDay } from '../usage/aggregate.ts';
import { TrashError } from '../platform/trash.ts';
import { DeleteError, SessionTrash } from './trash.ts';
import { getSessionState, markAutoDone, setSessionState } from './states.ts';

/**
 * セッションの削除（docs/design.md の「セッションの削除」）。
 * 消した PC は本文をゴミ箱へ移してから印（session_states.trashed_at）を書き、sessions の行を論理削除する。
 * 印を受け取った PC は、本文の持ち主ならゴミ箱へ移し（実行中は止まるまで待つ）、hangar が降ろした写しは消す。
 * 古い sessions の upsert が届いても、索引し直しても、生き返らない。ゴミ箱から戻せば復元する。
 */

const DEV = 'dev-1';
const OTHER = 'dev-2';
const UUID = '11111111-2222-3333-4444-555555555555';
const CWD = '/w/alpha';

let tmp: string;
let claudeDir: string;
let remoteRoot: string;
let bin: string;
let db: Db;
/** 偽のゴミ箱へ移したもの。元のパスから、ゴミ箱の中のパスへ。 */
let binned: Map<string, string>;
let failTrash: boolean;
let runsAnywhere: boolean;
let runsHere: boolean;
let restored: string[];
let restoredElsewhere: string[];
let trashCalls: string[];

const mainPath = () => path.join(claudeDir, 'projects', mangleCwd(CWD), `${UUID}.jsonl`);
const subDir = () => path.join(claudeDir, 'projects', mangleCwd(CWD), UUID);
const remoteMain = () => path.join(remoteRoot, OTHER, 'projects', mangleCwd(CWD), `${UUID}.jsonl`);

const LINES = [
  { type: 'user', sessionId: UUID, cwd: CWD, timestamp: '2026-10-16T00:00:00.000Z', uuid: 'a1', message: { role: 'user', content: 'こんにちは' } },
  { type: 'assistant', sessionId: UUID, cwd: CWD, timestamp: '2026-10-16T00:00:01.000Z', uuid: 'a2', message: { role: 'assistant', content: [{ type: 'text', text: 'はい' }] } },
].map((l) => JSON.stringify(l)).join('\n') + '\n';

function writeTranscript(): void {
  fs.mkdirSync(path.join(subDir(), 'subagents'), { recursive: true });
  fs.writeFileSync(mainPath(), LINES);
  fs.writeFileSync(path.join(subDir(), 'subagents', 'agent-x.jsonl'), LINES);
}

function service(deviceId = DEV): SessionTrash {
  return new SessionTrash({
    db, deviceId, claudeDir, remoteRoot,
    trash: async (p) => {
      trashCalls.push(p);
      if (failTrash) throw new TrashError('ゴミ箱が使えません');
      const to = path.join(bin, `${binned.size}-${path.basename(p)}`);
      fs.renameSync(p, to);
      binned.set(p, to);
    },
    runsAnywhere: () => runsAnywhere,
    runsHere: () => runsHere,
    onRestored: (id) => restored.push(id),
    onRestoredElsewhere: (uuid) => restoredElsewhere.push(uuid),
    log: () => {},
  });
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hangar-session-trash-'));
  claudeDir = path.join(tmp, 'claude');
  remoteRoot = path.join(tmp, 'remote');
  bin = path.join(tmp, 'bin');
  fs.mkdirSync(bin, { recursive: true });
  db = openDb(':memory:');
  binned = new Map(); failTrash = false; runsAnywhere = false; runsHere = false; restored = []; restoredElsewhere = []; trashCalls = [];
  upsertShared(db, 'projects', { id: 'pa', name: 'alpha', status: 'active', is_scratch: 0 }, DEV);
  upsertShared(db, 'projects', { id: 'pb', name: 'beta', status: 'active', is_scratch: 0 }, DEV);
  upsertShared(db, 'project_roots', { id: 'ra', project_id: 'pa', device_id: DEV, path: CWD, resolved: 1 }, DEV);
  upsertShared(db, 'sessions', { id: 's1', provider: 'claude-code', provider_session_id: UUID, cwd: CWD, home_device: DEV, project_id: 'pa' }, DEV);
  upsertShared(db, 'session_summaries', { session_id: 's1', title: 't', one_liner: 'o', body: 'b', state: 'done', next_steps: '[]', source: 'baseline', based_on_turns: 1 }, DEV, 'session_id');
  upsertShared(db, 'session_notes', { session_id: 's1', name: '名前' }, DEV, 'session_id');
});
afterEach(() => { db.close(); fs.rmSync(tmp, { recursive: true, force: true }); });

const sessionRow = () => db.prepare("select deleted_at, updated_at from sessions where id = 's1'").get() as { deleted_at: number | null; updated_at: number };
const trashedAt = () => (db.prepare("select trashed_at from session_states where session_id = 's1'").get() as { trashed_at: number | null } | undefined)?.trashed_at ?? null;
const unpushed = (table: string) => db.prepare("select op from changes where table_name = ? and row_id = 's1' and pushed_at is null").all(table) as { op: string }[];
const indexMain = (p = mainPath(), deviceId: string | null = null) => indexFile(db, { path: p, sessionId: UUID, agentId: null, deviceId }, { deviceId: DEV, remote: deviceId !== null });

describe('消した PC', () => {
  it('本文と隣のフォルダをゴミ箱へ移し、印を書き、行を論理削除する。名前と要約は残す', async () => {
    writeTranscript();
    indexMain();
    expect(db.prepare("select count(*) n from transcript_files where session_id = 's1'").get()).toEqual({ n: 1 });
    await service().deleteSession('s1');
    expect(fs.existsSync(mainPath())).toBe(false);
    expect(fs.existsSync(subDir())).toBe(false);
    expect([...binned.keys()].sort()).toEqual([mainPath(), subDir()].sort());
    expect(trashedAt()).toEqual(expect.any(Number));
    expect(sessionRow().deleted_at).toEqual(expect.any(Number));
    // 印と論理削除のどちらも同期に載る。
    expect(unpushed('session_states')).toEqual([{ op: 'upsert' }]);
    expect(unpushed('sessions')).toEqual([{ op: 'delete' }]);
    // 元のパスを端末ローカルの表に控える。
    expect(db.prepare("select path, kind from trashed_transcripts where session_id = 's1' order by kind").all()).toEqual([
      { path: subDir(), kind: 'dir' }, { path: mainPath(), kind: 'file' },
    ]);
    // 本文の索引は片付ける。
    expect(db.prepare("select count(*) n from transcript_files where session_id = 's1'").get()).toEqual({ n: 0 });
    expect(db.prepare("select count(*) n from event_index where session_id = 's1'").get()).toEqual({ n: 0 });
    // 名前と要約は、戻したときのために残す。
    expect(db.prepare("select deleted_at from session_summaries where session_id = 's1'").get()).toEqual({ deleted_at: null });
    expect(db.prepare("select deleted_at from session_notes where session_id = 's1'").get()).toEqual({ deleted_at: null });
  });
  it('hangar が降ろした写しは、ゴミ箱を通さずに消す', async () => {
    fs.mkdirSync(path.dirname(remoteMain()), { recursive: true });
    fs.writeFileSync(remoteMain(), LINES);
    indexMain(remoteMain(), OTHER);
    await service().deleteSession('s1');
    expect(fs.existsSync(remoteMain())).toBe(false);
    expect(trashCalls).toEqual([]);
    expect(trashedAt()).toEqual(expect.any(Number));
  });
  it('本文の無い PC でも消せる。印と論理削除だけを書く', async () => {
    await service().deleteSession('s1');
    expect(trashCalls).toEqual([]);
    expect(trashedAt()).toEqual(expect.any(Number));
    expect(sessionRow().deleted_at).toEqual(expect.any(Number));
  });
  it('実行中は 409 で断り、何も変えない', async () => {
    writeTranscript();
    runsAnywhere = true;
    await expect(service().deleteSession('s1')).rejects.toMatchObject({ status: 409 });
    expect(fs.existsSync(mainPath())).toBe(true);
    expect(trashedAt()).toBeNull();
    expect(sessionRow().deleted_at).toBeNull();
  });
  it('ゴミ箱へ移せなければ、何も変えずに誤りを返す（rm に倒さない）', async () => {
    writeTranscript();
    failTrash = true;
    const e = await service().deleteSession('s1').catch((x: unknown) => x);
    expect(e).toBeInstanceOf(DeleteError);
    expect((e as DeleteError).status).toBe(500);
    expect(fs.existsSync(mainPath())).toBe(true);
    expect(fs.existsSync(subDir())).toBe(true);
    expect(trashedAt()).toBeNull();
    expect(sessionRow().deleted_at).toBeNull();
    expect(unpushed('session_states')).toEqual([]);
  });
  it('ゴミ箱へ移せなかった本文は、元のパスの控えを残さない', async () => {
    writeTranscript();
    failTrash = true;
    await service().deleteSession('s1').catch(() => {});
    expect(db.prepare("select count(*) n from trashed_transcripts where session_id = 's1'").get()).toEqual({ n: 0 });
  });
  it('本文を移した後に DB の書き込みで転んでも、元のパスの控えは残り、戻せば復元できる', async () => {
    writeTranscript();
    indexMain();
    db.exec("create trigger boom before insert on changes when new.table_name = 'session_states' begin select raise(abort, 'boom'); end");
    await expect(service().deleteSession('s1')).rejects.toThrow();
    db.exec('drop trigger boom');
    expect(fs.existsSync(mainPath())).toBe(false);
    expect(trashedAt()).toBeNull();
    expect(db.prepare("select path, kind from trashed_transcripts where session_id = 's1' order by kind").all()).toEqual([
      { path: subDir(), kind: 'dir' }, { path: mainPath(), kind: 'file' },
    ]);
    fs.renameSync(binned.get(mainPath())!, mainPath());
    expect(service().checkRestores()).toEqual(['s1']);
    expect(restored).toEqual(['s1']);
  });
  it('無いセッションと、消したセッションは 404', async () => {
    await expect(service().deleteSession('nope')).rejects.toMatchObject({ status: 404 });
    await service().deleteSession('s1');
    await expect(service().deleteSession('s1')).rejects.toMatchObject({ status: 404 });
  });
});

describe('生き返らない', () => {
  it('消した後に、古い sessions の upsert（持ち主が受け取る前に書いた新しい時刻）が届いても、論理削除のまま', async () => {
    await service().deleteSession('s1');
    const t = Date.now() + 60_000;
    const stale: ChangeOut = {
      seq: 1, tableName: 'sessions', op: 'upsert', deviceId: OTHER, rowId: 's1', updatedAt: t,
      payload: { id: 's1', provider: 'claude-code', provider_session_id: UUID, cwd: CWD, home_device: OTHER, project_id: 'pa', updated_at: t, deleted_at: null, origin_device: OTHER },
    };
    expect(applyRemoteBatch(db, [stale], { ownDeviceId: DEV, skipOwn: true })).toHaveLength(1);
    expect(sessionRow().deleted_at).toEqual(expect.any(Number));
  });
  it('同じ束で sessions の upsert と印が届いても、論理削除になる', () => {
    const t = Date.now() + 60_000;
    const batch: ChangeOut[] = [
      { seq: 2, tableName: 'session_states', op: 'upsert', deviceId: OTHER, rowId: 's1', updatedAt: t, payload: { session_id: 's1', status: null, trashed_at: t, updated_at: t, deleted_at: null, origin_device: OTHER } },
      { seq: 3, tableName: 'sessions', op: 'upsert', deviceId: OTHER, rowId: 's1', updatedAt: t + 1, payload: { id: 's1', provider: 'claude-code', provider_session_id: UUID, cwd: CWD, home_device: DEV, project_id: 'pa', updated_at: t + 1, deleted_at: null, origin_device: OTHER } },
    ];
    applyRemoteBatch(db, batch, { ownDeviceId: DEV, skipOwn: true });
    expect(sessionRow().deleted_at).toBe(t);
  });
  it('本文がまだ残っていても、索引は掘り起こさない', async () => {
    await service().deleteSession('s1');
    writeTranscript();
    const r = indexMain();
    expect(r.skipped).toBe(true);
    expect(sessionRow().deleted_at).toEqual(expect.any(Number));
    expect(db.prepare("select count(*) n from transcript_files where session_id = 's1'").get()).toEqual({ n: 0 });
  });
  it('history.jsonl にだけ残る会話としても書き直さない', async () => {
    await service().deleteSession('s1');
    db.prepare('update changes set pushed_at = 1').run();
    const indexer = new IndexerService({ db, deviceId: DEV, claudeDir, isRunning: () => false });
    indexer.syncHistoryOnly(new Map([[UUID, { cwd: CWD, firstTs: 1, lastTs: Date.now() + 1000, firstDisplay: 'こんにちは', count: 3 }]]));
    expect(unpushed('sessions')).toEqual([]);
    expect(db.prepare("select last_activity_at from sessions where id = 's1'").get()).toEqual({ last_activity_at: null });
  });
  it('自動の振り分けとプロジェクトのまとめでも、論理削除のまま', async () => {
    await service().deleteSession('s1');
    assignSessions(db, DEV);
    mergeProjects(db, DEV, 'pa', 'pb');
    expect(sessionRow().deleted_at).toEqual(expect.any(Number));
  });
});

/** 別の PC（OTHER）が消した印が届いた形にする。 */
function receiveMark(at = Date.now() + 60_000): number {
  applyRemoteBatch(db, [
    { seq: 10, tableName: 'session_states', op: 'upsert', deviceId: OTHER, rowId: 's1', updatedAt: at, payload: { session_id: 's1', status: null, trashed_at: at, updated_at: at, deleted_at: null, origin_device: OTHER } },
    { seq: 11, tableName: 'sessions', op: 'delete', deviceId: OTHER, rowId: 's1', updatedAt: at, payload: { id: 's1', provider: 'claude-code', provider_session_id: UUID, cwd: CWD, home_device: DEV, project_id: 'pa', updated_at: at, deleted_at: at, origin_device: OTHER } },
  ], { ownDeviceId: DEV, skipOwn: true });
  return at;
}

describe('印を受け取った PC', () => {
  it('本文の持ち主なら、本文をゴミ箱へ移し、論理削除を自分でも書き直す', async () => {
    writeTranscript();
    indexMain();
    receiveMark();
    expect(sessionRow().deleted_at).toEqual(expect.any(Number));
    const r = await service().applyMarks();
    expect(r.trashed).toEqual(['s1']);
    expect(fs.existsSync(mainPath())).toBe(false);
    expect(fs.existsSync(subDir())).toBe(false);
    expect(db.prepare("select count(*) n from trashed_transcripts where session_id = 's1'").get()).toEqual({ n: 2 });
    // 持ち主が論理削除を書き直して上げる。持ち主が先に上げていた古い upsert にクラウドで勝つためである。
    expect(unpushed('sessions')).toEqual([{ op: 'delete' }]);
    // 同じ印は二度処理しない。
    trashCalls = [];
    expect((await service().applyMarks()).trashed).toEqual([]);
    expect(trashCalls).toEqual([]);
  });
  it('その PC で実行中なら、止まるまで待ってから移す', async () => {
    writeTranscript();
    indexMain();
    receiveMark();
    runsHere = true;
    const r1 = await service().applyMarks();
    expect(r1.waiting).toEqual(['s1']);
    expect(fs.existsSync(mainPath())).toBe(true);
    runsHere = false;
    const r2 = await service().applyMarks();
    expect(r2.trashed).toEqual(['s1']);
    expect(fs.existsSync(mainPath())).toBe(false);
  });
  it('hangar が降ろした写しは消す（ゴミ箱を通さない）', async () => {
    fs.mkdirSync(path.dirname(remoteMain()), { recursive: true });
    fs.writeFileSync(remoteMain(), LINES);
    indexMain(remoteMain(), OTHER);
    receiveMark();
    await service().applyMarks();
    expect(fs.existsSync(remoteMain())).toBe(false);
    expect(trashCalls).toEqual([]);
    expect(db.prepare("select count(*) n from transcript_files where session_id = 's1'").get()).toEqual({ n: 0 });
  });
  it('ゴミ箱へ移せなければ本文を残し、次の回でやり直す', async () => {
    writeTranscript();
    indexMain();
    receiveMark();
    failTrash = true;
    await service().applyMarks();
    expect(fs.existsSync(mainPath())).toBe(true);
    failTrash = false;
    const r = await service().applyMarks();
    expect(r.trashed).toEqual(['s1']);
    expect(fs.existsSync(mainPath())).toBe(false);
  });
  it('起きていなかった PC は、索引に本文の行が無くても、cwd の置き場から本文を見つけて移す', async () => {
    writeTranscript();
    receiveMark();
    await service().applyMarks();
    expect(fs.existsSync(mainPath())).toBe(false);
  });
});

describe('戻せる', () => {
  it('持ち主の PC で、同じパスに本文が戻ってきたら、印と論理削除を外し、同期に載せる', async () => {
    writeTranscript();
    indexMain();
    await service().deleteSession('s1');
    db.prepare('update changes set pushed_at = 1').run();
    fs.renameSync(binned.get(mainPath())!, mainPath());
    expect(service().checkRestores()).toEqual(['s1']);
    expect(trashedAt()).toBeNull();
    expect(sessionRow().deleted_at).toBeNull();
    expect(unpushed('session_states')).toEqual([{ op: 'upsert' }]);
    expect(unpushed('sessions')).toEqual([{ op: 'upsert' }]);
    expect(db.prepare("select count(*) n from trashed_transcripts where session_id = 's1'").get()).toEqual({ n: 0 });
    expect(restored).toEqual(['s1']);
    // 索引し直せる。
    expect(indexMain().skipped).toBe(false);
    expect(getSessionState(db, 's1')).toMatchObject({ status: null });
  });
  it('本文が戻っていなければ、何もしない', async () => {
    writeTranscript();
    await service().deleteSession('s1');
    expect(service().checkRestores()).toEqual([]);
    expect(trashedAt()).toEqual(expect.any(Number));
  });
  it('ほかの PC での復元が届けば、論理削除を外し、写しを降ろし直してもらう', async () => {
    writeTranscript();
    const at = receiveMark();
    await service().applyMarks();
    const t = at + 1000;
    applyRemoteBatch(db, [
      { seq: 20, tableName: 'session_states', op: 'upsert', deviceId: OTHER, rowId: 's1', updatedAt: t, payload: { session_id: 's1', status: null, trashed_at: null, restored_at: t, updated_at: t, deleted_at: null, origin_device: OTHER } },
    ], { ownDeviceId: DEV, skipOwn: true });
    expect(sessionRow().deleted_at).toBeNull();
    await service().applyMarks();
    expect(restoredElsewhere).toEqual([UUID]);
    expect(db.prepare("select count(*) n from trash_applied where session_id = 's1'").get()).toEqual({ n: 0 });
  });
  it('状態を変えても、削除の印は消えない', async () => {
    await service().deleteSession('s1');
    setSessionState(db, DEV, 's1', { status: 'done', setBy: 'user' });
    expect(trashedAt()).toEqual(expect.any(Number));
  });
});

describe('戻せるのは、元のパスに本文の jsonl が戻ったときだけ', () => {
  it('大きさが 0 のファイルや、同じパスのフォルダでは復元しない', async () => {
    writeTranscript();
    indexMain();
    await service().deleteSession('s1');
    fs.writeFileSync(mainPath(), '');
    expect(service().checkRestores()).toEqual([]);
    fs.rmSync(mainPath());
    fs.mkdirSync(mainPath());
    expect(service().checkRestores()).toEqual([]);
    expect(trashedAt()).toEqual(expect.any(Number));
  });
});

describe('削除の印は、明示の復元でしか外れない', () => {
  /** 印を受け取る前のほかの PC（OTHER）が、印の無い行を書いた形。自動の Done や状態の変更である。 */
  const staleRow = (t: number, extra: Record<string, unknown> = {}): ChangeOut => ({
    seq: 30, tableName: 'session_states', op: 'upsert', deviceId: OTHER, rowId: 's1', updatedAt: t,
    payload: { session_id: 's1', status: 'done', set_by: 'import', set_at: t, trashed_at: null, restored_at: null, updated_at: t, deleted_at: null, origin_device: OTHER, ...extra },
  });
  /** この PC が積んだ、まだ上げていない session_states の変更を、届く形にする。 */
  const outgoing = (from: Db): ChangeOut[] => (from.prepare("select seq, table_name, row_id, op, payload, updated_at, device_id from changes where table_name = 'session_states' and pushed_at is null order by seq").all() as { seq: number; table_name: string; row_id: string; op: 'upsert' | 'delete'; payload: string; updated_at: number; device_id: string }[])
    .map((r) => ({ seq: r.seq, tableName: r.table_name as ChangeOut['tableName'], op: r.op, deviceId: r.device_id, rowId: r.row_id, updatedAt: r.updated_at, payload: JSON.parse(r.payload) as Record<string, unknown> }));

  it('印を受け取る前のほかの PC の行（自動の Done）が後から届いても、消えたままで、状態の変更は取り込み、印を上げ直す', async () => {
    await service().deleteSession('s1');
    const t0 = trashedAt()!;
    db.prepare('update changes set pushed_at = 1').run();
    const t = Date.now() + 60_000;
    applyRemoteBatch(db, [staleRow(t)], { ownDeviceId: DEV, skipOwn: true });
    expect(trashedAt()).toBe(t0);
    expect(sessionRow().deleted_at).toEqual(expect.any(Number));
    expect(getSessionState(db, 's1')).toMatchObject({ status: 'done' });
    // 保った印をクラウドへ上げ直す。届いた行より新しい時刻で書くので、クラウドでも勝つ。
    const out = outgoing(db);
    expect(out).toHaveLength(1);
    expect(out[0]!.payload).toMatchObject({ trashed_at: t0, status: 'done' });
    expect(out[0]!.updatedAt).toBeGreaterThan(t);
  });
  it('往復しない：上げ直した行を受け取った PC は印をそのまま取り込み、何も上げ返さない。同じ行がまた届いても上げ直さない', async () => {
    await service().deleteSession('s1');
    db.prepare('update changes set pushed_at = 1').run();
    // ほかの PC の DB。印を受け取る前に自動の Done を書いた。
    const other = openDb(':memory:');
    try {
      upsertShared(other, 'sessions', { id: 's1', provider: 'claude-code', provider_session_id: UUID, cwd: CWD, home_device: DEV, project_id: null }, DEV);
      markAutoDone(other, OTHER, 's1', Date.now() + 60_000);
      other.prepare("update session_states set updated_at = ? where session_id = 's1'").run(Date.now() + 60_000);
      const fromOther = outgoing(other).map((c) => ({ ...c, updatedAt: Date.now() + 60_000, payload: { ...c.payload, updated_at: Date.now() + 60_000 } }));
      other.prepare('update changes set pushed_at = 1').run();
      applyRemoteBatch(db, fromOther, { ownDeviceId: DEV, skipOwn: true });
      const reraised = outgoing(db);
      expect(reraised).toHaveLength(1);
      db.prepare('update changes set pushed_at = 1').run();
      // 上げ直した行がほかの PC に届く。印を取り込み、上げ返さない。
      applyRemoteBatch(other, reraised, { ownDeviceId: OTHER, skipOwn: true });
      expect((other.prepare("select trashed_at from session_states where session_id = 's1'").get() as { trashed_at: number | null }).trashed_at).toBe(trashedAt());
      expect(outgoing(other)).toEqual([]);
      // 自分の上げ直しの戻りと、同じ古い行の届き直しでは、何も上げない。
      applyRemoteBatch(db, [...reraised, ...fromOther], { ownDeviceId: DEV, skipOwn: true });
      expect(outgoing(db)).toEqual([]);
    } finally {
      other.close();
    }
  });
  it('明示の復元（restored_at が印より新しい）は届く', async () => {
    await service().deleteSession('s1');
    const t0 = trashedAt()!;
    db.prepare('update changes set pushed_at = 1').run();
    const t = t0 + 1000;
    applyRemoteBatch(db, [staleRow(t, { status: null, set_by: null, set_at: null, restored_at: t })], { ownDeviceId: DEV, skipOwn: true });
    expect(trashedAt()).toBeNull();
    expect(sessionRow().deleted_at).toBeNull();
    expect(outgoing(db)).toEqual([]);
  });
  it('印より古い復元の行は、印を外さない', async () => {
    await service().deleteSession('s1');
    const t0 = trashedAt()!;
    applyRemoteBatch(db, [staleRow(t0 + 60_000, { restored_at: t0 - 1 })], { ownDeviceId: DEV, skipOwn: true });
    expect(trashedAt()).toBe(t0);
  });
  it('この PC での復元は restored_at を書いて印を外す', async () => {
    writeTranscript();
    indexMain();
    await service().deleteSession('s1');
    const t0 = trashedAt()!;
    fs.renameSync(binned.get(mainPath())!, mainPath());
    service().checkRestores();
    const r = db.prepare("select trashed_at, restored_at from session_states where session_id = 's1'").get() as { trashed_at: number | null; restored_at: number | null };
    expect(r.trashed_at).toBeNull();
    expect(r.restored_at).toBeGreaterThanOrEqual(t0);
  });
  /** この PC で消してから、ゴミ箱から戻す。戻した時刻（restored_at）と印の時刻を返す。 */
  const deleteAndRestore = async (): Promise<{ t0: number; r: number }> => {
    writeTranscript();
    indexMain();
    await service().deleteSession('s1');
    const t0 = trashedAt()!;
    fs.renameSync(binned.get(mainPath())!, mainPath());
    service().checkRestores();
    const r = (db.prepare("select restored_at from session_states where session_id = 's1'").get() as { restored_at: number }).restored_at;
    db.prepare('update changes set pushed_at = 1').run();
    return { t0, r };
  };
  it('戻した後に、戻す前の印を持つ行が新しい updated_at で届いても、戻ったままで本文を移さず、戻した行を上げ直す', async () => {
    const { t0, r } = await deleteAndRestore();
    const calls = trashCalls.length;
    const t = r + 60_000;
    applyRemoteBatch(db, [staleRow(t, { trashed_at: t0, restored_at: null })], { ownDeviceId: DEV, skipOwn: true });
    expect(trashedAt()).toBeNull();
    expect((db.prepare("select restored_at from session_states where session_id = 's1'").get() as { restored_at: number | null }).restored_at).toBe(r);
    expect(sessionRow().deleted_at).toBeNull();
    // 状態の変更は取り込む。
    expect(getSessionState(db, 's1')).toMatchObject({ status: 'done' });
    await service().applyMarks();
    expect(trashCalls).toHaveLength(calls);
    expect(fs.existsSync(mainPath())).toBe(true);
    // 戻した行を、届いた行より新しい時刻で上げ直す。クラウドでも印の無い行が勝つ。
    const out = outgoing(db);
    expect(out).toHaveLength(1);
    expect(out[0]!.payload).toMatchObject({ trashed_at: null, restored_at: r, status: 'done' });
    expect(out[0]!.updatedAt).toBeGreaterThan(t);
  });
  it('往復しない：戻す前の印を持つほかの PC と、戻した PC の間で、上げ直しは 1 回で止まる', async () => {
    const { t0 } = await deleteAndRestore();
    const other = openDb(':memory:');
    try {
      // ほかの PC は印を受け取り、戻したことはまだ受け取っていない。その間に状態を変えた（印を持つ行を新しい時刻で上げる）。
      upsertShared(other, 'sessions', { id: 's1', provider: 'claude-code', provider_session_id: UUID, cwd: CWD, home_device: DEV, project_id: null }, DEV);
      upsertShared(other, 'session_states', { session_id: 's1', trashed_at: t0 }, DEV, 'session_id', t0);
      other.prepare('update changes set pushed_at = 1').run();
      setSessionState(other, OTHER, 's1', { status: 'done', setBy: 'user' });
      const later = Date.now() + 60_000;
      other.prepare("update session_states set updated_at = ? where session_id = 's1'").run(later);
      const fromOther = outgoing(other).map((c) => ({ ...c, updatedAt: later, payload: { ...c.payload, updated_at: later } }));
      expect(fromOther[0]!.payload).toMatchObject({ trashed_at: t0 });
      other.prepare('update changes set pushed_at = 1').run();
      applyRemoteBatch(db, fromOther, { ownDeviceId: DEV, skipOwn: true });
      expect(trashedAt()).toBeNull();
      const reraised = outgoing(db);
      expect(reraised).toHaveLength(1);
      db.prepare('update changes set pushed_at = 1').run();
      // 上げ直した行がほかの PC に届く。印を外し、上げ返さない。
      applyRemoteBatch(other, reraised, { ownDeviceId: OTHER, skipOwn: true });
      expect((other.prepare("select trashed_at from session_states where session_id = 's1'").get() as { trashed_at: number | null }).trashed_at).toBeNull();
      expect(outgoing(other)).toEqual([]);
      // 自分の上げ直しの戻りと、同じ古い行の届き直しでは、何も上げない。
      applyRemoteBatch(db, [...reraised, ...fromOther], { ownDeviceId: DEV, skipOwn: true });
      expect(outgoing(db)).toEqual([]);
      expect(trashedAt()).toBeNull();
    } finally {
      other.close();
    }
  });
});

describe('同期で届く ID の検査', () => {
  /** provider_session_id が UUID でないセッションを作り、ほかの PC の印が届いた形にする。 */
  const badSession = (psid: string) => {
    upsertShared(db, 'sessions', { id: 's9', provider: 'claude-code', provider_session_id: psid, cwd: CWD, home_device: DEV, project_id: 'pa' }, DEV);
    const at = Date.now() + 60_000;
    applyRemoteBatch(db, [
      { seq: 40, tableName: 'session_states', op: 'upsert', deviceId: OTHER, rowId: 's9', updatedAt: at, payload: { session_id: 's9', status: null, trashed_at: at, updated_at: at, deleted_at: null, origin_device: OTHER } },
    ], { ownDeviceId: DEV, skipOwn: true });
  };
  for (const psid of ['', '..']) {
    it(`provider_session_id が ${JSON.stringify(psid)} なら、何もゴミ箱へ移さず、写しの置き場も消さない`, async () => {
      writeTranscript();
      fs.mkdirSync(path.dirname(remoteMain()), { recursive: true });
      fs.writeFileSync(remoteMain(), LINES);
      badSession(psid);
      await service().applyMarks();
      expect(trashCalls).toEqual([]);
      expect(fs.existsSync(mainPath())).toBe(true);
      expect(fs.existsSync(subDir())).toBe(true);
      expect(fs.existsSync(remoteMain())).toBe(true);
    });
  }
  it('消す PC でも、UUID でない ID なら何もゴミ箱へ移さずに印だけを書く', async () => {
    writeTranscript();
    upsertShared(db, 'sessions', { id: 's9', provider: 'claude-code', provider_session_id: '..', cwd: CWD, home_device: DEV, project_id: 'pa' }, DEV);
    await service().deleteSession('s9');
    expect(trashCalls).toEqual([]);
    expect(fs.existsSync(path.join(claudeDir, 'projects'))).toBe(true);
  });
});

describe('使用量は残す', () => {
  it('消しても usage_daily は消さず、集計にも残る。戻して索引し直しても二重に数えない', async () => {
    writeTranscript();
    indexMain();
    const day = localDay(Date.now());
    db.prepare('insert into usage_daily (session_id, day, file_path, input_tokens, output_tokens) values (?,?,?,?,?)').run('s1', day, mainPath(), 100, 20);
    await service().deleteSession('s1');
    expect(db.prepare("select sum(input_tokens) i from usage_daily where session_id = 's1'").get()).toEqual({ i: 100 });
    const agg = aggregateUsage(db, { days: 1 });
    expect(agg.days.find((d) => d.day === day)).toMatchObject({ inputTokens: 100, outputTokens: 20 });
    // 戻して索引し直すと、そのファイル由来のぶんは作り直される（足し合わさない）。
    fs.renameSync(binned.get(mainPath())!, mainPath());
    service().checkRestores();
    indexMain();
    expect(db.prepare("select count(*) n from usage_daily where session_id = 's1' and input_tokens = 100").get()).toEqual({ n: 0 });
  });
  it('印を受け取った PC でも usage_daily を消さない', async () => {
    writeTranscript();
    indexMain();
    db.prepare('insert into usage_daily (session_id, day, file_path, input_tokens, output_tokens) values (?,?,?,?,?)').run('s1', localDay(Date.now()), mainPath(), 7, 3);
    receiveMark();
    await service().applyMarks();
    expect(db.prepare("select sum(input_tokens) i from usage_daily where session_id = 's1'").get()).toEqual({ i: 7 });
  });
});

describe('削除は印の処理の後ろで待たされない', () => {
  it('印の処理が 1 件ごとに譲るので、途中で頼んだ削除が残りの印より先に走る', async () => {
    // 印のある 2 件（sA、sB）と、これから消す s1。
    const ids = { sA: 'aaaaaaaa-0000-0000-0000-000000000001', sB: 'bbbbbbbb-0000-0000-0000-000000000002' };
    const at = Date.now() + 60_000;
    for (const [id, psid] of Object.entries(ids)) {
      upsertShared(db, 'sessions', { id, provider: 'claude-code', provider_session_id: psid, cwd: CWD, home_device: DEV, project_id: 'pa' }, DEV);
      fs.mkdirSync(path.dirname(mainPath()), { recursive: true });
      fs.writeFileSync(path.join(path.dirname(mainPath()), `${psid}.jsonl`), LINES);
      applyRemoteBatch(db, [{ seq: 50, tableName: 'session_states', op: 'upsert', deviceId: OTHER, rowId: id, updatedAt: at, payload: { session_id: id, status: null, trashed_at: at, updated_at: at, deleted_at: null, origin_device: OTHER } }], { ownDeviceId: DEV, skipOwn: true });
    }
    writeTranscript();
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const order: string[] = [];
    const svc = new SessionTrash({
      db, deviceId: DEV, claudeDir, remoteRoot,
      trash: async (p) => {
        order.push(path.basename(p));
        if (order.length === 1) await gate;
        fs.renameSync(p, path.join(bin, `${order.length}-${path.basename(p)}`));
      },
      runsAnywhere: () => false, runsHere: () => false, log: () => {},
    });
    const marks = svc.applyMarks();
    // 1 件目の印の処理がゴミ箱の中で止まっている間に、削除を頼む。
    await new Promise((r) => setTimeout(r, 10));
    expect(order).toHaveLength(1);
    const del = svc.deleteSession('s1');
    release();
    await del;
    await marks;
    const firstMark = order[0]!;
    const rest = order.slice(1);
    const secondMark = rest.findIndex((n) => n.endsWith('.jsonl') && n !== `${UUID}.jsonl` && n !== firstMark);
    const deleted = rest.indexOf(`${UUID}.jsonl`);
    expect(deleted).toBeGreaterThanOrEqual(0);
    expect(deleted).toBeLessThan(secondMark);
  });
});

describe('持ち主の PC で戻したら、本文を上げ直す', () => {
  // 削除の印から 30 日たつと、Worker の掃除がクラウドの写しを消す（packages/cloud/src/sweep.ts の sweepTrash）。
  // その後に戻しても、上げた控え（file_sync）が残っていると、中身が同じなので上げ直さず、ほかの PC が降ろせない。
  // 手元の台帳（file_sync）の鍵。R2 の鍵名（HMAC）とは別である。
  const MAIN_KEY = `transcripts/${DEV}/${UUID}.jsonl.gz`;
  const SUB_KEY = `transcripts/${DEV}/${UUID}/subagents/agent-x.jsonl.gz`;
  const subPath = () => path.join(subDir(), 'subagents', 'agent-x.jsonl');
  let cloud: FakeCloudClient;
  let timers: FakeTimers;
  const uploader = () => new TranscriptUploader({ db, deviceId: DEV, claudeDir, client: cloud, keyring: cloud.keyring, state: new SyncStateStore(db), now: () => timers.now, timers, isPaused: () => false });
  /** 主線とサブエージェントの R2 の鍵名。 */
  const blobKeys = async () => [await cloud.transcriptKey(UUID), await cloud.transcriptKey(UUID, 'x')].sort();
  const plain = async (agentId: string | null) => (await cloud.openedFile(await cloud.transcriptKey(UUID, agentId)))!.body.toString();
  const ownUploads = () => (db.prepare("select key from file_sync where device_id = ? order by key").all(DEV) as { key: string }[]).map((r) => r.key);
  const indexAll = () => {
    indexMain();
    indexFile(db, { path: subPath(), sessionId: UUID, agentId: 'x', deviceId: null }, { deviceId: DEV });
  };
  /** 消して、ゴミ箱から主線とサブエージェントのフォルダを元の場所へ戻し、復元を見る。 */
  const trashAndRestore = async (beforeRestore: () => void = () => {}) => {
    await service().deleteSession('s1');
    beforeRestore();
    fs.renameSync(binned.get(mainPath())!, mainPath());
    fs.renameSync(binned.get(subDir())!, subDir());
    expect(service().checkRestores()).toEqual(['s1']);
    // 索引の全件走査（onRestored）の代わり。
    indexAll();
  };

  beforeEach(async () => {
    cloud = new FakeCloudClient({ deviceId: DEV });
    timers = new FakeTimers();
    writeTranscript();
    indexAll();
    const up = uploader();
    expect(await up.uploadFile({ path: mainPath(), sessionId: UUID, agentId: null })).toBe('uploaded');
    expect(await up.uploadFile({ path: subPath(), sessionId: UUID, agentId: 'x' })).toBe('uploaded');
    up.stop();
    expect([...cloud.files.keys()].sort()).toEqual(await blobKeys());
  });

  it('30 日を過ぎてクラウドの写しが消えていても、次の走査で主線とサブエージェントを上げ直す', async () => {
    await trashAndRestore(() => cloud.files.clear());
    expect(ownUploads()).toEqual([]);
    const up = uploader();
    expect(up.sweep()).toBe(2);
    await up.idle();
    up.stop();
    expect([...cloud.files.keys()].sort()).toEqual(await blobKeys());
    expect(await plain(null)).toBe(LINES);
    expect(await plain('x')).toBe(LINES);
    expect(ownUploads()).toEqual([MAIN_KEY, SUB_KEY]);
  });

  it('30 日より前に戻しても、同じ鍵へ同じ中身を上書きするだけで害は無い', async () => {
    await trashAndRestore();
    const up = uploader();
    expect(await up.uploadFile({ path: mainPath(), sessionId: UUID, agentId: null })).toBe('uploaded');
    expect(await up.uploadFile({ path: subPath(), sessionId: UUID, agentId: 'x' })).toBe('uploaded');
    up.stop();
    expect([...cloud.files.keys()].sort()).toEqual(await blobKeys());
    expect(await plain(null)).toBe(LINES);
    expect(await plain('x')).toBe(LINES);
  });

  it('忘れるのは自分が上げたそのセッションの控えだけで、降ろした写しの台帳とほかのセッションの控えは残す', async () => {
    const other = '11111111-2222-3333-4444-555555555556';
    const ins = db.prepare("insert into file_sync (key, kind, path, device_id, sha256, size, mtime, remote_seq, synced_at) values (?, 'transcript', ?, ?, 'x', 1, 1, 1, 1)");
    ins.run(`transcripts/${OTHER}/${UUID}.jsonl.gz`, `projects/${mangleCwd(CWD)}/${UUID}.jsonl`, OTHER);
    ins.run(`transcripts/${DEV}/${other}.jsonl.gz`, `projects/${mangleCwd(CWD)}/${other}.jsonl`, DEV);
    ins.run(`transcripts/${DEV}/${UUID}x.jsonl.gz`, `projects/${mangleCwd(CWD)}/${UUID}x.jsonl`, DEV);
    await trashAndRestore();
    expect((db.prepare('select key from file_sync order by key').all() as { key: string }[]).map((r) => r.key)).toEqual([
      `transcripts/${DEV}/${UUID}x.jsonl.gz`,
      `transcripts/${DEV}/${other}.jsonl.gz`,
      `transcripts/${OTHER}/${UUID}.jsonl.gz`,
    ]);
  });
});
