import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
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
  it('引き取りの確認は「外のターミナル」と書く', () => {
    render(<IntentRoot onIntent={() => {}}><ConfirmDialog confirm={{ kind: 'adoptSession', sessionId: 's1' }} /></IntentRoot>);
    expect(screen.getByText(/^外のターミナル（VS Code など）で動いている claude を終わらせ/)).toBeInTheDocument();
  });
  it('キーの一覧のダイアログは、開く操作と同じ名前を題にする', () => {
    render(<IntentRoot onIntent={() => {}}><ShortcutsDialog /></IntentRoot>);
    expect(screen.getByRole('dialog', { name: 'キーの一覧' })).toHaveTextContent(/^キーの一覧/);
  });
  it('キーの一覧の語は、ボタンや画面の語と同じにする', () => {
    const label = (id: string) => KEYMAP.find((k) => k.id === id)?.label;
    expect(label('session.new')).toBe('新しいセッション');
    expect(label('transcript.toggle')).toBe('右の欄の開閉');
    expect(label('split.toggle')).toBe('タブを横に並べる');
  });
  it('横に並べた 2 つの間の仕切りは「左右の幅」と読み上げる', () => {
    render(<IntentRoot onIntent={() => {}}><SplitPane left={<div />} right={<div />} /></IntentRoot>);
    expect(screen.getByRole('separator', { name: '左右の幅' })).toBeInTheDocument();
  });
});
