import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IntentRoot } from '../intent/chain.tsx';
import type { SessionRowProps } from '../presenters/row.ts';
import { SessionRows } from './SessionRows.tsx';
import { existsSync, readFileSync } from 'node:fs';

// dom の project では import.meta.url が file にならず、?raw も空文字になるので、cwd から辿って読む。
const rowsCssPath = ['packages/ui/src/styles/rows.css', 'src/styles/rows.css'].map((r) => `${process.cwd()}/${r}`).find(existsSync);
const rowsCss = readFileSync(rowsCssPath!, 'utf8');

const row = (id: string): SessionRowProps => ({ id, name: 'n' + id, oneLiner: 'one', projectName: 'alpha', live: id === 'a' ? 'busy' : null, stateLabel: '完了', model: 'fable 5.1', effort: 'high', when: '3 分前', whenAbs: '2026-09-01 10:00', filesChanged: 2, prUrl: 'https://x/pull/1', memo: null, hasTranscript: true, cost: '', runId: null });

describe('SessionRows', () => {
  it('行のクリックと Enter で session.open', () => {
    const onIntent = vi.fn();
    render(<IntentRoot onIntent={onIntent}><SessionRows rows={[row('a'), row('b')]} height={400} variant="search" /></IntentRoot>);
    fireEvent.click(screen.getByText('na'));
    expect(onIntent).toHaveBeenCalledWith({ type: 'session.open', id: 'a' });
    // 行の Enter は、その行にフォーカスがあるときにだけ届く。フォーカスした行がカーソルになる。
    const rb = screen.getByText('nb').closest('[role="row"]') as HTMLElement;
    act(() => rb.focus());
    fireEvent.keyDown(rb, { key: 'Enter' });
    expect(onIntent).toHaveBeenCalledWith({ type: 'session.open', id: 'b' });
    expect(screen.getAllByTitle('2026-09-01 10:00')).toHaveLength(2);
    expect(screen.getAllByText('alpha')).toHaveLength(2);
  });
  it('空なら案内を出す', () => {
    render(<IntentRoot onIntent={() => {}}><SessionRows rows={[]} height={100} variant="project" /></IntentRoot>);
    expect(screen.getByText('セッションはまだありません')).toBeInTheDocument();
  });
  it('行はセッションの id を、広がる元の印に持つ', () => {
    const { container } = render(<IntentRoot onIntent={() => {}}><SessionRows rows={[row('a'), row('b')]} height={400} variant="recent" /></IntentRoot>);
    expect([...container.querySelectorAll('.row-2')].map((r) => r.getAttribute('data-morph-id'))).toEqual(['a', 'b']);
  });
});

const p3Row = (id: string, over: Partial<SessionRowProps> = {}): SessionRowProps => ({
  id, name: '名前 ' + id, oneLiner: '要約 ' + id, projectName: 'alpha', live: null, stateLabel: '完了', model: 'opus 4.1', effort: 'high',
  when: '1 時間前', whenAbs: '2026-09-18 11:00', filesChanged: 2, prUrl: null, memo: null, hasTranscript: true, cost: '$0.50', runId: null, ...over,
});

describe('SessionRows のフェーズ 3', () => {
  it('コストとメモの列を出す', () => {
    render(<IntentRoot onIntent={() => {}}><SessionRows rows={[p3Row('s1', { memo: '覚書' })]} height={400} variant="project" /></IntentRoot>);
    expect(screen.getByText('$0.50')).toBeTruthy();
    expect(screen.getByText('✎ 覚書')).toBeTruthy();
  });
  it('j と k で選び、Enter で開く', () => {
    const onIntent = vi.fn();
    render(<IntentRoot onIntent={onIntent}><SessionRows rows={[p3Row('s1'), p3Row('s2')]} height={400} variant="project" /></IntentRoot>);
    const list = screen.getByTestId('session-rows');
    fireEvent.keyDown(list, { key: 'j' });
    fireEvent.keyDown(list, { key: 'j' });
    fireEvent.keyDown(list, { key: 'k' });
    fireEvent.keyDown(list, { key: 'Enter' });
    expect(onIntent).toHaveBeenCalledWith({ type: 'session.open', id: 's1' });
  });
  it('カーソルの行に印が付く', () => {
    render(<IntentRoot onIntent={() => {}}><SessionRows rows={[p3Row('s1'), p3Row('s2')]} height={400} variant="project" /></IntentRoot>);
    const list = screen.getByTestId('session-rows');
    fireEvent.keyDown(list, { key: 'j' });
    fireEvent.keyDown(list, { key: 'j' });
    const marked = list.querySelectorAll('[data-cursor="true"]');
    expect(marked).toHaveLength(1);
    expect(marked[0]!.textContent).toContain('名前 s2');
  });
  it('o はターミナル、e は VS Code', () => {
    const onIntent = vi.fn();
    render(<IntentRoot onIntent={onIntent}><SessionRows rows={[p3Row('s1', { runId: 'r1' }), p3Row('s2')]} height={400} variant="project" /></IntentRoot>);
    const list = screen.getByTestId('session-rows');
    fireEvent.keyDown(list, { key: 'j' });
    fireEvent.keyDown(list, { key: 'o' });
    expect(onIntent).toHaveBeenCalledWith({ type: 'session.openTerminalApp', runId: 'r1' });
    fireEvent.keyDown(list, { key: 'e' });
    expect(onIntent).toHaveBeenCalledWith({ type: 'session.openEditor', sessionId: 's1' });
    onIntent.mockClear();
    fireEvent.keyDown(list, { key: 'j' });
    fireEvent.keyDown(list, { key: 'o' });
    expect(onIntent).not.toHaveBeenCalled();
  });
  it('選んでいなければキー操作は何も出さない', () => {
    const onIntent = vi.fn();
    render(<IntentRoot onIntent={onIntent}><SessionRows rows={[p3Row('s1', { runId: 'r1' })]} height={400} variant="project" /></IntentRoot>);
    const list = screen.getByTestId('session-rows');
    fireEvent.keyDown(list, { key: 'Enter' });
    fireEvent.keyDown(list, { key: 'o' });
    fireEvent.keyDown(list, { key: 'e' });
    expect(onIntent).not.toHaveBeenCalled();
    expect(screen.queryByLabelText('名前 s1 のメモ')).toBeNull();
  });
  it('m でメモの入力欄に変わり、Enter で保存、Esc で捨てる', () => {
    const onIntent = vi.fn();
    render(<IntentRoot onIntent={onIntent}><SessionRows rows={[p3Row('s1', { memo: '前' })]} height={400} variant="project" /></IntentRoot>);
    const list = screen.getByTestId('session-rows');
    fireEvent.keyDown(list, { key: 'j' });
    fireEvent.keyDown(list, { key: 'm' });
    const input = screen.getByLabelText('名前 s1 のメモ') as HTMLInputElement;
    expect(input.value).toBe('前');
    fireEvent.change(input, { target: { value: '後' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onIntent).toHaveBeenCalledWith({ type: 'session.setMemo', id: 's1', text: '後' });
    expect(onIntent).toHaveBeenCalledTimes(1);
    expect(screen.queryByLabelText('名前 s1 のメモ')).toBeNull();
    onIntent.mockClear();
    fireEvent.keyDown(list, { key: 'm' });
    fireEvent.change(screen.getByLabelText('名前 s1 のメモ'), { target: { value: '捨てる' } });
    fireEvent.keyDown(screen.getByLabelText('名前 s1 のメモ'), { key: 'Escape' });
    expect(onIntent).not.toHaveBeenCalled();
    expect(screen.queryByLabelText('名前 s1 のメモ')).toBeNull();
  });
  it('編集中の入力欄では j と k を横取りしない', () => {
    const onIntent = vi.fn();
    render(<IntentRoot onIntent={onIntent}><SessionRows rows={[p3Row('s1'), p3Row('s2')]} height={400} variant="project" /></IntentRoot>);
    const list = screen.getByTestId('session-rows');
    fireEvent.keyDown(list, { key: 'j' });
    fireEvent.keyDown(list, { key: 'm' });
    const input = screen.getByLabelText('名前 s1 のメモ') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'jk' } });
    fireEvent.keyDown(input, { key: 'j' });
    fireEvent.keyDown(input, { key: 'k' });
    // カーソルは動かず、入力欄も開いたまま。
    expect(screen.getByLabelText('名前 s1 のメモ')).toBe(input);
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onIntent).toHaveBeenCalledWith({ type: 'session.setMemo', id: 's1', text: 'jk' });
  });
  it('入力欄から焦点が外れたら編集を閉じ、何も出さない', () => {
    const onIntent = vi.fn();
    render(<IntentRoot onIntent={onIntent}><SessionRows rows={[p3Row('s1', { memo: '前' })]} height={400} variant="project" /></IntentRoot>);
    fireEvent.click(screen.getByLabelText('名前 s1 のメモを編集'));
    const input = screen.getByLabelText('名前 s1 のメモ');
    fireEvent.change(input, { target: { value: '書きかけ' } });
    fireEvent.blur(input);
    expect(onIntent).not.toHaveBeenCalled();
    expect(screen.queryByLabelText('名前 s1 のメモ')).toBeNull();
  });
  it('鉛筆ボタンでも編集に入り、行は開かない', () => {
    const onIntent = vi.fn();
    render(<IntentRoot onIntent={onIntent}><SessionRows rows={[p3Row('s1')]} height={400} variant="project" /></IntentRoot>);
    fireEvent.click(screen.getByLabelText('名前 s1 のメモを編集'));
    expect(onIntent).not.toHaveBeenCalled();
    expect(screen.getByLabelText('名前 s1 のメモ')).toBeTruthy();
  });
});

describe('一覧のフォーカスの見え方', () => {
  it('一覧にフォーカスが当たったら accent の輪郭を出す', () => {
    // base.css の :focus-visible と同じ詳細度なので、blanket な outline: none は輪郭を消してしまう。
    expect(rowsCss).not.toMatch(/\.rows-host\s*\{[^}]*outline:\s*none/);
    const rule = rowsCss.match(/\.rows-host:focus-visible\s*\{[^}]*\}/)?.[0] ?? '';
    expect(rule).toContain('var(--accent)');
    expect(rule).toMatch(/outline:\s*2px solid/);
  });
  it('マウスで押しただけのときは輪郭を出さない', () => {
    expect(rowsCss).toMatch(/\.rows-host:focus:not\(:focus-visible\)\s*\{[^}]*outline:\s*none/);
  });
  it('行のフォーカスの輪郭は内側に描き、一覧の枠で切れないようにする', () => {
    const rule = rowsCss.match(/\.row:focus-visible\s*\{[^}]*\}/)?.[0] ?? '';
    expect(rule).toContain('var(--accent)');
    expect(rule).toMatch(/outline-offset:\s*-2px/);
  });
});

describe('カーソルの行を見える位置へ運ぶ', () => {
  let calls: { el: Element; arg: unknown }[] = [];
  beforeEach(() => {
    calls = [];
    // jsdom は scrollIntoView を実装していないので、呼ばれたことだけを見る。
    (Element.prototype as unknown as { scrollIntoView: unknown }).scrollIntoView = function (this: Element, arg: unknown) { calls.push({ el: this, arg }); };
  });
  afterEach(() => { delete (Element.prototype as unknown as { scrollIntoView?: unknown }).scrollIntoView; });

  it('j で選んだ行を可視範囲へ寄せる', () => {
    render(<IntentRoot onIntent={() => {}}><SessionRows rows={[p3Row('s1'), p3Row('s2')]} height={400} variant="project" /></IntentRoot>);
    const list = screen.getByTestId('session-rows');
    fireEvent.keyDown(list, { key: 'j' });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.el.textContent).toContain('名前 s1');
    expect(calls[0]!.arg).toEqual({ block: 'nearest' });
    fireEvent.keyDown(list, { key: 'j' });
    expect(calls).toHaveLength(2);
    expect(calls[1]!.el.textContent).toContain('名前 s2');
  });
  it('k でも寄せ、選んでいないうちは動かさない', () => {
    render(<IntentRoot onIntent={() => {}}><SessionRows rows={[p3Row('s1'), p3Row('s2')]} height={400} variant="project" /></IntentRoot>);
    const list = screen.getByTestId('session-rows');
    fireEvent.keyDown(list, { key: 'x' });
    expect(calls).toHaveLength(0);
    fireEvent.keyDown(list, { key: 'j' });
    fireEvent.keyDown(list, { key: 'j' });
    fireEvent.keyDown(list, { key: 'k' });
    expect(calls[calls.length - 1]!.el.textContent).toContain('名前 s1');
  });
  it('メモの編集に入っただけでは動かさない', () => {
    render(<IntentRoot onIntent={() => {}}><SessionRows rows={[p3Row('s1'), p3Row('s2')]} height={400} variant="project" /></IntentRoot>);
    const list = screen.getByTestId('session-rows');
    fireEvent.keyDown(list, { key: 'j' });
    const before = calls.length;
    fireEvent.keyDown(list, { key: 'm' });
    expect(calls).toHaveLength(before);
  });
});

describe('SessionRows（2 段の行）', () => {
  const r = (id: string, over: Partial<SessionRowProps> = {}): SessionRowProps => ({ id, name: '名前 ' + id, oneLiner: '要約 ' + id, projectName: 'alpha', live: null, stateLabel: '完了', model: 'opus 4.1', effort: 'high', when: '3 分前', whenAbs: '2026-09-01 10:00', filesChanged: 6, prUrl: 'https://github.com/x/y/pull/1', memo: 'スワイプは実機で', hasTranscript: true, cost: '$1.82', runId: null, ...over });
  const rowOf = (name: string) => screen.getByText(name).closest('[role="row"]') as HTMLElement;

  it('最近は 2 段目に要約、右は時刻だけ', () => {
    render(<IntentRoot onIntent={() => {}}><SessionRows rows={[r('a')]} height={400} variant="recent" /></IntentRoot>);
    const row = rowOf('名前 a');
    expect(row).toHaveTextContent('要約 a');
    expect(row).toHaveTextContent('3 分前');
    for (const t of ['opus 4.1', '変更 6', '$1.82', 'スワイプは実機で', 'alpha']) expect(row).not.toHaveTextContent(t);
    expect(within(row).queryByText('PR')).toBeNull();
  });
  it('プロジェクト詳細は右にモデル、変更、PR、コストと時刻、2 段目にメモ', () => {
    render(<IntentRoot onIntent={() => {}}><SessionRows rows={[r('a')]} height={400} variant="project" /></IntentRoot>);
    const row = rowOf('名前 a');
    for (const t of ['opus 4.1 · high', '変更 6', '$1.82', '3 分前', '要約 a', '✎ スワイプは実機で']) expect(row).toHaveTextContent(t);
    expect(within(row).getByText('PR').closest('a')).toHaveAttribute('href', 'https://github.com/x/y/pull/1');
  });
  it('変更が 0 で PR もコストもメモも無ければ、その印を出さない', () => {
    render(<IntentRoot onIntent={() => {}}><SessionRows rows={[r('a', { filesChanged: 0, prUrl: null, cost: '', memo: null })]} height={400} variant="project" /></IntentRoot>);
    const row = rowOf('名前 a');
    expect(row).not.toHaveTextContent('変更');
    expect(row).not.toHaveTextContent('✎');
    expect(within(row).queryByText('PR')).toBeNull();
  });
  it('検索は 1 段目にプロジェクト名、2 段目に一致箇所を印つきで出す', () => {
    const excerpt = [{ text: '…床（', hit: false }, { text: 'transcriptsFrom', hit: true }, { text: '）を…', hit: false }];
    render(<IntentRoot onIntent={() => {}}><SessionRows rows={[r('a', { excerpt })]} height={400} variant="search" /></IntentRoot>);
    const row = rowOf('名前 a');
    expect(row).toHaveTextContent('alpha');
    expect(row.querySelector('mark.hit')).toHaveTextContent('transcriptsFrom');
    expect(row).not.toHaveTextContent('要約 a');
  });
  it('検索でも抜粋が無ければ要約を出し、プロジェクトが無ければ未分類', () => {
    render(<IntentRoot onIntent={() => {}}><SessionRows rows={[r('a', { projectName: null })]} height={400} variant="search" /></IntentRoot>);
    const row = rowOf('名前 a');
    expect(row).toHaveTextContent('要約 a');
    expect(row).toHaveTextContent('未分類');
  });
  it('m のメモの編集は、プロジェクト詳細でなくても 2 段目で開く', () => {
    const onIntent = vi.fn();
    render(<IntentRoot onIntent={onIntent}><SessionRows rows={[r('a')]} height={400} variant="recent" /></IntentRoot>);
    const host = screen.getByTestId('session-rows');
    fireEvent.keyDown(host, { key: 'j' });
    fireEvent.keyDown(host, { key: 'm' });
    const input = screen.getByLabelText('名前 a のメモ');
    fireEvent.change(input, { target: { value: '新' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onIntent).toHaveBeenCalledWith({ type: 'session.setMemo', id: 'a', text: '新' });
  });
});

describe('一覧のキー操作（C1）', () => {
  const rowsOf = () => [...screen.getByTestId('session-rows').querySelectorAll<HTMLElement>('[role="row"]')];
  const mount = (onIntent = vi.fn(), over: { autoFocus?: boolean; rows?: SessionRowProps[] } = {}) => {
    const r = render(<IntentRoot onIntent={onIntent}><SessionRows rows={over.rows ?? [p3Row('s1'), p3Row('s2'), p3Row('s3')]} height={400} variant="project" autoFocus={over.autoFocus} /></IntentRoot>);
    return { ...r, onIntent };
  };

  it('↑ と ↓ も j と k と同じに動く', () => {
    const { onIntent } = mount();
    const list = screen.getByTestId('session-rows');
    fireEvent.keyDown(list, { key: 'ArrowDown' });
    fireEvent.keyDown(list, { key: 'ArrowDown' });
    fireEvent.keyDown(list, { key: 'ArrowDown' });
    fireEvent.keyDown(list, { key: 'ArrowUp' });
    fireEvent.keyDown(list, { key: 'Enter' });
    expect(onIntent).toHaveBeenCalledTimes(1);
    expect(onIntent).toHaveBeenCalledWith({ type: 'session.open', id: 's2' });
  });

  it('矢印は既定の動き（一覧のスクロール）を止める', () => {
    mount();
    const ev = new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true });
    act(() => { screen.getByTestId('session-rows').dispatchEvent(ev); });
    expect(ev.defaultPrevented).toBe(true);
  });

  it('Tab で止まる行は 1 つだけで、カーソルの行へフォーカスが移る', () => {
    mount();
    expect(rowsOf().map((r) => r.tabIndex)).toEqual([0, -1, -1]);
    const list = screen.getByTestId('session-rows');
    fireEvent.keyDown(list, { key: 'j' });
    fireEvent.keyDown(list, { key: 'j' });
    expect(rowsOf().map((r) => r.tabIndex)).toEqual([-1, 0, -1]);
    expect(document.activeElement).toBe(rowsOf()[1]);
  });

  it('フォーカスした行がカーソルになり、Enter はその行を 1 度だけ開く', () => {
    const { onIntent } = mount();
    const list = screen.getByTestId('session-rows');
    // カーソルを 1 行目に置いてから、Tab やクリックで 3 行目にフォーカスを移す。
    fireEvent.keyDown(list, { key: 'j' });
    act(() => rowsOf()[2]!.focus());
    expect(rowsOf()[2]).toHaveAttribute('data-cursor', 'true');
    expect(list.querySelectorAll('[data-cursor="true"]')).toHaveLength(1);
    fireEvent.keyDown(rowsOf()[2]!, { key: 'Enter' });
    expect(onIntent).toHaveBeenCalledTimes(1);
    expect(onIntent).toHaveBeenCalledWith({ type: 'session.open', id: 's3' });
  });

  it('行の中のボタンで押した Enter は行を開かない', () => {
    const { onIntent } = mount();
    const pencil = screen.getByLabelText('名前 s1 のメモを編集');
    act(() => pencil.focus());
    fireEvent.keyDown(pencil, { key: 'Enter' });
    expect(onIntent).not.toHaveBeenCalled();
    // 中のボタンへ Tab で入っても、フォーカスは行へ引き戻さない。
    expect(document.activeElement).toBe(pencil);
  });

  it('⌘ や Ctrl の付いた打鍵は一覧で使わない', () => {
    mount();
    const list = screen.getByTestId('session-rows');
    fireEvent.keyDown(list, { key: 'j', metaKey: true });
    fireEvent.keyDown(list, { key: 'k', ctrlKey: true });
    expect(list.querySelectorAll('[data-cursor="true"]')).toHaveLength(0);
  });

  it('メモを Enter で保存したら、フォーカスは行に戻る', () => {
    mount();
    const list = screen.getByTestId('session-rows');
    fireEvent.keyDown(list, { key: 'j' });
    fireEvent.keyDown(list, { key: 'm' });
    fireEvent.keyDown(screen.getByLabelText('名前 s1 のメモ'), { key: 'Enter' });
    expect(document.activeElement).toBe(rowsOf()[0]);
  });

  it('autoFocus なら、描いた時点で一覧にフォーカスする。行はまだ選ばない', () => {
    mount(vi.fn(), { autoFocus: true });
    const list = screen.getByTestId('session-rows');
    expect(document.activeElement).toBe(list);
    expect(list.querySelectorAll('[data-cursor="true"]')).toHaveLength(0);
    fireEvent.keyDown(list, { key: 'j' });
    expect(document.activeElement).toBe(rowsOf()[0]);
  });

  it('autoFocus でも、入力欄で打っている最中ならフォーカスを奪わない', () => {
    const box = document.createElement('input');
    document.body.appendChild(box);
    box.focus();
    mount(vi.fn(), { autoFocus: true });
    expect(document.activeElement).toBe(box);
    box.remove();
  });

  it('並びが変わっても、フォーカスした行とカーソルと Enter で開く行は同じ', () => {
    const onIntent = vi.fn();
    const rows = [p3Row('a'), p3Row('b'), p3Row('c')];
    const { rerender } = render(<IntentRoot onIntent={onIntent}><SessionRows rows={rows} height={400} variant="project" /></IntentRoot>);
    const rowB = screen.getByText('名前 b').closest('[role="row"]') as HTMLElement;
    act(() => rowB.focus());
    rerender(<IntentRoot onIntent={onIntent}><SessionRows rows={[rows[1]!, rows[0]!, rows[2]!]} height={400} variant="project" /></IntentRoot>);
    const focused = document.activeElement as HTMLElement;
    expect(focused.textContent).toContain('名前 b');
    const marked = screen.getByTestId('session-rows').querySelectorAll('[data-cursor="true"]');
    expect(marked).toHaveLength(1);
    expect(marked[0]).toBe(focused);
    fireEvent.keyDown(focused, { key: 'Enter' });
    expect(onIntent).toHaveBeenCalledWith({ type: 'session.open', id: 'b' });
    expect(onIntent).toHaveBeenCalledTimes(1);
    // 並び替えの後の j は、いまの並びで次の行へ進む。
    fireEvent.keyDown(focused, { key: 'j' });
    expect((document.activeElement as HTMLElement).textContent).toContain('名前 a');
  });

  it('autoFocus でも、モーダルのダイアログが開いていればフォーカスを奪わない', () => {
    // 起動時の未解決ダイアログのように、フォーカスがまだダイアログの外（body）にあっても奪わない。
    const modal = document.createElement('div');
    modal.setAttribute('aria-modal', 'true');
    document.body.appendChild(modal);
    try {
      mount(vi.fn(), { autoFocus: true });
      expect(document.activeElement).toBe(document.body);
    } finally {
      modal.remove();
    }
  });

  it('autoFocus は、行が後から届いたときに 1 度だけ当てる', () => {
    const onIntent = vi.fn();
    const { rerender } = render(<IntentRoot onIntent={onIntent}><SessionRows rows={[]} height={400} variant="search" autoFocus /></IntentRoot>);
    expect(document.activeElement).toBe(document.body);
    rerender(<IntentRoot onIntent={onIntent}><SessionRows rows={[p3Row('s1')]} height={400} variant="search" autoFocus /></IntentRoot>);
    expect(document.activeElement).toBe(screen.getByTestId('session-rows'));
    act(() => (document.activeElement as HTMLElement).blur());
    rerender(<IntentRoot onIntent={onIntent}><SessionRows rows={[p3Row('s1'), p3Row('s2')]} height={400} variant="search" autoFocus /></IntentRoot>);
    expect(document.activeElement).toBe(document.body);
  });
});
