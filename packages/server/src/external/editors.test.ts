import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { EditorSetting } from '@agent-hangar/shared';
import { detectEditors, findEditor, planEditorLaunch, type EditorHost } from './editors.ts';

/** ファイルの有無だけを持つ見せかけの PC。which は PATH の代わりの表を引く。 */
function host(o: { platform: NodeJS.Platform; files?: string[]; onPath?: Record<string, string>; env?: NodeJS.ProcessEnv; dirs?: Record<string, string[]> }): EditorHost {
  const files = new Set(o.files ?? []);
  const p = o.platform === 'win32' ? path.win32 : path.posix;
  return {
    platform: o.platform,
    env: o.env ?? (o.platform === 'win32' ? { LOCALAPPDATA: 'C:\\Users\\u\\AppData\\Local', ProgramFiles: 'C:\\Program Files' } : {}),
    home: o.platform === 'win32' ? 'C:\\Users\\u' : '/Users/u',
    exists: (f) => files.has(f) || [...files].some((x) => x.startsWith(f + p.sep)),
    isExec: (f) => files.has(f),
    which: (name) => o.onPath?.[name] ?? null,
    readdir: (d) => o.dirs?.[d] ?? [],
  };
}

const vscode: EditorSetting = { id: 'vscode', path: null, fileCmd: '', dirCmd: '', terminal: 'none' };
const file = (p: string, line: number | null = null) => ({ path: p, line, dir: false });
const dir = (p: string) => ({ path: p, line: null, dir: true });

describe('findEditor（macOS）', () => {
  it('CLI が PATH にあれば found', () => {
    const h = host({ platform: 'darwin', onPath: { code: '/usr/local/bin/code' } });
    expect(findEditor('vscode', h, null)).toMatchObject({ state: 'found', cli: '/usr/local/bin/code' });
  });
  it('PATH に無くても既知の場所の CLI を拾う（Toolbox のスクリプト）', () => {
    const f = '/Users/u/Library/Application Support/JetBrains/Toolbox/scripts/idea';
    expect(findEditor('idea', host({ platform: 'darwin', files: [f] }), null)).toMatchObject({ state: 'found', cli: f });
  });
  it('アプリだけあれば app。アプリの中の CLI を覚える', () => {
    const app = '/Applications/Zed.app';
    const h = host({ platform: 'darwin', files: [`${app}/Contents/MacOS/cli`] });
    expect(findEditor('zed', h, null)).toEqual({ state: 'app', cli: null, app, inAppCli: `${app}/Contents/MacOS/cli` });
  });
  it('~/Applications のアプリも探す', () => {
    const app = '/Users/u/Applications/Cursor.app';
    expect(findEditor('cursor', host({ platform: 'darwin', files: [`${app}/Contents/Info.plist`] }), null)).toMatchObject({ state: 'app', app, inAppCli: null });
  });
  it('どこにも無ければ none', () => {
    expect(findEditor('windsurf', host({ platform: 'darwin' }), null)).toEqual({ state: 'none', cli: null, app: null, inAppCli: null });
  });
  it('設定のパスが動けばそれを使い、動かなければ自動で探す', () => {
    const h = host({ platform: 'darwin', files: ['/opt/x/code'], onPath: { code: '/usr/local/bin/code' } });
    expect(findEditor('vscode', h, '/opt/x/code')).toMatchObject({ state: 'found', cli: '/opt/x/code' });
    expect(findEditor('vscode', h, '/gone/code')).toMatchObject({ state: 'found', cli: '/usr/local/bin/code' });
  });
});

describe('findEditor（Windows）', () => {
  it('LOCALAPPDATA の Programs にある code.cmd を拾う', () => {
    const f = 'C:\\Users\\u\\AppData\\Local\\Programs\\Microsoft VS Code\\bin\\code.cmd';
    expect(findEditor('vscode', host({ platform: 'win32', files: [f] }), null)).toMatchObject({ state: 'found', cli: f });
  });
  it('CLI が無くアプリの実行ファイルだけあれば app', () => {
    const exe = 'C:\\Users\\u\\AppData\\Local\\Programs\\cursor\\Cursor.exe';
    expect(findEditor('cursor', host({ platform: 'win32', files: [exe] }), null)).toEqual({ state: 'app', cli: null, app: exe, inAppCli: exe });
  });
  it('JetBrains は Program Files の版ごとのフォルダから探す', () => {
    const exe = 'C:\\Program Files\\JetBrains\\WebStorm 2025.2.2\\bin\\webstorm64.exe';
    const h = host({ platform: 'win32', files: [exe], dirs: { 'C:\\Program Files\\JetBrains': ['IntelliJ IDEA 2025.2.3', 'WebStorm 2025.2.2'] } });
    expect(findEditor('webstorm', h, null)).toMatchObject({ state: 'app', app: exe, inAppCli: exe });
  });
  it('環境変数が無い場所は探さない', () => {
    expect(findEditor('vscode', host({ platform: 'win32', env: {} }), null).state).toBe('none');
  });
});

describe('detectEditors', () => {
  it('表の順に、見つかり方と場所を返す', () => {
    const h = host({ platform: 'darwin', onPath: { code: '/usr/local/bin/code' }, files: ['/Applications/Zed.app/Contents/MacOS/cli'] });
    const r = detectEditors(h);
    expect(r.map((c) => c.id)).toEqual(['vscode', 'cursor', 'windsurf', 'zed', 'idea', 'webstorm']);
    expect(r[0]).toEqual({ id: 'vscode', name: 'VS Code', state: 'found', path: '/usr/local/bin/code', version: null });
    expect(r[3]).toEqual({ id: 'zed', name: 'Zed', state: 'app', path: '/Applications/Zed.app', version: null });
    expect(r[1]!.state).toBe('none');
  });
});

describe('planEditorLaunch', () => {
  const mac = host({ platform: 'darwin', onPath: { code: '/usr/local/bin/code', zed: '/usr/local/bin/zed', idea: '/usr/local/bin/idea' } });
  it('VS Code の仲間は -g path:line で行まで、行が無ければパスだけ', () => {
    expect(planEditorLaunch(vscode, file('/w/a b.ts', 42), mac)).toEqual({ kind: 'exec', via: 'cli', file: '/usr/local/bin/code', args: ['-g', '/w/a b.ts:42'] });
    expect(planEditorLaunch(vscode, file('/w/a.ts'), mac)).toEqual({ kind: 'exec', via: 'cli', file: '/usr/local/bin/code', args: ['/w/a.ts'] });
    expect(planEditorLaunch(vscode, dir('/w'), mac)).toEqual({ kind: 'exec', via: 'cli', file: '/usr/local/bin/code', args: ['/w'] });
  });
  it('Zed は path:line、JetBrains は --line N path', () => {
    expect(planEditorLaunch({ ...vscode, id: 'zed' }, file('/w/a.ts', 3), mac)).toMatchObject({ args: ['/w/a.ts:3'] });
    expect(planEditorLaunch({ ...vscode, id: 'idea' }, file('/w/a.ts', 3), mac)).toMatchObject({ args: ['--line', '3', '/w/a.ts'] });
    expect(planEditorLaunch({ ...vscode, id: 'idea' }, dir('/w'), mac)).toMatchObject({ args: ['/w'] });
  });
  it('アプリだけなら、アプリの中の CLI を使う', () => {
    const h = host({ platform: 'darwin', files: ['/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code'] });
    expect(planEditorLaunch(vscode, file('/w/a.ts', 3), h)).toEqual({ kind: 'exec', via: 'app', file: '/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code', args: ['-g', '/w/a.ts:3'] });
  });
  it('アプリの中の CLI も無ければ、URL か open -a に落とす', () => {
    const h = host({ platform: 'darwin', files: ['/Applications/Cursor.app/Contents/Info.plist', '/Applications/IntelliJ IDEA.app/Contents/Info.plist'] });
    expect(planEditorLaunch({ ...vscode, id: 'cursor' }, file('/w/a b.ts', 3), h)).toEqual({ kind: 'exec', via: 'url', file: 'open', args: ['cursor://file/w/a%20b.ts:3'] });
    expect(planEditorLaunch({ ...vscode, id: 'cursor' }, dir('/w'), h)).toEqual({ kind: 'exec', via: 'openA', file: 'open', args: ['-a', '/Applications/Cursor.app', '/w'] });
    expect(planEditorLaunch({ ...vscode, id: 'idea' }, file('/w/a.ts', 3), h)).toEqual({ kind: 'exec', via: 'openA', file: 'open', args: ['-na', '/Applications/IntelliJ IDEA.app', '--args', '--line', '3', '/w/a.ts'] });
  });
  it('見つからなければ missing。最後に設定した場所を添える', () => {
    expect(planEditorLaunch({ ...vscode, id: 'windsurf', path: '/old/windsurf' }, file('/w/a.ts'), mac)).toEqual({ kind: 'missing', lastPath: '/old/windsurf' });
  });
  it('任意のコマンドは語を差し込み、先頭の名前を PATH から探す', () => {
    const h = host({ platform: 'darwin', onPath: { subl: '/usr/local/bin/subl' } });
    const custom: EditorSetting = { id: 'custom', path: null, fileCmd: 'subl {path}:{line}', dirCmd: '', terminal: 'none' };
    expect(planEditorLaunch(custom, file('/w/a b.ts', 7), h)).toEqual({ kind: 'exec', via: 'command', file: '/usr/local/bin/subl', args: ['/w/a b.ts:7'] });
    expect(planEditorLaunch(custom, dir('/w'), h)).toEqual({ kind: 'exec', via: 'command', file: '/usr/local/bin/subl', args: ['/w'] });
    expect(planEditorLaunch({ ...custom, fileCmd: 'nope {path}' }, file('/w/a'), h)).toEqual({ kind: 'missing', lastPath: 'nope' });
    expect(planEditorLaunch({ ...custom, fileCmd: 'subl' }, file('/w/a'), h)).toEqual({ kind: 'badCommand' });
  });
  it('任意のコマンドの先頭がフルパスなら、そのファイルがあるかを見る', () => {
    const h = host({ platform: 'darwin', files: ['/opt/ed/bin/ed'] });
    const custom: EditorSetting = { id: 'custom', path: null, fileCmd: '/opt/ed/bin/ed {path}', dirCmd: '', terminal: 'none' };
    expect(planEditorLaunch(custom, file('/w/a'), h)).toEqual({ kind: 'exec', via: 'command', file: '/opt/ed/bin/ed', args: ['/w/a'] });
  });
  it('Windows のアプリだけは、アプリの実行ファイルに同じ引数を渡す', () => {
    const exe = 'C:\\Users\\u\\AppData\\Local\\Programs\\Microsoft VS Code\\Code.exe';
    expect(planEditorLaunch(vscode, file('D:\\w\\a.ts', 5), host({ platform: 'win32', files: [exe] }))).toEqual({ kind: 'exec', via: 'app', file: exe, args: ['-g', 'D:\\w\\a.ts:5'] });
  });
});
