import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ActionRoot } from '../action/chain.tsx';
import type { LinkRepairCardProps, LinkRepairProps } from '../presenters/linkRepair.ts';
import { LinkRepairDialog } from './LinkRepairDialog.tsx';

const card = (name: string, over: Partial<LinkRepairCardProps> = {}): LinkRepairCardProps => ({
  name, mineWhen: '2026-10-29 08:40', sharedWhen: '2026-10-28 21:05',
  lines: [{ kind: 'ctx', text: 'a' }, { kind: 'del', text: 'shared' }, { kind: 'add', text: 'mine' }], ...over,
});
const investigate = { op: 'linkRepair' as const, message: 'settings.json が共有設定から外れています', agent: 'claude-code' as const, accountId: 'a1', files: ['settings.json', 'CLAUDE.md'] };
const base: LinkRepairProps = { account: '大学', names: 'settings.json、CLAUDE.md', loading: false, cards: [card('settings.json'), card('CLAUDE.md')], working: false, error: null, investigate };

function mount(p: Partial<LinkRepairProps> = {}) {
  const onAction = vi.fn();
  render(<ActionRoot onAction={onAction}><LinkRepairDialog {...base} {...p} /></ActionRoot>);
  return onAction;
}
const cardOf = (name: string) => screen.getByRole('group', { name: `${name} の差分` }).closest('.cfg-card') as HTMLElement;
const repair = () => screen.getByRole('button', { name: '修復' });

describe('LinkRepairDialog', () => {
  it('題とリードにアカウントと項目を言い、足元に注と件数を出す', () => {
    mount();
    expect(screen.getByRole('dialog', { name: '大学 の設定を共有に戻す' })).toBeInTheDocument();
    expect(screen.getByText('settings.json、CLAUDE.md が共有設定から外れています。残す方を選択すると、再び共有状態に戻します。')).toBeInTheDocument();
    expect(screen.getByText('選択しなかった方は、名前に .bak-hangar-日時 を付けてバックアップします')).toBeInTheDocument();
    expect(screen.getByText('2 件中 0 件を選択')).toBeInTheDocument();
  });
  it('札に 2 つの更新時刻と差分（赤は共有だけ、緑はこのアカウントだけ）を出す', () => {
    mount();
    const c = within(cardOf('settings.json'));
    expect(c.getByText(/^このアカウント：2026-10-29 08:40 更新\s共有設定：2026-10-28 21:05 更新$/)).toBeInTheDocument();
    expect(c.getByText('- shared')).toHaveClass('diff-del');
    expect(c.getByText('+ mine')).toHaveClass('diff-add');
  });
  it('本文の無い側があれば、差分の代わりに理由を言う', () => {
    mount({ cards: [card('settings.json', { lines: null })] });
    expect(screen.getByText('ファイルサイズが大きいかバイナリ形式のため、差分を表示できません')).toBeInTheDocument();
    expect(screen.queryByRole('group', { name: 'settings.json の差分' })).toBeNull();
  });
  it('全部選ぶまで「修復」は押せない。選び直すと外せる', () => {
    mount();
    expect(repair()).toBeDisabled();
    const mine = within(cardOf('settings.json')).getByRole('button', { name: 'このアカウントの設定を残す' });
    fireEvent.click(mine);
    expect(mine).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByText('2 件中 1 件を選択')).toBeInTheDocument();
    expect(repair()).toBeDisabled();
    fireEvent.click(within(cardOf('CLAUDE.md')).getByRole('button', { name: '共有設定を残す' }));
    expect(repair()).toBeEnabled();
    fireEvent.click(mine);
    expect(mine).toHaveAttribute('aria-pressed', 'false');
    expect(repair()).toBeDisabled();
  });
  it('「修復」で選んだとおりを送る', () => {
    const onAction = mount();
    fireEvent.click(within(cardOf('settings.json')).getByRole('button', { name: 'このアカウントの設定を残す' }));
    fireEvent.click(within(cardOf('CLAUDE.md')).getByRole('button', { name: '共有設定を残す' }));
    fireEvent.click(repair());
    expect(onAction).toHaveBeenCalledWith({ type: 'linkRepair.apply', entries: [{ name: 'settings.json', keep: 'mine' }, { name: 'CLAUDE.md', keep: 'shared' }] });
  });
  it('足の左の「エージェントで調査…」は、修復の事情を渡す', () => {
    const onAction = mount();
    const button = within(document.querySelector('.dialog-foot') as HTMLElement).getByRole('button', { name: 'エージェントで調査…' });
    expect(button).toHaveAttribute('title', 'エラーの内容を入れた新しいセッションのダイアログを開きます。');
    fireEvent.click(button);
    expect(onAction).toHaveBeenCalledWith({ type: 'investigate.open', ...investigate });
  });
  it('キャンセルで閉じる', () => {
    const onAction = mount();
    fireEvent.click(screen.getByRole('button', { name: 'キャンセル' }));
    expect(onAction).toHaveBeenCalledWith({ type: 'overlay.close' });
  });
  it('直している最中は「修復中…」で、どれも押せない', () => {
    mount({ working: true });
    expect(screen.getByRole('button', { name: '修復中…' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'キャンセル' })).toBeDisabled();
    for (const b of screen.getAllByRole('button', { name: /を残す$/ })) expect(b).toBeDisabled();
  });
  it('読み込み中は札を出さず、押せない。失敗の理由はダイアログの中に出す', () => {
    const { unmount } = render(<ActionRoot onAction={() => {}}><LinkRepairDialog {...base} loading cards={[]} /></ActionRoot>);
    expect(screen.getByText('読み込み中…')).toBeInTheDocument();
    expect(repair()).toBeDisabled();
    unmount();
    mount({ error: '断られました' });
    expect(screen.getByRole('alert')).toHaveTextContent('断られました');
  });
});
