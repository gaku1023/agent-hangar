import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { decodeEpochList, fromBase64Url, generateKeyPair, importPrivate, openKeybox, SHARED_TABLES, toBase64Url } from '@agent-hangar/shared';
import { FakeTimers } from '../../test/fake-timers.ts';
import { seedCloud, type FakeWireClient } from '../../test/fake-cloud.ts';
import type { CloudConfig } from '../config/cloud.ts';
import { openDb, type Db } from '../db/open.ts';
import { upsertShared } from '../db/shared.ts';
import { getSessionNote, setSessionName } from '../sessions/notes.ts';
import { SyncEngine } from './engine.ts';
import { Keyring } from './keyring.ts';
import { RemotePuller, remoteTranscriptPath } from './puller.ts';
import { RosterStore, rosterRefresh, type ConfigWriter } from './roster.ts';
import { SealedCloudClient } from './sealedClient.ts';
import { SyncStateStore } from './state.ts';
import { TranscriptUploader } from './uploader.ts';

/**
 * 2 台の PC の通し（偽のクラウド）。
 * 参加（Task 14）より前なので、名簿と keybox は seedCloud が直に置く。
 * 各 PC は本物の部品（SealedCloudClient、RosterStore、SyncEngine、TranscriptUploader、RemotePuller）で組む。
 */

const UUID_A = 'aaaaaaaa-1111-4111-8111-111111111111';
const UUID_B = 'bbbbbbbb-2222-4222-8222-222222222222';
const PROJECT_DIR = '-Users-someone-workspace-secret-proj';
// 平文の走査で探す値。暗号文に偶然現れないよう、長く他と被らない綴りにする。
const SECRET_TITLE = 'title-unique-1-e2e';
const SECRET_PROJECT = 'project-unique-name-1-e2e';
const SECRET_TODO = 'todo-unique-text-1-e2e';
const NAME_A = 'pc-a-unique-name';
const NAME_B = 'pc-b-unique-name';
const PROJECT_ID = 'proj-unique-id-e2e-1';
const TODO_ID = 'todo-unique-id-e2e-1';

type Pc = {
  id: string;
  db: Db;
  cfg: ConfigWriter & { current: CloudConfig };
  client: SealedCloudClient;
  roster: RosterStore;
  engine: SyncEngine;
  uploader: TranscriptUploader;
  puller: RemotePuller;
  home: string;
  claudeDir: string;
};

const dirs: string[] = [];
const tmp = (p: string): string => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), p));
  dirs.push(d);
  return d;
};

async function pcOn(wire: FakeWireClient, id: string, cloud: CloudConfig): Promise<Pc> {
  const db = openDb(':memory:');
  const cfg = { current: cloud, read: () => cfg.current, write: (patch: Partial<CloudConfig>) => { cfg.current = { ...cfg.current, ...patch }; } };
  const keyring = await Keyring.fromConfig(cloud);
  const w = wire.asDevice(id);
  const roster = new RosterStore(w, keyring, cfg, id);
  let pc: Pc | null = null;
  const client = new SealedCloudClient(w, keyring, id, {
    onRoster: rosterRefresh(roster, () => { void pc?.engine.rewindSkippedRows(); }),
  });
  const timers = new FakeTimers();
  const home = tmp('hangar-home-');
  const claudeDir = tmp('hangar-claude-');
  const state = new SyncStateStore(db);
  const engine = new SyncEngine({ db, deviceId: id, client, url: cloud.url, home, timers, now: () => timers.now });
  const uploader = new TranscriptUploader({ db, deviceId: id, claudeDir, client, keyring, state, timers, isPaused: () => false, onError: (p, m) => { throw new Error(`${p}: ${m}`); } });
  const puller = new RemotePuller({ db, deviceId: id, home, client, state, onError: (k, m) => { throw new Error(`${k}: ${m}`); } });
  pc = { id, db, cfg, client, roster, engine, uploader, puller, home, claudeDir };
  return pc;
}

/** 索引が済んだ本文を 1 本置き、上げる。 */
async function writeAndUpload(pc: Pc, uuid: string, text: string): Promise<string> {
  const rel = `projects/${PROJECT_DIR}/${uuid}.jsonl`;
  const file = path.join(pc.claudeDir, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
  pc.uploader.noteChanged({ path: file, sessionId: uuid, agentId: null });
  await pc.uploader.flushSession(uuid);
  return rel;
}

const addSession = (pc: Pc, uuid: string) =>
  upsertShared(pc.db, 'sessions', { id: `s-${uuid}`, provider: 'claude-code', provider_session_id: uuid, cwd: '/Users/someone/workspace/secret-proj', started_at: 1, last_activity_at: 1, home_device: pc.id, origin_device: pc.id }, pc.id);

/** 走査する偽のクラウドの保存値。storeForScan の形のうち、PC どうしの同期が書くもの。 */
type ScanInput = Pick<ReturnType<FakeWireClient['storeForScan']>, 'rows' | 'changes' | 'files' | 'roster' | 'keyboxes' | 'devices'>;
/** 保存値の出どころ。どれも 1 つ以上走査したことを確かめる。 */
type Source = 'rowKeys' | 'rowSealed' | 'changes' | 'fileKeys' | 'fileMetas' | 'fileBodies' | 'roster' | 'keyboxes' | 'devices';

const text = (s: string): Buffer => Buffer.from(s, 'utf8');
/** base64url の文字は、文字のままと、復号したバイト列の両方を走査する（平文を符号化しただけのものも見つけるため）。 */
const sealedText = (s: string): Buffer[] => {
  const bytes = fromBase64Url(s);
  return bytes ? [text(s), Buffer.from(bytes)] : [text(s)];
};

/**
 * 偽のクラウドの保存値を出どころごとに集め、needles の平文がどこかに含まれていれば返す。
 * visits は出どころごとに走査した値の数で、空の出どころが無いことを試験が確かめる。
 */
function scanStore(s: ScanInput, needles: string[]): { found: string[]; visits: Record<Source, number> } {
  const by: Record<Source, Buffer[]> = { rowKeys: [], rowSealed: [], changes: [], fileKeys: [], fileMetas: [], fileBodies: [], roster: [], keyboxes: [], devices: [] };
  for (const r of s.rows.values()) {
    by.rowKeys.push(text(r.k), text(r.deviceId));
    if (r.sealed.length > 0) by.rowSealed.push(Buffer.from(r.sealed));
  }
  for (const c of s.changes) by.changes.push(text(c.k), Buffer.from(c.sealed));
  for (const [key, f] of s.files) {
    by.fileKeys.push(text(key), text(f.entry.key), text(f.entry.deviceId), text(f.entry.kind));
    by.fileMetas.push(...sealedText(f.entry.sealedMeta));
    by.fileBodies.push(Buffer.from(f.body));
  }
  if (s.roster) by.roster.push(...sealedText(s.roster.sealed));
  for (const [recipient, boxes] of s.keyboxes) {
    by.keyboxes.push(text(recipient));
    for (const sealed of boxes.values()) by.keyboxes.push(...sealedText(sealed));
  }
  for (const d of s.devices.values()) by.devices.push(text(JSON.stringify(d)));
  const all = Object.values(by).flat();
  const found = needles.filter((n) => all.some((v) => v.includes(text(n))));
  const visits = Object.fromEntries(Object.entries(by).map(([k, v]) => [k, v.length])) as Record<Source, number>;
  return { found, visits };
}

/** 平文の目印を 1 つの出どころの値に混ぜた写しを作る（走査が平文を見つけられることの確かめ）。元の保存値は変えない。 */
function withMarker(s: ScanInput, where: 'rowSealed' | 'fileBody' | 'fileMeta' | 'roster' | 'keybox', marker: string): ScanInput {
  const m = text(marker);
  const rows = new Map(s.rows);
  const files = new Map(s.files);
  let roster = s.roster;
  const keyboxes = new Map(s.keyboxes);
  if (where === 'rowSealed') {
    const [k, r] = [...rows].find(([, x]) => x.sealed.length > 0)!;
    rows.set(k, { ...r, sealed: new Uint8Array(Buffer.concat([Buffer.from(r.sealed), m])) });
  } else if (where === 'fileBody' || where === 'fileMeta') {
    const [k, f] = [...files][0]!;
    files.set(k, where === 'fileBody'
      ? { ...f, body: Buffer.concat([f.body, m]) }
      : { ...f, entry: { ...f.entry, sealedMeta: toBase64Url(Buffer.concat([Buffer.from(fromBase64Url(f.entry.sealedMeta)!), m])) } });
  } else if (where === 'roster') {
    roster = { ...s.roster!, sealed: toBase64Url(Buffer.concat([Buffer.from(fromBase64Url(s.roster!.sealed)!), m])) };
  } else {
    const [recipient, boxes] = [...keyboxes][0]!;
    const [epoch, sealed] = [...boxes][0]!;
    keyboxes.set(recipient, new Map([[epoch, toBase64Url(Buffer.concat([Buffer.from(fromBase64Url(sealed)!), m]))]]));
  }
  return { ...s, rows, files, roster, keyboxes };
}

let pcs: Pc[] = [];
afterEach(() => {
  for (const p of pcs) { p.engine.stop(); p.uploader.stop(); }
  pcs = [];
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

describe('2 台の通し（偽のクラウド）', () => {
  let wire: FakeWireClient;
  let a: Pc;
  let b: Pc;

  beforeEach(async () => {
    const seeded = await seedCloud([
      { id: 'dev-a', name: NAME_A, os: 'darwin', keyPair: await generateKeyPair() },
      { id: 'dev-b', name: NAME_B, os: 'win32', keyPair: await generateKeyPair() },
    ]);
    wire = seeded.wire;
    a = await pcOn(wire, 'dev-a', seeded.configs['dev-a']!);
    b = await pcOn(wire, 'dev-b', seeded.configs['dev-b']!);
    pcs = [a, b];
  });

  it('seedCloud は名簿と各 PC 宛ての keybox を置き、どちらの PC も開ける', async () => {
    for (const pc of [a, b]) {
      const { roster } = await pc.roster.read();
      expect(roster.entries.map((e) => [e.id, e.name])).toEqual([['dev-a', NAME_A], ['dev-b', NAME_B]]);
      const box = (await wire.asDevice(pc.id).getKeyboxes()).boxes[0]!;
      const { keyPair, epochs } = pc.cfg.current;
      const list = decodeEpochList(await openKeybox(await importPrivate(keyPair.priv), keyPair.pub, { epoch: box.epoch, recipient: pc.id }, fromBase64Url(box.sealed)!));
      expect(list.epochs).toEqual(epochs);
    }
    expect((await wire.listDevices()).map((d) => d.id).sort()).toEqual(['dev-a', 'dev-b']);
  });

  it('参加 → 同期で行とファイルが往復し、偽のクラウドの保存値に表名、行 ID、パス、PC の名前、題の平文が無い', async () => {
    await a.engine.start();
    await b.engine.start();

    // pc-a の行と本文が pc-b に届く。
    upsertShared(a.db, 'projects', { id: PROJECT_ID, name: SECRET_PROJECT, status: 'active', is_scratch: 0 }, 'dev-a');
    addSession(a, UUID_A);
    setSessionName(a.db, 'dev-a', `s-${UUID_A}`, SECRET_TITLE);
    await a.engine.pushNow();
    const relA = await writeAndUpload(a, UUID_A, `{"title":"${SECRET_TITLE}"}\n`);
    await b.engine.pullNow();
    await b.puller.pullNow();
    expect((b.db.prepare('select name from projects where id = ?').get(PROJECT_ID) as { name: string }).name).toBe(SECRET_PROJECT);
    expect(getSessionNote(b.db, `s-${UUID_A}`)?.name).toBe(SECRET_TITLE);
    expect(fs.readFileSync(remoteTranscriptPath(b.home, 'dev-a', relA), 'utf8')).toBe(`{"title":"${SECRET_TITLE}"}\n`);

    // pc-b の行と本文が pc-a に届く。
    upsertShared(b.db, 'todos', { id: TODO_ID, project_id: PROJECT_ID, text: SECRET_TODO, done: 0, position: 1 }, 'dev-b');
    addSession(b, UUID_B);
    await b.engine.pushNow();
    const relB = await writeAndUpload(b, UUID_B, `{"from":"${NAME_B}"}\n`);
    await a.engine.pullNow();
    await a.puller.pullNow();
    expect((a.db.prepare('select text from todos where id = ?').get(TODO_ID) as { text: string }).text).toBe(SECRET_TODO);
    expect(fs.readFileSync(remoteTranscriptPath(a.home, 'dev-b', relB), 'utf8')).toBe(`{"from":"${NAME_B}"}\n`);

    // 偽のクラウドの保存値を全部走査する（行、採った行の控え、索引、R2 の鍵名と本体、名簿、keybox、端末）。
    const s = wire.storeForScan();
    const needles = [
      ...SHARED_TABLES,
      PROJECT_ID, TODO_ID, `s-${UUID_A}`, `s-${UUID_B}`,
      UUID_A, UUID_B, PROJECT_DIR, relA, relB, '.jsonl', 'projects/', a.claudeDir, b.claudeDir,
      NAME_A, NAME_B, SECRET_TITLE, SECRET_PROJECT, SECRET_TODO,
    ];
    const clean = scanStore(s, needles);
    // どの出どころも走査している（封じた行のバイト列、本文、メタ、名簿、keybox を含む）。
    expect(Object.entries(clean.visits).filter(([, n]) => n === 0).map(([k]) => k)).toEqual([]);
    expect(clean.visits.rowSealed).toBeGreaterThanOrEqual(4);
    expect(clean.visits.fileBodies).toBe(2);
    expect(clean.found).toEqual([]);

    // 走査が平文を見つけられることの確かめ。目印を 1 つの出どころに混ぜた写しでは、同じ走査が目印を見つける。
    const marker = 'plaintext-marker-unique-e2e';
    expect(scanStore(s, [marker]).found).toEqual([]);
    for (const where of ['rowSealed', 'fileBody', 'fileMeta', 'roster', 'keybox'] as const) {
      expect({ where, found: scanStore(withMarker(s, where, marker), [marker]).found }).toEqual({ where, found: [marker] });
    }
    // 端末の ID は Worker が平文で持つ（認証と鍵名の頭）ので見つかる。
    expect(scanStore(s, ['dev-a', 'dev-b']).found).toEqual(['dev-a', 'dev-b']);
  });
});
