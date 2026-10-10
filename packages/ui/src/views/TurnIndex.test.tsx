import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ActionRoot } from '../action/chain.tsx';
import type { TranscriptItem, TurnRowProps } from '../presenters/session.ts';
import { fakeMotionTokens } from '../test/motion.ts';
import { LanguageRoot } from './primitives/language.tsx';
import { TurnIndex, type TurnIndexProps } from './TurnIndex.tsx';

afterEach(cleanup);

const rows: TurnRowProps[] = [
  { seq: 1, when: '20:31', text: '最初の指示です\n2 行目', head: '最初の指示です', tools: 3, open: false, band: [] },
  { seq: 10, when: '21:02', text: '次の指示', head: '次の指示', tools: 0, open: false, band: [] },
  { seq: 20, when: '22:46', text: '今起動してみたけど、反映されてないように見えます。', head: '今起動してみたけど、反映されてない', tools: 12, open: false, band: [] },
];

function setup(over: Partial<TurnIndexProps> = {}) {
  const onAction = vi.fn();
  const props: TurnIndexProps = { sessionId: 's1', runId: 'r1', rows, complete: true, openItems: [], turnJump: null, hasMore: false, loading: false, remaining: 0, agentId: null, ...over };
  const r = render(<ActionRoot onAction={onAction}><TurnIndex {...props} /></ActionRoot>);
  return { ...r, onAction };
}

const row = (n: number): TurnRowProps => ({ seq: n, when: '10:00', text: `t${n}`, head: `t${n}`, tools: 0, open: false, band: [] });
const indexUi = (p: Partial<TurnIndexProps> = {}) => <ActionRoot onAction={vi.fn()}><TurnIndex sessionId="s1" runId={null} rows={[]} complete openItems={[]} turnJump={null} hasMore={false} loading={false} remaining={0} agentId={null} {...p} /></ActionRoot>;
const renderIndex = (p: Partial<TurnIndexProps> = {}) => render(indexUi(p));

describe('TurnIndex', () => {
  it('ターンを開いても scrollIntoView を呼ばない（WebKit ではアプリ全体を戻れない位置までずらす）', () => {
    const spy = vi.fn();
    const had = Object.prototype.hasOwnProperty.call(HTMLElement.prototype, 'scrollIntoView');
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { value: spy, configurable: true, writable: true });
    try {
      const { rerender, onAction } = setup();
      const props: TurnIndexProps = { sessionId: 's1', runId: 'r1', rows: rows.map((r) => ({ ...r, open: r.seq === 20 })), complete: true, openItems: [], turnJump: null, hasMore: false, loading: false, remaining: 0, agentId: null };
      rerender(<ActionRoot onAction={onAction}><TurnIndex {...props} /></ActionRoot>);
      expect(spy).not.toHaveBeenCalled();
    } finally {
      if (had) Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { value: undefined, configurable: true, writable: true });
      else delete (HTMLElement.prototype as { scrollIntoView?: unknown }).scrollIntoView;
    }
  });

  it('見出しは「目次」と、ターンの数（数の回転 .roll）を出す', () => {
    renderIndex({ rows: [row(0), row(1)] });
    expect(document.querySelector('.turns-head')).toHaveTextContent('目次');
    expect(document.querySelector('.turns-head .roll')).toHaveTextContent('2 ターン');
  });
  it('古いターンが残っているときは、ターンの数に + を添える', () => {
    renderIndex({ rows: [row(0), row(1)], hasMore: true, remaining: 3, complete: false });
    expect(document.querySelector('.turns-head .roll')).toHaveTextContent('2+ ターン');
  });
  it('英語では、見出しも単数形（1 turn）も英語の語で出る', () => {
    const { rerender } = render(<LanguageRoot language="en">{indexUi({ rows: [row(0), row(1)] })}</LanguageRoot>);
    expect(document.querySelector('.turns-head')).toHaveTextContent('Outline');
    expect(document.querySelector('.turns-head .roll')).toHaveTextContent('2 turns');
    rerender(<LanguageRoot language="en">{indexUi({ rows: [row(0)] })}</LanguageRoot>);
    expect(document.querySelector('.turns-head .roll')).toHaveTextContent('1 turn');
    expect(screen.getByRole('button', { name: 'Jump to latest' })).toBeInTheDocument();
  });
  it('動かない環境では、新しい行が来たら末尾へすぐ追従する', () => {
    const { rerender } = renderIndex({ rows: [row(0)] });
    const list = document.querySelector('.turns-list') as HTMLElement;
    Object.defineProperty(list, 'scrollHeight', { value: 500, configurable: true });
    rerender(indexUi({ rows: [row(0), row(1)] }));
    expect(list.scrollTop).toBe(500);
  });

  it('動かない環境では、開いたターンをすぐ見える位置へ寄せる', () => {
    const { container, rerender } = renderIndex({ rows: [row(0), row(1)] });
    const list = container.querySelector('.turns-list') as HTMLElement;
    const had = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'getBoundingClientRect');
    HTMLElement.prototype.getBoundingClientRect = function (this: HTMLElement) {
      return this === list ? new DOMRect(0, 0, 100, 100) : new DOMRect(0, 80, 100, 100);
    };
    try {
      list.scrollTop = 0;
      rerender(indexUi({ rows: [row(0), { ...row(1), open: true }] }));
      expect(list.scrollTop).toBe(80);
    } finally {
      if (had) Object.defineProperty(HTMLElement.prototype, 'getBoundingClientRect', had);
      else delete (HTMLElement.prototype as { getBoundingClientRect?: unknown }).getBoundingClientRect;
    }
  });

  it('指示を 1 行ずつ、時刻とツールの数を添えて並べる', () => {
    const { container } = setup();
    const lines = [...container.querySelectorAll('.turn-row')].map((b) => b.textContent);
    expect(lines).toEqual(['20:31最初の指示です3', '21:02次の指示', '22:46今起動してみたけど、反映されてないように見えます。12']);
  });

  it('押すと、そのターンを開き、左のターミナルを跳ばす切り出しを送る', () => {
    const { container, onAction } = setup();
    fireEvent.click(container.querySelectorAll('.turn-row')[2]!);
    expect(onAction).toHaveBeenCalledWith({ type: 'turn.open', sessionId: 's1', seq: 20, runId: 'r1', jump: { heads: rows.map((r) => r.head), index: 2, from: 'bottom' } });
  });

  it('run が無ければ跳ばさずに開くだけ', () => {
    const { container, onAction } = setup({ runId: null });
    fireEvent.click(container.querySelectorAll('.turn-row')[0]!);
    expect(onAction).toHaveBeenCalledWith({ type: 'turn.open', sessionId: 's1', seq: 1, runId: null, jump: null });
  });

  it('開いたターンは中身を見せる。指示そのものは行に出ているので繰り返さない', () => {
    const openItems: TranscriptItem[] = [
      { kind: 'user', seq: 20, text: '今起動してみたけど', when: '22:46' },
      { kind: 'assistant', seq: 21, text: 'まず確かめます', when: '22:46' },
    ];
    const { container } = setup({ rows: rows.map((r) => ({ ...r, open: r.seq === 20 })), openItems });
    const body = container.querySelector('.turn-body')!;
    expect(body.querySelector('.msg-user')).toBeNull();
    expect(body.querySelector('.msg-assistant')?.textContent).toBe('まず確かめます');
  });

  it('行の下に手の種類の色帯を出し、手の無いターンには出さない', () => {
    const { container } = setup({ rows: [{ ...rows[0]!, band: ['read', 'fail', 'git'] }, rows[1]!] });
    const bands = [...container.querySelectorAll('.turn')].map((t) => [...t.querySelectorAll('.turn-band i')].map((i) => i.getAttribute('data-k')));
    expect(bands).toEqual([['read', 'fail', 'git'], []]);
  });

  it('ターミナルで見つからなかったときは、開いたターンに一言添える', () => {
    const { container } = setup({ rows: rows.map((r) => ({ ...r, open: r.seq === 10 })), turnJump: { seq: 10, status: 'notFound' } });
    expect(container.querySelector('.turn-note')?.textContent).toBe('ターミナルでは見つかりませんでした');
  });
  it('表示を切り替えられなかったときは、英語の内部の語を出さずに言う', () => {
    const { container } = setup({ rows: rows.map((r) => ({ ...r, open: r.seq === 10 })), turnJump: { seq: 10, status: 'mode' } });
    expect(container.querySelector('.turn-note')?.textContent).toBe('ターミナルの表示を切り替えられませんでした');
  });

  it('最新へで transcript を抜けて末尾に戻る', () => {
    const { getByRole, onAction } = setup();
    fireEvent.click(getByRole('button', { name: '最新へ移動' }));
    expect(onAction).toHaveBeenCalledWith({ type: 'turn.latest', sessionId: 's1', runId: 'r1' });
  });

  it('古いターンが残っていれば、読み込むボタンを先頭に出す', () => {
    const { getByRole, onAction } = setup({ hasMore: true, remaining: 40, complete: false });
    fireEvent.click(getByRole('button', { name: '古いターンを読み込む（残り 40 件）' }));
    expect(onAction).toHaveBeenCalledWith({ type: 'transcript.loadMore', sessionId: 's1' });
  });

  it('サブエージェントを見ている間は、メイン会話へ戻る道を出す', () => {
    const { getByRole, onAction } = setup({ agentId: 'abc' });
    fireEvent.click(getByRole('button', { name: 'メイン会話に戻る' }));
    expect(onAction).toHaveBeenCalledWith({ type: 'transcript.selectAgent', sessionId: 's1', agentId: null });
  });
});

describe('TurnIndex のキー操作（C3）', () => {
  const rowsOf = (c: HTMLElement) => [...c.querySelectorAll<HTMLButtonElement>('.turn-row')];

  it('Tab で止まる行は 1 つだけで、既定はいちばん新しい指示、開いていればその行', () => {
    const { container, unmount } = setup();
    expect(rowsOf(container).map((b) => b.tabIndex)).toEqual([-1, -1, 0]);
    unmount();
    const opened = setup({ rows: rows.map((r) => ({ ...r, open: r.seq === 10 })) });
    expect(rowsOf(opened.container).map((b) => b.tabIndex)).toEqual([-1, 0, -1]);
  });

  it('↑ と ↓、k と j でフォーカスを隣の行へ動かし、端で止まる', () => {
    const { container, onAction } = setup();
    const b = rowsOf(container);
    act(() => b[2]!.focus());
    fireEvent.keyDown(b[2]!, { key: 'ArrowUp' });
    expect(document.activeElement).toBe(b[1]);
    fireEvent.keyDown(b[1]!, { key: 'k' });
    expect(document.activeElement).toBe(b[0]);
    fireEvent.keyDown(b[0]!, { key: 'k' });
    expect(document.activeElement).toBe(b[0]);
    fireEvent.keyDown(b[0]!, { key: 'j' });
    expect(document.activeElement).toBe(b[1]);
    fireEvent.keyDown(b[1]!, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(b[2]);
    fireEvent.keyDown(b[2]!, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(b[2]);
    // 動かすだけでは開かない。
    expect(onAction).not.toHaveBeenCalled();
    expect(rowsOf(container).map((x) => x.tabIndex)).toEqual([-1, -1, 0]);
  });

  it('動かした先が次の Tab の止まり先になる', () => {
    const { container } = setup();
    const b = rowsOf(container);
    act(() => b[2]!.focus());
    fireEvent.keyDown(b[2]!, { key: 'k' });
    expect(rowsOf(container).map((x) => x.tabIndex)).toEqual([-1, 0, -1]);
  });

  it('矢印は一覧のスクロールに使わせない', () => {
    const { container } = setup();
    const b = rowsOf(container);
    act(() => b[2]!.focus());
    const ev = new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true, cancelable: true });
    act(() => { b[2]!.dispatchEvent(ev); });
    expect(ev.defaultPrevented).toBe(true);
  });

  it('Enter でフォーカスの行を 1 度だけ開く', () => {
    const { container, onAction } = setup();
    const b = rowsOf(container);
    act(() => b[2]!.focus());
    fireEvent.keyDown(b[2]!, { key: 'k' });
    fireEvent.keyDown(b[1]!, { key: 'Enter' });
    expect(onAction).toHaveBeenCalledTimes(1);
    // 押したときと同じ UiAction を出す。
    const viaKey = onAction.mock.calls[0]![0];
    onAction.mockClear();
    fireEvent.click(b[1]!);
    expect(viaKey).toEqual(onAction.mock.calls[0]![0]);
    expect(viaKey).toMatchObject({ type: 'turn.open', sessionId: 's1', seq: 10, runId: 'r1' });
  });

  it('⌘ の付いた打鍵は動かさない', () => {
    const { container } = setup();
    const b = rowsOf(container);
    act(() => b[2]!.focus());
    fireEvent.keyDown(b[2]!, { key: 'ArrowUp', metaKey: true });
    expect(document.activeElement).toBe(b[2]);
  });
});

describe('TurnIndex の仮の行', () => {
  it('届くまでは仮の行を 6 つ出し、「まだ指示がありません」は出さない', () => {
    renderIndex({ rows: [], pending: true });
    expect(document.querySelectorAll('.turn-skel')).toHaveLength(6);
    expect(screen.queryByText('まだ指示がありません')).toBeNull();
  });
  it('読み込み済みで 0 件なら、仮の行は出さず「まだ指示がありません」を出す', () => {
    renderIndex({ rows: [], pending: false });
    expect(document.querySelectorAll('.turn-skel')).toHaveLength(0);
    expect(screen.getByText('まだ指示がありません')).toBeInTheDocument();
  });
});

describe('TurnIndex の動き', () => {
  let restore: (() => void) | null = null;
  let animations: { el: Element; frames: Keyframe[] }[] = [];
  let finish: (() => void)[] = [];
  beforeEach(() => {
    restore = fakeMotionTokens(undefined, { everywhere: true });
    animations = []; finish = [];
    (HTMLElement.prototype as unknown as { getAnimations: unknown }).getAnimations = () => [];
    (HTMLElement.prototype as unknown as { animate: unknown }).animate = function (this: Element, frames: Keyframe[]) {
      animations.push({ el: this, frames });
      return { finished: new Promise<void>((r) => finish.push(r)), cancel: vi.fn() };
    };
  });
  afterEach(() => {
    restore?.(); restore = null;
    delete (HTMLElement.prototype as unknown as { animate?: unknown }).animate;
    delete (HTMLElement.prototype as unknown as { getAnimations?: unknown }).getAnimations;
  });
  const turns = (c: HTMLElement) => [...c.querySelectorAll('.turn')];

  it('新しい指示の行だけが入り、最初に出た行は動かさない', () => {
    const { container, rerender } = renderIndex({ rows: [row(0), row(1)] });
    expect(animations).toHaveLength(0);
    rerender(indexUi({ rows: [row(0), row(1), row(2)] }));
    expect(animations.map((a) => a.el)).toEqual([turns(container)[2]]);
  });
  it('古いターンの読み込みで先頭に足された行は動かさない', () => {
    const { rerender } = renderIndex({ rows: [row(2), row(3)] });
    rerender(indexUi({ rows: [row(0), row(1), row(2), row(3)] }));
    expect(animations).toHaveLength(0);
  });
  it('末尾への追従は、動くときは滑らかに scrollTo する', () => {
    const { rerender } = renderIndex({ rows: [row(0)] });
    const list = document.querySelector('.turns-list') as HTMLElement;
    const scrollTo = vi.fn();
    list.scrollTo = scrollTo as unknown as typeof list.scrollTo;
    Object.defineProperty(list, 'scrollHeight', { value: 500, configurable: true });
    rerender(indexUi({ rows: [row(0), row(1)] }));
    expect(scrollTo).toHaveBeenCalledWith({ top: 500, behavior: 'smooth' });
  });
  it('セッションやサブエージェントを替えたら、末尾へ滑らせずにすぐ跳ぶ', () => {
    const { rerender } = renderIndex({ rows: [row(0), row(1)] });
    const list = document.querySelector('.turns-list') as HTMLElement;
    const scrollTo = vi.fn();
    list.scrollTo = scrollTo as unknown as typeof list.scrollTo;
    Object.defineProperty(list, 'scrollHeight', { value: 500, configurable: true });
    list.scrollTop = 0;
    rerender(indexUi({ sessionId: 's2', rows: [row(5), row(6), row(7)] }));
    expect(scrollTo).not.toHaveBeenCalled();
    expect(list.scrollTop).toBe(500);
    list.scrollTop = 0;
    rerender(indexUi({ sessionId: 's2', agentId: 'abc', rows: [row(8)] }));
    expect(scrollTo).not.toHaveBeenCalled();
    expect(list.scrollTop).toBe(500);
    // 同じ範囲で新しい指示が来たら、また滑らかに追う。
    rerender(indexUi({ sessionId: 's2', agentId: 'abc', rows: [row(8), row(9)] }));
    expect(scrollTo).toHaveBeenCalledWith({ top: 500, behavior: 'smooth' });
  });
  it('空や仮の行から埋まった描画では、末尾へ滑らせずにすぐ跳ぶ', () => {
    const { rerender } = renderIndex({ rows: [row(0)] });
    const list = document.querySelector('.turns-list') as HTMLElement;
    const scrollTo = vi.fn();
    list.scrollTo = scrollTo as unknown as typeof list.scrollTo;
    Object.defineProperty(list, 'scrollHeight', { value: 500, configurable: true });
    rerender(indexUi({ rows: [], pending: true }));
    list.scrollTop = 0;
    rerender(indexUi({ rows: [row(3), row(4)] }));
    expect(scrollTo).not.toHaveBeenCalled();
    expect(list.scrollTop).toBe(500);
  });
  it('仮の行から本物の行へ替わったら、一覧を薄れから現す', () => {
    const { rerender } = renderIndex({ rows: [], pending: true });
    expect(animations).toHaveLength(0);
    rerender(indexUi({ rows: [row(0), row(1)], pending: false }));
    expect(animations.map((a) => a.el)).toContain(document.querySelector('.turns-list'));
    expect(animations.find((a) => a.el === document.querySelector('.turns-list'))!.frames).toEqual([{ opacity: 0 }, { opacity: 1 }]);
  });
  it('最初から行があるときは、一覧を薄れから現さない', () => {
    const { rerender } = renderIndex({ rows: [row(0)] });
    rerender(indexUi({ rows: [row(0), row(1)] }));
    expect(animations.map((a) => a.el)).not.toContain(document.querySelector('.turns-list'));
  });
  it('開いたターンの中身は伸びて入る', () => {
    const { container, rerender } = renderIndex({ rows: [row(0), row(1)] });
    rerender(indexUi({ rows: [row(0), { ...row(1), open: true }] }));
    expect(animations.map((a) => a.el)).toEqual([container.querySelector('.turn-body')]);
  });
  it('閉じたターンの中身は、畳んで出るまで控えで描き続け、終わったら外す', async () => {
    const openItems: TranscriptItem[] = [{ kind: 'assistant', seq: 2, text: '返答です', when: '10:00' }];
    const { container, rerender } = renderIndex({ rows: [row(0), { ...row(1), open: true }], openItems });
    rerender(indexUi({ rows: [row(0), row(1)], openItems: [] }));
    const body = container.querySelector('.turn-body');
    expect(body).toHaveAttribute('aria-hidden', 'true');
    expect(body).toHaveTextContent('返答です');
    await act(async () => { finish.forEach((f) => f()); });
    expect(container.querySelector('.turn-body')).toBeNull();
  });
  it('消える行は読み上げと操作から外す（行の位置は元のまま）', () => {
    const { container, rerender } = renderIndex({ rows: [row(0), row(1), row(2)] });
    rerender(indexUi({ rows: [row(0), row(2)] }));
    const gone = turns(container)[1]!;
    expect(turns(container)).toHaveLength(3);
    expect(gone).toHaveAttribute('aria-hidden', 'true');
    const btn = gone.querySelector('button')!;
    expect(btn).toBeDisabled();
    expect(btn.tabIndex).toBe(-1);
  });
  it('矢印で移るとき、消えていく行は飛ばす', () => {
    const { container, rerender } = renderIndex({ rows: [row(0), row(1), row(2)] });
    rerender(indexUi({ rows: [row(0), row(2)] }));
    const b = [...container.querySelectorAll<HTMLButtonElement>('.turn-row')];
    act(() => b[0]!.focus());
    fireEvent.keyDown(b[0]!, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(b[2]);
  });
  it('開いたターンの寄せは、伸び切ったあとの大きさで行う（伸びる前には動かさない）', async () => {
    const { container, rerender } = renderIndex({ rows: [row(0), row(1)] });
    const list = container.querySelector('.turns-list') as HTMLElement;
    HTMLElement.prototype.getBoundingClientRect = function (this: HTMLElement) {
      return this === list ? new DOMRect(0, 0, 100, 100) : new DOMRect(0, 80, 100, 100);
    };
    try {
      list.scrollTop = 0;
      rerender(indexUi({ rows: [row(0), { ...row(1), open: true }] }));
      expect(list.scrollTop).toBe(0);
      await act(async () => { finish.forEach((f) => f()); });
      expect(list.scrollTop).toBe(80);
    } finally {
      delete (HTMLElement.prototype as { getBoundingClientRect?: unknown }).getBoundingClientRect;
    }
  });
  it('エージェントの切り替え（途中で行が空になる）では、行を畳みも入れもせず、前の中身も残さない', async () => {
    const openItems: TranscriptItem[] = [{ kind: 'assistant', seq: 2, text: '前の返答', when: '10:00' }];
    const { container, rerender } = renderIndex({ rows: [row(0), { ...row(1), open: true }], openItems });
    animations = [];
    rerender(indexUi({ rows: [], agentId: 'abc' }));
    expect(turns(container)).toHaveLength(0);
    rerender(indexUi({ rows: [row(0), row(1)], agentId: 'abc' }));
    await act(async () => { finish.forEach((f) => f()); });
    expect(animations).toHaveLength(0);
    expect(turns(container)).toHaveLength(2);
    expect(container.querySelector('.turn-body')).toBeNull();
  });
  it('scope が替わった描画では、前の scope の閉じた中身を畳まない', () => {
    const openItems: TranscriptItem[] = [{ kind: 'assistant', seq: 2, text: '前の返答', when: '10:00' }];
    const { container, rerender } = renderIndex({ sessionId: 's1', rows: [row(0), { ...row(1), open: true }], openItems });
    animations = [];
    rerender(indexUi({ sessionId: 's2', rows: [row(0), row(1)], openItems: [] }));
    expect(container.querySelector('.turn-body')).toBeNull();
    expect(animations).toHaveLength(0);
  });
});
