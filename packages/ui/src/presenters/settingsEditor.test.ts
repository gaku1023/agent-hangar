import { describe, expect, it } from 'vitest';
import type { EditorsDto, EditorSetting, SettingsDto } from '@agent-hangar/shared';
import { initialState } from '../mediator/transition.ts';
import { initialStore, type Store } from '../store/store.ts';
import { presentSettings } from './settings.ts';

const vscode: EditorSetting = { id: 'vscode', path: null, fileCmd: '', dirCmd: '', terminal: 'none' };
const SETTINGS: SettingsDto = { workspaceRoot: '/w', claudeDir: '/c', tmuxPath: null, terminalApp: 'terminal', editor: vscode, lmStudioUrl: 'http://127.0.0.1:1234', lmStudioModel: null, summaryFallback: true, summaryHourlyCap: 20, allowExternalSummarizer: false, nodePath: null, claudePath: null };
const EDITORS: EditorsDto = {
  candidates: [
    { id: 'vscode', name: 'VS Code', state: 'found', path: '/usr/local/bin/code', version: '1.105.1' },
    { id: 'cursor', name: 'Cursor', state: 'found', path: '/usr/local/bin/cursor', version: '1.7.4' },
    { id: 'windsurf', name: 'Windsurf', state: 'none', path: null, version: null },
    { id: 'zed', name: 'Zed', state: 'app', path: '/Applications/Zed.app', version: null },
    { id: 'idea', name: 'IntelliJ IDEA', state: 'none', path: null, version: null },
    { id: 'webstorm', name: 'WebStorm', state: 'none', path: null, version: null },
  ],
  current: { id: 'vscode', state: 'found', path: '/usr/local/bin/code' },
};
const store = (over: Partial<Store> = {}, editor: EditorSetting = vscode): Store => ({ ...initialStore(), settings: { ...SETTINGS, editor }, ...over });
const present = (s: Store) => presentSettings({ ...initialState(), screen: { name: 'settings' } }, s, 0, 'darwin').editor;

describe('設定のエディタの欄（試作の 1-1 の A）', () => {
  it('表のエディタを並べ、見つかり方と場所と版を添え、最後に任意のコマンドを置く', () => {
    const e = present(store({ editors: EDITORS }));
    expect(e.choices.map((c) => [c.id, c.name, c.tile, c.state, c.selected])).toEqual([
      ['vscode', 'VS Code', 'VS', 'found', true], ['cursor', 'Cursor', 'Cu', 'found', false], ['windsurf', 'Windsurf', 'Wi', 'none', false],
      ['zed', 'Zed', 'Ze', 'app', false], ['idea', 'IntelliJ IDEA', 'IJ', 'none', false], ['webstorm', 'WebStorm', 'WS', 'none', false],
      ['custom', '任意のコマンド', '{ }', null, false],
    ]);
    expect(e.choices[0]).toMatchObject({ path: '/usr/local/bin/code', version: '1.105.1', badge: { text: '検出済み', tone: 'ok' } });
    expect(e.choices[3]).toMatchObject({ path: '/Applications/Zed.app', badge: { text: 'アプリのみ', tone: 'warn' } });
    expect(e.choices[2]).toMatchObject({ path: null, badge: { text: '未検出', tone: 'mute' } });
    expect(e.loading).toBe(false);
  });
  it('一覧が届く前は、見つかり方を出さずに確かめている印にする', () => {
    const e = present(store());
    expect(e.loading).toBe(true);
    expect(e.choices.every((c) => c.badge === null)).toBe(true);
  });
  it('任意のコマンドは、ファイルのコマンドを場所の代わりに出し、見本を作る', () => {
    const custom: EditorSetting = { id: 'custom', path: null, fileCmd: 'subl {path}:{line}', dirCmd: '', terminal: 'none' };
    const e = present(store({ editors: EDITORS }, custom));
    expect(e.choices.at(-1)).toMatchObject({ id: 'custom', selected: true, path: 'subl {path}:{line}' });
    expect(e.setting).toEqual(custom);
    expect(e.name).toBeNull();
  });
  it('テストの答えを、通り道ごとの文にする', () => {
    expect(present(store({ editors: EDITORS, editorTest: 'running' })).test).toEqual({ running: true, result: null });
    expect(present(store({ editors: EDITORS, editorTest: { ok: true, via: 'cli', file: '/h/hangar-editor-test.md', message: null } })).test.result)
      .toEqual({ tone: 'ok', text: 'VS Code で hangar-editor-test.md の 3 行目を開きました。カーソルが 3 行目にあれば、行の指定も有効です。' });
    expect(present(store({ editors: EDITORS, editorTest: { ok: true, via: 'openA', file: '/h/hangar-editor-test.md', message: null } })).test.result)
      .toMatchObject({ tone: 'warn' });
    expect(present(store({ editors: EDITORS, editorTest: { ok: false, via: null, file: '/h/hangar-editor-test.md', message: 'Cursor が見つかりません', missing: true } })).test.result)
      .toEqual({ tone: 'ng', text: 'Cursor が見つかりません。インストール後に「再確認」をクリックするか、パスを指定してください。' });
  });
});
