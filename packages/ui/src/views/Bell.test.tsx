import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ActionRoot } from '../action/chain.tsx';
import type { NoticeRow, NoticesProps } from '../presenters/notices.ts';
import { Bell } from './Bell.tsx';
import { NoticeList } from './NoticeList.tsx';
import { LanguageRoot } from './primitives/language.tsx';

const row = (over: Partial<NoticeRow> = {}): NoticeRow => ({
  key: 'sync|error|503', kind: 'sync', tone: 'err', icon: 'sync', kindLabel: '同期', title: '同期エラー', detail: 'サーバが 503 を返しました', when: null, unread: true,
  action: { label: '同期の設定を開く', send: { type: 'nav.go', to: { name: 'settings', at: 'sync' } } }, ...over,
});
const rows: NoticeRow[] = [
  row({ key: 'config|unsent|2', kind: 'config', tone: 'warn', icon: 'settings', kindLabel: '設定の同期', title: '送らなかった項目 2 件', detail: '秘密らしい文字列があった項目', when: '昨日', action: { label: '送らなかった項目を開く', send: { type: 'nav.go', to: { name: 'settings', at: 'unsent' } } } }),
  row(),
  row({ key: 'compat|2.4.2|1 change', kind: 'compat', tone: 'warn', icon: 'link', kindLabel: '互換性', title: '変更点あり', detail: 'Claude Code 2.4.2：変更点 1 件', when: '12 分前', unread: false, action: { label: '詳細を開く', send: { type: 'nav.go', to: { name: 'settings' } } } }),
];
const props = (over: Partial<NoticesProps> = {}): NoticesProps => ({ rows, unread: 2, keys: rows.map((r) => r.key), label: '注意、未読 2 件', ...over });
const mount = (p: NoticesProps = props(), onAction = vi.fn()) => {
  render(<LanguageRoot language="ja"><ActionRoot onAction={onAction}><Bell {...p} /><button type="button">ほかのボタン</button></ActionRoot></LanguageRoot>);
  return { onAction, bell: screen.getByRole('button', { name: p.label }) };
};

describe('Bell：ヘッダーの注意', () => {
  it('ボタンで、名前に未読の数を持ち、数の札は未読の数を出す。印は三角で、数は注意の色', () => {
    const { bell } = mount();
    expect(bell.tagName).toBe('BUTTON');
    expect(bell).toHaveAttribute('type', 'button');
    expect(bell).toHaveAttribute('aria-haspopup', 'dialog');
    expect(bell).toHaveAttribute('aria-expanded', 'false');
    expect(bell.querySelector('.bell-n')).toHaveTextContent('2');
    expect(bell).toHaveAttribute('data-tone', 'warn');
    expect(bell.querySelector('.icon')).toHaveAttribute('data-icon', 'warning');
  });
  it('未読が 0 なら数の札を出さない', () => {
    const { bell } = mount(props({ unread: 0, label: '注意' }));
    expect(bell.querySelector('.bell-n')).toBeNull();
  });
  it('押すと知らせの一覧が開き、焦点が一覧へ入る。閉じている間は一覧を描かない', () => {
    const { bell } = mount();
    expect(screen.queryByRole('dialog')).toBeNull();
    fireEvent.click(bell);
    const dialog = screen.getByRole('dialog', { name: '注意' });
    expect(dialog.querySelector('.pop-h')).toHaveTextContent('画面のほかの箇所に表示されていない項目');
    expect(bell).toHaveAttribute('aria-expanded', 'true');
    expect(dialog).toHaveFocus();
    expect(within(dialog).getAllByRole('listitem')).toHaveLength(3);
  });
  it('Esc で閉じて、焦点をベルへ戻す', () => {
    const { bell } = mount();
    fireEvent.click(bell);
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(bell).toHaveFocus();
  });
  it('開いたままにしても、勝手に既読にはしない', () => {
    const { bell, onAction } = mount();
    fireEvent.click(bell);
    expect(onAction).not.toHaveBeenCalled();
  });
  it('「すべて既読にする」は、いまある鍵を全部送る（既読の行の鍵も含めてよい）', () => {
    const { bell, onAction } = mount();
    fireEvent.click(bell);
    fireEvent.click(screen.getByRole('button', { name: 'すべて既読にする' }));
    expect(onAction).toHaveBeenCalledWith({ type: 'notices.read', keys: ['config|unsent|2', 'sync|error|503', 'compat|2.4.2|1 change'] });
  });
  it('未読が無ければ「すべて既読にする」は押せない', () => {
    const { bell } = mount(props({ unread: 0, label: '注意', rows: rows.map((r) => ({ ...r, unread: false })) }));
    fireEvent.click(bell);
    expect(screen.getByRole('button', { name: 'すべて既読にする' })).toBeDisabled();
  });
  it('行の操作は、行を既読にして、行き先へ移り、一覧を閉じる', () => {
    const { bell, onAction } = mount();
    fireEvent.click(bell);
    fireEvent.click(screen.getByRole('button', { name: '同期の設定を開く' }));
    expect(onAction.mock.calls.map((c) => c[0])).toEqual([
      { type: 'notices.read', keys: ['sync|error|503'] },
      { type: 'nav.go', to: { name: 'settings', at: 'sync' } },
    ]);
    expect(screen.queryByRole('dialog')).toBeNull();
  });
  it('既読の行を開いても、もう一度既読にはしない', () => {
    const { bell, onAction } = mount();
    fireEvent.click(bell);
    fireEvent.click(screen.getByRole('button', { name: '詳細を開く' }));
    expect(onAction.mock.calls.map((c) => c[0])).toEqual([{ type: 'nav.go', to: { name: 'settings' } }]);
  });
  it('中身が 1 件も無いときは、注意そのものを描かない', () => {
    const { container } = render(<LanguageRoot language="ja"><ActionRoot onAction={vi.fn()}><Bell {...props({ rows: [], keys: [], unread: 0, label: '注意' })} /></ActionRoot></LanguageRoot>);
    expect(container.querySelector('.bell')).toBeNull();
    expect(screen.queryByRole('button', { name: '注意' })).toBeNull();
  });
  it('English では見出しとボタンを英語で出す', () => {
    render(<LanguageRoot language="en"><ActionRoot onAction={vi.fn()}><Bell {...props({ label: 'Attention, 2 unread' })} /></ActionRoot></LanguageRoot>);
    fireEvent.click(screen.getByRole('button', { name: 'Attention, 2 unread' }));
    expect(screen.getByRole('dialog', { name: 'Attention' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Mark all as read' })).toBeInTheDocument();
  });
});

describe('NoticeList：知らせの行', () => {
  it('種類、題、説明、時を並べ、色の意味を data-tone に持つ', () => {
    render(<LanguageRoot language="ja"><ActionRoot onAction={vi.fn()}><NoticeList rows={rows} onAct={vi.fn()} /></ActionRoot></LanguageRoot>);
    const items = screen.getAllByRole('listitem');
    expect(items.map((li) => li.querySelector('.n-kind')!.getAttribute('data-tone'))).toEqual(['warn', 'err', 'warn']);
    expect(items[0]).toHaveTextContent('設定の同期');
    expect(items[0]).toHaveTextContent('送らなかった項目 2 件');
    expect(items[0]).toHaveTextContent('秘密らしい文字列があった項目');
    expect(items[0]!.querySelector('.p-when')).toHaveTextContent('昨日');
    // 時が無い行は、時の欄を作らない。
    expect(items[1]!.querySelector('.p-when')).toBeNull();
  });
  it('未読の行にだけ印を付け、読み上げには「未読」を足す', () => {
    render(<LanguageRoot language="ja"><ActionRoot onAction={vi.fn()}><NoticeList rows={rows} onAct={vi.fn()} /></ActionRoot></LanguageRoot>);
    const items = screen.getAllByRole('listitem');
    expect(items.map((li) => li.hasAttribute('data-unread'))).toEqual([true, true, false]);
    expect(items.map((li) => within(li).queryByText('未読') !== null)).toEqual([true, true, false]);
  });
  it('説明の無い行は、説明の欄を作らない', () => {
    render(<LanguageRoot language="ja"><ActionRoot onAction={vi.fn()}><NoticeList rows={[row({ detail: null })]} onAct={vi.fn()} /></ActionRoot></LanguageRoot>);
    expect(document.querySelector('.p-d')).toBeNull();
  });
});
