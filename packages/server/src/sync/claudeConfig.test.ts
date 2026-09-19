import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { gunzipSync, gzipSync } from 'node:zlib';
import type { FileEntry, FileMetaIn } from '@agent-hangar/shared';
import { beforeEach, describe, expect, it } from 'vitest';
import { FakeCloudClient } from '../../test/fake-cloud.ts';
import { FakeTimers } from '../../test/fake-timers.ts';
import { openDb, type Db } from '../db/open.ts';
import { upsertShared } from '../db/shared.ts';
import type { CloudClient } from './client.ts';
import { ClaudeConfigSync, CONFIG_MAX_BYTES, denormalizeHome, HOME_MARKER, isConfigPath, isTextBuffer, listConfigFiles, normalizeHome, statusLineRel, type ClaudeConfigDeps } from './claudeConfig.ts';
import { safeDeviceLabel, timestampLabel } from './copy.ts';
import { decryptBuffer, deriveFileKey, encryptBuffer, sha256Hex } from './crypto.ts';
import { SyncStateStore } from './state.ts';

const key = deriveFileKey('join-secret');
const NOW = 1_700_000_000_000;
const STAMP = timestampLabel(NOW);
let db: Db;
let cloud: FakeCloudClient;
let timers: FakeTimers;
let claudeDir: string;
let home: string;
let state: SyncStateStore;
let enabled = true;
const toasts: { level: string; message: string }[] = [];

const HOME_DIR = '/Users/me';
const write = (rel: string, text: string, mtime = NOW): string => {
  const abs = path.join(claudeDir, ...rel.split('/'));
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, text);
  fs.utimesSync(abs, new Date(mtime), new Date(mtime));
  return abs;
};
const make = (over: Partial<ClaudeConfigDeps> = {}): ClaudeConfigSync =>
  new ClaudeConfigSync({
    db, deviceId: 'dev-a', deviceName: 'mac', claudeDir, home, client: cloud, key, state,
    enabled: () => enabled,
    onToast: (l, m) => toasts.push({ level: l, message: m }),
    now: () => NOW, timers, homeDir: HOME_DIR,
    ...over,
  });
const remotePut = async (rel: string, text: string, o: { device?: string; mtime?: number } = {}): Promise<FileEntry> => {
  const dev = o.device ?? 'dev-b';
  const meta: FileMetaIn = { key: `config/${dev}/${rel}`, path: rel, kind: 'config', sha256: sha256Hex(text), size: Buffer.byteLength(text), mtime: o.mtime ?? NOW, encrypted: true };
  const enc = await encryptBuffer(key, gzipSync(Buffer.from(text)));
  await cloud.asDevice(dev).putFile(meta, Readable.from([enc]));
  return { ...meta, seq: cloud.files.get(meta.key)!.entry.seq, deviceId: dev, uploadedAt: NOW, storedSize: enc.length };
};
const plainUploaded = async (k: string): Promise<string> => gunzipSync(await decryptBuffer(key, cloud.files.get(k)!.body)).toString();
const seedSynced = (rel: string, text: string, mtime = NOW, dev = 'dev-b'): void => {
  db.prepare('insert into file_sync (key, kind, path, device_id, sha256, size, mtime, remote_seq, synced_at) values (?,?,?,?,?,?,?,?,?)')
    .run(`config/${dev}/${rel}`, 'config', rel, dev, sha256Hex(text), Buffer.byteLength(text), mtime, 1, NOW);
};
const backupDir = (): string => path.join(home, 'backups', 'claude-config');

beforeEach(() => {
  db = openDb(':memory:');
  cloud = new FakeCloudClient({ deviceId: 'dev-a' });
  timers = new FakeTimers();
  claudeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hangar-claude-'));
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'hangar-home-'));
  state = new SyncStateStore(db);
  enabled = true;
  toasts.length = 0;
  upsertShared(db, 'devices', { id: 'dev-b', name: 'mini', platform: 'darwin', last_seen_at: NOW }, 'dev-b');
});

describe('listConfigFiles', () => {
  it('対象だけを集め、除外するものを外す', () => {
    write('CLAUDE.md', '# hi\n');
    write('settings.json', JSON.stringify({ statusLine: { command: '~/.claude/statusline.sh' } }));
    write('statusline.sh', 'echo hi\n');
    write('skills/foo/SKILL.md', 'skill\n');
    write('skills/foo/node_modules/dep/index.js', 'x\n');
    write('memory/alpha/notes.md', 'memo\n');
    write('projects/-w-alpha/memory/auto.md', 'auto\n');
    write('projects/-w-alpha/1111.jsonl', '{}\n');
    write('history.jsonl', '{}\n');
    write('skills/big.txt', 'x'.repeat(CONFIG_MAX_BYTES + 1));
    fs.symlinkSync(path.join(claudeDir, 'CLAUDE.md'), path.join(claudeDir, 'skills', 'link.md'));
    expect(listConfigFiles(claudeDir).map((f) => f.rel)).toEqual([
      'CLAUDE.md', 'memory/alpha/notes.md', 'projects/-w-alpha/memory/auto.md', 'settings.json', 'skills/foo/SKILL.md', 'statusline.sh',
    ]);
  });

  it('isConfigPath は監視の絞り込みに使える', () => {
    expect(['CLAUDE.md', 'settings.json', 'skills/a/b.md', 'memory/x.md', 'projects/-w-a/memory/x.md'].every(isConfigPath)).toBe(true);
    expect(['projects/-w-a/1111.jsonl', 'history.jsonl', 'todos/x.json'].some(isConfigPath)).toBe(false);
  });

  it('競合の控えと書きかけの一時ファイルは同期の対象にしない', () => {
    write('memory/x.md', 'local\n');
    write('memory/x.md.conflict-mini-20240101-000000', 'other\n');
    write('memory/x.md.conflict-Mac-20240101-000000-2', 'other too\n');
    write('memory/x.md.hangar-tmp-1-abcdef', 'partial\n');
    expect(listConfigFiles(claudeDir).map((f) => f.rel)).toEqual(['memory/x.md']);
    expect(isConfigPath('memory/x.md.conflict-mini-20240101-000000')).toBe(false);
    // 畳んだ端末名と連番が付いた形でも、同期の対象に戻ってこない。
    expect(isConfigPath(`memory/x.md.conflict-${safeDeviceLabel('さとうの Mac')}-20240101-000000-2`)).toBe(false);
  });

  it('競合の写しの名前を持つディレクトリの中身も対象にしない', () => {
    write('memory/x.md', 'local\n');
    write('memory/x.md.conflict-Mac-20240101-000000/inner.md', 'inner\n');
    expect(listConfigFiles(claudeDir).map((f) => f.rel)).toEqual(['memory/x.md']);
    expect(isConfigPath('memory/x.md.conflict-Mac-20240101-000000/inner.md')).toBe(false);
  });

  it('statusLine にインタプリタや引数が付いていてもスクリプトを拾う', () => {
    write('statusline.sh', 'echo hi\n');
    for (const cmd of [
      'sh ~/.claude/statusline.sh',
      'bash ~/.claude/statusline.sh --short',
      '/bin/zsh "$HOME/.claude/statusline.sh"',
      "sh '~/.claude/statusline.sh'",
      'node ${HOME}/.claude/statusline.sh',
      '~/.claude/statusline.sh',
      'statusline.sh',
      '"~/.claude/statusline.sh" --plain',
    ]) {
      write('settings.json', JSON.stringify({ statusLine: { command: cmd } }));
      expect([cmd, statusLineRel(claudeDir, HOME_DIR)]).toEqual([cmd, 'statusline.sh']);
      expect([cmd, listConfigFiles(claudeDir, HOME_DIR).map((f) => f.rel)]).toEqual([cmd, ['settings.json', 'statusline.sh']]);
    }
  });

  it('statusLine が ~/.claude の外を指していれば拾わない', () => {
    for (const cmd of ['/usr/local/bin/statusline.sh', 'sh /usr/local/bin/statusline.sh', 'sh ~/elsewhere/statusline.sh', 'sh', 'sh -c "echo hi"']) {
      write('settings.json', JSON.stringify({ statusLine: { command: cmd } }));
      expect([cmd, statusLineRel(claudeDir, HOME_DIR)]).toEqual([cmd, null]);
      expect([cmd, listConfigFiles(claudeDir, HOME_DIR).map((f) => f.rel)]).toEqual([cmd, ['settings.json']]);
    }
  });
});

describe('ホームの書き換え', () => {
  it('絶対パスだけを目印に置き換え、$HOME の文字列には触らない', () => {
    const text = 'cmd /Users/me/.claude/x.sh\nalt $HOME/.claude/x.sh\n';
    const n = normalizeHome(text, HOME_DIR);
    expect(n).toBe(`cmd ${HOME_MARKER}/.claude/x.sh\nalt $HOME/.claude/x.sh\n`);
    expect(denormalizeHome(n, '/home/you')).toBe('cmd /home/you/.claude/x.sh\nalt $HOME/.claude/x.sh\n');
    expect(denormalizeHome(n, HOME_DIR)).toBe(text);
  });

  it('中身にある目印そのものは化けずに往復する', () => {
    const text = `メモ: 目印そのもの ${HOME_MARKER} を書いた行と /Users/me/work\n`;
    const n = normalizeHome(text, HOME_DIR);
    expect(denormalizeHome(n, HOME_DIR)).toBe(text);
    // 相手の端末でも、目印だった文字列はホームのパスに化けない。
    expect(denormalizeHome(n, '/home/you')).toBe(`メモ: 目印そのもの ${HOME_MARKER} を書いた行と /home/you/work\n`);
  });

  it('ホームのパスが別のパスの接頭辞でも切り違えない', () => {
    const text = 'see /Users/meeting/notes.md and /Users/me/work and "/Users/me"\n';
    const n = normalizeHome(text, HOME_DIR);
    expect(n).toBe(`see /Users/meeting/notes.md and ${HOME_MARKER}/work and "${HOME_MARKER}"\n`);
    expect(denormalizeHome(n, '/home/you')).toBe('see /Users/meeting/notes.md and /home/you/work and "/home/you"\n');
  });

  it('isTextBuffer は NUL を含むものを弾く', () => {
    expect(isTextBuffer(Buffer.from('こんにちは\n'))).toBe(true);
    expect(isTextBuffer(Buffer.from([0x50, 0x00, 0x51]))).toBe(false);
  });
});

describe('push', () => {
  it('ホームを目印に替えて上げ、変わらなければ上げ直さない', async () => {
    write('CLAUDE.md', 'see /Users/me/workspace\n');
    const c = make();
    expect(await c.pushChanged()).toBe(1);
    expect(await plainUploaded('config/dev-a/CLAUDE.md')).toBe(`see ${HOME_MARKER}/workspace\n`);
    expect(cloud.files.get('config/dev-a/CLAUDE.md')!.entry).toMatchObject({ kind: 'config', path: 'CLAUDE.md', sha256: sha256Hex(`see ${HOME_MARKER}/workspace\n`) });
    expect(await c.pushChanged()).toBe(0);
    write('CLAUDE.md', 'see /Users/me/workspace/alpha\n');
    expect(await c.pushChanged()).toBe(1);
    c.stop();
  });

  it('設定が無効なら何もしない', async () => {
    write('CLAUDE.md', 'x\n');
    enabled = false;
    const c = make();
    expect(await c.pushChanged()).toBe(0);
    expect(cloud.files.size).toBe(0);
    c.stop();
  });

  it('statusLine からスクリプトを読み取れなければ知らせる。ただし 1 度だけ', async () => {
    write('CLAUDE.md', 'x\n');
    write('settings.json', JSON.stringify({ statusLine: { command: 'sh /usr/local/bin/statusline.sh' } }));
    const c = make();
    await c.pushChanged();
    await c.pushChanged();
    const said = toasts.filter((t) => t.level === 'error' && t.message.includes('statusLine'));
    expect(said.length).toBe(1);
    // 見つかる形に直せば鳴りやむ。
    write('statusline.sh', 'echo hi\n');
    write('settings.json', JSON.stringify({ statusLine: { command: 'sh ~/.claude/statusline.sh' } }));
    await c.pushChanged();
    expect(toasts.filter((t) => t.level === 'error' && t.message.includes('statusLine')).length).toBe(1);
    expect([...cloud.files.keys()].sort()).toContain('config/dev-a/statusline.sh');
    c.stop();
  });

  it('目印に替えて上限を超えるものは上げない', async () => {
    // /Users/me（9 字）が __HANGAR_HOME__（15 字）に伸びる分で、1MB を跨ぐ。
    write('memory/many.md', '/Users/me/'.repeat(100_000));
    const c = make();
    expect(await c.pushChanged()).toBe(0);
    expect(cloud.files.size).toBe(0);
    expect(toasts.some((t) => t.level === 'error' && t.message.includes('上限'))).toBe(true);
    c.stop();
  });

  it('start は最初に 1 度まるごと走査する', async () => {
    write('CLAUDE.md', 'a\n');
    write('memory/x.md', 'b\n');
    const c = make({ debounceMs: 5000 });
    c.start();
    expect(cloud.files.size).toBe(0);
    await timers.advance(5000);
    // タイマー越しに始まった押し出しは誰も約束を持たないので、鎖が空になるまで待つ。
    // マイクロタスクの回数で待つと、zlib の終わる回が端末ごとに違うぶん Linux で落ちる。
    await c.idle();
    expect([...cloud.files.keys()].sort()).toEqual(['config/dev-a/CLAUDE.md', 'config/dev-a/memory/x.md']);
    c.stop();
  });

  it('変化の 5 秒後にまとめて 1 回だけ上げる', async () => {
    const c = make({ debounceMs: 5000 });
    write('CLAUDE.md', 'a\n');
    c.noteChanged();
    write('memory/x.md', 'b\n');
    c.noteChanged();
    expect(cloud.files.size).toBe(0);
    await timers.advance(5000);
    await c.idle();
    expect([...cloud.files.keys()].sort()).toEqual(['config/dev-a/CLAUDE.md', 'config/dev-a/memory/x.md']);
    c.stop();
    expect(timers.pendingCount()).toBe(0);
  });
});

describe('端末ごとの写し', () => {
  it('2 台が同じ相対パスを上げても潰し合わず、相手の新しい方を取り込める', async () => {
    write('CLAUDE.md', '# A の内容\n', NOW - 60_000);
    const a = make();
    expect(await a.pushChanged()).toBe(1);
    const eB = await remotePut('CLAUDE.md', '# B の内容\n', { device: 'dev-b', mtime: NOW });
    // 同じ相対パスでも鍵が違うので、両方が残る。
    expect([...cloud.files.keys()].sort()).toEqual(['config/dev-a/CLAUDE.md', 'config/dev-b/CLAUDE.md']);
    expect(await plainUploaded('config/dev-a/CLAUDE.md')).toBe('# A の内容\n');
    expect(await plainUploaded('config/dev-b/CLAUDE.md')).toBe('# B の内容\n');
    // A は B の新しい方を取り込み、負けた自分の内容は隣に残る。
    a.confirm();
    expect(await a.applyPull([eB])).toEqual({ applied: 1, conflicts: 1, backedUp: 1 });
    expect(fs.readFileSync(path.join(claudeDir, 'CLAUDE.md'), 'utf8')).toBe('# B の内容\n');
    expect(fs.readFileSync(path.join(claudeDir, `CLAUDE.md.conflict-mac-${STAMP}`), 'utf8')).toBe('# A の内容\n');
    // 取り込んだ後は、相手の更新時刻をそのまま引き継ぐ。次に新旧を比べられるようにするためである。
    expect(Math.floor(fs.statSync(path.join(claudeDir, 'CLAUDE.md')).mtimeMs)).toBe(NOW);
    // A の押し戻しは A の場所にだけ書く。
    expect(await a.pushChanged()).toBe(1);
    expect(await plainUploaded('config/dev-a/CLAUDE.md')).toBe('# B の内容\n');
    expect(await plainUploaded('config/dev-b/CLAUDE.md')).toBe('# B の内容\n');
    a.stop();
  });

  it('同じ相対パスに複数の端末の写しがあれば、新しい方を採る', async () => {
    upsertShared(db, 'devices', { id: 'dev-c', name: 'air', platform: 'darwin', last_seen_at: NOW }, 'dev-c');
    const older = await remotePut('memory/x.md', '古い\n', { device: 'dev-b', mtime: NOW - 60_000 });
    const newer = await remotePut('memory/x.md', '新しい\n', { device: 'dev-c', mtime: NOW });
    const c = make();
    c.confirm();
    expect(c.preview([older, newer]).entries.map((x) => [x.path, x.remoteDevice])).toEqual([['memory/x.md', 'air']]);
    expect(await c.applyPull([older, newer])).toEqual({ applied: 1, conflicts: 0, backedUp: 0 });
    expect(fs.readFileSync(path.join(claudeDir, 'memory/x.md'), 'utf8')).toBe('新しい\n');
    // 負けた写しも用済みなので、一覧に残さない。
    expect(c.pendingRemote()).toEqual([]);
    c.stop();
  });

  it('相手の写しが手元より古ければ上書きせず、隣に置く', async () => {
    write('memory/x.md', '手元の新しい内容\n', NOW);
    seedSynced('memory/x.md', '手元の新しい内容\n', NOW);
    const e = await remotePut('memory/x.md', '相手の古い内容\n', { mtime: NOW - 60_000 });
    const c = make();
    c.confirm();
    expect(await c.applyPull([e])).toEqual({ applied: 1, conflicts: 1, backedUp: 0 });
    expect(fs.readFileSync(path.join(claudeDir, 'memory/x.md'), 'utf8')).toBe('手元の新しい内容\n');
    expect(fs.readFileSync(path.join(claudeDir, 'memory', `x.md.conflict-mini-${STAMP}`), 'utf8')).toBe('相手の古い内容\n');
    c.stop();
  });

  it('鍵と相対パスと端末が食い違う項目は受け取らない', async () => {
    const e = await remotePut('CLAUDE.md', '# remote\n');
    const c = make();
    c.confirm();
    // 鍵は dev-b の場所なのに、別の相対パスを名乗る。
    expect(await c.applyPull([{ ...e, path: 'memory/other.md' }])).toEqual({ applied: 0, conflicts: 0, backedUp: 0 });
    // 鍵は dev-b の場所なのに、dev-c が上げたと名乗る。
    expect(await c.applyPull([{ ...e, deviceId: 'dev-c' }])).toEqual({ applied: 0, conflicts: 0, backedUp: 0 });
    expect(fs.readdirSync(claudeDir)).toEqual([]);
    expect(c.pendingRemote()).toEqual([]);
    c.stop();
  });
});

describe('preview と applyPull', () => {
  it('取り込み内容を作成、上書き、競合、変更なしに分ける', async () => {
    const e1 = await remotePut('CLAUDE.md', '# remote\n');
    const e2 = await remotePut('skills/foo/SKILL.md', 'remote skill\n');
    const e3 = await remotePut('memory/same.md', 'same\n');
    const e4 = await remotePut('memory/synced.md', 'remote new\n');
    write('skills/foo/SKILL.md', 'local edit\n');
    write('memory/same.md', 'same\n');
    write('memory/synced.md', 'old\n');
    seedSynced('memory/synced.md', 'old\n');
    const c = make();
    const p = c.preview([e1, e2, e3, e4]);
    expect(p.confirmed).toBe(false);
    expect(p.entries.map((x) => [x.path, x.action])).toEqual([
      ['CLAUDE.md', 'create'], ['memory/same.md', 'skip'], ['memory/synced.md', 'overwrite'], ['skills/foo/SKILL.md', 'conflict'],
    ]);
    expect(p.entries[0]).toMatchObject({ remoteDevice: 'mini', remoteMtime: NOW, localMtime: null });
    c.stop();
  });

  it('確認の前は書かず、確認の後に書いて控えを残す', async () => {
    const e = await remotePut('CLAUDE.md', `# from ${HOME_MARKER}/work\n`);
    write('CLAUDE.md', '# local\n', NOW - 10_000);
    seedSynced('CLAUDE.md', '# local\n', NOW - 10_000);
    const c = make();
    expect(await c.applyPull([e])).toEqual({ applied: 0, conflicts: 0, backedUp: 0 });
    expect(fs.readFileSync(path.join(claudeDir, 'CLAUDE.md'), 'utf8')).toBe('# local\n');
    expect(c.pendingRemote().map((x) => x.key)).toEqual(['config/dev-b/CLAUDE.md']);
    c.confirm();
    expect(c.preview().confirmed).toBe(true);
    expect(await c.applyPull([e])).toEqual({ applied: 1, conflicts: 0, backedUp: 1 });
    expect(fs.readFileSync(path.join(claudeDir, 'CLAUDE.md'), 'utf8')).toBe(`# from ${HOME_DIR}/work\n`);
    expect(fs.readdirSync(backupDir())).toEqual([STAMP]);
    expect(fs.readFileSync(path.join(backupDir(), STAMP, 'CLAUDE.md'), 'utf8')).toBe('# local\n');
    // 一時ファイルを残さない。
    expect(fs.readdirSync(claudeDir)).toEqual(['CLAUDE.md']);
    c.stop();
  });

  it('サーバを起こし直しても、まだ取り込んでいない相手の設定が下見に出る', async () => {
    const e1 = await remotePut('CLAUDE.md', '# remote\n');
    const e2 = await remotePut('settings.json', '{"model":"opus"}\n');
    const first = make();
    // 確認の前なので何も書かない。puller はこの後 filesSeq を進めるので、同じ項目は二度と届かない。
    expect(await first.applyPull([e1, e2])).toEqual({ applied: 0, conflicts: 0, backedUp: 0 });
    expect(first.preview().entries.map((x) => x.path)).toEqual(['CLAUDE.md', 'settings.json']);
    first.stop();

    // ここで hangar stop / start に当たる。新しい ClaudeConfigSync はメモリを引き継がない。
    const second = make();
    expect(second.preview().entries.map((x) => x.path)).toEqual(['CLAUDE.md', 'settings.json']);
    expect(second.pendingRemote().map((x) => x.key)).toEqual(['config/dev-b/CLAUDE.md', 'config/dev-b/settings.json']);
    second.confirm();
    // puller からは何も届かなくても、残っている一覧から取り込める。
    expect(await second.applyPull([])).toEqual({ applied: 2, conflicts: 0, backedUp: 0 });
    expect(fs.readFileSync(path.join(claudeDir, 'CLAUDE.md'), 'utf8')).toBe('# remote\n');
    expect(fs.readFileSync(path.join(claudeDir, 'settings.json'), 'utf8')).toBe('{"model":"opus"}\n');
    // 取り込んだものは下見から消える。
    expect(second.preview().entries).toEqual([]);
    expect(second.pendingRemote()).toEqual([]);
    second.stop();
  });

  it('取り込みに失敗した分は残り、起こし直した後も下見に出る', async () => {
    const e = await remotePut('memory/x.md', 'remote\n');
    write('memory/x.md', 'local\n');
    seedSynced('memory/x.md', 'local\n');
    const first = make();
    first.confirm();
    // 指紋が合わないので書かない。
    expect(await first.applyPull([{ ...e, sha256: sha256Hex('すりかえ\n') }])).toEqual({ applied: 0, conflicts: 0, backedUp: 0 });
    first.stop();
    const second = make();
    expect(second.pendingRemote().map((x) => x.key)).toEqual(['config/dev-b/memory/x.md']);
    second.stop();
  });

  it('両方が変わっていたら新しい方を残し、古い方を conflict として隣に置く', async () => {
    const e = await remotePut('memory/x.md', 'remote\n', { mtime: NOW });
    write('memory/x.md', 'local\n', NOW - 60_000);
    seedSynced('memory/x.md', 'base\n', NOW - 120_000);
    const c = make();
    c.confirm();
    expect(await c.applyPull([e])).toEqual({ applied: 1, conflicts: 1, backedUp: 1 });
    expect(fs.readFileSync(path.join(claudeDir, 'memory/x.md'), 'utf8')).toBe('remote\n');
    const conflicts = fs.readdirSync(path.join(claudeDir, 'memory')).filter((f) => f.includes('.conflict-'));
    expect(conflicts).toEqual([`x.md.conflict-mac-${STAMP}`]);
    expect(fs.readFileSync(path.join(claudeDir, 'memory', conflicts[0]!), 'utf8')).toBe('local\n');
    expect(toasts.some((t) => t.message.includes('競合'))).toBe(true);
    c.stop();
  });

  it('手元の方が新しければ相手の分を conflict にする', async () => {
    const e = await remotePut('memory/x.md', 'remote\n', { mtime: NOW - 60_000 });
    write('memory/x.md', 'local\n', NOW);
    seedSynced('memory/x.md', 'base\n', NOW - 120_000);
    const c = make();
    c.confirm();
    expect(await c.applyPull([e])).toEqual({ applied: 1, conflicts: 1, backedUp: 0 });
    expect(fs.readFileSync(path.join(claudeDir, 'memory/x.md'), 'utf8')).toBe('local\n');
    expect(fs.readFileSync(path.join(claudeDir, 'memory', `x.md.conflict-mini-${STAMP}`), 'utf8')).toBe('remote\n');
    // 手元が勝った分は相手に追いつかせる。競合の控え自体は上げない。
    expect([...cloud.files.keys()].sort()).toEqual(['config/dev-a/memory/x.md', 'config/dev-b/memory/x.md']);
    expect(await plainUploaded('config/dev-a/memory/x.md')).toBe('local\n');
    // 相手の場所は触らない。上げ合いで潰さない。
    expect(await plainUploaded('config/dev-b/memory/x.md')).toBe('remote\n');
    c.stop();
  });

  it('端末の名前は畳んでからファイル名に入れる', async () => {
    const e = await remotePut('memory/x.md', 'remote\n', { mtime: NOW });
    write('memory/x.md', 'local\n', NOW - 60_000);
    seedSynced('memory/x.md', 'base\n', NOW - 120_000);
    upsertShared(db, 'devices', { id: 'dev-b', name: 'たなかの MacBook Pro', platform: 'darwin', last_seen_at: NOW }, 'dev-b');
    const c = make({ deviceName: 'さとうの Mac' });
    c.confirm();
    expect(await c.applyPull([e])).toEqual({ applied: 1, conflicts: 1, backedUp: 1 });
    expect(safeDeviceLabel('さとうの Mac')).toBe('Mac');
    expect(fs.readdirSync(path.join(claudeDir, 'memory')).filter((f) => f.includes('.conflict-'))).toEqual([`x.md.conflict-Mac-${STAMP}`]);
    expect(fs.readFileSync(path.join(claudeDir, 'memory', `x.md.conflict-Mac-${STAMP}`), 'utf8')).toBe('local\n');
    c.stop();
  });

  it('同じ名前の写しが既にあれば連番を足して潰さない', async () => {
    const e = await remotePut('memory/x.md', 'remote\n', { mtime: NOW });
    write('memory/x.md', 'local\n', NOW - 60_000);
    seedSynced('memory/x.md', 'base\n', NOW - 120_000);
    // 別名の端末（「たなかの Mac」）が同じ秒に残した写しがあるとする。
    const taken = write(`memory/x.md.conflict-Mac-${STAMP}`, '先にあった写し\n');
    const c = make({ deviceName: 'さとうの Mac' });
    c.confirm();
    expect(await c.applyPull([e])).toEqual({ applied: 1, conflicts: 1, backedUp: 1 });
    expect(fs.readFileSync(taken, 'utf8')).toBe('先にあった写し\n');
    expect(fs.readFileSync(path.join(claudeDir, 'memory', `x.md.conflict-Mac-${STAMP}-2`), 'utf8')).toBe('local\n');
    expect(fs.readFileSync(path.join(claudeDir, 'memory/x.md'), 'utf8')).toBe('remote\n');
    expect(toasts.some((t) => t.message.includes(`x.md.conflict-Mac-${STAMP}-2`))).toBe(true);
    c.stop();
  });

  it('相手の分を隣に置くときも既存の写しを潰さない', async () => {
    const e = await remotePut('memory/x.md', 'remote\n', { mtime: NOW - 60_000 });
    write('memory/x.md', 'local\n', NOW);
    seedSynced('memory/x.md', 'base\n', NOW - 120_000);
    const taken = write(`memory/x.md.conflict-mini-${STAMP}`, '先にあった写し\n');
    const c = make();
    c.confirm();
    expect(await c.applyPull([e])).toEqual({ applied: 1, conflicts: 1, backedUp: 0 });
    expect(fs.readFileSync(taken, 'utf8')).toBe('先にあった写し\n');
    expect(fs.readFileSync(path.join(claudeDir, 'memory', `x.md.conflict-mini-${STAMP}-2`), 'utf8')).toBe('remote\n');
    // 競合の写しは、連番の付いた形でも相手に上げ直さない。
    expect([...cloud.files.keys()].sort()).toEqual(['config/dev-a/memory/x.md', 'config/dev-b/memory/x.md']);
    c.stop();
  });

  it('控えを取れなければそのファイルを書き戻さない', async () => {
    const e = await remotePut('CLAUDE.md', 'remote\n', { mtime: NOW });
    write('CLAUDE.md', '# local\n', NOW - 60_000);
    // backups/claude-config を同名のファイルで塞ぎ、控えのディレクトリを作れなくする。
    fs.mkdirSync(path.join(home, 'backups'), { recursive: true });
    fs.writeFileSync(path.join(home, 'backups', 'claude-config'), 'x');
    const c = make();
    c.confirm();
    expect(await c.applyPull([e])).toEqual({ applied: 0, conflicts: 0, backedUp: 0 });
    expect(fs.readFileSync(path.join(claudeDir, 'CLAUDE.md'), 'utf8')).toBe('# local\n');
    // 控えが取れないなら、競合の写しも作らない。
    expect(fs.readdirSync(claudeDir)).toEqual(['CLAUDE.md']);
    expect(toasts.some((t) => t.level === 'error')).toBe(true);
    c.stop();
  });

  it('同じ秒に 2 度取り込んでも先の控えを潰さない', async () => {
    write('CLAUDE.md', '元の内容\n', NOW - 60_000);
    const c = make();
    c.confirm();
    const e1 = await remotePut('CLAUDE.md', '1 回目の相手\n', { mtime: NOW });
    expect(await c.applyPull([e1])).toMatchObject({ backedUp: 1 });
    const e2 = await remotePut('CLAUDE.md', '2 回目の相手\n', { mtime: NOW });
    expect(await c.applyPull([e2])).toMatchObject({ backedUp: 1 });
    expect(fs.readFileSync(path.join(claudeDir, 'CLAUDE.md'), 'utf8')).toBe('2 回目の相手\n');
    // 同じ秒なので世代は 1 つだが、利用者の元の内容も 1 回目の内容も残る。
    expect(fs.readdirSync(backupDir())).toEqual([STAMP]);
    expect(fs.readFileSync(path.join(backupDir(), STAMP, 'CLAUDE.md'), 'utf8')).toBe('元の内容\n');
    expect(fs.readFileSync(path.join(backupDir(), STAMP, 'CLAUDE.md-2'), 'utf8')).toBe('1 回目の相手\n');
    c.stop();
  });

  it('push が通らない間も同じ写しを積み上げない', async () => {
    const offline: CloudClient = {
      health: () => cloud.health(),
      pushChanges: (c) => cloud.pushChanges(c),
      pullChanges: (s, l) => cloud.pullChanges(s, l),
      snapshot: (a, l) => cloud.snapshot(a, l),
      putFile: async () => { throw new Error('圏外です'); },
      getFile: (k) => cloud.getFile(k),
      listFiles: (s, l) => cloud.listFiles(s, l),
      deleteFile: (k) => cloud.deleteFile(k),
    };
    const e = await remotePut('memory/x.md', 'remote\n', { mtime: NOW - 60_000 });
    write('memory/x.md', 'local\n', NOW);
    seedSynced('memory/x.md', 'base\n', NOW - 120_000);
    let t = NOW;
    const c = make({ client: offline, now: () => t });
    c.confirm();
    for (let i = 0; i < 3; i++) {
      t = NOW + i * 60_000;
      expect(await c.applyPull([e])).toEqual({ applied: 1, conflicts: 1, backedUp: 0 });
    }
    expect(fs.readdirSync(path.join(claudeDir, 'memory')).filter((f) => f.includes('.conflict-')))
      .toEqual([`x.md.conflict-mini-${STAMP}`]);
    expect(fs.readFileSync(path.join(claudeDir, 'memory/x.md'), 'utf8')).toBe('local\n');
    c.stop();
  });

  it('控えの世代は上限までで、古いものから消える', async () => {
    let t = NOW;
    const c = make({ now: () => t, backupGenerations: 2 });
    c.confirm();
    const stamps: string[] = [];
    for (let i = 0; i < 3; i++) {
      t = NOW + i * 60_000;
      stamps.push(timestampLabel(t));
      write('CLAUDE.md', `local${i}\n`, t);
      const e = await remotePut('CLAUDE.md', `remote${i}\n`, { mtime: t });
      expect(await c.applyPull([e])).toMatchObject({ backedUp: 1 });
    }
    expect(fs.readdirSync(backupDir()).sort()).toEqual(stamps.slice(1).sort());
    expect(fs.readFileSync(path.join(backupDir(), stamps[2]!, 'CLAUDE.md'), 'utf8')).toBe('local2\n');
    c.stop();
  });
});

describe('受け取りの守り', () => {
  it('対象の外の相対パスは書き戻さない', async () => {
    const e = await remotePut('settings.local.json', '{"permissions":{"allow":["Bash"]}}\n');
    const c = make();
    c.confirm();
    expect(await c.applyPull([e])).toEqual({ applied: 0, conflicts: 0, backedUp: 0 });
    expect(fs.existsSync(path.join(claudeDir, 'settings.local.json'))).toBe(false);
    expect(c.preview().entries).toEqual([]);
    c.stop();
  });

  it('~/.claude の外を指すパスは書き戻さない', async () => {
    const e = await remotePut('CLAUDE.md', 'evil\n');
    const c = make();
    c.confirm();
    expect(await c.applyPull([{ ...e, path: '../evil.md' }])).toEqual({ applied: 0, conflicts: 0, backedUp: 0 });
    expect(fs.existsSync(path.join(path.dirname(claudeDir), 'evil.md'))).toBe(false);
    c.stop();
  });

  it('指紋が合わない中身は書かない', async () => {
    const e = await remotePut('memory/x.md', 'remote\n');
    write('memory/x.md', 'local\n');
    seedSynced('memory/x.md', 'local\n');
    const c = make();
    c.confirm();
    expect(await c.applyPull([{ ...e, sha256: sha256Hex('すりかえ\n') }])).toEqual({ applied: 0, conflicts: 0, backedUp: 0 });
    expect(fs.readFileSync(path.join(claudeDir, 'memory/x.md'), 'utf8')).toBe('local\n');
    expect(fs.readdirSync(path.join(claudeDir, 'memory'))).toEqual(['x.md']);
    expect(toasts.some((t) => t.level === 'error')).toBe(true);
    c.stop();
  });

  it('上限より大きい申告は降ろさない', async () => {
    const big = 'x'.repeat(CONFIG_MAX_BYTES + 1);
    const e = await remotePut('memory/big.md', big);
    const c = make();
    c.confirm();
    expect(await c.applyPull([e])).toEqual({ applied: 0, conflicts: 0, backedUp: 0 });
    expect(fs.existsSync(path.join(claudeDir, 'memory/big.md'))).toBe(false);
    expect(toasts.some((t) => t.level === 'error')).toBe(true);
    c.stop();
  });

  it('途中のディレクトリがリンクでも ~/.claude の外に作らない', async () => {
    // レビューの D1。claudeDir/skills を外へのリンクにして、相手から skills/evil/SKILL.md を降ろす。
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'hangar-outside-'));
    fs.symlinkSync(outside, path.join(claudeDir, 'skills'));
    const e = await remotePut('skills/evil/SKILL.md', '外に書けた\n');
    const c = make();
    c.confirm();
    expect(await c.applyPull([e])).toEqual({ applied: 0, conflicts: 0, backedUp: 0 });
    expect(fs.existsSync(path.join(outside, 'evil'))).toBe(false);
    expect(toasts.some((t) => t.level === 'error')).toBe(true);
    c.stop();
  });

  it('途中のディレクトリがリンクでも ~/.claude の外の既存ファイルを上書きしない', async () => {
    // レビューの D2。claudeDir/memory を外へのリンクにして、その先にある既存ファイルを狙う。
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'hangar-outside-'));
    fs.writeFileSync(path.join(outside, 'x.md'), '外の大事な内容\n');
    fs.symlinkSync(outside, path.join(claudeDir, 'memory'));
    const e = await remotePut('memory/x.md', '相手の内容\n', { mtime: NOW });
    const c = make();
    c.confirm();
    expect(await c.applyPull([e])).toEqual({ applied: 0, conflicts: 0, backedUp: 0 });
    expect(fs.readFileSync(path.join(outside, 'x.md'), 'utf8')).toBe('外の大事な内容\n');
    // 外のファイルを控えに取ることもしない。
    expect(fs.existsSync(backupDir())).toBe(false);
    expect(toasts.some((t) => t.level === 'error')).toBe(true);
    c.stop();
  });

  it('手元がシンボリックリンクなら書き戻さない', async () => {
    write('real.md', 'real\n');
    fs.mkdirSync(path.join(claudeDir, 'memory'), { recursive: true });
    fs.symlinkSync(path.join(claudeDir, 'real.md'), path.join(claudeDir, 'memory', 'x.md'));
    const e = await remotePut('memory/x.md', 'remote\n');
    const c = make();
    c.confirm();
    expect(await c.applyPull([e])).toEqual({ applied: 0, conflicts: 0, backedUp: 0 });
    expect(fs.readFileSync(path.join(claudeDir, 'real.md'), 'utf8')).toBe('real\n');
    expect(fs.lstatSync(path.join(claudeDir, 'memory', 'x.md')).isSymbolicLink()).toBe(true);
    expect(toasts.some((t) => t.level === 'error')).toBe(true);
    c.stop();
  });

  it('直しようのない失敗は 1 度だけ鳴らし、相手の中身が変われば鳴り直す', async () => {
    const e = await remotePut('memory/x.md', 'remote\n');
    write('memory/x.md', 'local\n');
    seedSynced('memory/x.md', 'local\n');
    const c = make();
    c.confirm();
    const errors = (): number => toasts.filter((t) => t.level === 'error').length;
    const bad = { ...e, sha256: sha256Hex('すりかえ\n') };
    expect(await c.applyPull([bad])).toEqual({ applied: 0, conflicts: 0, backedUp: 0 });
    expect(errors()).toBe(1);
    // 30 秒ごとの取り込みで同じ項目が何度も来ても、鳴らすのは 1 度きりである。
    expect(await c.applyPull([bad])).toEqual({ applied: 0, conflicts: 0, backedUp: 0 });
    expect(await c.applyPull([])).toEqual({ applied: 0, conflicts: 0, backedUp: 0 });
    expect(errors()).toBe(1);
    // 相手が書き換えたら指紋が変わるので、あらためて知らせる。
    const bad2 = { ...e, sha256: sha256Hex('別のすりかえ\n'), seq: e.seq + 1 };
    expect(await c.applyPull([bad2])).toEqual({ applied: 0, conflicts: 0, backedUp: 0 });
    expect(errors()).toBe(2);
    c.stop();
  });

  it('取り込めない理由が続いても鳴らすのは 1 度だけで、直れば取り込める', async () => {
    write('real.md', 'real\n');
    fs.mkdirSync(path.join(claudeDir, 'memory'), { recursive: true });
    const link = path.join(claudeDir, 'memory', 'x.md');
    fs.symlinkSync(path.join(claudeDir, 'real.md'), link);
    const e = await remotePut('memory/x.md', 'remote\n');
    const c = make();
    c.confirm();
    await c.applyPull([e]);
    await c.applyPull([e]);
    expect(toasts.filter((t) => t.level === 'error').length).toBe(1);
    // 利用者がリンクを外せば、一覧に残っているので次の取り込みで入る。
    fs.unlinkSync(link);
    expect(await c.applyPull([])).toEqual({ applied: 1, conflicts: 0, backedUp: 0 });
    expect(fs.readFileSync(link, 'utf8')).toBe('remote\n');
    c.stop();
  });

  it('上げられないファイルも 1 度だけ鳴らす', async () => {
    write('memory/many.md', '/Users/me/'.repeat(100_000));
    const c = make();
    expect(await c.pushChanged()).toBe(0);
    expect(await c.pushChanged()).toBe(0);
    expect(toasts.filter((t) => t.level === 'error').length).toBe(1);
    c.stop();
  });

  it('自端末が上げた分は取り込みの一覧に載せない', async () => {
    const e = await remotePut('CLAUDE.md', '# mine\n', { device: 'dev-a' });
    const c = make();
    c.confirm();
    expect(await c.applyPull([e])).toEqual({ applied: 0, conflicts: 0, backedUp: 0 });
    expect(c.pendingRemote()).toEqual([]);
    expect(fs.existsSync(path.join(claudeDir, 'CLAUDE.md'))).toBe(false);
    c.stop();
  });

  it('新しく届いたスクリプトは実行できる形で置く', async () => {
    const e = await remotePut('statusline.sh', '#!/bin/sh\necho hi\n');
    write('settings.json', JSON.stringify({ statusLine: { command: '~/.claude/statusline.sh' } }));
    const c = make();
    c.confirm();
    expect(await c.applyPull([e])).toMatchObject({ applied: 1 });
    const abs = path.join(claudeDir, 'statusline.sh');
    expect(fs.readFileSync(abs, 'utf8')).toBe('#!/bin/sh\necho hi\n');
    expect(fs.statSync(abs).mode & 0o100).toBe(0o100);
    c.stop();
  });

  it('statusLine が指していないスクリプトには実行の許しを付けない', async () => {
    const e = await remotePut('helper.sh', '#!/bin/sh\necho hi\n');
    const c = make();
    c.confirm();
    expect(await c.applyPull([e])).toMatchObject({ applied: 1 });
    expect(fs.statSync(path.join(claudeDir, 'helper.sh')).mode & 0o111).toBe(0);
    c.stop();
  });

  it('確認は取り消せる', async () => {
    const e = await remotePut('CLAUDE.md', '# remote\n');
    const c = make();
    c.confirm();
    expect(c.preview().confirmed).toBe(true);
    c.unconfirm();
    expect(c.preview().confirmed).toBe(false);
    expect(await c.applyPull([e])).toEqual({ applied: 0, conflicts: 0, backedUp: 0 });
    expect(fs.existsSync(path.join(claudeDir, 'CLAUDE.md'))).toBe(false);
    c.stop();
  });

  it('上書きでも元のファイルの権限を保つ', async () => {
    const abs = write('statusline.sh', '#!/bin/sh\nold\n', NOW - 60_000);
    fs.chmodSync(abs, 0o755);
    write('settings.json', JSON.stringify({ statusLine: { command: '~/.claude/statusline.sh' } }), NOW - 60_000);
    seedSynced('statusline.sh', '#!/bin/sh\nold\n', NOW - 60_000);
    const e = await remotePut('statusline.sh', '#!/bin/sh\nnew\n');
    const c = make();
    c.confirm();
    expect(await c.applyPull([e])).toEqual({ applied: 1, conflicts: 0, backedUp: 1 });
    expect(fs.readFileSync(abs, 'utf8')).toBe('#!/bin/sh\nnew\n');
    expect(fs.statSync(abs).mode & 0o777).toBe(0o755);
    c.stop();
  });
});
