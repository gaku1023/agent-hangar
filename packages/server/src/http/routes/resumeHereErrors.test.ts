import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Language } from '@agent-hangar/shared';
import { openDb } from '../../db/open.ts';
import { upsertShared } from '../../db/shared.ts';
import { remoteTranscriptPath } from '../../sync/puller.ts';
import { resumeHere } from '../../sync/resumeHere.ts';
import { sha256Hex } from '../../sync/crypto.ts';
import { createApp } from '../app.ts';
import { H, launched, testDeps, type TestWorld } from '../testing.ts';

/**
 * 「この PC で再開」の写しが失敗したとき、経路は生の 500 ではなく、いまの言語の文を JSON で返す。
 * 写しは本物（sync/copy.ts）を通し、~/.claude の途中をリンクにして失敗させる。
 */

const UUID = '11111111-1111-4111-8111-111111111111';
const NOW = 1_700_000_000_000;
let t: TestWorld;
let home: string;
let claudeDir: string;
let outside: string;
let db: ReturnType<typeof openDb>;

beforeEach(async () => {
  t = await testDeps();
  db = openDb(':memory:');
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'hangar-home-'));
  claudeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hangar-claude-'));
  outside = fs.mkdtempSync(path.join(os.tmpdir(), 'hangar-outside-'));
  upsertShared(db, 'sessions', { id: 's1', provider: 'claude-code', provider_session_id: UUID, cwd: '/w/alpha', home_device: 'dev-b' }, 'dev-b');
  // 他の PC から降ろした写しを 1 つ置く。
  const rel = `projects/-w-alpha/${UUID}.jsonl`;
  const p = remoteTranscriptPath(home, 'dev-b', rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, 'remote\n');
  db.prepare('insert into file_sync (key, kind, path, device_id, sha256, size, mtime, remote_seq, synced_at) values (?,?,?,?,?,?,?,?,?)')
    .run(`transcripts/dev-b/${UUID}.jsonl.gz`, 'transcript', rel, 'dev-b', sha256Hex('remote\n'), 7, NOW, 1, NOW);
});
afterEach(() => {
  t.dispose();
  for (const d of [home, claudeDir, outside]) fs.rmSync(d, { recursive: true, force: true });
});

const post = (language: Language, sessionId = 's1') => {
  const app = createApp({
    ...t.deps,
    language: () => language,
    resumeHere: (id, overwrite) => resumeHere({ db, home, claudeDir, resume: () => launched, pruneTranscripts: () => undefined }, id, overwrite),
  });
  return app.request(`/api/sessions/${sessionId}/resume-here`, { method: 'POST', headers: { ...H, 'content-type': 'application/json' }, body: JSON.stringify({ overwrite: true }) });
};
const body = async (r: Response): Promise<{ error: string }> => (await r.json()) as { error: string };

describe('この PC で再開の写しの失敗', () => {
  it('projects の途中がリンクなら、409 でいまの言語の文を返す（500 にしない）', async () => {
    fs.mkdirSync(path.join(claudeDir, 'projects'), { recursive: true });
    fs.symlinkSync(outside, path.join(claudeDir, 'projects', '-w-alpha'));
    const ja = await post('ja');
    expect(ja.status).toBe(409);
    expect((await body(ja)).error).toContain('がシンボリックリンクなので、~/.claudeの外に出ます');
    const en = await post('en');
    expect(en.status).toBe(409);
    expect((await body(en)).error).toBe('projects/-w-alpha is a symbolic link, so it would leave ~/.claude');
    // リンクの先には何も書かない。
    expect(fs.readdirSync(outside)).toEqual([]);
  });

  it('控えが取れなければ、理由も同じ言語の文で返す', async () => {
    fs.mkdirSync(path.join(claudeDir, 'projects', '-w-alpha'), { recursive: true });
    fs.writeFileSync(path.join(claudeDir, 'projects', '-w-alpha', `${UUID}.jsonl`), 'short\n');
    fs.mkdirSync(path.join(home, 'backups'), { recursive: true });
    fs.symlinkSync(outside, path.join(home, 'backups', 'transcripts'));
    const ja = await post('ja');
    expect(ja.status).toBe(409);
    expect((await body(ja)).error).toBe('バックアップを作成できなかったので、トランスクリプトを置き換えませんでした: transcripts がシンボリックリンクなので、バックアップのフォルダの外に出ます');
    const en = await post('en');
    expect(en.status).toBe(409);
    expect((await body(en)).error).toBe('The transcript was not replaced because a backup could not be made: transcripts is a symbolic link, so it would leave the backup folder');
  });

  it('セッションの識別子が名前として不正なら、400 で文を返す', async () => {
    db.prepare('update sessions set provider_session_id = ? where id = ?').run('../../../evil', 's1');
    const ja = await post('ja');
    expect(ja.status).toBe(400);
    expect((await body(ja)).error).toBe('セッションの識別子がファイル名として不正です');
    const en = await post('en');
    expect(en.status).toBe(400);
    expect((await body(en)).error).toBe('The session ID is not valid as a file name');
  });
});
