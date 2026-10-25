import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { LaunchResultDto } from '@agent-hangar/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDb, type Db } from '../db/open.ts';
import { ensureSession } from '../indexer/write.ts';
import { OpencodeImportError } from '../provider/opencode/transfer.ts';
import { RunError } from '../runs/errors.ts';
import { sha256Hex } from './crypto.ts';
import { compareOpencodeForResume, pickRemoteOpencode, resumeOpencodeHere, type OpencodeResumeDeps } from './opencodeResume.ts';
import { remoteTranscriptPath } from './puller.ts';

const SES = 'ses_e8e86939cffewIeT7kgc690PVE';
const SELF = 'dev-a';
const exportText = (dir: string, ids: string[]): string =>
  JSON.stringify({ info: { id: SES, location: { directory: dir } }, messages: ids.map((id, i) => ({ id, time: { created: i + 1 }, text: id, type: 'user' })) });

describe('opencode の「この PC で再開」', () => {
  let db: Db;
  let home: string;
  let sessionId: string;
  let calls: string[];
  let localFile: string | null;
  let importErr: Error | null;
  const launched = { sessionId: 'x' } as unknown as LaunchResultDto;

  beforeEach(() => {
    db = openDb(':memory:');
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'hangar-ocr-'));
    sessionId = ensureSession(db, SES, '/Users/other/work/alpha', 'dev-b', 'opencode');
    calls = [];
    localFile = null;
    importErr = null;
  });
  afterEach(() => { db.close(); fs.rmSync(home, { recursive: true, force: true }); });

  /** dev から降ろした写しを置き、台帳に行を書く（puller と同じ形）。 */
  const landed = (dev: string, text: string, o: { mtime?: number; sha?: string } = {}): string => {
    const rel = `opencode/${SES}.json`;
    const p = remoteTranscriptPath(home, dev, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, text);
    db.prepare("insert into file_sync (key, kind, path, device_id, sha256, size, mtime, remote_seq, synced_at) values (?, 'transcript', ?, ?, ?, ?, ?, 1, 0)")
      .run(`opencode/${dev}/${SES}.json.gz`, rel, dev, o.sha ?? sha256Hex(text), Buffer.byteLength(text), o.mtime ?? 1000);
    return p;
  };
  /** この PC の opencode にある会話の書き出し（無ければ null）。 */
  const local = (text: string | null): void => {
    if (text === null) { localFile = null; return; }
    const dir = path.join(home, 'opencode', 'export');
    fs.mkdirSync(dir, { recursive: true });
    localFile = path.join(dir, `${SES}.json`);
    fs.writeFileSync(localFile, text);
  };
  const deps = (): OpencodeResumeDeps => ({
    db, home, deviceId: SELF,
    prepare: (id) => { calls.push(`prepare ${id}`); return '/Users/me/work/alpha'; },
    exportLocal: async (id) => { calls.push(`export ${id}`); return localFile; },
    transfer: {
      importSession: async (o) => {
        calls.push(`import ${o.providerSessionId} ${o.file} ${o.directory} ${o.replace ? 'replace' : 'new'}`);
        if (importErr) throw importErr;
      },
    },
    stopServe: async (id) => { calls.push(`stop ${id}`); },
    resume: async (id) => { calls.push(`resume ${id}`); return launched; },
    pruneTranscripts: () => { calls.push('prune'); },
    now: () => new Date(2026, 9, 25, 12, 0, 0).getTime(),
  });

  it('この PC に会話が無ければ、降ろした写しを、この PC の場所で取り込んでから再開する', async () => {
    const p = landed('dev-b', exportText('/Users/other/work/alpha', ['m1', 'm2']));
    expect(await resumeOpencodeHere(deps(), sessionId, false)).toBe(launched);
    expect(calls).toEqual([`prepare ${sessionId}`, `export ${SES}`, `import ${SES} ${p} /Users/me/work/alpha new`, `resume ${sessionId}`]);
  });

  it('手元が写しの全部を持っていれば（写しが古い）、取り込まずに再開する', async () => {
    landed('dev-b', exportText('/x', ['m1', 'm2']));
    local(exportText('/Users/me/work/alpha', ['m1', 'm2', 'm3']));
    expect(await resumeOpencodeHere(deps(), sessionId, false)).toBe(launched);
    expect(calls).toEqual([`prepare ${sessionId}`, `export ${SES}`, `resume ${sessionId}`]);
  });

  it('写しに手元に無い続きがあれば、上書きの承諾が無いうちは大きさを返して尋ねる（local_smaller）', async () => {
    const remote = exportText('/x', ['m1', 'm2', 'm3']);
    landed('dev-b', remote);
    const mine = exportText('/Users/me/work/alpha', ['m1']);
    local(mine);
    expect(await resumeOpencodeHere(deps(), sessionId, false)).toEqual({ error: 'local_smaller', localSize: Buffer.byteLength(mine), remoteSize: Buffer.byteLength(remote) });
    expect(calls).toEqual([`prepare ${sessionId}`, `export ${SES}`]);
  });

  it('承諾があれば、手元の書き出しの控えを取り、消してから取り込み、控えを刈って再開する', async () => {
    const p = landed('dev-b', exportText('/x', ['m1', 'm2', 'm3']));
    const mine = exportText('/Users/me/work/alpha', ['m1', 'mine']);
    local(mine);
    expect(await resumeOpencodeHere(deps(), sessionId, true)).toBe(launched);
    expect(calls).toEqual([`prepare ${sessionId}`, `export ${SES}`, `import ${SES} ${p} /Users/me/work/alpha replace`, 'prune', `resume ${sessionId}`]);
    const backups = fs.readdirSync(path.join(home, 'backups', 'transcripts'));
    expect(backups).toEqual([`${SES}-20261025-120000.json`]);
    expect(fs.readFileSync(path.join(home, 'backups', 'transcripts', backups[0]!), 'utf8')).toBe(mine);
  });

  it('取り込めなければ、起こした serve を止めて 400 で断る', async () => {
    landed('dev-b', exportText('/x', ['m1']));
    importErr = new OpencodeImportError('directory');
    const err = await resumeOpencodeHere(deps(), sessionId, false).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RunError);
    expect((err as RunError).status).toBe(400);
    expect(calls.slice(-1)).toEqual([`stop ${sessionId}`]);
    expect(calls.some((c) => c.startsWith('resume'))).toBe(false);
  });

  it('写しも手元の会話も無ければ 400、この PC で起こせなければ書き出しの前に断る', async () => {
    const none = await resumeOpencodeHere(deps(), sessionId, false).catch((e: unknown) => e);
    expect((none as RunError).status).toBe(400);
    expect((none as RunError).message).toBe('このセッションのトランスクリプトがありません');
    calls = [];
    const d = { ...deps(), prepare: (): string => { calls.push('prepare'); throw new RunError(409, 'running'); } };
    await expect(resumeOpencodeHere(d, sessionId, false)).rejects.toThrow('running');
    expect(calls).toEqual(['prepare']);
  });

  it('写しの選び方：台帳と指紋の合わない写しと、自分の写しは使わず、新しい方を選ぶ', () => {
    landed('dev-b', exportText('/b', ['m1']), { mtime: 1000 });
    const c = landed('dev-c', exportText('/c', ['m1', 'm2']), { mtime: 2000 });
    expect(pickRemoteOpencode(db, home, SELF, SES)?.path).toBe(c);
    db.prepare("update file_sync set sha256 = 'bad' where device_id = 'dev-c'").run();
    expect(pickRemoteOpencode(db, home, SELF, SES)?.deviceId).toBe('dev-b');
    expect(pickRemoteOpencode(db, home, 'dev-b', SES)).toBeNull();
  });

  it('確認の 1 枚：手元の書き出しが写しの先頭部分なら ahead、別の続きなら diverged、手元が全部を持てば null', () => {
    landed('dev-b', exportText('/x', ['m1', 'm2', 'm3']));
    expect(compareOpencodeForResume({ db, home, deviceId: SELF, sessionId })).toBeNull();
    local(exportText('/me', ['m1']));
    expect(compareOpencodeForResume({ db, home, deviceId: SELF, sessionId })).toMatchObject({ kind: 'ahead' });
    local(exportText('/me', ['m1', 'mine']));
    expect(compareOpencodeForResume({ db, home, deviceId: SELF, sessionId })).toMatchObject({ kind: 'diverged' });
    local(exportText('/me', ['m1', 'm2', 'm3', 'm4']));
    expect(compareOpencodeForResume({ db, home, deviceId: SELF, sessionId })).toBeNull();
  });
});
