import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { translator } from '@agent-hangar/shared';
import { ActionRoot } from '../action/chain.tsx';
import { bindingLabel, KEYMAP } from '../keys.ts';
import { ConfirmDialog } from './ConfirmDialog.tsx';
import { ShortcutsDialog } from './ShortcutsDialog.tsx';
import { SplitPane } from './SplitPane.tsx';
import { StatusDot } from './primitives/StatusDot.tsx';

// docs/superpowers/specs/2026-10-01-ux-refresh/terminology.md の用語表のうち、ほかの試験が見ていない語をここで押さえる。

describe('用語表', () => {
  it('アイドルの点は、チップと同じく「アイドル」と読み上げる', () => {
    render(<StatusDot status="idle" />);
    expect(screen.getByLabelText('アイドル')).toHaveAttribute('title', 'アイドル');
  });
  it('hangar への移動の確認は「外部ターミナル」と書く', () => {
    render(<ActionRoot onAction={() => {}}><ConfirmDialog confirm={{ kind: 'adoptSession', sessionId: 's1' }} /></ActionRoot>);
    expect(screen.getByText(/^外部ターミナル（VS Code など）で実行中の claude を終了し/)).toBeInTheDocument();
  });
  it('キーボードショートカットのダイアログは、開く操作と同じ名前を題にする', () => {
    render(<ActionRoot onAction={() => {}}><ShortcutsDialog /></ActionRoot>);
    expect(screen.getByRole('dialog', { name: 'キーボードショートカット' })).toHaveTextContent(/^キーボードショートカット/);
    const open = KEYMAP.find((k) => k.id === 'shortcuts.open')!;
    expect(bindingLabel(translator('ja'), open)).toBe('キーボードショートカット');
  });
  it('キーボードショートカットの語は、ボタンや画面の語と同じにする', () => {
    const ja = translator('ja');
    const label = (id: string) => { const k = KEYMAP.find((b) => b.id === id); return k ? bindingLabel(ja, k) : undefined; };
    expect(label('session.new')).toBe('新しいセッション');
    expect(label('transcript.toggle')).toBe('右パネルの開閉');
    expect(label('split.toggle')).toBe('タブを横に並べる');
    expect(label('session.newScratch')).toBe('クイックセッションを開始');
    // 一覧の m（ノートを編集）は、ノートと一緒に外した。
    expect(label('list.memo')).toBeUndefined();
  });
  it('参加の画面は、参加コード、確認コード、参加リクエスト、接続先の語を使い、「届く」「宛先」「参加トークン」を使わない', () => {
    const ja = translator('ja');
    expect(ja('cloudMember.join.button')).toBe('参加コードで参加');
    expect(ja('cloudMember.join.urlLabel')).toBe('接続先の URL');
    expect(ja('cloudMember.join.waitingBody')).toBe('参加コードを発行した PC で承認してください。');
    expect(ja('cloudMember.add.requested', { name: 'pc-b' })).toBe('pc-b から参加リクエストを受信しました');
    expect(ja('cloudMember.toast.title', { name: 'pc-b' })).toBe('pc-b から参加リクエストを受信しました');
    expect(ja('cloudMember.join.sasLabel')).toBe('確認コード');
    const keys = ['cloudMember.join.lead', 'cloudMember.join.sasNote', 'cloudMember.add.lead', 'cloudMember.add.sasNote', 'cloudMember.add.waiting', 'cloudMember.toast.sasNote', 'cloudMember.fail.noAnswer.body', 'cloudMember.fail.rejected.body', 'cloudMember.fail.expired.body'] as const;
    for (const k of keys) expect(ja(k)).not.toMatch(/届|宛先|参加トークン/);
  });
  it('横に並べた 2 つの間の仕切りは「左右の幅」と読み上げる', () => {
    render(<ActionRoot onAction={() => {}}><SplitPane left={<div />} right={<div />} /></ActionRoot>);
    expect(screen.getByRole('separator', { name: '左右の幅' })).toBeInTheDocument();
  });
});
