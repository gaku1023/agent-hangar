import { describe, expect, it } from 'vitest';
import { translator } from '@agent-hangar/shared';
import { initialStore } from '../store/store.ts';
import { openAtLabel, openForLabel, openLabel, presentEditorMissing } from './editor.ts';

const ja = translator('ja');
const en = translator('en');
const settings = (id: 'vscode' | 'cursor' | 'custom') => ({ editor: { id, path: null, fileCmd: 'subl {path}', dirCmd: '', terminal: 'none' as const } });

describe('「<名前> で開く」（試作の 1-2 の A）', () => {
  it('選んでいるエディタの名前で言い、任意のコマンドは「エディタで開く」', () => {
    expect(openLabel(ja, settings('cursor'))).toBe('Cursor で開く');
    expect(openLabel(ja, settings('custom'))).toBe('エディタで開く');
    expect(openLabel(ja, null)).toBe('VS Code で開く');
    expect(openLabel(en, settings('cursor'))).toBe('Open in Cursor');
    expect(openForLabel(ja, settings('vscode'), 'a.ts')).toBe('a.ts を VS Code で開く');
    expect(openForLabel(ja, settings('custom'), 'a.ts')).toBe('a.ts をエディタで開く');
    expect(openAtLabel(ja, settings('cursor'), 'a.ts', 42)).toBe('a.ts の 42 行目を Cursor で開く');
  });
});

describe('エディタが見つからないときの面（試作の 1-3 の B）', () => {
  const missing = { code: 'editor_missing' as const, error: 'Cursor が見つかりません', editor: 'cursor' as const, name: 'Cursor', lastPath: '/usr/local/bin/cursor', others: ['vscode' as const, 'zed' as const, 'idea' as const], n: 2 };
  it('理由と、設定、今回だけほかのエディタ（2 つまで）、再確認を並べる', () => {
    const p = presentEditorMissing({ ...initialStore(), editorMissing: { ...missing, retry: { type: 'session.openFile', sessionId: 's1', path: '/w/a.ts', line: 3 } } }, ja)!;
    expect(p).toMatchObject({ n: 2, title: 'Cursor が見つかりません', lastPath: '/usr/local/bin/cursor' });
    expect(p.choices.map((c) => [c.label, c.send])).toEqual([
      ['設定でエディタを選ぶ', { type: 'nav.go', to: { name: 'settings', at: 'editor' } }],
      ['今回は VS Code で開く', { type: 'session.openFile', sessionId: 's1', path: '/w/a.ts', line: 3, once: 'vscode' }],
      ['今回は Zed で開く', { type: 'session.openFile', sessionId: 's1', path: '/w/a.ts', line: 3, once: 'zed' }],
      ['再確認', { type: 'session.openFile', sessionId: 's1', path: '/w/a.ts', line: 3 }],
    ]);
  });
  it('「今回は」で送り直して断られたときも、再確認は設定のエディタで送り直す', () => {
    const p = presentEditorMissing({ ...initialStore(), editorMissing: { ...missing, others: [], retry: { type: 'project.openEditor', id: 'p1', once: 'zed' } } }, ja)!;
    expect(p.choices.at(-1)!.send).toEqual({ type: 'project.openEditor', id: 'p1' });
  });
  it('断られていなければ出さない', () => {
    expect(presentEditorMissing(initialStore(), ja)).toBeNull();
  });
});
