import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { ConfigConflictDto, ConfigInboxItemDto, ConfigOutgoingItemDto, ConfigSyncDto, UiAction } from '@agent-hangar/shared';
import { ActionRoot } from '../action/chain.tsx';
import { initialState } from '../mediator/transition.ts';
import type { State } from '../mediator/types.ts';
import { presentConfigDialog } from '../presenters/configSync.ts';
import { EMPTY_CONFIG_DETAIL, initialStore, type ConfigDetail, type Store } from '../store/store.ts';
import { ConfigSyncDialog } from './ConfigSyncDialog.tsx';

const dto = (over: Partial<ConfigSyncDto> = {}): ConfigSyncDto => ({ enabled: true, workerPending: false, approval: 'each', incoming: 0, conflicts: 0, held: 0, unsent: 0, backups: 0, applyOrder: null, lastSentAt: null, ...over });
const open = (part: 'send' | 'review' | 'approve' | 'conflicts', working = false): State => ({ ...initialState(), overlay: { kind: 'configSync', part, working } });
const store = (detail: Partial<ConfigDetail>, c: ConfigSyncDto = dto(), desktop = true): Store => ({ ...initialStore(), configSync: c, configDetail: { ...EMPTY_CONFIG_DETAIL, ...detail }, desktop });
const show = (state: State, s: Store, onAction: (i: UiAction) => void = () => {}) => {
  const p = presentConfigDialog(state, s);
  if (!p) throw new Error('no dialog');
  return render(<ActionRoot onAction={onAction}><ConfigSyncDialog {...p} /></ActionRoot>);
};
const out = (id: string, kind: ConfigOutgoingItemDto['kind'], label: string, over: Partial<ConfigOutgoingItemDto> = {}): ConfigOutgoingItemDto => ({ id, kind, label, size: 100, marks: [], value: null, ...over });
const inb = (id: string, kind: ConfigInboxItemDto['kind'], label: string, op: ConfigInboxItemDto['op'], over: Partial<ConfigInboxItemDto> = {}): ConfigInboxItemDto => ({ id, kind, label, op, fromDeviceId: 'dev-a', fromDevice: 'Studio', size: 100, marks: [], head: '', held: null, needsApproval: false, ...over });

describe('送る一覧（a1）', () => {
  const outgoing = (items: ConfigOutgoingItemDto[]) => ({ enabled: false, items, droppedKeys: [{ key: 'env', reason: 'execution' as const }], unsentCount: 0, lastSentAt: null });
  it('種類ごとの折りたたみで、見出しに件数、settings.json は鍵と値を出し、承諾すると送る', () => {
    const onAction = vi.fn();
    show(open('send'), store({ outgoing: outgoing([out('settings:model', 'settings', 'model', { value: '"opus"' }), out('file:CLAUDE.md', 'claude-md', 'CLAUDE.md')]) }, dto({ enabled: false })), onAction);
    expect(screen.getByRole('dialog', { name: 'ほかの PC へ送るもの' })).toBeInTheDocument();
    expect(screen.getByText(/次の 2 項目をクラウドへ送ります/)).toBeInTheDocument();
    expect(screen.getByText('"opus"')).toBeInTheDocument();
    expect(screen.getByText('送らないもの')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '2 項目を送る' }));
    expect(onAction).toHaveBeenCalledWith({ type: 'configSync.send.confirm' });
  });
  it('読み込み前は押せず、送るものが無ければ「有効にする」と言う', () => {
    const { unmount } = show(open('send'), store({}, dto({ enabled: false })));
    expect(screen.getByRole('button', { name: '有効にする' })).toBeDisabled();
    unmount();
    show(open('send'), store({ outgoing: outgoing([]) }, dto({ enabled: false })));
    expect(screen.getByRole('button', { name: '有効にする' })).toBeEnabled();
    expect(screen.getByText(/送るものはまだありません/)).toBeInTheDocument();
  });
  it('すでに入っているときは、見るだけで閉じる（承諾の操作を出さない）', () => {
    show(open('send'), store({ outgoing: outgoing([out('file:CLAUDE.md', 'claude-md', 'CLAUDE.md')]) }));
    expect(screen.queryByRole('button', { name: /項目を送る$/ })).toBeNull();
    // 閉じる手は見出しの × と下端の 1 つだけ。
    expect(screen.getAllByRole('button', { name: '閉じる' })).toHaveLength(2);
  });
});

describe('適用内容の確認（b1）', () => {
  const items = [
    inb('file:CLAUDE.md', 'claude-md', 'CLAUDE.md', 'conflict'),
    inb('file:skills/old/SKILL.md', 'skills', 'skills/old/SKILL.md', 'delete'),
    inb('file:skills/a/SKILL.md', 'skills', 'skills/a/SKILL.md', 'overwrite', { needsApproval: true }),
    inb('settings:model', 'settings', 'model', 'create'),
  ];
  it('操作ごとの群を危ない順に並べ、適用…は承諾の要らない項目だけを渡す', () => {
    const onAction = vi.fn();
    show(open('review'), store({ inbox: { items, approval: 'each' } }, dto({ incoming: 3, conflicts: 1 })), onAction);
    const heads = [...document.querySelectorAll('.cfg-grp-t')].map((e) => e.textContent);
    expect(heads).toEqual(['競合', '削除', '上書き', '新規']);
    fireEvent.click(screen.getByRole('button', { name: '適用…' }));
    expect(onAction).toHaveBeenCalledWith({ type: 'configSync.apply', entries: [{ id: 'file:skills/old/SKILL.md' }, { id: 'settings:model' }] });
  });
  it('競合と承諾の入口を出し、押すとそのダイアログを開く', () => {
    const onAction = vi.fn();
    show(open('review'), store({ inbox: { items, approval: 'each' } }), onAction);
    fireEvent.click(screen.getByRole('button', { name: '競合 1 件を選択…' }));
    fireEvent.click(screen.getByRole('button', { name: '承諾が要るもの 1 件を選択…' }));
    expect(onAction.mock.calls.map((c) => (c[0] as { part: string }).part)).toEqual(['conflicts', 'approve']);
  });
  it('適用の最中は、押せず「適用しています…」と出し、ブラウザでは指示書のあとにターミナルで実行すると書く', () => {
    show(open('review', true), store({ inbox: { items, approval: 'each' } }, dto(), false));
    expect(screen.getByRole('button', { name: '適用しています…' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'キャンセル' })).toBeDisabled();
    expect(screen.getByText(/hangar config apply を実行します/)).toBeInTheDocument();
  });
  it('何も無ければ空の言葉を出し、適用…は押せない', () => {
    show(open('review'), store({ inbox: { items: [], approval: 'each' } }));
    expect(screen.getByText('届いている変更はありません')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '適用…' })).toBeDisabled();
  });
});

describe('承諾の表（c2）', () => {
  const hooky = inb('file:skills/h/SKILL.md', 'skills', 'skills/h/SKILL.md', 'create', { needsApproval: true, marks: ['hooks'], size: 90, head: '---\nname: h\nhooks:\n  PreToolUse:\n---\nbody' });
  const plainA = inb('file:commands/a.md', 'commands', 'commands/a.md', 'create', { needsApproval: true, head: '# a' });
  const plainB = inb('file:agents/b.md', 'agents', 'agents/b.md', 'overwrite', { needsApproval: true, head: '# b' });
  const view = (onAction: (i: UiAction) => void = () => {}) => show(open('approve'), store({ inbox: { items: [hooky, plainA, plainB], approval: 'each' } }), onAction);
  const cb = (name: string) => screen.getByRole('checkbox', { name: `${name} を選択` });

  it('「すべて選択」は置かず、印の無い行だけをまとめて選べる', () => {
    view();
    expect(screen.queryByRole('button', { name: /すべて選択/ })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '印の無いものを選択 2' }));
    expect(cb('commands/a.md')).toBeChecked();
    expect(cb('agents/b.md')).toBeChecked();
    expect(cb('skills/h/SKILL.md')).not.toBeChecked();
    expect(screen.getByText('選択 2 件')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '選択を解除' }));
    expect(screen.getByText('選択 0 件')).toBeInTheDocument();
  });
  it('印のある行は、内容を開くまでチェックできず、開くと印の付く行を強調して見せる', () => {
    view();
    expect(cb('skills/h/SKILL.md')).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'skills/h/SKILL.md の内容' }));
    expect(cb('skills/h/SKILL.md')).toBeEnabled();
    const pre = screen.getByLabelText('skills/h/SKILL.md の内容', { selector: 'pre' });
    expect([...pre.querySelectorAll('mark')].map((m) => m.textContent?.trim())).toEqual(['hooks:', 'PreToolUse:']);
    // 閉じても、1 度見た行は選べる。
    fireEvent.click(screen.getByRole('button', { name: 'skills/h/SKILL.md の内容' }));
    expect(cb('skills/h/SKILL.md')).toBeEnabled();
  });
  it('選んだ項目だけを渡して適用し、0 件では押せない', () => {
    const onAction = vi.fn();
    view(onAction);
    expect(screen.getByRole('button', { name: '選んだ 0 件を承諾して適用…' })).toBeDisabled();
    fireEvent.click(cb('commands/a.md'));
    fireEvent.click(screen.getByRole('button', { name: 'skills/h/SKILL.md の内容' }));
    fireEvent.click(cb('skills/h/SKILL.md'));
    fireEvent.click(screen.getByRole('button', { name: '選んだ 2 件を承諾して適用…' }));
    const sent = onAction.mock.calls.map((x) => x[0] as { type: string; entries?: { id: string }[] }).find((x) => x.type === 'configSync.apply');
    expect(sent?.entries?.map((e) => e.id).sort()).toEqual(['file:commands/a.md', 'file:skills/h/SKILL.md']);
  });
  it('「あとで」は何も書かずに閉じる', () => {
    const onAction = vi.fn();
    view(onAction);
    fireEvent.click(screen.getByRole('button', { name: 'あとで' }));
    expect(onAction).toHaveBeenCalledWith({ type: 'overlay.close' });
  });
});

describe('競合の札（d1）', () => {
  const c = (id: string, label: string): ConfigConflictDto => ({ id, kind: 'claude-md', label, marks: [], local: { deviceName: 'MacBook', at: 1, size: 4 }, remote: { deviceName: 'Studio', at: 2, size: 5 }, diff: [{ kind: 'ctx', text: 'a' }, { kind: 'del', text: 'mine' }, { kind: 'add', text: 'theirs' }] });
  it('差分を最初から出し、採る側を選んで、選んだ分を適用する', () => {
    const onAction = vi.fn();
    show(open('conflicts'), store({ conflicts: [c('file:CLAUDE.md', 'CLAUDE.md'), c('settings:model', 'model')] }, dto({ conflicts: 2 })), onAction);
    expect(screen.getAllByText(/theirs/)).toHaveLength(2);
    expect(screen.getByRole('button', { name: '選んだ 0 件を適用…' })).toBeDisabled();
    const cards = document.querySelectorAll('.cfg-card');
    fireEvent.click(within(cards[0] as HTMLElement).getByRole('button', { name: '相手（Studio）を採用' }));
    fireEvent.click(within(cards[1] as HTMLElement).getByRole('button', { name: '自分（この PC）を採用' }));
    expect(within(cards[0] as HTMLElement).getByRole('button', { name: '相手（Studio）を採用' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByText('選択 2 / 2 件')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '選んだ 2 件を適用…' }));
    expect(onAction).toHaveBeenCalledWith({ type: 'configSync.apply', entries: [{ id: 'file:CLAUDE.md', take: 'remote' }, { id: 'settings:model', take: 'mine' }] });
  });
  it('選んだ側をもう一度押すと、選びを外す', () => {
    show(open('conflicts'), store({ conflicts: [c('file:CLAUDE.md', 'CLAUDE.md')] }, dto({ conflicts: 1 })));
    const b = screen.getByRole('button', { name: '自分（この PC）を採用' });
    fireEvent.click(b);
    expect(b).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(b);
    expect(b).toHaveAttribute('aria-pressed', 'false');
  });
});
