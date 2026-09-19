import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { openDb, type Db } from '../db/open.ts';
import { upsertShared } from '../db/shared.ts';
import { copyTranscriptForResume, safeDeviceLabel, timestampLabel } from './copy.ts';
import { sha256Hex } from './crypto.ts';
import { remoteTranscriptPath } from './puller.ts';

const UUID = '11111111-1111-4111-8111-111111111111';
const NOW = 1_700_000_000_000;
let db: Db;
let home: string;
let claudeDir: string;

const target = () => path.join(claudeDir, 'projects', '-w-alpha', `${UUID}.jsonl`);

const REL = `projects/-w-alpha/${UUID}.jsonl`;

/**
 * 他端末から降ろした写しと、その台帳の 1 行を作る。
 * 置き場は puller の remoteTranscriptPath そのもので組み立てる。
 * copy.ts が別の規則で組み立てていたら、ここで置いた写しは見つからずテストが落ちる。
 */
const seedRemote = (device: string, text: string, mtime: number, sha = sha256Hex(text), rel = REL): string => {
  const p = remoteTranscriptPath(home, device, rel);
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

  it('同じ秒に 2 度上書きしても、先の控えを潰さない', () => {
    const dir = path.join(home, 'backups', 'transcripts');
    const at = (n: number) => path.join(dir, n === 1 ? `${UUID}-${timestampLabel(NOW)}.jsonl` : `${UUID}-${timestampLabel(NOW)}-${n}.jsonl`);
    seedRemote('dev-b', 'remote-longer\n', NOW);

    writeLocal('first\n');
    expect((copy(true) as { backedUp: string }).backedUp).toBe(at(1));
    writeLocal('second\n');
    expect((copy(true) as { backedUp: string }).backedUp).toBe(at(2));
    writeLocal('third\n');
    expect((copy(true) as { backedUp: string }).backedUp).toBe(at(3));

    // 3 回分の直前の姿がすべて残っている。
    expect(fs.readFileSync(at(1), 'utf8')).toBe('first\n');
    expect(fs.readFileSync(at(2), 'utf8')).toBe('second\n');
    expect(fs.readFileSync(at(3), 'utf8')).toBe('third\n');
    // 一時ファイルは残らない。
    expect(fs.readdirSync(dir).sort()).toEqual([at(1), at(2), at(3)].map((p) => path.basename(p)).sort());
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

  it('写しを探す場所は puller の remoteTranscriptPath と同じである', () => {
    seedRemote('dev-b', 'body\n', NOW);
    const r = copy();
    expect(r).toMatchObject({ kind: 'copied', from: remoteTranscriptPath(home, 'dev-b', REL) });
    // 手で組み立てた場所とも一致することを見ておく（規則が変わったらどちらかが必ず落ちる）。
    expect((r as { from: string }).from).toBe(path.join(home, 'remote', 'dev-b', 'projects', '-w-alpha', `${UUID}.jsonl`));
  });

  it('projects の外を指す台帳の行は、ファイルがあっても使わない', () => {
    const rel = `skills/${UUID}.jsonl`;
    const p = path.join(home, 'remote', 'dev-b', ...rel.split('/'));
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, 'outside\n');
    db.prepare('insert into file_sync (key, kind, path, device_id, sha256, size, mtime, remote_seq, synced_at) values (?,?,?,?,?,?,?,?,?)')
      .run(`transcripts/dev-b/${UUID}.jsonl.gz`, 'transcript', rel, 'dev-b', sha256Hex('outside\n'), 8, NOW, 1, NOW);
    // remoteTranscriptPath が projects/ の下だけを許すので、ここで弾かれる。
    expect(() => remoteTranscriptPath(home, 'dev-b', rel)).toThrow();
    expect(copy()).toEqual({ kind: 'none' });
  });

  it('timestampLabel は秒までの並べ替えできる文字列', () => {
    expect(timestampLabel(new Date(2026, 8, 18, 9, 5, 7).getTime())).toBe('20260918-090507');
  });
});

describe('safeDeviceLabel', () => {
  it('英数字とハイフンとアンダースコアだけを残す', () => {
    expect(safeDeviceLabel('mini')).toBe('mini');
    expect(safeDeviceLabel('dev_b-1')).toBe('dev_b-1');
    expect(safeDeviceLabel('MacBook Pro')).toBe('MacBook-Pro');
    expect(safeDeviceLabel('my  mac\tbook')).toBe('my-mac-book');
    expect(safeDeviceLabel('sato.local')).toBe('sato-local');
  });

  it('日本語のホスト名は ASCII の部分を残し、残らなければ指紋付きの既定の名前にする', () => {
    expect(safeDeviceLabel('さとうの Mac')).toBe('Mac');
    const only = safeDeviceLabel('さとうのマック');
    expect(only).toMatch(/^device-[0-9a-f]{8}$/);
    // 同じ名前なら同じ、違う名前なら違う。日本語名の端末が 2 台あっても見分けが付く。
    expect(safeDeviceLabel('さとうのマック')).toBe(only);
    expect(safeDeviceLabel('たなかのマック')).not.toBe(only);
  });

  it('空文字と記号だけの名前でも必ず使える名前を返す', () => {
    for (const n of ['', '   ', '...', '!!!', '\u0000\u0001']) {
      expect(safeDeviceLabel(n)).toMatch(/^device-[0-9a-f]{8}$/);
    }
  });

  it('パスとして危ない名前も畳む', () => {
    expect(safeDeviceLabel('../evil')).toBe('evil');
    expect(safeDeviceLabel('a/b\\c')).toBe('a-b-c');
    expect(safeDeviceLabel('.')).toMatch(/^device-[0-9a-f]{8}$/);
    expect(safeDeviceLabel('..')).toMatch(/^device-[0-9a-f]{8}$/);
  });

  it('長すぎる名前は 32 字までに切り、末尾にハイフンを残さない', () => {
    const long = safeDeviceLabel('a'.repeat(100));
    expect(long).toBe('a'.repeat(32));
    // 切った先がちょうど区切りに当たっても、末尾にハイフンを残さない。
    expect(safeDeviceLabel(`${'b'.repeat(31)} tail`)).toBe('b'.repeat(31));
    expect(safeDeviceLabel(`${'c'.repeat(30)} tail`)).toBe(`${'c'.repeat(30)}-t`);
    expect(safeDeviceLabel('x'.repeat(200)).length).toBeLessThanOrEqual(32);
  });

  it('返す名前はそのままファイル名に使える', () => {
    for (const n of ['さとうの Mac', 'MacBook Pro', '../evil', '', 'a'.repeat(100)]) {
      const label = safeDeviceLabel(n);
      expect(label).toMatch(/^[A-Za-z0-9_-]{1,32}$/);
      expect(path.basename(label)).toBe(label);
    }
  });
});
