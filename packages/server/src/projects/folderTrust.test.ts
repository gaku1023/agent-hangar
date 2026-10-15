import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { posixIt } from '../../test/platform.ts';
import { launchTrustDirs, trustBeforeLaunch, trustedPlaces, trustedWorkspaceOf, trustWorkspaceFolders, workspaceTrustDirs } from './folderTrust.ts';

let root: string;
let home: string;
beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hangar-ft-')));
  home = path.join(root, '.agent-hangar');
  fs.mkdirSync(home);
});
afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe('trustedPlaces', () => {
  it('クイックセッションの 2 つの置き場はいつも、作業フォルダは同意したときだけ', () => {
    const quick = [path.join(home, 'quick-sessions'), path.join(home, 'scratch')];
    expect(trustedPlaces({ hangarHome: home, trustedWorkspace: null })).toEqual(quick);
    expect(trustedPlaces({ hangarHome: home, trustedWorkspace: '/w' })).toEqual([...quick, '/w']);
  });
});

describe('trustedWorkspaceOf', () => {
  it('同意した場所が、いまの作業フォルダと同じときだけ返す', () => {
    expect(trustedWorkspaceOf({ workspaceRoot: '/w', trustedWorkspaceRoot: '/w' })).toBe('/w');
    expect(trustedWorkspaceOf({ workspaceRoot: '/w/', trustedWorkspaceRoot: '/w' })).toBe('/w');
    expect(trustedWorkspaceOf({ workspaceRoot: '/x', trustedWorkspaceRoot: '/w' })).toBeNull();
    expect(trustedWorkspaceOf({ workspaceRoot: '', trustedWorkspaceRoot: '' })).toBeNull();
    expect(trustedWorkspaceOf({ workspaceRoot: '/w' })).toBeNull();
    expect(trustedWorkspaceOf({ workspaceRoot: '/w', trustedWorkspaceRoot: null })).toBeNull();
  });
});

describe('launchTrustDirs', () => {
  it('置き場の下のふつうのフォルダは、置き場そのものだけ（親の信頼が子に及ぶ）', () => {
    const quick = path.join(home, 'quick-sessions');
    const cwd = path.join(quick, '20261016-120000');
    fs.mkdirSync(cwd, { recursive: true });
    expect(launchTrustDirs(cwd, trustedPlaces({ hangarHome: home, trustedWorkspace: null }))).toEqual([quick]);
  });

  it('前の置き場（scratch）の下も同じ', () => {
    const legacy = path.join(home, 'scratch');
    const cwd = path.join(legacy, 'old');
    fs.mkdirSync(cwd, { recursive: true });
    expect(launchTrustDirs(cwd, trustedPlaces({ hangarHome: home, trustedWorkspace: null }))).toEqual([legacy]);
  });

  it('git のリポジトリの中は親の信頼が及ばないので、リポジトリの根も足す（実物の claude で確かめた）', () => {
    const ws = path.join(root, 'workspace');
    const repo = path.join(ws, 'app');
    const sub = path.join(repo, 'packages', 'x');
    fs.mkdirSync(sub, { recursive: true });
    fs.mkdirSync(path.join(repo, '.git'));
    const places = trustedPlaces({ hangarHome: home, trustedWorkspace: ws });
    expect(launchTrustDirs(sub, places)).toEqual([ws, repo]);
    expect(launchTrustDirs(repo, places)).toEqual([ws, repo]);
  });

  it('worktree の .git（ファイル）もリポジトリの根として見る', () => {
    const ws = path.join(root, 'workspace');
    const wt = path.join(ws, 'app-wt');
    fs.mkdirSync(wt, { recursive: true });
    fs.writeFileSync(path.join(wt, '.git'), 'gitdir: /elsewhere\n');
    expect(launchTrustDirs(wt, trustedPlaces({ hangarHome: home, trustedWorkspace: ws }))).toEqual([ws, wt]);
  });

  it('入れ子のリポジトリの中では、いちばん近いリポジトリの根だけを書く', () => {
    const ws = path.join(root, 'workspace');
    const outer = path.join(ws, 'outer');
    const inner = path.join(outer, 'vendor', 'inner');
    const sub = path.join(inner, 'src');
    fs.mkdirSync(sub, { recursive: true });
    fs.mkdirSync(path.join(outer, '.git'));
    fs.mkdirSync(path.join(inner, '.git'));
    const places = trustedPlaces({ hangarHome: home, trustedWorkspace: ws });
    expect(launchTrustDirs(sub, places)).toEqual([ws, inner]);
    expect(launchTrustDirs(path.join(outer, 'vendor'), places)).toEqual([ws, outer]);
  });

  posixIt('置き場の下のリンクが置き場の外を指すときは書かない（リンクの先の実体で判定する）', () => {
    const ws = path.join(root, 'workspace');
    const outside = path.join(root, 'elsewhere', 'repo');
    fs.mkdirSync(path.join(outside, '.git'), { recursive: true });
    fs.mkdirSync(ws, { recursive: true });
    fs.symlinkSync(outside, path.join(ws, 'link'));
    const quick = path.join(home, 'quick-sessions');
    fs.mkdirSync(quick, { recursive: true });
    fs.symlinkSync(outside, path.join(quick, 'link'));
    const places = trustedPlaces({ hangarHome: home, trustedWorkspace: ws });
    expect(launchTrustDirs(path.join(ws, 'link'), places)).toEqual([]);
    expect(launchTrustDirs(path.join(quick, 'link'), places)).toEqual([]);
  });

  posixIt('置き場そのものがリンクでも、実体どうしで比べるので書く', () => {
    const real = path.join(root, 'real-ws');
    const repo = path.join(real, 'app');
    fs.mkdirSync(path.join(repo, '.git'), { recursive: true });
    const ws = path.join(root, 'ws-link');
    fs.symlinkSync(real, ws);
    const places = trustedPlaces({ hangarHome: home, trustedWorkspace: ws });
    expect(launchTrustDirs(path.join(ws, 'app'), places)).toEqual([real, repo]);
    expect(launchTrustDirs(repo, places)).toEqual([real, repo]);
  });

  it('置き場の外は何もしない。同意していない作業フォルダの下も、名前が scratch なだけのフォルダも', () => {
    const ws = path.join(root, 'workspace');
    const mine = path.join(root, 'workspace', 'scratch', 'x');
    fs.mkdirSync(mine, { recursive: true });
    const places = trustedPlaces({ hangarHome: home, trustedWorkspace: null });
    expect(launchTrustDirs(mine, places)).toEqual([]);
    expect(launchTrustDirs(ws, places)).toEqual([]);
    expect(launchTrustDirs(path.join(root, 'workspace2'), trustedPlaces({ hangarHome: home, trustedWorkspace: ws }))).toEqual([]);
  });
});

describe('workspaceTrustDirs', () => {
  it('作業フォルダそのものと、直下の git のリポジトリ（隠しフォルダとファイルは除く）', () => {
    const ws = path.join(root, 'workspace');
    for (const d of ['repo1', 'plain', '.hidden', 'repo2']) fs.mkdirSync(path.join(ws, d), { recursive: true });
    fs.mkdirSync(path.join(ws, 'repo1', '.git'));
    fs.writeFileSync(path.join(ws, 'repo2', '.git'), 'gitdir: x\n');
    fs.mkdirSync(path.join(ws, '.hidden', '.git'));
    fs.writeFileSync(path.join(ws, 'file.txt'), '');
    expect(workspaceTrustDirs(ws)).toEqual([ws, path.join(ws, 'repo1'), path.join(ws, 'repo2')]);
  });

  it('無い場所は空', () => {
    expect(workspaceTrustDirs(path.join(root, 'none'))).toEqual([]);
  });
});

describe('trustBeforeLaunch（起こすアカウントの .claude.json に書く）', () => {
  const projects = (file: string) => (JSON.parse(fs.readFileSync(file, 'utf8')) as { projects: Record<string, { hasTrustDialogAccepted?: boolean }> }).projects;

  it('最初のアカウントはホームの直下、ほかのアカウントは置き場の直下に書き、もう一方には書かない', () => {
    const userHome = path.join(root, 'user');
    const univ = path.join(userHome, '.claude-univ');
    fs.mkdirSync(univ, { recursive: true });
    const primaryFile = path.join(userHome, '.claude.json');
    const univFile = path.join(univ, '.claude.json');
    fs.writeFileSync(primaryFile, JSON.stringify({ projects: {} }));
    fs.writeFileSync(univFile, JSON.stringify({ projects: {} }));
    const quick = path.join(home, 'quick-sessions');
    const cwd = path.join(quick, '20261016-120000');
    fs.mkdirSync(cwd, { recursive: true });
    const deps = { hangarHome: home, homeDir: userHome, trustedWorkspace: () => null };

    expect(trustBeforeLaunch(deps, univ, cwd)).toEqual([quick]);
    expect(projects(univFile)[quick]).toEqual({ hasTrustDialogAccepted: true });
    expect(projects(primaryFile)).toEqual({});

    expect(trustBeforeLaunch(deps, null, cwd)).toEqual([quick]);
    expect(projects(primaryFile)[quick]).toEqual({ hasTrustDialogAccepted: true });
    // 2 回目からは書かない（控えも増えない）
    const backups = fs.readdirSync(path.join(home, 'backups')).length;
    expect(trustBeforeLaunch(deps, null, cwd)).toEqual([]);
    expect(fs.readdirSync(path.join(home, 'backups')).length).toBe(backups);
  });

  it('置き場の外では何も読まず、何も書かない', () => {
    const userHome = path.join(root, 'user');
    fs.mkdirSync(userHome);
    fs.writeFileSync(path.join(userHome, '.claude.json'), '{ broken');
    expect(trustBeforeLaunch({ hangarHome: home, homeDir: userHome, trustedWorkspace: () => null }, null, root)).toEqual([]);
  });
});

describe('trustWorkspaceFolders', () => {
  it('全部の書く先に、作業フォルダと直下のリポジトリを書く。無いファイルは作らず、壊れたファイルはその行だけ失敗にする', () => {
    const ws = path.join(root, 'workspace');
    fs.mkdirSync(path.join(ws, 'repo', '.git'), { recursive: true });
    const ok = path.join(root, 'a.json');
    const none = path.join(root, 'none.json');
    const broken = path.join(root, 'broken.json');
    fs.writeFileSync(ok, JSON.stringify({ projects: { [ws]: { hasTrustDialogAccepted: true } } }));
    fs.writeFileSync(broken, '{ broken');
    const backupDir = path.join(home, 'backups');

    const dry = trustWorkspaceFolders({ root: ws, files: [ok, none, broken], backupDir, dryRun: true });
    expect(dry.dirs).toEqual([ws, path.join(ws, 'repo')]);
    expect(dry.files[0]).toEqual({ file: ok, added: [path.join(ws, 'repo')], missing: false });
    expect(dry.files[1]).toEqual({ file: none, added: [], missing: true });
    expect(dry.files[2]!.error).toBeTruthy();
    expect(fs.existsSync(backupDir)).toBe(false);

    const done = trustWorkspaceFolders({ root: ws, files: [ok, none, broken], backupDir, dryRun: false });
    expect(done.files[0]!.added).toEqual([path.join(ws, 'repo')]);
    expect(fs.existsSync(none)).toBe(false);
    expect(fs.readFileSync(broken, 'utf8')).toBe('{ broken');
    expect((JSON.parse(fs.readFileSync(ok, 'utf8')) as { projects: Record<string, unknown> }).projects[path.join(ws, 'repo')]).toEqual({ hasTrustDialogAccepted: true });
  });
});
