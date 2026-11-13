import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { ConfigHistoryDto, ConfigSyncDto, SettingsDto, UiAction } from '@agent-hangar/shared';
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
  it('切のスイッチを入れるときは、送る一覧のダイアログを開く（承認するまで入れない）。入っているものを切るのはその場で保存する', () => {
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
    expect(screen.getByRole('status')).toHaveTextContent('setup した PC で npm run hangar -- setup cloud');
    fireEvent.click(screen.getByRole('button', { name: '送信する項目を表示' }));
    expect(onAction).toHaveBeenCalledWith({ type: 'configSync.open', part: 'send' });
  });
  it('Worker の更新待ちでなければ帯は出さず、切のときも出さない', () => {
    const { rerender } = render(ui(propsOf(dto())));
    expect(screen.queryByRole('status')).toBeNull();
    rerender(ui(propsOf(dto({ enabled: false, workerPending: true }))));
    expect(screen.queryByRole('status')).toBeNull();
  });
  it('受信した変更は、押すと適用内容の確認のダイアログを開く。0 件のものは押せない', () => {
    const onAction = vi.fn();
    const { unmount } = render(ui(propsOf(dto()), onAction));
    expect(screen.getByRole('button', { name: '適用内容を確認' })).toBeDisabled();
    unmount();
    render(ui(propsOf(dto({ incoming: 1 })), onAction));
    fireEvent.click(screen.getByRole('button', { name: '適用内容を確認' }));
    expect(onAction.mock.calls.map((c) => (c[0] as { part?: string }).part)).toEqual(['review']);
  });
  it('送らなかった項目は、0 件でも行を残し、開くと理由と「それでも送信」を出す', () => {
    const onAction = vi.fn();
    const { rerender } = render(ui(propsOf(dto()), onAction));
    expect(screen.getByText('送信しなかった項目 0 件')).toBeInTheDocument();
    const rowBtn = () => within(screen.getByText(/^送信しなかった項目 \d+ 件$/).closest('.set-row') as HTMLElement).getByRole('button', { name: /^(表示|折りたたむ)$/ });
    expect(rowBtn()).toBeDisabled();
    const unsent = { items: [{ id: 'secret:x', kind: 'secret' as const, itemId: 'file:x', label: 'skills/x/SKILL.md', reason: 'secret:ghp_', allowed: false }] };
    rerender(ui(propsOf(dto({ unsent: 1 }), { unsent }), onAction));
    expect(screen.queryByText('skills/x/SKILL.md')).toBeNull();
    fireEvent.click(rowBtn());
    expect(screen.getByText('skills/x/SKILL.md')).toBeInTheDocument();
    expect(screen.getByText('シークレットと思われる文字列（ghp_ 形式）')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'skills/x/SKILL.md をそれでも送信' }));
    // U0 の 3a：行の下で確かめてから送る。
    expect(onAction).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'configSync.unsent.send' }));
    fireEvent.click(within(screen.getByRole('group', { name: 'シークレットと思われる値を送信します' })).getByRole('button', { name: '送信' }));
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
    expect(onAction).toHaveBeenCalledWith({ type: 'configSync.restore', name: '20261010-110000', target: 'claude' });
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

  describe('種類ごとの行（C 性質ごと）', () => {
    const kindsProps = (kinds: Partial<Record<string, string>> = {}, c: ConfigSyncDto = dto()) =>
      presentConfigSection({ ...initialStore(), configSync: c, settings: { configKinds: kinds } as unknown as SettingsDto, configDetail: EMPTY_CONFIG_DETAIL, desktop: true, canRestoreHistory: true }, NOW);
    const row = (name: string) => within(screen.getByRole('group', { name }));
    it('会話の本文は切と自動の 2 つだけ。変えると、その鍵だけを保存する', () => {
      const onAction = vi.fn();
      render(ui(kindsProps(), onAction));
      const g = row('トランスクリプト');
      expect(g.queryByRole('button', { name: '確認' })).toBeNull();
      fireEvent.click(g.getByRole('button', { name: '切' }));
      expect(onAction).toHaveBeenCalledWith({ type: 'settings.update', patch: { configKinds: { transcript: 'off' } } });
    });
    it('指示・スキルなどの種類は、その場で保存する（帯は出さない）', () => {
      const onAction = vi.fn();
      render(ui(kindsProps(), onAction));
      fireEvent.click(row('スキル').getByRole('button', { name: '確認' }));
      expect(onAction).toHaveBeenCalledWith({ type: 'settings.update', patch: { configKinds: { skills: 'confirm' } } });
      expect(screen.queryByRole('group', { name: '自動にする' })).toBeNull();
    });
    it('自動で走るコードを自動にするときだけ、行の下に帯を開き、「自動にする」を押すまで保存しない', () => {
      const onAction = vi.fn();
      render(ui(kindsProps(), onAction));
      fireEvent.click(row('Claude のフック').getByRole('button', { name: '自動' }));
      const strip = screen.getByRole('group', { name: '自動にする' });
      expect(strip).toHaveTextContent('Claude のフック');
      expect(onAction).not.toHaveBeenCalled();
      fireEvent.click(within(strip).getByRole('button', { name: 'キャンセル' }));
      expect(onAction).not.toHaveBeenCalled();
      fireEvent.click(row('Claude のフック').getByRole('button', { name: '自動' }));
      fireEvent.click(within(screen.getByRole('group', { name: '自動にする' })).getByRole('button', { name: '自動にする' }));
      expect(onAction).toHaveBeenCalledWith({ type: 'settings.update', patch: { configKinds: { 'claude-hooks': 'auto' } } });
    });
    it('自動で走るコードを確認や切に替えるときは、帯なしですぐ保存する', () => {
      const onAction = vi.fn();
      render(ui(kindsProps({ 'claude-hooks': 'auto' }), onAction));
      fireEvent.click(row('Claude のフック').getByRole('button', { name: '切' }));
      expect(screen.queryByRole('group', { name: '自動にする' })).toBeNull();
      expect(onAction).toHaveBeenCalledWith({ type: 'settings.update', patch: { configKinds: { 'claude-hooks': 'off' } } });
    });
    it('束の見出しの切り替えで、束の中の鍵をまとめて替える。自動で走るコードの束を自動にするときは帯を挟む', () => {
      const onAction = vi.fn();
      render(ui(kindsProps(), onAction));
      fireEvent.click(row('設定').getByRole('button', { name: '切' }));
      expect(onAction).toHaveBeenCalledWith({ type: 'settings.update', patch: { configKinds: { settings: 'off', keybindings: 'off', 'hangar-pref': 'off' } } });
      onAction.mockClear();
      fireEvent.click(row('自動で走るコード').getByRole('button', { name: '自動' }));
      expect(onAction).not.toHaveBeenCalled();
      fireEvent.click(within(screen.getByRole('group', { name: '自動にする' })).getByRole('button', { name: '自動にする' }));
      expect(onAction).toHaveBeenCalledWith({ type: 'settings.update', patch: { configKinds: { 'claude-mcp': 'auto', 'claude-hooks': 'auto', 'claude-statusline': 'auto', plugins: 'auto' } } });
    });
    it('リンクで外した件数を行にチップで出し、押すと名前が開く', () => {
      render(ui(kindsProps({}, dto({ linkSkipped: { skills: ['skills/benkyo'] } }))));
      expect(screen.queryByText('skills/benkyo')).toBeNull();
      fireEvent.click(screen.getByRole('button', { name: 'リンクのため同期しない 1 件' }));
      expect(screen.getByText('skills/benkyo')).toBeInTheDocument();
    });
  });

  describe('届いたもの', () => {
    const batch = (): ConfigHistoryDto => ({
      id: 7, at: NOW - 60_000, mode: 'auto', fromDeviceId: 'm', fromDevice: 'MacBook', generations: [], undone: ['file:skills/b'], seen: false,
      items: [
        { id: 'file:skills/a', kind: 'skills', label: 'skills/a', op: 'create', restorable: true },
        { id: 'file:skills/b', kind: 'skills', label: 'skills/b', op: 'overwrite', restorable: true },
        { id: 'file:CLAUDE.md', kind: 'claude-md', label: 'CLAUDE.md', op: 'overwrite', restorable: false },
      ],
    });
    const inboxProps = (canRestoreHistory: boolean) => presentConfigSection({ ...initialStore(), configSync: dto({ autoUnseen: 1, history: [batch()] }), configDetail: EMPTY_CONFIG_DETAIL, desktop: true, canRestoreHistory }, NOW);
    it('履歴を開くと既読の口を呼ぶ。開いていない間は呼ばない', () => {
      const onAction = vi.fn();
      render(ui(inboxProps(true), onAction));
      expect(onAction).not.toHaveBeenCalled();
      fireEvent.click(screen.getByRole('button', { name: /MacBook/ }));
      expect(onAction).toHaveBeenCalledWith({ type: 'configSync.history.seen' });
    });
    it('まとめて戻すと 1 項目ずつの戻しを出す。戻したものと restorable が偽の項目には 1 項目の戻しを出さない', () => {
      const onAction = vi.fn();
      render(ui(inboxProps(true), onAction));
      fireEvent.click(screen.getByRole('button', { name: /MacBook/ }));
      fireEvent.click(screen.getByRole('button', { name: 'skills/a を戻す' }));
      expect(onAction).toHaveBeenCalledWith({ type: 'configSync.history.restore', history: 7, item: 'file:skills/a' });
      expect(screen.queryByRole('button', { name: 'skills/b を戻す' })).toBeNull();
      expect(screen.queryByRole('button', { name: 'CLAUDE.md を戻す' })).toBeNull();
      fireEvent.click(screen.getByRole('button', { name: 'まとめて戻す' }));
      expect(onAction).toHaveBeenCalledWith({ type: 'configSync.history.restore', history: 7 });
    });
    it('殻が履歴の戻しを持たないときは、戻す入口を出さない', () => {
      render(ui(inboxProps(false)));
      fireEvent.click(screen.getByRole('button', { name: /MacBook/ }));
      expect(screen.queryByRole('button', { name: 'まとめて戻す' })).toBeNull();
      expect(screen.queryByRole('button', { name: /を戻す$/ })).toBeNull();
    });
    it('自動の適用の失敗があれば、その行を出す', () => {
      render(ui(presentConfigSection({ ...initialStore(), configSync: dto({ lastAutoError: { at: NOW - 5000, message: 'EACCES' } }), configDetail: EMPTY_CONFIG_DETAIL, desktop: true }, NOW)));
      expect(screen.getByText(/EACCES/)).toBeInTheDocument();
    });
  });
});
