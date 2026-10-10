import { fireEvent, render, screen, within } from '@testing-library/react';
import { translator } from '@agent-hangar/shared';
import { describe, expect, it, vi } from 'vitest';
import { ActionRoot } from '../action/chain.tsx';
import { presentHomeBand, type ConfirmCard, type HomeCards, type HomeScreenProps, type ReturnCard } from '../presenters/home.ts';
import type { SessionListProps } from '../presenters/sessions.ts';
import { HomeScreen } from './HomeScreen.tsx';
import { LanguageRoot } from './primitives/language.tsx';

const ja = translator('ja');
const list: SessionListProps = { text: '', filter: {}, projects: [], rows: [], total: 0, loading: false, mode: 'all', conditions: [], tabs: [], tab: 'all', pager: null, statusColumn: true, tokens: [], hints: [], allCount: 0 };
const home = (over: Partial<HomeCards> = {}, props: Partial<HomeScreenProps> = {}) => {
  const band = presentHomeBand({ attention: [], returning: [], confirm: [], running: [], ...over }, ja);
  const screenProps: HomeScreenProps = { band, idle: band.groups.every((g) => g.count === 0), searching: false, list, allCount: 0, loadMore: null, note: null, ...props };
  return screenProps;
};
const mount = (cards: Partial<HomeCards>, onAction = vi.fn()) => ({ ...render(<LanguageRoot language="ja"><ActionRoot onAction={onAction}><HomeScreen {...home(cards)} /></ActionRoot></LanguageRoot>), onAction });
const ret = (id: string, overdueDays: number | null, projectName: string | null = 'agent-hangar'): ReturnCard => ({ id, name: `戻る ${id}`, projectName, reason: `${id} の数字を見る`, returnOn: overdueDays === null ? null : '2026-10-02', returnTime: null, overdueDays, due: true, pastMin: null });

describe('HomeScreen の今日戻る（C1）', () => {
  it('要対応の引き出しに、入力待ちの後ろで今日戻るの行を出し、戻る日を言う', () => {
    mount({ attention: [{ id: 'w1', name: '待ち', projectName: 'a', waited: '1 分', question: 'q', answer: 'terminal' }], returning: [ret('r1', 0), ret('r2', 3), ret('r3', null, null)] });
    expect(screen.getByRole('button', { name: '要対応 4' })).toHaveAttribute('aria-expanded', 'true');
    const drawer = screen.getByRole('region', { name: '要対応' });
    const rows = [...drawer.querySelectorAll('.crow')];
    expect(rows).toHaveLength(4);
    expect(rows.slice(1).map((c) => c.querySelector('.return-when')!.textContent)).toEqual(['今日', '3 日過ぎ', '日付なし']);
    expect(rows[1]).toHaveTextContent('r1 の数字を見る');
    expect(rows[3]).toHaveTextContent('未分類');
  });
  it('今日戻るの行から開く、戻る日を変える、Done にする', () => {
    const { onAction } = mount({ returning: [ret('r1', 0)] });
    fireEvent.click(screen.getByRole('button', { name: '開く、戻る r1' }));
    expect(onAction).toHaveBeenLastCalledWith({ type: 'session.open', id: 'r1' });
    fireEvent.click(screen.getByRole('button', { name: '日付を変更、戻る r1' }));
    expect(onAction).toHaveBeenLastCalledWith({ type: 'session.pause.open', id: 'r1', from: 'menu' });
    fireEvent.click(screen.getByRole('button', { name: 'Done、戻る r1' }));
    expect(onAction).toHaveBeenLastCalledWith({ type: 'session.state.set', id: 'r1', status: 'done' });
  });
  it('今日戻るも入力待ちも無ければ、要対応の錠剤は押せない薄い札になる', () => {
    mount({ running: [{ id: 'x', name: '動く', live: 'busy', aside: false, elapsed: '5分', meta: 'alpha', intent: null, activity: null, note: '作業中', contextPercent: null, contextLabel: '' }] });
    expect(screen.queryByRole('button', { name: /^要対応/ })).toBeNull();
    expect(screen.getByText('要対応').closest('.count-chip')).toHaveAttribute('data-zero', 'true');
  });
});

describe('HomeScreen の確認待ち（セッションの提案）', () => {
  const session = (id: string, status: 'paused' | 'done'): ConfirmCard => ({ kind: 'session', id, name: `会話 ${id}`, projectName: null, status, label: status === 'done' ? 'Done にする？' : 'Paused · 10/3（土）？', note: '直して push した', ago: '2 時間前' });
  const todo: ConfirmCard = { kind: 'todo', id: 't1', text: '窓を掴める', projectId: 'p1', projectName: 'agent-hangar', sessionName: 's', ago: '1 分前', note: 'n' };
  it('提案の札を行の頭に出し、確定・日付を変更（Paused のみ）・却下を押せる', () => {
    const { onAction } = mount({ confirm: [session('s1', 'paused'), session('s2', 'done')] });
    const drawer = screen.getByRole('region', { name: '確認待ち' });
    expect([...drawer.querySelectorAll('.home-cand')].map((x) => x.textContent)).toEqual(['Paused · 10/3（土）？', 'Done にする？']);
    expect(drawer).toHaveTextContent('未分類');
    fireEvent.click(within(drawer).getByRole('button', { name: '確定、会話 s1' }));
    expect(onAction).toHaveBeenLastCalledWith({ type: 'session.state.confirm', id: 's1' });
    fireEvent.click(within(drawer).getByRole('button', { name: '日付を変更、会話 s1' }));
    expect(onAction).toHaveBeenLastCalledWith({ type: 'session.pause.open', id: 's1', from: 'candidate' });
    fireEvent.click(within(drawer).getByRole('button', { name: '却下、会話 s2' }));
    expect(onAction).toHaveBeenLastCalledWith({ type: 'session.state.reject', id: 's2' });
    expect(within(drawer).queryByRole('button', { name: '日付を変更、会話 s2' })).toBeNull();
    fireEvent.click(within(drawer).getByRole('button', { name: '会話 s2' }));
    expect(onAction).toHaveBeenLastCalledWith({ type: 'session.open', id: 's2' });
  });
  it('TODO の候補と混ざった並びをそのまま描く', () => {
    mount({ confirm: [todo, session('s1', 'done')] });
    const drawer = screen.getByRole('region', { name: '確認待ち' });
    const rows = [...drawer.querySelectorAll('.crow')];
    expect(rows[0]!.querySelector('.cand-mark')).not.toBeNull();
    expect(rows[1]!.querySelector('.home-cand')).not.toBeNull();
  });
  it('別のプロジェクトに同じ本文の候補があっても、確定と却下の名前は 1 つに決まる', () => {
    const mk = (id: string, projectId: string, projectName: string): ConfirmCard => ({ kind: 'todo', id, text: '窓を掴める', projectId, projectName, sessionName: 's', ago: '1 分前', note: 'n' });
    const { onAction } = mount({ confirm: [mk('t1', 'p1', 'alpha'), mk('t2', 'p2', 'beta')] });
    fireEvent.click(screen.getByRole('button', { name: '確定、窓を掴める（alpha）' }));
    expect(onAction).toHaveBeenLastCalledWith({ type: 'todo.confirm', id: 't1' });
    fireEvent.click(screen.getByRole('button', { name: '確定、窓を掴める（beta）' }));
    expect(onAction).toHaveBeenLastCalledWith({ type: 'todo.confirm', id: 't2' });
    fireEvent.click(screen.getByRole('button', { name: '却下、窓を掴める（alpha）' }));
    expect(onAction).toHaveBeenLastCalledWith({ type: 'todo.reject', id: 't1' });
    fireEvent.click(screen.getByRole('button', { name: '却下、窓を掴める（beta）' }));
    expect(onAction).toHaveBeenLastCalledWith({ type: 'todo.reject', id: 't2' });
  });
});
