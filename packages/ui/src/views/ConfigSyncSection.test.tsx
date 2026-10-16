import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { ConfigSyncDto, UiAction } from '@agent-hangar/shared';
import { ActionRoot } from '../action/chain.tsx';
import { presentConfigSection, type ConfigSyncSectionProps } from '../presenters/configSync.ts';
import { EMPTY_CONFIG_DETAIL, initialStore, type ConfigDetail } from '../store/store.ts';
import { ConfigSyncSection } from './ConfigSyncSection.tsx';

const NOW = Date.parse('2026-10-10T12:00:00+09:00');
const dto = (over: Partial<ConfigSyncDto> = {}): ConfigSyncDto => ({ enabled: true, workerPending: false, approval: 'each', incoming: 0, conflicts: 0, held: 0, unsent: 0, backups: 0, applyOrder: null, lastSentAt: null, ...over });
const propsOf = (c: ConfigSyncDto | null, detail: Partial<ConfigDetail> = {}, desktop = true, focusUnsent = false): ConfigSyncSectionProps =>
  presentConfigSection({ ...initialStore(), configSync: c, configDetail: { ...EMPTY_CONFIG_DETAIL, ...detail }, desktop }, NOW, focusUnsent);
const ui = (cfg: ConfigSyncSectionProps, onAction: (i: UiAction) => void = () => {}, cloudOff = false) => <ActionRoot onAction={onAction}><ConfigSyncSection cfg={cfg} cloudOff={cloudOff} /></ActionRoot>;
const sw = () => screen.getByRole('switch', { name: 'この PC で有効にする' });

describe('Claude Code の設定の同期の節', () => {
  it('クラウドに参加していなければ、スイッチは押せず、他の行は出さない', () => {
    render(ui(propsOf(null), () => {}, true));
    expect(sw()).toBeDisabled();
    expect(screen.getByText('クラウド同期を開始すると使えます')).toBeInTheDocument();
    expect(screen.queryByText('受信した変更')).toBeNull();
  });
  it('切のスイッチを入れるときは、送る一覧のダイアログを開く（承諾するまで入れない）。入っているものを切るのはその場で保存する', () => {
    const onAction = vi.fn();
    const { rerender } = render(ui(propsOf(dto({ enabled: false })), onAction));
    expect(screen.queryByText('受信した変更')).toBeNull();
    fireEvent.click(sw());
    expect(onAction).toHaveBeenCalledWith({ type: 'configSync.open', part: 'send' });
    expect(onAction).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'settings.update' }));
    rerender(ui(propsOf(dto()), onAction));
    fireEvent.click(sw());
    expect(onAction).toHaveBeenCalledWith({ type: 'settings.update', patch: { configBundleSync: false } });
  });
  it('入っているとき、最後に送った時刻と「送るものを表示」を出し、Worker の更新待ちを注意の帯で言う', () => {
    const onAction = vi.fn();
    render(ui(propsOf(dto({ lastSentAt: NOW - 120_000, workerPending: true })), onAction));
    expect(screen.getByText(/最終送信: 2 分前/)).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('Worker の更新待ち');
    expect(screen.getByRole('status')).toHaveTextContent('リポジトリを clone して npm install したディレクトリから npm run hangar -- setup cloud');
    fireEvent.click(screen.getByRole('button', { name: '送信する項目を表示' }));
    expect(onAction).toHaveBeenCalledWith({ type: 'configSync.open', part: 'send' });
  });
  it('Worker の更新待ちでなければ帯は出さず、切のときも出さない', () => {
    const { rerender } = render(ui(propsOf(dto())));
    expect(screen.queryByRole('status')).toBeNull();
    rerender(ui(propsOf(dto({ enabled: false, workerPending: true }))));
    expect(screen.queryByRole('status')).toBeNull();
  });
  it('受信した変更、承諾待ち、競合は、押すとそれぞれのダイアログを開く。0 件のものは押せない', () => {
    const onAction = vi.fn();
    const inbox = { items: [{ id: 'a', kind: 'skills' as const, label: 'skills/a/SKILL.md', op: 'create' as const, fromDeviceId: 'x', fromDevice: 'Studio', size: 1, marks: [], head: '', held: null, needsApproval: true }], approval: 'each' as const };
    render(ui(propsOf(dto({ incoming: 1, conflicts: 2 }), { inbox }), onAction));
    expect(screen.getByText('1 件、Studio から')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '適用内容を確認' }));
    fireEvent.click(screen.getByRole('button', { name: '選択して承認…' }));
    fireEvent.click(screen.getByRole('button', { name: '差分を表示' }));
    expect(onAction.mock.calls.map((c) => (c[0] as { part?: string }).part)).toEqual(['review', 'approve', 'conflicts']);
    expect(screen.getByText('競合 2 件')).toBeInTheDocument();
  });
  it('何も届いていないとき、確認の入口は押せない', () => {
    render(ui(propsOf(dto())));
    expect(screen.getAllByText('ありません', { selector: '.set-row-d' })).toHaveLength(2);
    expect(screen.getByRole('button', { name: '適用内容を確認' })).toBeDisabled();
    expect(screen.getByRole('button', { name: '差分を表示' })).toBeDisabled();
    expect(screen.queryByRole('button', { name: '選択して承認…' })).toBeNull();
  });
  it('自動で適用に切り替えるときは、注意の文と、キャンセル、自動にする、を出し、押すまで保存しない', () => {
    const onAction = vi.fn();
    render(ui(propsOf(dto()), onAction));
    const seg = screen.getByRole('radiogroup', { name: '受信したスキル、コマンド、エージェント' });
    expect(within(seg).getByRole('radio', { name: '毎回承認する' })).toHaveAttribute('aria-checked', 'true');
    fireEvent.click(within(seg).getByRole('radio', { name: '自動で適用' }));
    const strip = screen.getByRole('group', { name: '自動で適用にする前の確認' });
    expect(strip).toHaveTextContent('乗っ取られたとき');
    expect(onAction).not.toHaveBeenCalled();
    // やめれば帯が消え、何も保存しない。
    fireEvent.click(within(strip).getByRole('button', { name: 'キャンセル' }));
    expect(screen.queryByRole('group', { name: '自動で適用にする前の確認' })).toBeNull();
    expect(onAction).not.toHaveBeenCalled();
    fireEvent.click(within(seg).getByRole('radio', { name: '自動で適用' }));
    fireEvent.click(within(screen.getByRole('group', { name: '自動で適用にする前の確認' })).getByRole('button', { name: '自動にする' }));
    expect(onAction).toHaveBeenCalledWith({ type: 'settings.update', patch: { configApproval: 'auto' } });
  });
  it('自動のときは承諾待ちの行を出さず、毎回に戻すのは注意なしにその場で保存する', () => {
    const onAction = vi.fn();
    render(ui(propsOf(dto({ approval: 'auto' })), onAction));
    expect(screen.getByText(/自動で適用する設定です/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('radio', { name: '毎回承認する' }));
    expect(onAction).toHaveBeenCalledWith({ type: 'settings.update', patch: { configApproval: 'each' } });
  });
  it('送らなかった項目は、0 件でも行を残し、開くと理由と「それでも送信」を出す', () => {
    const onAction = vi.fn();
    const { rerender } = render(ui(propsOf(dto()), onAction));
    expect(screen.getByText('送信しなかった項目 0 件')).toBeInTheDocument();
    const rowBtn = () => within(screen.getByText(/^送信しなかった項目 \d+ 件$/).closest('.set-row') as HTMLElement).getByRole('button');
    expect(rowBtn()).toBeDisabled();
    const unsent = { items: [{ id: 'secret:x', kind: 'secret' as const, itemId: 'file:x', label: 'skills/x/SKILL.md', reason: 'secret:ghp_', allowed: false }] };
    rerender(ui(propsOf(dto({ unsent: 1 }), { unsent }), onAction));
    expect(screen.queryByText('skills/x/SKILL.md')).toBeNull();
    fireEvent.click(rowBtn());
    expect(screen.getByText('skills/x/SKILL.md')).toBeInTheDocument();
    expect(screen.getByText('シークレットと思われる文字列（ghp_ 形式）')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'skills/x/SKILL.md をそれでも送信' }));
    expect(onAction).toHaveBeenCalledWith({ type: 'configSync.unsent.send', id: 'secret:x' });
  });
  it('ベルの行から来たとき（at=unsent）は、送らなかった項目の行を開いた状態で出す。印が無ければ畳んだまま', () => {
    const unsent = { items: [{ id: 'secret:x', kind: 'secret' as const, itemId: 'file:x', label: 'skills/x/SKILL.md', reason: 'secret:ghp_', allowed: false }] };
    const { rerender } = render(ui(propsOf(dto({ unsent: 1 }), { unsent })));
    expect(screen.queryByText('skills/x/SKILL.md')).toBeNull();
    rerender(ui(propsOf(dto({ unsent: 1 }), { unsent }, true, true)));
    expect(screen.getByText('skills/x/SKILL.md')).toBeInTheDocument();
    expect(screen.getByText(/^送信しなかった項目 1 件$/).closest('.set-row')).toHaveAttribute('id', 'settings-config-unsent');
  });
  it('バックアップの世代は、殻があれば戻すボタンを、無ければターミナルのコマンドを出す', () => {
    const onAction = vi.fn();
    const backups = { generations: [{ name: '20261010-110000', at: NOW - 3_600_000, files: 3 }] };
    const rowBtn = () => within(screen.getByText(/^バックアップ \d+ 世代$/).closest('.set-row') as HTMLElement).getByRole('button');
    const { unmount } = render(ui(propsOf(dto({ backups: 1 }), { backups }, true), onAction));
    fireEvent.click(rowBtn());
    fireEvent.click(screen.getByRole('button', { name: /の世代に戻す$/ }));
    expect(onAction).toHaveBeenCalledWith({ type: 'configSync.restore', name: '20261010-110000' });
    unmount();
    render(ui(propsOf(dto({ backups: 1 }), { backups }, false), onAction));
    fireEvent.click(rowBtn());
    expect(screen.queryByRole('button', { name: /の世代に戻す$/ })).toBeNull();
    expect(screen.getByText('hangar config restore 20261010-110000')).toBeInTheDocument();
  });
  it('適用の待ち（指示書）は、殻があれば適用と取り消し、無ければコマンドと取り消しを出す', () => {
    const onAction = vi.fn();
    const order = dto({ applyOrder: { count: 5, createdAt: NOW - 60_000 } });
    const { unmount } = render(ui(propsOf(order, {}, true), onAction));
    expect(screen.getByText(/承認した 5 項目の適用内容を/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '適用…' }));
    fireEvent.click(screen.getByRole('button', { name: '取り消す' }));
    expect(onAction.mock.calls.map((c) => (c[0] as UiAction).type)).toEqual(['configSync.order.apply', 'configSync.order.cancel']);
    unmount();
    render(ui(propsOf(order, {}, false), onAction));
    expect(screen.queryByRole('button', { name: '適用…' })).toBeNull();
    expect(screen.getByText('hangar config apply')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '取り消す' })).toBeInTheDocument();
  });
});
