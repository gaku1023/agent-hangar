import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { IntentRoot } from '../intent/chain.tsx';
import type { SessionRowProps } from '../presenters/row.ts';
import type { SessionsProps, StatusTab, StatusTabProps } from '../presenters/sessions.ts';
import { SessionsScreen } from './SessionsScreen.tsx';

const row = (id: string, over: Partial<SessionRowProps> = {}): SessionRowProps => ({ id, name: 'n' + id, oneLiner: 'one', projectName: 'alpha', live: null, aside: false, stateLabel: '', summaryState: null, model: '', effort: '', when: '3 分前', whenAbs: '2026-10-01 10:00', filesChanged: 0, prUrl: null, memo: null, hasTranscript: true, transcript: 'present', cost: '', runId: null, state: null, returnOn: null, returnTime: null, overdueDays: null, returnDue: false, returnPastMin: null, candidate: null, setBy: null, ...over });
const TABS: StatusTabProps[] = ([['all', 'すべて', '1,236'], ['proposed', '確かめる', '3'], ['active', 'Active', '5'], ['paused', 'Paused', '4'], ['done', 'Done', '1,221'], ['archived', 'Archived', '5']] as [StatusTab, string, string][]).map(([tab, label, count]) => ({ tab, label, count, hot: tab === 'proposed' }));
const props = (over: Partial<SessionsProps> = {}): SessionsProps => ({ text: '', filter: {}, projects: [{ id: 'p1', name: 'agent-hangar' }, { id: 'p4', name: 'my app' }], rows: [], total: 0, loading: false, mode: 'all', allCount: 1241, conditions: [], tabs: TABS, tab: 'all', sections: null, tokens: [], hints: [], pager: null, statusColumn: true, ...over });
const mount = (over: Partial<SessionsProps> = {}, onIntent = vi.fn()) => ({ ...render(<IntentRoot onIntent={onIntent}><SessionsScreen {...props(over)} /></IntentRoot>), onIntent });
const tabs = () => within(screen.getByRole('group', { name: '状態' }));

describe('SessionsScreen の状態のタブ（★）', () => {
  it('件数つきのタブを並べ、確かめるの数字だけを灯し、選んでいるタブに印を付ける', () => {
    mount({ tab: 'paused' });
    expect(tabs().getAllByRole('button').map((b) => b.textContent)).toEqual(['すべて1,236', '確かめる3', 'Active5', 'Paused4', 'Done1,221', 'Archived5']);
    expect(tabs().getByRole('button', { name: /^確かめる/ }).querySelector('[data-hot="true"]')).not.toBeNull();
    expect(tabs().getByRole('button', { name: /^Done/ }).querySelector('[data-hot="true"]')).toBeNull();
    expect(tabs().getByRole('button', { name: /^Paused/ })).toHaveAttribute('aria-pressed', 'true');
  });
  it('タブを押すと状態で絞り、「すべて」は外し、いまのタブは何も出さない', () => {
    const { onIntent } = mount({ tab: 'paused' });
    fireEvent.click(tabs().getByRole('button', { name: /^Done/ }));
    expect(onIntent).toHaveBeenLastCalledWith({ type: 'search.filter', patch: { status: 'done' } });
    fireEvent.click(tabs().getByRole('button', { name: /^すべて/ }));
    expect(onIntent).toHaveBeenLastCalledWith({ type: 'search.filter', patch: { status: undefined } });
    onIntent.mockClear();
    fireEvent.click(tabs().getByRole('button', { name: /^Paused/ }));
    expect(onIntent).not.toHaveBeenCalled();
  });
  it('動きの切替（状態の Segmented）は外した', () => {
    mount();
    expect(screen.queryByRole('radiogroup', { name: '状態' })).toBeNull();
  });
});

describe('SessionsScreen の欄（欄が正）', () => {
  it('Enter で欄のトークンを読み、今の条件に重ねて search.query を出し、読めた分は欄から消す', () => {
    const { onIntent } = mount({ filter: { projectId: 'p1' } });
    const kw = screen.getByLabelText('キーワード') as HTMLInputElement;
    fireEvent.change(kw, { target: { value: 'is:paused 動画 project:"my app"' } });
    fireEvent.keyDown(kw, { key: 'Enter' });
    expect(onIntent).toHaveBeenLastCalledWith({ type: 'search.query', text: '動画', filter: { projectId: 'p4', status: 'paused' } });
    expect(kw.value).toBe('動画');
  });
  it('効いている条件を欄の中のチップにし、× と、空の欄の Backspace で外す', () => {
    const { onIntent } = mount({ tokens: [{ key: 'status', token: 'is:paused' }, { key: 'days', token: 'since:7d' }] });
    const box = document.querySelector('.sessions-keyword') as HTMLElement;
    expect(within(box).getByText('is:paused')).toBeInTheDocument();
    fireEvent.click(within(box).getByRole('button', { name: 'is:paused を外す' }));
    expect(onIntent).toHaveBeenLastCalledWith({ type: 'search.filter', patch: { status: undefined } });
    const kw = screen.getByLabelText('キーワード');
    fireEvent.keyDown(kw, { key: 'Backspace' });
    expect(onIntent).toHaveBeenLastCalledWith({ type: 'search.filter', patch: { days: undefined } });
    onIntent.mockClear();
    fireEvent.change(kw, { target: { value: 'x' } });
    fireEvent.keyDown(kw, { key: 'Backspace' });
    expect(onIntent).not.toHaveBeenCalled();
  });
  it('読めなかったトークンは、欄の下で語として探していることを知らせる', () => {
    mount({ text: 'is:pasued', hints: ['「is:pasued」は条件として読めないので、語として本文を探しています。'] });
    expect(screen.getByRole('note')).toHaveTextContent('「is:pasued」は条件として読めないので、語として本文を探しています。');
  });
  it('帯に無い期間（since:14d）では、期間の帯のどれにも印を付けない', () => {
    mount({ filter: { days: 14 }, tokens: [{ key: 'days', token: 'since:14d' }] });
    expect(within(screen.getByRole('radiogroup', { name: '期間' })).queryAllByRole('radio', { checked: true })).toHaveLength(0);
  });
});

describe('SessionsScreen の節', () => {
  it('条件が無いときは節を描き、見出しのボタンと行の札はそのタブを選ぶ', () => {
    const { onIntent } = mount({ sections: [
      { kind: 'head', id: 'returning', label: '今日戻る', count: 1 }, { kind: 'row', row: row('r') },
      { kind: 'head', id: 'proposed', label: '確かめる', count: 1, more: { label: 'この節だけ見る ▸', target: 'proposed' } }, { kind: 'row', row: row('c') },
      { kind: 'head', id: 'active', label: 'Active', count: 1, more: { label: 'この節だけ見る ▸', target: 'active' } }, { kind: 'row', row: row('l', { live: 'busy' }) },
      { kind: 'head', id: 'done', label: 'Done', count: 1221, more: { label: 'ほか 1218 件 ▸', target: 'done' } }, { kind: 'row', row: row('d', { state: 'done' }) },
    ] });
    const buttons = screen.getAllByRole('button', { name: 'この節だけ見る ▸' });
    fireEvent.click(buttons[0]!);
    expect(onIntent).toHaveBeenLastCalledWith({ type: 'search.filter', patch: { status: 'proposed' } });
    fireEvent.click(buttons[1]!);
    expect(onIntent).toHaveBeenLastCalledWith({ type: 'search.filter', patch: { status: 'active' } });
    fireEvent.click(screen.getByRole('button', { name: 'ほか 1218 件 ▸' }));
    expect(onIntent).toHaveBeenLastCalledWith({ type: 'search.filter', patch: { status: 'done' } });
    fireEvent.click(screen.getByRole('button', { name: 'Done のセッションだけを見る' }));
    expect(onIntent).toHaveBeenLastCalledWith({ type: 'search.filter', patch: { status: 'done' } });
    expect(onIntent).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'session.open' }));
  });
  it('平らな結果でも、行の状態の札でタブへ移る', () => {
    const { onIntent } = mount({ rows: [row('a', { state: 'archived' }), row('b')], total: 2, conditions: ['7 日'] });
    fireEvent.click(screen.getByRole('button', { name: 'Archived のセッションだけを見る' }));
    expect(onIntent).toHaveBeenLastCalledWith({ type: 'search.filter', patch: { status: 'archived' } });
    // 状態の無い行の Active の札も、Active のタブへ移る。
    fireEvent.click(screen.getByRole('button', { name: 'Active のセッションだけを見る' }));
    expect(onIntent).toHaveBeenLastCalledWith({ type: 'search.filter', patch: { status: 'active' } });
    expect(onIntent).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'session.open' }));
  });
});
