import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { openDb, type Db } from '../db/open.ts';
import { upsertShared } from '../db/shared.ts';
import { copyTranscriptForResume, timestampLabel } from './copy.ts';
import { sha256Hex } from './crypto.ts';

const UUID = '11111111-1111-4111-8111-111111111111';
const NOW = 1_700_000_000_000;
let db: Db;
let home: string;
let claudeDir: string;

const target = () => path.join(claudeDir, 'projects', '-w-alpha', `${UUID}.jsonl`);

/** 他端末から降ろした写しと、その台帳の 1 行を作る。sha256 は実物の中身から取る。 */
const seedRemote = (device: string, text: string, mtime: number, sha = sha256Hex(text)): string => {
  const rel = `projects/-w-alpha/${UUID}.jsonl`;
  const p = path.join(home, 'remote', device, ...rel.split('/'));
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, text);
  fs.utimesSync(p, new Date(mtime), new Date(mtime));
  db.prepare('insert into file_sync (key, kind, path, device_id, sha256, size, mtime, remote_seq, synced_at) values (?,?,?,?,?,?,?,?,?)')
    .run(`transcripts/${device}/${UUID}.jsonl.gz`, 'transcript', rel, device, sha, Buffer.byteLength(text), mtime, 1, NOW);
  return p;
};

const writeLocal = (text: string): void => {
  fs.mkdirSync(path.dirname(target()), { recursive: true });
  fs.writeFileSync(target(), text);
};

const copy = (overwrite = false) => copyTranscriptForResume({ db, home, claudeDir, sessionId: 's1', overwrite, now: () => NOW });

beforeEach(() => {
  db = openDb(':memory:');
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'hangar-home-'));
  claudeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hangar-claude-'));
  upsertShared(db, 'sessions', { id: 's1', provider: 'claude-code', provider_session_id: UUID, cwd: '/w/alpha', home_device: 'dev-b' }, 'dev-b');
});

describe('copyTranscriptForResume', () => {
  it('写しが無ければ none', () => {
    expect(copy()).toEqual({ kind: 'none' });
    expect(copyTranscriptForResume({ db, home, claudeDir, sessionId: 'nope', overwrite: false })).toEqual({ kind: 'none' });
  });

  it('手元に無ければ、更新時刻が最新の写しを cwd の変換名の下に置く', () => {
    seedRemote('dev-b', 'older\n', NOW - 10_000);
    const newer = seedRemote('dev-c', 'newer-body\n', NOW);
    const r = copy();
    expect(r).toEqual({ kind: 'copied', target: target(), from: newer, bytes: 11, backedUp: null });
    expect(fs.readFileSync(target(), 'utf8')).toBe('newer-body\n');
    // 一時ファイルを置いたままにしない。
    expect(fs.readdirSync(path.dirname(target()))).toEqual([`${UUID}.jsonl`]);
  });

  it('手元の方が大きいか同じなら手元を使う', () => {
    seedRemote('dev-b', 'abc\n', NOW);
    writeLocal('abcdef\n');
    expect(copy()).toEqual({ kind: 'kept', target: target() });
    expect(fs.readFileSync(target(), 'utf8')).toBe('abcdef\n');
  });

  it('手元の方が大きいか同じなら、overwrite でも上書きしない', () => {
    seedRemote('dev-b', 'abc\n', NOW);
    writeLocal('abcdef\n');
    expect(copy(true)).toEqual({ kind: 'kept', target: target() });
    expect(fs.readFileSync(target(), 'utf8')).toBe('abcdef\n');
    expect(fs.existsSync(path.join(home, 'backups'))).toBe(false);
  });

  it('手元の方が小さければ ask を返し、overwrite でバックアップしてから置き換える', () => {
    seedRemote('dev-b', 'remote-longer\n', NOW);
    writeLocal('short\n');
    expect(copy()).toEqual({ kind: 'ask', localSize: 6, remoteSize: 14 });
    expect(fs.readFileSync(target(), 'utf8')).toBe('short\n');
    const r = copy(true);
    expect(r.kind).toBe('copied');
    const backedUp = (r as { backedUp: string }).backedUp;
    expect(backedUp).toBe(path.join(home, 'backups', 'transcripts', `${UUID}-${timestampLabel(NOW)}.jsonl`));
    expect(fs.readFileSync(backedUp, 'utf8')).toBe('short\n');
    expect(fs.readFileSync(target(), 'utf8')).toBe('remote-longer\n');
  });

  it('台帳の SHA-256 と中身が合わない写しは使わず、合う写しへ落とす', () => {
    const good = seedRemote('dev-b', 'good-body\n', NOW - 10_000);
    seedRemote('dev-c', 'tampered\n', NOW, 'f'.repeat(64));
    const r = copy();
    expect(r).toMatchObject({ kind: 'copied', from: good });
    expect(fs.readFileSync(target(), 'utf8')).toBe('good-body\n');
  });

  it('合う写しが 1 つも無ければ none を返し、手元があれば kept のまま触らない', () => {
    seedRemote('dev-c', 'tampered\n', NOW, 'f'.repeat(64));
    expect(copy()).toEqual({ kind: 'none' });
    writeLocal('mine\n');
    expect(copy(true)).toEqual({ kind: 'kept', target: target() });
    expect(fs.readFileSync(target(), 'utf8')).toBe('mine\n');
  });

  it('控えが取れなければ ~/.claude を書き換えない', () => {
    seedRemote('dev-b', 'remote-longer\n', NOW);
    writeLocal('short\n');
    // backups を普通のファイルで塞ぐと、控えの入れ物が作れなくなる。
    fs.writeFileSync(path.join(home, 'backups'), 'x');
    expect(() => copy(true)).toThrow(/控え/);
    expect(fs.readFileSync(target(), 'utf8')).toBe('short\n');
    expect(fs.readdirSync(path.dirname(target()))).toEqual([`${UUID}.jsonl`]);
  });

  it('セッションの UUID が名前として不正なら書かない', () => {
    db.prepare('update sessions set provider_session_id = ? where id = ?').run('../../../evil', 's1');
    expect(() => copy()).toThrow(/セッション/);
  });

  it('timestampLabel は秒までの並べ替えできる文字列', () => {
    expect(timestampLabel(new Date(2026, 8, 18, 9, 5, 7).getTime())).toBe('20260918-090507');
  });
});
