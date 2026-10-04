import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { IntentRoot } from '../intent/chain.tsx';
import type { ConfirmCard, HomeProps, ReturnCard } from '../presenters/home.ts';
import { HomeScreen } from './HomeScreen.tsx';

const home = (over: Partial<HomeProps> = {}): HomeProps => ({ attention: [], returning: [], confirm: [], running: [], recent: [], recentPager: null, projects: [], idle: false, ...over });
const ret = (id: string, overdueDays: number | null, projectName: string | null = 'agent-hangar'): ReturnCard => ({ id, name: `戻る ${id}`, projectName, reason: `${id} の数字を見る`, returnOn: overdueDays === null ? null : '2026-10-02', returnTime: null, overdueDays, due: true });

describe('HomeScreen の今日戻る（C1）', () => {
  it('要対応の札の並びに、入力待ちの後ろで今日戻るの札を出し、戻る日を言う', () => {
    const { container } = render(<IntentRoot onIntent={vi.fn()}><HomeScreen {...home({ attention: [{ id: 'w1', name: '待ち', projectName: 'a', waited: '1 分', question: 'q', answer: 'terminal' }], returning: [ret('r1', 0), ret('r2', 3), ret('r3', null, null)] })} /></IntentRoot>);
    const section = screen.getByRole('heading', { name: /要対応/ }).closest('section')!;
    expect(within(section).getByRole('heading', { name: /要対応/ })).toHaveTextContent('要対応4');
    const cards = [...section.querySelectorAll('.ask-card')];
    expect(cards.map((c) => c.classList.contains('return-card'))).toEqual([false, true, true, true]);
    expect(cards.slice(1).map((c) => c.querySelector('.return-when')!.textContent)).toEqual(['今日', '3 日過ぎ', '日付なし']);
    expect(cards[1]).toHaveTextContent('r1 の数字を見る');
    expect(cards[3]).toHaveTextContent('未分類');
  });
  it('今日戻るの札から開く、戻る日を変える、Done にする', () => {
    const onIntent = vi.fn();
    render(<IntentRoot onIntent={onIntent}><HomeScreen {...home({ returning: [ret('r1', 0)] })} /></IntentRoot>);
    fireEvent.click(screen.getByRole('button', { name: '開く' }));
    expect(onIntent).toHaveBeenLastCalledWith({ type: 'session.open', id: 'r1' });
    fireEvent.click(screen.getByRole('button', { name: '戻る r1 の戻る日を変える' }));
    expect(onIntent).toHaveBeenLastCalledWith({ type: 'session.pause.open', id: 'r1', from: 'menu' });
    fireEvent.click(screen.getByRole('button', { name: '戻る r1 を Done にする' }));
    expect(onIntent).toHaveBeenLastCalledWith({ type: 'session.state.set', id: 'r1', status: 'done' });
  });
  it('今日戻るも入力待ちも無ければ、要対応の区画ごと省く', () => {
    render(<IntentRoot onIntent={vi.fn()}><HomeScreen {...home()} /></IntentRoot>);
    expect(screen.queryByRole('heading', { name: /要対応/ })).toBeNull();
  });
});

describe('HomeScreen の確かめる（セッションの提案）', () => {
  const session = (id: string, status: 'paused' | 'done'): ConfirmCard => ({ kind: 'session', id, name: `会話 ${id}`, projectName: null, status, label: status === 'done' ? 'Done にする？' : 'Paused · 10/3（土）？', note: '直して push した', ago: '2 時間前' });
  const todo: ConfirmCard = { kind: 'todo', id: 't1', text: '窓を掴める', projectId: 'p1', projectName: 'agent-hangar', sessionName: 's', ago: '1 分前', note: 'n' };
  it('提案の札を行の頭に出し、確定・日を変える（Paused のみ）・却下を押せる', () => {
    const onIntent = vi.fn();
    render(<IntentRoot onIntent={onIntent}><HomeScreen {...home({ confirm: [session('s1', 'paused'), session('s2', 'done')] })} /></IntentRoot>);
    const section = screen.getByRole('heading', { name: /確かめる/ }).closest('section')!;
    expect([...section.querySelectorAll('.home-cand')].map((x) => x.textContent)).toEqual(['Paused · 10/3（土）？', 'Done にする？']);
    expect(section).toHaveTextContent('未分類');
    fireEvent.click(within(section).getByRole('button', { name: '会話 s1 の提案を確定' }));
    expect(onIntent).toHaveBeenLastCalledWith({ type: 'session.state.confirm', id: 's1' });
    fireEvent.click(within(section).getByRole('button', { name: '会話 s1 の戻る日を変える' }));
    expect(onIntent).toHaveBeenLastCalledWith({ type: 'session.pause.open', id: 's1', from: 'candidate' });
    fireEvent.click(within(section).getByRole('button', { name: '会話 s2 の提案を却下' }));
    expect(onIntent).toHaveBeenLastCalledWith({ type: 'session.state.reject', id: 's2' });
    expect(within(section).queryByRole('button', { name: '会話 s2 の戻る日を変える' })).toBeNull();
    fireEvent.click(within(section).getByRole('button', { name: '会話 s2' }));
    expect(onIntent).toHaveBeenLastCalledWith({ type: 'session.open', id: 's2' });
  });
  it('TODO の候補と混ざった並びをそのまま描く', () => {
    render(<IntentRoot onIntent={vi.fn()}><HomeScreen {...home({ confirm: [todo, session('s1', 'done')] })} /></IntentRoot>);
    const section = screen.getByRole('heading', { name: /確かめる/ }).closest('section')!;
    expect(within(section).getByRole('heading', { name: /確かめる/ })).toHaveTextContent('確かめる2');
    const cards = [...section.querySelectorAll('.ask-card')];
    expect(cards[0]!.querySelector('.cand-mark')).not.toBeNull();
    expect(cards[1]!.querySelector('.home-cand')).not.toBeNull();
  });
});
