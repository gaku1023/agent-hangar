import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { claudeJsonPath, upsertUserMcpServer } from './claudeJson.ts';

let root: string;
let dir: string;
let file: string;
let backups: string;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'hangar-cj-'));
  dir = path.join(root, 'home');
  fs.mkdirSync(dir);
  file = path.join(dir, '.claude.json');
  backups = path.join(root, 'hangar', 'backups');
});
afterEach(() => {
  delete process.env.CLAUDE_CONFIG_DIR;
  fs.rmSync(root, { recursive: true, force: true });
});

describe('claudeJsonPath', () => {
  it('既定は ~/.claude.json で、CLAUDE_CONFIG_DIR があればその下（実物で確認）', () => {
    delete process.env.CLAUDE_CONFIG_DIR;
    expect(claudeJsonPath('/tmp/h')).toBe(path.join('/tmp/h', '.claude.json'));
    process.env.CLAUDE_CONFIG_DIR = '/tmp/cfg';
    expect(claudeJsonPath('/tmp/h')).toBe(path.join('/tmp/cfg', '.claude.json'));
  });
});

describe('upsertUserMcpServer', () => {
  it('無ければ 0600 で作る', () => {
    upsertUserMcpServer(file, 'hangar', { type: 'http', url: 'http://x/mcp' }, { backupDir: backups });
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual({ mcpServers: { hangar: { type: 'http', url: 'http://x/mcp' } } });
  });

  it('他の項目と他のサーバを残し、元の mode を保つ', () => {
    fs.writeFileSync(file, JSON.stringify({ userID: 'u1', mcpServers: { other: { type: 'stdio' } } }), { mode: 0o600 });
    upsertUserMcpServer(file, 'hangar', { type: 'http', url: 'http://x/mcp' }, { backupDir: backups });
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual({ userID: 'u1', mcpServers: { other: { type: 'stdio' }, hangar: { type: 'http', url: 'http://x/mcp' } } });
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(fs.readdirSync(dir)).toEqual(['.claude.json']);
  });

  it('壊れた JSON は上書きせずに投げる。中身は message に出さない', () => {
    fs.writeFileSync(file, '{ 壊れている', { mode: 0o600 });
    let message = '';
    try {
      upsertUserMcpServer(file, 'hangar', {}, { backupDir: backups });
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toContain(file);
    expect(message).not.toContain('壊れている');
    expect(fs.readFileSync(file, 'utf8')).toBe('{ 壊れている');
  });
});

describe('upsertUserMcpServer の安全（同時書き込み、リンク、控え、権限）', () => {
  it('書く直前に読み直すので、割り込みで書かれた変更を潰さない', () => {
    fs.writeFileSync(file, JSON.stringify({ userID: 'u1' }), { mode: 0o600 });
    // 控えを取った後、書く直前に Claude Code が書いたことにする。
    const interrupt = () => fs.writeFileSync(file, JSON.stringify({ userID: 'u1', addedByClaude: 'x' }), { mode: 0o600 });
    upsertUserMcpServer(file, 'hangar', { type: 'http' }, { backupDir: backups, onBeforeWrite: interrupt });
    const j = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
    expect(j.addedByClaude).toBe('x');
    expect(j.mcpServers).toEqual({ hangar: { type: 'http' } });
  });

  it('シンボリックリンクはリンクのまま残し、実体の側に書く', () => {
    const real = path.join(root, 'dotfiles', 'claude.json');
    fs.mkdirSync(path.dirname(real));
    fs.writeFileSync(real, JSON.stringify({ userID: 'u1' }), { mode: 0o600 });
    fs.symlinkSync(real, file);
    const r = upsertUserMcpServer(file, 'hangar', { type: 'http' }, { backupDir: backups });
    expect(fs.lstatSync(file).isSymbolicLink()).toBe(true);
    expect((JSON.parse(fs.readFileSync(real, 'utf8')) as { mcpServers: unknown }).mcpServers).toEqual({ hangar: { type: 'http' } });
    expect(r.file).toBe(fs.realpathSync(real));
    // 一時ファイルもロックも、リンクの隣にも実体の隣にも残らない。
    expect(fs.readdirSync(dir)).toEqual(['.claude.json']);
    expect(fs.readdirSync(path.dirname(real))).toEqual(['claude.json']);
  });

  it('書く前に控えを取り、0600 で残す', () => {
    fs.writeFileSync(file, JSON.stringify({ userID: 'u1' }), { mode: 0o600 });
    const r = upsertUserMcpServer(file, 'hangar', { type: 'http' }, { backupDir: backups, now: new Date(2026, 8, 19, 3, 4, 5) });
    expect(r.backup).toBe(path.join(backups, 'claude.json-20260919030405'));
    expect(JSON.parse(fs.readFileSync(r.backup!, 'utf8'))).toEqual({ userID: 'u1' });
    expect(fs.statSync(r.backup!).mode & 0o777).toBe(0o600);
    expect(fs.statSync(backups).mode & 0o777).toBe(0o700);
    // 同じ秒に 2 度書いても、前の控えを潰さない。
    const r2 = upsertUserMcpServer(file, 'hangar', { type: 'http' }, { backupDir: backups, now: new Date(2026, 8, 19, 3, 4, 5) });
    expect(r2.backup).toBe(path.join(backups, 'claude.json-20260919030405-2'));
    expect(fs.readdirSync(backups)).toHaveLength(2);
  });

  it('控えが取れなければ書かない', () => {
    fs.writeFileSync(file, JSON.stringify({ userID: 'u1' }), { mode: 0o600 });
    // 置き場がファイルなので、控えのディレクトリを作れない。
    const blocked = path.join(root, 'blocked');
    fs.writeFileSync(blocked, 'x');
    expect(() => upsertUserMcpServer(file, 'hangar', { type: 'http' }, { backupDir: blocked })).toThrow();
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual({ userID: 'u1' });
  });

  it('ロックが取れなければ、書かずに失敗する', () => {
    fs.writeFileSync(file, JSON.stringify({ userID: 'u1' }), { mode: 0o600 });
    const lock = `${fs.realpathSync(file)}.hangar-lock`;
    fs.writeFileSync(lock, '99999 held');
    let message = '';
    try {
      upsertUserMcpServer(file, 'hangar', { type: 'http' }, { backupDir: backups, lockWaitMs: 50 });
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toContain('Claude Code');
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual({ userID: 'u1' });
    // 他人のロックは消さない。
    expect(fs.existsSync(lock)).toBe(true);
    expect(fs.existsSync(backups)).toBe(false);
  });

  it('古いロックは残骸とみなして書き、書き終われば自分のロックを消す', () => {
    fs.writeFileSync(file, JSON.stringify({ userID: 'u1' }), { mode: 0o600 });
    const lock = `${fs.realpathSync(file)}.hangar-lock`;
    fs.writeFileSync(lock, '99999 dead');
    const old = new Date(Date.now() - 60_000);
    fs.utimesSync(lock, old, old);
    upsertUserMcpServer(file, 'hangar', { type: 'http' }, { backupDir: backups, lockWaitMs: 50, staleLockMs: 10_000 });
    expect((JSON.parse(fs.readFileSync(file, 'utf8')) as { mcpServers: unknown }).mcpServers).toEqual({ hangar: { type: 'http' } });
    expect(fs.existsSync(lock)).toBe(false);
  });

  it('他人に読める権限なら 0600 へ狭め、それ以外は利用者が決めた権限を保つ', () => {
    fs.writeFileSync(file, JSON.stringify({ userID: 'u1' }), { mode: 0o600 });
    fs.chmodSync(file, 0o644);
    const r = upsertUserMcpServer(file, 'hangar', { type: 'http' }, { backupDir: backups });
    expect(r.tightened).toBe(true);
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);

    const other = path.join(dir, 'other.json');
    fs.writeFileSync(other, '{}', { mode: 0o600 });
    fs.chmodSync(other, 0o700);
    const r2 = upsertUserMcpServer(other, 'hangar', { type: 'http' }, { backupDir: backups });
    expect(r2.tightened).toBe(false);
    expect(fs.statSync(other).mode & 0o777).toBe(0o700);
  });
});
