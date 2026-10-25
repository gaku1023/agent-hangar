import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDb, type Db } from '../../../db/open.ts';
import { upsertShared } from '../../../db/shared.ts';
import { getSession } from '../../../db/queries.ts';
import { IndexerService, type IndexerListener } from '../../../indexer/service.ts';
import { writeBatch } from '../../../indexer/write.ts';
import { readEvents } from '../../../transcript/read.ts';
import { claudeTranscriptSource } from '../../claude-code/transcript/source.ts';
import { fixtureMessages } from '../../../../test/fake-opencode-events.ts';
import { convertMessages } from './convert.ts';
import { RemoteOpencodeTranscripts } from './remote.ts';

// ほかの PC から降ろした opencode の本文の写し（export の JSON）を、閲覧のために索引へ入れる道。記録した 2.1.4 の本文を使う。
const SID = 'ses_e8eb096a3ffekAvQlPtKFewFB4';
/** 2.1.4 の API は新しい順に返す。export は古い順。 */
const ALL = [...fixtureMessages('messages.json').data].reverse();
const FIRST_TURN = ALL.findIndex((m) => (m as { type?: string }).type === 'idle') + 1;
const exportOf = (messages: unknown[], directory = '/Users/other/work/repo', updated = 100) =>
  JSON.stringify({ info: { id: SID, title: 't', time: { created: 1, updated }, location: { directory } }, messages });

let dir: string;
let remoteRoot: string;
let exportDir: string;
let db: Db;
let marks: Map<string, string>;
let runningHere: Set<string>;
let source: RemoteOpencodeTranscripts;
let svc: IndexerService;
let changed: Parameters<NonNullable<IndexerListener['sessionChanged']>>[0][];

beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hangar-oc-remote-'));
  fs.mkdirSync(path.join(dir, 'projects'));
  remoteRoot = path.join(dir, 'remote');
  exportDir = path.join(dir, 'export');
  db = openDb(':memory:');
  marks = new Map();
  runningHere = new Set();
  source = new RemoteOpencodeTranscripts({
    db, remoteRoot, exportDir,
    marks: { get: (id) => marks.get(id) ?? null, set: (id, v) => { if (v === null) marks.delete(id); else marks.set(id, v); } },
    isRunningHere: (id) => runningHere.has(id),
    log: () => undefined,
  });
  svc = new IndexerService({ db, deviceId: 'dev-a', transcript: claudeTranscriptSource({ claudeDir: dir }), stored: [source], isRunning: () => false });
  changed = [];
  svc.on({ sessionChanged: (e) => changed.push(e) });
});
afterEach(() => {
  svc.stop();
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

/** dev の写しを置く。mtime は降ろした写しの更新時刻（puller が相手の mtime に合わせる）。 */
const place = (dev: string, text: string, mtime = 1_700_000_000): string => {
  const p = path.join(remoteRoot, dev, 'opencode', `${SID}.json`);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, text);
  fs.utimesSync(p, mtime, mtime);
  return p;
};
/** 同期で届いた会話の行（ほかの PC が作った）。 */
const syncedRow = (): string => {
  upsertShared(db, 'sessions', { id: 'h1', provider: 'opencode', provider_session_id: SID, cwd: '/Users/other/work/repo', home_device: 'dev-b' }, 'dev-b');
  return 'h1';
};
const events = (messages: unknown[]) => convertMessages(messages).flatMap((r) => r.events);

describe('RemoteOpencodeTranscripts', () => {
  it('降ろした export を古い順のまま変換して agent_events に入れ、ほかの PC の写しとして知らせる', async () => {
    const id = syncedRow();
    place('dev-b', exportOf(ALL));
    await svc.start();
    expect(readEvents(db, id, {}).events).toEqual(events(ALL));
    expect(changed).toEqual([expect.objectContaining({ sessionId: id, providerSessionId: SID, deviceId: 'dev-b', path: null })]);
    // ほかの PC の写しなので、会話の行（sessions）には書かない。この PC の本文としても数えない（閲覧は「ほかの PC の本文」）。
    expect(db.prepare('select cwd, home_device from sessions where id = ?').get(id)).toEqual({ cwd: '/Users/other/work/repo', home_device: 'dev-b' });
    expect(getSession(db, [], id, { deviceId: 'dev-a' })).toMatchObject({ hasTranscript: true, remoteOnly: true });
    // 写しが変わらなければ読み直さない。
    expect(source.refresh()).toBe(0);
    expect(changed).toHaveLength(1);
  });

  it('写しが伸びたら作り直しで読み直す', async () => {
    const id = syncedRow();
    place('dev-b', exportOf(ALL.slice(0, FIRST_TURN)));
    await svc.start();
    expect(readEvents(db, id, {}).events).toEqual(events(ALL.slice(0, FIRST_TURN)));
    place('dev-b', exportOf(ALL, undefined, 200), 1_700_000_100);
    expect(source.refresh()).toBe(1);
    expect(readEvents(db, id, {}).events).toEqual(events(ALL));
  });

  it('会話の行がまだ届いていなければ待ち、届いたら（次の refresh で）入れる', async () => {
    place('dev-b', exportOf(ALL));
    await svc.start();
    expect(db.prepare("select count(*) c from sessions where provider = 'opencode'").get()).toEqual({ c: 0 });
    expect(changed).toEqual([]);
    const id = syncedRow();
    expect(source.refresh()).toBe(1);
    expect(readEvents(db, id, {}).total).toBe(events(ALL).length);
  });

  it('写しが 2 台にあれば、本文の新しい方を選ぶ', async () => {
    const id = syncedRow();
    place('dev-b', exportOf(ALL.slice(0, FIRST_TURN), '/b', 100), 1_700_000_500);
    place('dev-c', exportOf(ALL, '/c', 300), 1_700_000_000);
    await svc.start();
    expect(readEvents(db, id, {}).events).toEqual(events(ALL));
    expect(changed[0]).toMatchObject({ deviceId: 'dev-c' });
  });

  it('この PC で動いている会話と、この PC の書き出しの方が新しい会話には、写しを入れない', async () => {
    syncedRow();
    place('dev-b', exportOf(ALL, undefined, 100));
    runningHere.add(SID);
    await svc.start();
    expect(changed).toEqual([]);
    runningHere.clear();
    fs.mkdirSync(exportDir, { recursive: true });
    fs.writeFileSync(path.join(exportDir, `${SID}.json`), exportOf(ALL, '/Users/me/work/repo', 500));
    expect(source.refresh()).toBe(0);
    expect(changed).toEqual([]);
  });

  it('手元の束とほかの PC の写しの束は、互いに作り直しで置き換え、日別の使用量を二重に数えない', async () => {
    const id = syncedRow();
    // この PC で前に動かした分（手元の束、出どころは opencode:<会話>）。
    writeBatch(db, { agent: 'opencode', providerSessionId: SID, agentId: null, reset: true, records: convertMessages(ALL.slice(0, FIRST_TURN)) }, { deviceId: 'dev-a' });
    expect(getSession(db, [], id, { deviceId: 'dev-a' })).toMatchObject({ remoteOnly: false });
    const usage = () => db.prepare('select file_path, sum(input_tokens) i from usage_daily where session_id = ? group by file_path order by file_path').all(id);
    expect(usage()).toEqual([{ file_path: `opencode:${SID}`, i: expect.any(Number) }]);
    place('dev-b', exportOf(ALL));
    await svc.start();
    expect(usage()).toEqual([{ file_path: `opencode:${SID}@dev-b`, i: expect.any(Number) }]);
    expect(getSession(db, [], id, { deviceId: 'dev-a' })).toMatchObject({ remoteOnly: true });
    // この PC で再開して手元の束が作り直すと、写しの分は消える。
    writeBatch(db, { agent: 'opencode', providerSessionId: SID, agentId: null, reset: true, records: convertMessages(ALL) }, { deviceId: 'dev-a' });
    expect(usage()).toEqual([{ file_path: `opencode:${SID}`, i: expect.any(Number) }]);
    expect(getSession(db, [], id, { deviceId: 'dev-a' })).toMatchObject({ remoteOnly: false });
  });

  it('消した会話（行が論理削除）の写しは入れない。形の違う名前とリンクは読まない', async () => {
    syncedRow();
    db.prepare("update sessions set deleted_at = 1 where id = 'h1'").run();
    place('dev-b', exportOf(ALL));
    fs.writeFileSync(path.join(remoteRoot, 'dev-b', 'opencode', 'not-an-id!.json'), exportOf(ALL));
    fs.symlinkSync(path.join(remoteRoot, 'dev-b', 'opencode', `${SID}.json`), path.join(remoteRoot, 'dev-b', 'opencode', 'ses_link.json'));
    await svc.start();
    expect(changed).toEqual([]);
  });
});
