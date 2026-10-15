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
/** a と b の信頼の鍵（Windows では / 区切り）。 */
let ka: string;
let kb: string;
beforeEach(() => {
  // Windows の一時の置き場は 8.3 の短い名前（RUNNER~1）で返り、native だけが長い名前に直す。鍵は native の実体で作る。
  root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'hangar-trust-')));
  fs.mkdirSync(path.join(root, 'home'));
  file = path.join(root, 'home', '.claude.json');
  backups = path.join(root, 'hangar', 'backups');
  a = path.join(root, 'work', 'a');
  b = path.join(root, 'work', 'b');
  fs.mkdirSync(a, { recursive: true });
  fs.mkdirSync(b, { recursive: true });
  ka = trustKeyOf(a);
  kb = trustKeyOf(b);
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

  it('Windows の path で作ったパスも、区切りだけを / にし、ドライブと大小はそのまま残す', () => {
    // 置き場とリポジトリの根は path.join と realpath の形（\ 区切り）で来る。それを鍵にしたときの形を、Mac でも押さえる。
    const ws = path.win32.resolve('D:\\Work');
    expect(toTrustKey(path.win32.join(ws, 'app', 'packages'), 'win32')).toBe('D:/Work/app/packages');
    expect(toTrustKey(path.win32.join('C:\\Users\\runneradmin', '.agent-hangar', 'quick-sessions'), 'win32')).toBe('C:/Users/runneradmin/.agent-hangar/quick-sessions');
    // ネットワークの共有（UNC）も同じく区切りだけを変える。
    expect(toTrustKey('\\\\server\\share\\repo', 'win32')).toBe('//server/share/repo');
    // Mac と Linux では \ はファイル名の一部なので変えない。
    expect(toTrustKey('/tmp/a\\b', 'linux')).toBe('/tmp/a\\b');
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
    fs.writeFileSync(file, JSON.stringify({ numStartups: 3, mcpServers: { x: { type: 'http' } }, projects: { [ka]: { allowedTools: ['Bash'], hasTrustDialogAccepted: false }, '/other': { hasTrustDialogAccepted: true } } }), { mode: 0o640 });
    const r = trustFolders(file, [a, b], { backupDir: backups });
    expect(r.added).toEqual([ka, kb]);
    expect(r.missing).toBe(false);
    expect(r.backup).not.toBeNull();
    expect(read()).toEqual({
      numStartups: 3,
      mcpServers: { x: { type: 'http' } },
      projects: { [ka]: { allowedTools: ['Bash'], hasTrustDialogAccepted: true }, '/other': { hasTrustDialogAccepted: true }, [kb]: { hasTrustDialogAccepted: true } },
    });
    // 他人にも読める権限は、MCP の登録と同じく 0600 に狭める（Claude Code 自身も 0600 で書く）。
    expectMode(file, 0o600);
  });

  it('全部すでに信頼済みなら書かず、控えも取らない', () => {
    fs.writeFileSync(file, JSON.stringify({ projects: { [ka]: { hasTrustDialogAccepted: true } } }));
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
    expect(read()).toEqual({ late: 1, projects: { '/late': { hasTrustDialogAccepted: false }, [ka]: { hasTrustDialogAccepted: true } } });
  });

  it('置き場のフォルダがまだ無ければ（登録したばかりのアカウント）、投げずに missing で返す', () => {
    const none = path.join(root, 'none', '.claude.json');
    expect(trustFolders(none, [a], { backupDir: backups })).toMatchObject({ added: [], backup: null, missing: true });
    expect(untrustedFolders(none, [a])).toBeNull();
    expect(fs.existsSync(path.join(root, 'none'))).toBe(false);
  });

  it('読み直したら書き足すものが無くなっていたときは、控えを残さない', () => {
    fs.writeFileSync(file, JSON.stringify({ projects: {} }));
    const r = trustFolders(file, [a], {
      backupDir: backups,
      onBeforeWrite: () => fs.writeFileSync(file, JSON.stringify({ projects: { [ka]: { hasTrustDialogAccepted: true } } })),
    });
    expect(r).toMatchObject({ added: [], backup: null, missing: false });
    expect(fs.readdirSync(backups)).toEqual([]);
  });

  it('信頼の控えは新しいものから 5 つだけ残す。MCP の登録の控えには触らない', () => {
    fs.mkdirSync(backups, { recursive: true });
    fs.writeFileSync(path.join(backups, 'claude.json-20260101000000'), '{}');
    fs.writeFileSync(file, JSON.stringify({ projects: {} }));
    const kept: string[] = [];
    for (let i = 0; i < 7; i++) {
      const d = path.join(root, 'work', `d${i}`);
      fs.mkdirSync(d);
      const r = trustFolders(file, [d], { backupDir: backups, now: new Date(2026, 9, 16, 12, 0, i) });
      kept.push(path.basename(r.backup!));
    }
    // 同じ秒に取った控え（-2 の付いたもの）も、取った順に数える。
    const same = trustFolders(file, [path.join(root, 'work', 'late')], { backupDir: backups, now: new Date(2026, 9, 16, 12, 0, 6) });
    kept.push(path.basename(same.backup!));
    expect(kept.at(-1)).toMatch(/-2$/);
    expect(fs.readdirSync(backups).sort()).toEqual(['claude.json-20260101000000', ...kept.slice(-5)].sort());
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
    fs.writeFileSync(file, JSON.stringify({ projects: { [ka]: { hasTrustDialogAccepted: true }, [kb]: { hasTrustDialogAccepted: false } } }));
    expect(untrustedFolders(file, [a, b])).toEqual([kb]);
  });
});
