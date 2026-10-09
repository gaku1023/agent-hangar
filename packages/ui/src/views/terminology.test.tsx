import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { translator } from '@agent-hangar/shared';
import { IntentRoot } from '../intent/chain.tsx';
import { KEYMAP } from '../keys.ts';
import { ConfirmDialog } from './ConfirmDialog.tsx';
import { ShortcutsDialog } from './ShortcutsDialog.tsx';
import { SplitPane } from './SplitPane.tsx';
import { StatusDot } from './primitives/StatusDot.tsx';

// docs/superpowers/specs/2026-10-01-ux-refresh/terminology.md の用語表のうち、ほかの試験が見ていない語をここで押さえる。

describe('用語表', () => {
  it('休みの点は、チップと同じく「休み」と読み上げる', () => {
    render(<StatusDot status="idle" />);
    expect(screen.getByLabelText('休み')).toHaveAttribute('title', '休み');
  });
  it('hangar への移動の確認は「外部ターミナル」と書く', () => {
    render(<IntentRoot onIntent={() => {}}><ConfirmDialog confirm={{ kind: 'adoptSession', sessionId: 's1' }} /></IntentRoot>);
    expect(screen.getByText(/^外部ターミナル（VS Code など）で動いている claude を終了し/)).toBeInTheDocument();
  });
  it('キーボードショートカットのダイアログは、開く操作と同じ名前を題にする', () => {
    render(<IntentRoot onIntent={() => {}}><ShortcutsDialog /></IntentRoot>);
    expect(screen.getByRole('dialog', { name: 'キーボードショートカット' })).toHaveTextContent(/^キーボードショートカット/);
    const open = KEYMAP.find((k) => k.id === 'shortcuts.open')!;
    expect(translator('ja')(open.labelKey)).toBe('キーボードショートカット');
  });
  it('キーボードショートカットの語は、ボタンや画面の語と同じにする', () => {
    const ja = translator('ja');
    const label = (id: string) => { const k = KEYMAP.find((b) => b.id === id); return k ? ja(k.labelKey) : undefined; };
    expect(label('session.new')).toBe('新しいセッション');
    expect(label('transcript.toggle')).toBe('右パネルの開閉');
    expect(label('split.toggle')).toBe('タブを横に並べる');
    expect(label('session.newScratch')).toBe('クイックセッションを開始');
    expect(label('list.memo')).toBe('ノートを編集');
  });
  it('横に並べた 2 つの間の仕切りは「左右の幅」と読み上げる', () => {
    render(<IntentRoot onIntent={() => {}}><SplitPane left={<div />} right={<div />} /></IntentRoot>);
    expect(screen.getByRole('separator', { name: '左右の幅' })).toBeInTheDocument();
  });
});
