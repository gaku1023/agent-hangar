import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ChangeOut } from '@agent-hangar/shared';
import { openDb, type Db } from '../db/open.ts';
import { upsertShared } from '../db/shared.ts';
import { indexFile } from '../indexer/indexFile.ts';
import { IndexerService } from '../indexer/service.ts';
import { assignSessions, mergeProjects } from '../projects/registry.ts';
import { mangleCwd } from '../provider/claude-code/transcript/discover.ts';
import { applyRemoteBatch } from '../sync/apply.ts';
import { TrashError } from '../platform/trash.ts';
import { DeleteError, SessionTrash } from './trash.ts';
import { getSessionState, setSessionState } from './states.ts';

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
      { seq: 20, tableName: 'session_states', op: 'upsert', deviceId: OTHER, rowId: 's1', updatedAt: t, payload: { session_id: 's1', status: null, trashed_at: null, updated_at: t, deleted_at: null, origin_device: OTHER } },
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
