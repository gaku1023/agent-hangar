import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { decodeEpochList, fromBase64Url, generateKeyPair, importPrivate, openKeybox, SHARED_TABLES } from '@agent-hangar/shared';
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
const SECRET_TITLE = 'title-1';
const SECRET_PROJECT = 'project-name-1';

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

/** 文字列を、base64url として読めればその中身のバイト列も、読めなければそのまま、走査の対象に足す。 */
function collect(out: Buffer[], v: unknown): void {
  if (v === null || v === undefined) return;
  if (v instanceof Uint8Array) { out.push(Buffer.from(v)); return; }
  if (typeof v === 'string') {
    out.push(Buffer.from(v, 'utf8'));
    const bytes = fromBase64Url(v);
    if (bytes && v.length >= 16) out.push(Buffer.from(bytes));
    return;
  }
  if (typeof v === 'number' || typeof v === 'boolean') return;
  if (v instanceof Map) { for (const [k, x] of v) { collect(out, k); collect(out, x); } return; }
  if (Array.isArray(v)) { for (const x of v) collect(out, x); return; }
  if (typeof v === 'object') for (const x of Object.values(v as Record<string, unknown>)) collect(out, x);
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
      { id: 'dev-a', name: 'pc-a', os: 'darwin', keyPair: await generateKeyPair() },
      { id: 'dev-b', name: 'pc-b', os: 'win32', keyPair: await generateKeyPair() },
    ]);
    wire = seeded.wire;
    a = await pcOn(wire, 'dev-a', seeded.configs['dev-a']!);
    b = await pcOn(wire, 'dev-b', seeded.configs['dev-b']!);
    pcs = [a, b];
  });

  it('seedCloud は名簿と各 PC 宛ての keybox を置き、どちらの PC も開ける', async () => {
    for (const pc of [a, b]) {
      const { roster } = await pc.roster.read();
      expect(roster.entries.map((e) => [e.id, e.name])).toEqual([['dev-a', 'pc-a'], ['dev-b', 'pc-b']]);
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
    upsertShared(a.db, 'projects', { id: 'proj-e2e-1', name: SECRET_PROJECT, status: 'active', is_scratch: 0 }, 'dev-a');
    addSession(a, UUID_A);
    setSessionName(a.db, 'dev-a', `s-${UUID_A}`, SECRET_TITLE);
    await a.engine.pushNow();
    const relA = await writeAndUpload(a, UUID_A, `{"title":"${SECRET_TITLE}"}\n`);
    await b.engine.pullNow();
    await b.puller.pullNow();
    expect((b.db.prepare('select name from projects where id = ?').get('proj-e2e-1') as { name: string }).name).toBe(SECRET_PROJECT);
    expect(getSessionNote(b.db, `s-${UUID_A}`)?.name).toBe(SECRET_TITLE);
    expect(fs.readFileSync(remoteTranscriptPath(b.home, 'dev-a', relA), 'utf8')).toBe(`{"title":"${SECRET_TITLE}"}\n`);

    // pc-b の行と本文が pc-a に届く。
    upsertShared(b.db, 'todos', { id: 'todo-e2e-1', project_id: 'proj-e2e-1', text: 'secret-todo-text', done: 0, position: 1 }, 'dev-b');
    addSession(b, UUID_B);
    await b.engine.pushNow();
    const relB = await writeAndUpload(b, UUID_B, '{"from":"pc-b"}\n');
    await a.engine.pullNow();
    await a.puller.pullNow();
    expect((a.db.prepare('select text from todos where id = ?').get('todo-e2e-1') as { text: string }).text).toBe('secret-todo-text');
    expect(fs.readFileSync(remoteTranscriptPath(a.home, 'dev-b', relB), 'utf8')).toBe('{"from":"pc-b"}\n');

    // 偽のクラウドの保存値を全部走査する（行、採った行の控え、索引、R2 の鍵名と本体、名簿、keybox、端末）。
    const s = wire.storeForScan();
    const values: Buffer[] = [];
    collect(values, s.rows);
    collect(values, s.changes);
    collect(values, [...s.files.values()].map((f) => [f.entry, f.body]));
    collect(values, [...s.files.keys()]);
    collect(values, s.roster);
    collect(values, s.keyboxes);
    collect(values, s.devices);
    expect(values.length).toBeGreaterThan(10);
    // 走査が値に届いている確かめ。端末の ID は Worker が平文で持つ（認証と鍵名の頭）。
    expect(values.some((v) => v.includes(Buffer.from('dev-a', 'utf8')))).toBe(true);
    const needles = [
      ...SHARED_TABLES,
      'proj-e2e-1', 'todo-e2e-1', `s-${UUID_A}`, `s-${UUID_B}`,
      UUID_A, UUID_B, PROJECT_DIR, relA, relB, '.jsonl', 'projects/', a.claudeDir, b.claudeDir,
      'pc-a', 'pc-b', SECRET_TITLE, SECRET_PROJECT, 'secret-todo-text',
    ];
    const found = needles.filter((n) => values.some((v) => v.includes(Buffer.from(n, 'utf8'))));
    expect(found).toEqual([]);
  });
});
