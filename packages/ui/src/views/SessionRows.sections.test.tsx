import { act, fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { IntentRoot } from '../intent/chain.tsx';
import type { SessionRowProps } from '../presenters/row.ts';
import type { ListItem, SectionId } from '../presenters/sections.ts';
import { SessionRows } from './SessionRows.tsx';

const row = (id: string, over: Partial<SessionRowProps> = {}): SessionRowProps => ({ id, name: 'n' + id, oneLiner: 'one', projectName: 'alpha', live: null, stateLabel: '', summaryState: null, model: '', effort: '', when: '3 分前', whenAbs: '2026-10-01 10:00', filesChanged: 0, prUrl: null, memo: null, hasTranscript: true, transcript: 'present', cost: '', runId: null, state: null, returnOn: null, overdueDays: null, candidate: null, setBy: null, ...over });
const head = (id: SectionId, label: string, count: number, more?: { label: string; target: SectionId }): ListItem => (more ? { kind: 'head', id, label, count, more } : { kind: 'head', id, label, count });
const r = (id: string, over?: Partial<SessionRowProps>): ListItem => ({ kind: 'row', row: row(id, over) });
const ITEMS: ListItem[] = [head('returning', '今日戻る', 1), r('a'), head('continue', '続き', 2), r('b'), r('c'), head('done', 'Done', 1221, { label: 'ほか 1218 件 ▸', target: 'done' }), r('d')];
const toggle = (target: SectionId) => (target === 'done' ? { type: 'project.section.toggle' as const, projectId: 'p1', section: 'done' as const } : null);
const mount = (items: ListItem[] = ITEMS, onIntent = vi.fn()) => ({ ...render(<IntentRoot onIntent={onIntent}><SessionRows items={items} height={400} variant="project" moreIntent={toggle} /></IntentRoot>), onIntent });
const rowsOf = () => [...screen.getByTestId('session-rows').querySelectorAll<HTMLElement>('[role="row"]')];
const list = () => screen.getByTestId('session-rows');

describe('SessionRows の節の見出し（P3 と ★）', () => {
  it('見出しは行ではなく、名前と桁を区切った件数と右端のボタンを出す', () => {
    mount();
    expect(rowsOf()).toHaveLength(4);
    expect(screen.getAllByRole('heading', { level: 2 }).map((h) => h.textContent)).toEqual(['今日戻る1', '続き2', 'Done1,221ほか 1218 件 ▸']);
  });
  it('j と k は見出しを飛ばして行だけを動く', () => {
    const { onIntent } = mount();
    fireEvent.keyDown(list(), { key: 'j' });
    fireEvent.keyDown(list(), { key: 'j' });
    fireEvent.keyDown(list(), { key: 'Enter' });
    expect(onIntent).toHaveBeenLastCalledWith({ type: 'session.open', id: 'b' });
    for (let i = 0; i < 3; i++) fireEvent.keyDown(list(), { key: 'j' });
    fireEvent.keyDown(list(), { key: 'Enter' });
    expect(onIntent).toHaveBeenLastCalledWith({ type: 'session.open', id: 'd' });
    for (let i = 0; i < 5; i++) fireEvent.keyDown(list(), { key: 'k' });
    fireEvent.keyDown(list(), { key: 'Enter' });
    expect(onIntent).toHaveBeenLastCalledWith({ type: 'session.open', id: 'a' });
  });
  it('Tab で止まるのは先頭の行で、見出しには止まらない', () => {
    mount();
    expect(rowsOf().map((x) => x.tabIndex)).toEqual([0, -1, -1, -1]);
    expect(screen.getAllByRole('heading', { level: 2 }).every((h) => !h.hasAttribute('tabindex'))).toBe(true);
  });
  it('見出しのボタンは moreIntent の Intent を出し、行は開かない。null ならボタンを出さない', () => {
    const { onIntent } = mount([head('done', 'Done', 5, { label: 'ほか 2 件 ▸', target: 'done' }), r('a'), head('archived', 'Archived', 2, { label: '表示 ▸', target: 'archived' })]);
    fireEvent.click(screen.getByRole('button', { name: 'ほか 2 件 ▸' }));
    expect(onIntent).toHaveBeenCalledTimes(1);
    expect(onIntent).toHaveBeenCalledWith({ type: 'project.section.toggle', projectId: 'p1', section: 'done' });
    expect(screen.queryByRole('button', { name: '表示 ▸' })).toBeNull();
  });
  it('見出しを押しても何も起きない', () => {
    const { onIntent } = mount();
    fireEvent.click(screen.getByRole('heading', { name: /^今日戻る/ }));
    expect(onIntent).not.toHaveBeenCalled();
  });
  // 選んでいた行が畳んだ Done の中へ移ると、見えない行が Enter で開いてしまう。
  it('選んでいた行が一覧から消えたら、未選択に戻る', () => {
    const onIntent = vi.fn();
    const { rerender } = render(<IntentRoot onIntent={onIntent}><SessionRows items={ITEMS} height={400} variant="project" /></IntentRoot>);
    fireEvent.keyDown(list(), { key: 'j' });
    fireEvent.keyDown(list(), { key: 'j' });
    rerender(<IntentRoot onIntent={onIntent}><SessionRows items={[head('returning', '今日戻る', 1), r('a'), head('continue', '続き', 1), r('c'), head('done', 'Done', 1222), r('d')]} height={400} variant="project" /></IntentRoot>);
    fireEvent.keyDown(list(), { key: 'Enter' });
    expect(onIntent).not.toHaveBeenCalled();
    fireEvent.keyDown(list(), { key: 'j' });
    fireEvent.keyDown(list(), { key: 'Enter' });
    expect(onIntent).toHaveBeenLastCalledWith({ type: 'session.open', id: 'a' });
  });
  it('行だけの rows も今までどおり受け、見出しを出さない', () => {
    render(<IntentRoot onIntent={vi.fn()}><SessionRows rows={[row('x')]} height={400} variant="recent" /></IntentRoot>);
    expect(rowsOf()).toHaveLength(1);
    expect(screen.queryByRole('heading')).toBeNull();
  });
  it('Archived の行に印を付ける', () => {
    mount([r('z', { state: 'archived' }), r('y')]);
    expect(rowsOf().map((x) => x.getAttribute('data-archived'))).toEqual(['true', null]);
  });
});

describe('SessionRows の状態の札（★ の E）', () => {
  it('badgeIntent があれば、状態の札がそのタブへ移るボタンになり、行は開かない', () => {
    const onIntent = vi.fn();
    render(<IntentRoot onIntent={onIntent}><SessionRows rows={[row('d1', { state: 'done' }), row('a1', { state: 'archived' }), row('p1', { state: 'paused', returnOn: '2026-10-09' })]} height={400} variant="search" badgeIntent={(status) => ({ type: 'search.filter', patch: { status } })} /></IntentRoot>);
    fireEvent.click(screen.getByRole('button', { name: 'Done のセッションだけを見る' }));
    expect(onIntent).toHaveBeenLastCalledWith({ type: 'search.filter', patch: { status: 'done' } });
    fireEvent.click(screen.getByRole('button', { name: 'Archived のセッションだけを見る' }));
    expect(onIntent).toHaveBeenLastCalledWith({ type: 'search.filter', patch: { status: 'archived' } });
    fireEvent.click(screen.getByRole('button', { name: 'Paused のセッションだけを見る' }));
    expect(onIntent).toHaveBeenLastCalledWith({ type: 'search.filter', patch: { status: 'paused' } });
    expect(onIntent).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'session.open' }));
  });
  it('badgeIntent が無ければ札は押せない', () => {
    render(<IntentRoot onIntent={vi.fn()}><SessionRows rows={[row('d1', { state: 'done' })]} height={400} variant="project" /></IntentRoot>);
    expect(screen.queryByRole('button', { name: /のセッションだけを見る$/ })).toBeNull();
  });
  // 裁定 2A：戻る日の無い Paused の行も「日付なし」の札を出すので、その札もタブへ移るボタンにする。
  it('戻る日の無い Paused の「日付なし」の札も、Paused のタブへ移るボタンになる', () => {
    const onIntent = vi.fn();
    render(<IntentRoot onIntent={onIntent}><SessionRows rows={[row('p1', { state: 'paused', returnOn: null })]} height={400} variant="search" badgeIntent={(status) => ({ type: 'search.filter', patch: { status } })} /></IntentRoot>);
    const b = screen.getByRole('button', { name: 'Paused のセッションだけを見る' });
    expect(b).toHaveTextContent('日付なし');
    fireEvent.click(b);
    expect(onIntent).toHaveBeenLastCalledWith({ type: 'search.filter', patch: { status: 'paused' } });
  });
});

// 裁定 2B：フォーカスのあった行が一覧から消えたり、DOM が作り直されたりしても、フォーカスを body に落とさない。
// 一覧の打鍵は器が受けるので、body に落ちると j・Enter・. が効かなくなる。
describe('SessionRows のフォーカスの拾い直し（裁定 2B）', () => {
  const ui = (items: ListItem[], onIntent = vi.fn()) => <IntentRoot onIntent={onIntent}><SessionRows items={items} height={400} variant="project" /></IntentRoot>;
  const rowOf = (name: string) => screen.getByText(name).closest<HTMLElement>('[role="row"]')!;

  it('打鍵 . → a で行が Archived の畳んだ節へ移って消えても、j が効く', () => {
    const onIntent = vi.fn();
    const { rerender } = render(ui(ITEMS, onIntent));
    act(() => rowOf('nb').focus());
    fireEvent.keyDown(rowOf('nb'), { key: '.' });
    fireEvent.keyDown(document.activeElement!, { key: 'a' });
    expect(onIntent).toHaveBeenCalledWith({ type: 'session.state.set', id: 'b', status: 'archived' });
    // session.upsert で行が Archived の節へ移る。Archived は畳んであるので見出しだけが残る。
    rerender(ui([head('returning', '今日戻る', 1), r('a'), head('continue', '続き', 1), r('c'), head('done', 'Done', 1221), r('d'), head('archived', 'Archived', 1)], onIntent));
    expect(document.activeElement).toBe(list());
    fireEvent.keyDown(document.activeElement!, { key: 'j' });
    expect(rowOf('na')).toHaveAttribute('data-cursor', 'true');
    expect(document.activeElement).toBe(rowOf('na'));
  });

  it('打鍵 . → d で行が Done の節へ移って DOM が並び替わっても、フォーカスとカーソルはその行に残る', () => {
    const onIntent = vi.fn();
    const { rerender } = render(ui(ITEMS, onIntent));
    act(() => rowOf('nb').focus());
    fireEvent.keyDown(rowOf('nb'), { key: '.' });
    fireEvent.keyDown(document.activeElement!, { key: 'd' });
    rerender(ui([head('returning', '今日戻る', 1), r('a'), head('continue', '続き', 1), r('c'), head('done', 'Done', 1222), r('b', { state: 'done' }), r('d')], onIntent));
    expect(document.activeElement).toBe(rowOf('nb'));
    fireEvent.keyDown(document.activeElement!, { key: 'j' });
    expect(document.activeElement).toBe(rowOf('nd'));
  });

  it('ダイアログを閉じたときに開いた元の行が消えていたら、一覧がフォーカスを拾う', () => {
    const onIntent = vi.fn();
    const { rerender } = render(ui(ITEMS, onIntent));
    act(() => rowOf('nb').focus());
    // Paused のダイアログが開き、フォーカスがその欄へ移る。
    const dialog = document.createElement('div');
    dialog.setAttribute('role', 'dialog');
    dialog.setAttribute('aria-modal', 'true');
    const field = document.createElement('input');
    dialog.appendChild(field);
    document.body.appendChild(dialog);
    act(() => field.focus());
    // ダイアログが開いている間に行が消えても、ダイアログのフォーカスは奪わない。
    const without = [head('returning', '今日戻る', 2), r('a'), r('b', { state: 'paused', returnOn: '2026-10-02' }), head('continue', '続き', 1), r('c'), head('done', 'Done', 1221), r('d')];
    rerender(ui(without.filter((it) => it.kind === 'head' || it.row.id !== 'b'), onIntent));
    expect(document.activeElement).toBe(field);
    // ダイアログが閉じる。開いた元の行は DOM に無いので、Dialog はフォーカスを返せず body に落ちる。
    act(() => dialog.remove());
    expect(document.activeElement).toBe(document.body);
    rerender(ui(without.filter((it) => it.kind === 'head' || it.row.id !== 'b'), onIntent));
    expect(document.activeElement).toBe(list());
    fireEvent.keyDown(document.activeElement!, { key: 'j' });
    expect(document.activeElement).toBe(rowOf('na'));
  });

  it('利用者が一覧の外へフォーカスを外したら、描き直しでも奪い返さない', () => {
    const { rerender } = render(ui(ITEMS));
    act(() => rowOf('nb').focus());
    act(() => rowOf('nb').blur());
    expect(document.activeElement).toBe(document.body);
    rerender(ui(ITEMS.filter((it) => it.kind === 'head' || it.row.id !== 'b')));
    expect(document.activeElement).toBe(document.body);
  });
});
