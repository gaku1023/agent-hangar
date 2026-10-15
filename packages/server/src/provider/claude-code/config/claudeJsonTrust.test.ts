import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { claudeJsonFor, toTrustKey, trustFolders, trustKeyOf, untrustedFolders } from './claudeJson.ts';
import { expectMode, posixIt } from '../../../../test/platform.ts';

let root: string;
let file: string;
let backups: string;
let a: string;
let b: string;
beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hangar-trust-')));
  fs.mkdirSync(path.join(root, 'home'));
  file = path.join(root, 'home', '.claude.json');
  backups = path.join(root, 'hangar', 'backups');
  a = path.join(root, 'work', 'a');
  b = path.join(root, 'work', 'b');
  fs.mkdirSync(a, { recursive: true });
  fs.mkdirSync(b, { recursive: true });
});
afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

const read = () => JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;

describe('claudeJsonFor', () => {
  it('最初のアカウント（置き場なし）はホームの直下、ほかは置き場の直下の .claude.json', () => {
    expect(claudeJsonFor(null, '/h')).toBe(path.join('/h', '.claude.json'));
    expect(claudeJsonFor('/h/.claude-univ', '/h')).toBe(path.join('/h/.claude-univ', '.claude.json'));
  });
});

describe('信頼の鍵', () => {
  it('Windows は Claude Code と同じく / 区切りにする', () => {
    expect(toTrustKey('C:\\Users\\me\\work', 'win32')).toBe('C:/Users/me/work');
    expect(toTrustKey('/Users/me/work', 'darwin')).toBe('/Users/me/work');
  });

  posixIt('リンクは実体のパスにする（claude は getcwd の実体で引く）', () => {
    const link = path.join(root, 'link');
    fs.symlinkSync(a, link);
    expect(trustKeyOf(link)).toBe(a);
    // 無いフォルダは resolve の形のまま
    expect(trustKeyOf(path.join(root, 'none', '..', 'none2'))).toBe(path.join(root, 'none2'));
  });
});

describe('trustFolders', () => {
  it('projects.<path>.hasTrustDialogAccepted を true にし、ほかの鍵と同じ行のほかの項目を残す', () => {
    fs.writeFileSync(file, JSON.stringify({ numStartups: 3, mcpServers: { x: { type: 'http' } }, projects: { [a]: { allowedTools: ['Bash'], hasTrustDialogAccepted: false }, '/other': { hasTrustDialogAccepted: true } } }), { mode: 0o640 });
    const r = trustFolders(file, [a, b], { backupDir: backups });
    expect(r.added).toEqual([a, b]);
    expect(r.missing).toBe(false);
    expect(r.backup).not.toBeNull();
    expect(read()).toEqual({
      numStartups: 3,
      mcpServers: { x: { type: 'http' } },
      projects: { [a]: { allowedTools: ['Bash'], hasTrustDialogAccepted: true }, '/other': { hasTrustDialogAccepted: true }, [b]: { hasTrustDialogAccepted: true } },
    });
    // 他人にも読める権限は、MCP の登録と同じく 0600 に狭める（Claude Code 自身も 0600 で書く）。
    expectMode(file, 0o600);
  });

  it('全部すでに信頼済みなら書かず、控えも取らない', () => {
    fs.writeFileSync(file, JSON.stringify({ projects: { [a]: { hasTrustDialogAccepted: true } } }));
    const before = fs.readFileSync(file, 'utf8');
    const r = trustFolders(file, [a], { backupDir: backups });
    expect(r).toMatchObject({ added: [], backup: null, missing: false });
    expect(fs.readFileSync(file, 'utf8')).toBe(before);
    expect(fs.existsSync(backups)).toBe(false);
  });

  it('ファイルが無ければ作らない（まだ一度も claude を起こしていない置き場）', () => {
    const r = trustFolders(file, [a], { backupDir: backups });
    expect(r).toMatchObject({ added: [], backup: null, missing: true });
    expect(fs.existsSync(file)).toBe(false);
  });

  it('壊れた JSON は上書きせずに投げる', () => {
    fs.writeFileSync(file, '{ broken');
    expect(() => trustFolders(file, [a], { backupDir: backups })).toThrow();
    expect(fs.readFileSync(file, 'utf8')).toBe('{ broken');
  });

  it('書く直前に読み直すので、割り込みで書かれた変更を潰さない', () => {
    fs.writeFileSync(file, JSON.stringify({ projects: {} }));
    trustFolders(file, [a], {
      backupDir: backups,
      onBeforeWrite: () => fs.writeFileSync(file, JSON.stringify({ projects: { '/late': { hasTrustDialogAccepted: false } }, late: 1 })),
    });
    expect(read()).toEqual({ late: 1, projects: { '/late': { hasTrustDialogAccepted: false }, [a]: { hasTrustDialogAccepted: true } } });
  });

  posixIt('シンボリックリンクの .claude.json はリンクのまま残し、実体に書く', () => {
    const real = path.join(root, 'dotfiles.json');
    fs.writeFileSync(real, JSON.stringify({ projects: {} }));
    fs.symlinkSync(real, file);
    trustFolders(file, [a], { backupDir: backups });
    expect(fs.lstatSync(file).isSymbolicLink()).toBe(true);
    expect((JSON.parse(fs.readFileSync(real, 'utf8')) as { projects: Record<string, unknown> }).projects[a]).toEqual({ hasTrustDialogAccepted: true });
  });
});

describe('untrustedFolders', () => {
  it('自分の鍵で信頼済みでないものの鍵を返す。ファイルが無ければ null', () => {
    expect(untrustedFolders(file, [a])).toBeNull();
    fs.writeFileSync(file, JSON.stringify({ projects: { [a]: { hasTrustDialogAccepted: true }, [b]: { hasTrustDialogAccepted: false } } }));
    expect(untrustedFolders(file, [a, b])).toEqual([b]);
  });
});
