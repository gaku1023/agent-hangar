import { fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ConfigInboxItemDto, ConfigSyncDto, ConfigUnsentItemDto, SettingsDto, UiAction } from '@agent-hangar/shared';
import { ActionRoot } from '../action/chain.tsx';
import { initialState } from '../mediator/transition.ts';
import { presentConfigDialog, presentConfigSection } from '../presenters/configSync.ts';
import { EMPTY_CONFIG_DETAIL, initialStore, type ConfigDetail, type Store } from '../store/store.ts';
import { ConfigSyncDialog } from './ConfigSyncDialog.tsx';
import { ConfigSyncSection } from './ConfigSyncSection.tsx';

const NOW = Date.parse('2026-10-27T12:00:00+09:00');
const dto = (over: Partial<ConfigSyncDto> & Record<string, unknown> = {}): ConfigSyncDto => ({ enabled: true, workerPending: false, approval: 'each', incoming: 0, conflicts: 0, held: 0, unsent: 0, backups: 0, applyOrder: null, lastSentAt: null, ...over });
const storeOf = (c: ConfigSyncDto | null, settings: Record<string, unknown> = {}, detail: Partial<ConfigDetail> = {}): Store => ({ ...initialStore(), configSync: c, settings: settings as unknown as SettingsDto, configDetail: { ...EMPTY_CONFIG_DETAIL, ...detail }, desktop: true });
const section = (store: Store, onAction: (i: UiAction) => void = () => {}) => <ActionRoot onAction={onAction}><ConfigSyncSection cfg={presentConfigSection(store, NOW)} cloudOff={false} /></ActionRoot>;
const uns = (id: string, kind: ConfigUnsentItemDto['kind'], reason: string): ConfigUnsentItemDto => ({ id, kind, itemId: id, label: id, reason, allowed: false });

afterEach(() => { try { localStorage.clear(); } catch { /* 無い環境 */ } });

describe('対象ごとの入切（1A、1a、1α、2A、2a）', () => {
  it('親が入っていれば対象の行を並べ、切なら出さない', () => {
    const { rerender } = render(section(storeOf(dto(), { configTargets: { hangar: true } })));
    expect(screen.getByText('同期する対象')).toBeInTheDocument();
    expect(screen.getByRole('switch', { name: 'Hangar の設定' })).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByRole('switch', { name: 'hooks と statusLine' })).toHaveAttribute('aria-checked', 'false');
    expect(screen.queryByRole('switch', { name: 'Codex' })).toBeNull();
    rerender(section(storeOf(dto({ enabled: false }), { configTargets: { hangar: true } })));
    expect(screen.queryByText('同期する対象')).toBeNull();
  });
  it('行のスイッチは configTargets 全体を、その対象だけ替えて保存する', () => {
    const onAction = vi.fn();
    render(section(storeOf(dto(), { configTargets: { hangar: true } }), onAction));
    fireEvent.click(screen.getByRole('switch', { name: 'plugins' }));
    expect(onAction).toHaveBeenCalledWith({ type: 'settings.update', patch: { configTargets: { hangar: true, 'claude-plugins': true } } });
    fireEvent.click(screen.getByRole('switch', { name: 'Hangar の設定' }));
    expect(onAction).toHaveBeenCalledWith({ type: 'settings.update', patch: { configTargets: { hangar: false } } });
  });
  it('Git で管理された入れ物の対象は、名前の横に札を出し、有効にする前に行の下で確かめる', () => {
    const onAction = vi.fn();
    render(section(storeOf(dto({ vcs: [{ target: 'claude', tools: ['git'] }] }), { configTargets: { hangar: false } }), onAction));
    expect(screen.getAllByText('Git で管理').length).toBe(3);
    fireEvent.click(screen.getByRole('switch', { name: 'hooks と statusLine' }));
    expect(onAction).not.toHaveBeenCalled();
    const strip = screen.getByRole('group', { name: 'Git の管理と重なります' });
    expect(strip).toHaveTextContent('~/.claude は Git で管理されています。同期を有効にすると');
    fireEvent.click(within(strip).getByRole('button', { name: '有効にする' }));
    expect(onAction).toHaveBeenCalledWith({ type: 'settings.update', patch: { configTargets: { hangar: false, 'claude-hooks': true } } });
  });
  it('確かめの帯のキャンセルは何も保存しない', () => {
    const onAction = vi.fn();
    render(section(storeOf(dto({ vcs: [{ target: 'claude', tools: ['git'] }] }), { configTargets: { hangar: false } }), onAction));
    fireEvent.click(screen.getByRole('switch', { name: 'plugins' }));
    fireEvent.click(within(screen.getByRole('group', { name: 'Git の管理と重なります' })).getByRole('button', { name: 'キャンセル' }));
    expect(onAction).not.toHaveBeenCalled();
  });
  it('まだどれも選んでいなければ増えた知らせを出し、すべて有効にするは Git で管理されていないものだけを入れる', () => {
    const onAction = vi.fn();
    render(section(storeOf(dto({ vcs: [{ target: 'claude', tools: ['git'] }] })), onAction));
    expect(screen.getAllByText('新').length).toBe(5);
    expect(screen.getByText('同期できる対象が増えました')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'すべて有効にする' }));
    expect(onAction).toHaveBeenCalledWith({ type: 'settings.update', patch: { configTargets: { 'claude-mcp': true, hangar: true } } });
  });
  it('あとでを押すと知らせを畳む', () => {
    render(section(storeOf(dto())));
    fireEvent.click(screen.getByRole('button', { name: 'あとで' }));
    expect(screen.queryByText('同期できる対象が増えました')).toBeNull();
  });
  it('opencode の json と jsonc の併存を行に添える', () => {
    render(section(storeOf(dto({ notices: [{ target: 'opencode', code: 'both-json-jsonc' }] }), { opencodeEnabled: true, configTargets: {} })));
    expect(screen.getByText(/opencode.json と opencode.jsonc が両方あります/)).toBeInTheDocument();
  });
});

describe('送らなかった項目（3A、3a）', () => {
  const items = [uns('u1', 'secret', 'secret:aws-key'), uns('u2', 'unknown-key', 'unknown-key')];
  it('理由ごとの群で見せ、それでも送るは行の下で確かめてから送る', () => {
    const onAction = vi.fn();
    render(section(storeOf(dto({ unsent: 1, unknownKeyCount: 1 }), { configTargets: { hangar: false } }, { unsent: { items } }), onAction));
    expect(screen.getByText('送信しなかった項目 1 件')).toBeInTheDocument();
    fireEvent.click(screen.getAllByRole('button', { name: '表示' })[0]!);
    expect(screen.getByText('シークレットと思われる値を含む項目')).toBeInTheDocument();
    expect(screen.getByText('不明なキー')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'u1 をそれでも送信' }));
    expect(onAction).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'configSync.unsent.send' }));
    const strip = screen.getByRole('group', { name: 'シークレットと思われる値を送信します' });
    fireEvent.click(within(strip).getByRole('button', { name: '送信' }));
    expect(onAction).toHaveBeenCalledWith({ type: 'configSync.unsent.send', id: 'u1' });
  });
});

describe('バックアップの世代に対象名', () => {
  it('世代の行の頭に対象の名前を出す', () => {
    render(section(storeOf(dto({ backups: 1 }), { configTargets: { hangar: false } }, { backups: { generations: [{ name: 'g2', at: null, files: 2, target: 'codex' }] } })));
    fireEvent.click(screen.getAllByRole('button', { name: '表示' }).at(-1)!);
    expect(screen.getByText('Codex')).toBeInTheDocument();
  });
});

describe('適用内容の確認の対象の札（4B）', () => {
  const inb = (id: string, kind: ConfigInboxItemDto['kind'], op: ConfigInboxItemDto['op'], over: Partial<ConfigInboxItemDto> & Record<string, unknown> = {}): ConfigInboxItemDto => ({ id, kind, label: id, op, fromDeviceId: 'd', fromDevice: 'Studio', size: 1, marks: [], head: '', held: null, needsApproval: false, ...over });
  const items = [inb('settings:model', 'settings', 'overwrite'), inb('codex:toml:model', 'codex-config', 'overwrite'), inb('opencode:mcp:x', 'opencode-mcp', 'create', { missingEnv: ['API_KEY'] })];
  const show = (onAction: (i: UiAction) => void = () => {}) => {
    const st = { ...initialState(), overlay: { kind: 'configSync' as const, part: 'review' as const, working: false } };
    const p = presentConfigDialog(st, storeOf(dto(), {}, { inbox: { items, approval: 'each' } }))!;
    return render(<ActionRoot onAction={onAction}><ConfigSyncDialog {...p} /></ActionRoot>);
  };
  it('札で絞り込むと、その対象の行だけを見せる。適用するものは絞り込みに依らない', () => {
    const onAction = vi.fn();
    show(onAction);
    const bar = screen.getByRole('group', { name: '対象で絞り込む' });
    expect(within(bar).getAllByRole('button').map((b) => b.textContent)).toEqual(['すべて3', 'Claude Code1', 'Codex1', 'opencode1']);
    fireEvent.click(within(bar).getByRole('button', { name: /^Codex/ }));
    expect(screen.queryByText('settings:model')).toBeNull();
    expect(screen.getByText('codex:toml:model')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '適用…' }));
    expect(onAction).toHaveBeenCalledWith({ type: 'configSync.apply', entries: [{ id: 'settings:model' }, { id: 'codex:toml:model' }, { id: 'opencode:mcp:x' }] });
  });
  it('この PC に無い環境変数を行の下に添える', () => {
    show();
    expect(screen.getByText('この PC に API_KEY がありません')).toBeInTheDocument();
  });
});
