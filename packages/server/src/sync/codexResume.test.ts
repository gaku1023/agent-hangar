import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { LaunchResultDto } from '@agent-hangar/shared';
import { CODEX_ONE_TURN, fixtureBytes, makeCodexHome, putRollout, rolloutName } from '../../test/codexFixtures.ts';
import { openDb, type Db } from '../db/open.ts';
import { codexSyncPath } from './agentSync.ts';
import { resumeCodexHere, type CodexResumeDeps } from './codexResume.ts';
import { sha256Hex } from './crypto.ts';
import { remoteTranscriptPath } from './puller.ts';
import { resumeHereFor } from './resumeHere.ts';

// Codex の会話の「この PC で再開」（docs/design.md「Codex の本文」の「この PC で再開」）。
// CODEX_HOME はどれも一時のディレクトリで、本物の ~/.codex は読まない・書かない。偽のクラウドの代わりに、降ろした写しと台帳の行を直に置く。

const ID = CODEX_ONE_TURN.id;
const { name: NAME, rel: REL } = rolloutName(ID);
const SESSIONS_PATH = codexSyncPath(NAME, false);
const ARCHIVED_PATH = codexSyncPath(NAME, true);
const BODY = fixtureBytes(CODEX_ONE_TURN.file);
/** resume しただけで末尾に足される 1 行（thread_settings_applied）を真似た追記。 */
const RESUME_LINE = (cwd: string) => Buffer.from(`{"type":"event_msg","payload":{"type":"thread_settings_applied","cwd":${JSON.stringify(cwd)}}}\n`);
const LONGER = Buffer.concat([BODY, RESUME_LINE('/b/alpha')]);
const SID = 's-cx';

let db: Db;
let home: string;
let codexHome: string;
let calls: string[];
let prepared: string | null;

const local = () => path.join(codexHome, REL);
const archivedLocal = () => path.join(codexHome, 'archived_sessions', NAME);

/** dev-b が上げた写しを降ろした状態を作る（remote/dev-b/ の下と、台帳の行）。 */
function putRemote(body: Buffer, rel = SESSIONS_PATH, o: { sha?: string; mtime?: number; device?: string } = {}): string {
  const device = o.device ?? 'dev-b';
  const p = remoteTranscriptPath(home, device, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, body);
  db.prepare(`insert into file_sync (key, kind, path, device_id, sha256, size, mtime, remote_seq, synced_at) values (?, 'transcript', ?, ?, ?, ?, ?, 1, 1)
    on conflict(key) do update set path = excluded.path, sha256 = excluded.sha256, size = excluded.size, mtime = excluded.mtime`)
    .run(`codex/${device}/${ID}.jsonl.gz`, rel, device, o.sha ?? sha256Hex(body), body.length, o.mtime ?? 1);
  return p;
}

function deps(over: Partial<CodexResumeDeps> = {}): CodexResumeDeps {
  return {
    db, home, deviceId: 'dev-a', codexHome: () => codexHome,
    prepare: (id) => { calls.push(`prepare:${id}`); prepared = '/a/alpha'; return prepared; },
    stopWriters: async (id, thread) => { calls.push(`stop:${id}:${thread}`); },
    resume: async (id) => {
      calls.push(`resume:${id}`);
      return { sessionId: id } as unknown as LaunchResultDto;
    },
    ...over,
  };
}

beforeEach(() => {
  db = openDb(':memory:');
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'hangar-cxr-home-'));
  codexHome = makeCodexHome();
  calls = [];
  prepared = null;
  db.prepare('insert into sessions (id, provider, provider_session_id, cwd, started_at, last_activity_at, home_device, origin_device, updated_at) values (?,?,?,?,?,?,?,?,?)')
    .run(SID, 'codex', ID, '/b/alpha', 1, 1, 'dev-b', 'dev-b', 1);
});
afterEach(() => {
  db.close();
  for (const d of [home, codexHome]) fs.rmSync(d, { recursive: true, force: true });
});

describe('Codex の会話の「この PC で再開」', () => {
  it('手元に無ければ、写しを $CODEX_HOME/sessions/YYYY/MM/DD/<元の名前>.jsonl に置いてから再開する。止めるのは置く前', async () => {
    putRemote(LONGER);
    await resumeCodexHere(deps({
      stopWriters: async (id, thread) => { calls.push(`stop:${id}:${thread}`); expect(fs.existsSync(local())).toBe(false); },
    }), SID);
    expect(fs.readFileSync(local()).equals(LONGER)).toBe(true);
    expect(calls).toEqual([`prepare:${SID}`, `stop:${SID}:${ID}`, `resume:${SID}`]);
    // Codex の DB と索引には触らない。
    expect(fs.readdirSync(codexHome).sort()).toEqual(['sessions']);
  });

  it('一致：手元が写しと同じなら書かずに再開する', async () => {
    putRollout(codexHome, REL, BODY);
    const before = fs.statSync(local()).mtimeMs;
    putRemote(BODY);
    await resumeCodexHere(deps(), SID);
    expect(fs.readFileSync(local()).equals(BODY)).toBe(true);
    expect(fs.statSync(local()).mtimeMs).toBe(before);
    expect(calls.at(-1)).toBe(`resume:${SID}`);
  });

  it('伸びた：手元が写しの先頭部分なら、写しで置き換えてから再開する', async () => {
    putRollout(codexHome, REL, BODY);
    putRemote(LONGER);
    await resumeCodexHere(deps(), SID);
    expect(fs.readFileSync(local()).equals(LONGER)).toBe(true);
    expect(calls.at(-1)).toBe(`resume:${SID}`);
  });

  it('手元の方が先へ進んでいる（写しが手元の先頭部分）なら、書かずに再開する', async () => {
    putRollout(codexHome, REL, LONGER);
    putRemote(BODY);
    await resumeCodexHere(deps(), SID);
    expect(fs.readFileSync(local()).equals(LONGER)).toBe(true);
    expect(calls.at(-1)).toBe(`resume:${SID}`);
  });

  it('食い違う：手元が写しの先頭部分でなく、写しも手元の先頭部分でなければ、競合として上書きせず 409 で断る（承認があっても）', async () => {
    const mine = Buffer.concat([BODY, RESUME_LINE('/a/alpha')]);
    putRollout(codexHome, REL, mine);
    putRemote(LONGER);
    for (const overwrite of [false, true]) {
      await expect(resumeCodexHere(deps(), SID, overwrite)).rejects.toMatchObject({ status: 409 });
      expect(fs.readFileSync(local()).equals(mine)).toBe(true);
    }
    expect(calls.filter((c) => c.startsWith('resume:'))).toEqual([]);
  });

  it('手元が .jsonl.zst なら展開して比べ、伸びていれば .jsonl で置き、.zst を消す', async () => {
    putRollout(codexHome, `${REL}.zst`, fixtureBytes(`${CODEX_ONE_TURN.file}.zst`));
    putRemote(LONGER);
    await resumeCodexHere(deps(), SID);
    expect(fs.readFileSync(local()).equals(LONGER)).toBe(true);
    expect(fs.existsSync(`${local()}.zst`)).toBe(false);
  });

  it('アーカイブ済みの写しは sessions/ に置く（unarchive）', async () => {
    putRemote(LONGER, ARCHIVED_PATH);
    await resumeCodexHere(deps(), SID);
    expect(fs.readFileSync(local()).equals(LONGER)).toBe(true);
    expect(fs.existsSync(archivedLocal())).toBe(false);
  });

  it('この PC でアーカイブ済みの会話は、その置き場のまま書き直す（codex の DB がアーカイブ済みと覚えているので、戻すのは再開の thread/unarchive に任せる）', async () => {
    putRollout(codexHome, path.join('archived_sessions', NAME), BODY);
    putRemote(LONGER);
    await resumeCodexHere(deps(), SID);
    expect(fs.readFileSync(archivedLocal()).equals(LONGER)).toBe(true);
    expect(fs.existsSync(local())).toBe(false);
  });

  it('台帳の指紋と合わない写しは使わない。使える写しが無く、手元にも無ければ 400', async () => {
    putRemote(LONGER, SESSIONS_PATH, { sha: 'f'.repeat(64) });
    await expect(resumeCodexHere(deps(), SID)).rejects.toMatchObject({ status: 400 });
    expect(fs.existsSync(local())).toBe(false);
  });

  it('写しが無くても、手元にあればそのまま再開する', async () => {
    putRollout(codexHome, REL, BODY);
    await resumeCodexHere(deps(), SID);
    expect(calls.at(-1)).toBe(`resume:${SID}`);
  });

  it('自分が上げた台帳の行は写しに使わない。写しが何台分もあれば新しい方を使う', async () => {
    putRemote(BODY, SESSIONS_PATH, { device: 'dev-a', mtime: 9 });
    putRemote(BODY, SESSIONS_PATH, { device: 'dev-c', mtime: 1 });
    putRemote(LONGER, SESSIONS_PATH, { device: 'dev-b', mtime: 5 });
    await resumeCodexHere(deps(), SID);
    expect(fs.readFileSync(local()).equals(LONGER)).toBe(true);
  });

  it('用意（prepare）が断れば、止めも書きもしない', async () => {
    putRemote(LONGER);
    await expect(resumeCodexHere(deps({ prepare: () => { throw Object.assign(new Error('running'), { status: 409 }); } }), SID)).rejects.toMatchObject({ status: 409 });
    expect(calls).toEqual([]);
    expect(fs.existsSync(local())).toBe(false);
  });

  it('置き場の途中のシンボリックリンクは踏まずに断る', async () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'hangar-cxr-out-'));
    try {
      fs.mkdirSync(path.join(codexHome, 'sessions'), { recursive: true });
      fs.symlinkSync(outside, path.join(codexHome, 'sessions', '2026'));
      putRemote(LONGER);
      await expect(resumeCodexHere(deps(), SID)).rejects.toMatchObject({ status: 409 });
      expect(fs.readdirSync(outside)).toEqual([]);
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  it('resumeHereFor は Codex の会話をこの道に振り分ける', async () => {
    putRemote(LONGER);
    const claudeResume = (): never => { throw new Error('claude path'); };
    await resumeHereFor({
      db,
      claude: { db, home, claudeDir: home, resume: claudeResume, pruneTranscripts: () => {} },
      opencode: () => { throw new Error('opencode path'); },
      codex: () => deps(),
    }, SID, false);
    expect(fs.readFileSync(local()).equals(LONGER)).toBe(true);
  });
});
