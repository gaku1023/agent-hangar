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
import { ClaudeConfigSync, CONFIG_MAX_BYTES, denormalizeHome, HOME_MARKER, isConfigPath, isTextBuffer, listConfigFiles, normalizeHome, type ClaudeConfigDeps } from './claudeConfig.ts';
import { timestampLabel } from './copy.ts';
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
  const meta: FileMetaIn = { key: `config/${rel}`, path: rel, kind: 'config', sha256: sha256Hex(text), size: Buffer.byteLength(text), mtime: o.mtime ?? NOW, encrypted: true };
  const enc = await encryptBuffer(key, gzipSync(Buffer.from(text)));
  const dev = o.device ?? 'dev-b';
  await cloud.asDevice(dev).putFile(meta, Readable.from([enc]));
  return { ...meta, seq: cloud.files.get(meta.key)!.entry.seq, deviceId: dev, uploadedAt: NOW, storedSize: enc.length };
};
const plainUploaded = async (k: string): Promise<string> => gunzipSync(await decryptBuffer(key, cloud.files.get(k)!.body)).toString();
const seedSynced = (rel: string, text: string, mtime = NOW): void => {
  db.prepare('insert into file_sync (key, kind, path, device_id, sha256, size, mtime, remote_seq, synced_at) values (?,?,?,?,?,?,?,?,?)')
    .run(`config/${rel}`, 'config', rel, 'dev-b', sha256Hex(text), Buffer.byteLength(text), mtime, 1, NOW);
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
    write('memory/x.md.hangar-tmp-1-abcdef', 'partial\n');
    expect(listConfigFiles(claudeDir).map((f) => f.rel)).toEqual(['memory/x.md']);
    expect(isConfigPath('memory/x.md.conflict-mini-20240101-000000')).toBe(false);
  });

  it('statusLine が ~/.claude の外を指していれば拾わない', () => {
    write('settings.json', JSON.stringify({ statusLine: { command: '/usr/local/bin/statusline.sh' } }));
    expect(listConfigFiles(claudeDir).map((f) => f.rel)).toEqual(['settings.json']);
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
    expect(await plainUploaded('config/CLAUDE.md')).toBe(`see ${HOME_MARKER}/workspace\n`);
    expect(cloud.files.get('config/CLAUDE.md')!.entry).toMatchObject({ kind: 'config', path: 'CLAUDE.md', sha256: sha256Hex(`see ${HOME_MARKER}/workspace\n`) });
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

  it('変化の 5 秒後にまとめて 1 回だけ上げる', async () => {
    const c = make({ debounceMs: 5000 });
    write('CLAUDE.md', 'a\n');
    c.noteChanged();
    write('memory/x.md', 'b\n');
    c.noteChanged();
    expect(cloud.files.size).toBe(0);
    await timers.advance(5000);
    expect([...cloud.files.keys()].sort()).toEqual(['config/CLAUDE.md', 'config/memory/x.md']);
    c.stop();
    expect(timers.pendingCount()).toBe(0);
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
    expect(c.pendingRemote().map((x) => x.key)).toEqual(['config/CLAUDE.md']);
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
    expect([...cloud.files.keys()].filter((k) => k.startsWith('config/'))).toEqual(['config/memory/x.md']);
    expect(await plainUploaded('config/memory/x.md')).toBe('local\n');
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
