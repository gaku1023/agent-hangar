import { act, cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { IntentRoot } from '../intent/chain.tsx';
import type { TranscriptItem, TurnRowProps } from '../presenters/session.ts';
import { TurnIndex, type TurnIndexProps } from './TurnIndex.tsx';

afterEach(cleanup);

const rows: TurnRowProps[] = [
  { seq: 1, when: '20:31', text: '最初の指示です\n2 行目', head: '最初の指示です', tools: 3, open: false, band: [] },
  { seq: 10, when: '21:02', text: '次の指示', head: '次の指示', tools: 0, open: false, band: [] },
  { seq: 20, when: '22:46', text: '今起動してみたけど、反映されてないように見えます。', head: '今起動してみたけど、反映されてない', tools: 12, open: false, band: [] },
];

function setup(over: Partial<TurnIndexProps> = {}) {
  const onIntent = vi.fn();
  const props: TurnIndexProps = { sessionId: 's1', runId: 'r1', rows, complete: true, openItems: [], turnJump: null, hasMore: false, loading: false, remaining: 0, agentId: null, ...over };
  const r = render(<IntentRoot onIntent={onIntent}><TurnIndex {...props} /></IntentRoot>);
  return { ...r, onIntent };
}

describe('TurnIndex', () => {
  it('ターンを開いても scrollIntoView を呼ばない（WebKit ではアプリ全体を戻れない位置までずらす）', () => {
    const spy = vi.fn();
    const had = Object.prototype.hasOwnProperty.call(HTMLElement.prototype, 'scrollIntoView');
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { value: spy, configurable: true, writable: true });
    try {
      const { rerender, onIntent } = setup();
      const props: TurnIndexProps = { sessionId: 's1', runId: 'r1', rows: rows.map((r) => ({ ...r, open: r.seq === 20 })), complete: true, openItems: [], turnJump: null, hasMore: false, loading: false, remaining: 0, agentId: null };
      rerender(<IntentRoot onIntent={onIntent}><TurnIndex {...props} /></IntentRoot>);
      expect(spy).not.toHaveBeenCalled();
    } finally {
      if (had) Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { value: undefined, configurable: true, writable: true });
      else delete (HTMLElement.prototype as { scrollIntoView?: unknown }).scrollIntoView;
    }
  });

  it('指示を 1 行ずつ、時刻とツールの数を添えて並べる', () => {
    const { container } = setup();
    const lines = [...container.querySelectorAll('.turn-row')].map((b) => b.textContent);
    expect(lines).toEqual(['20:31最初の指示です3', '21:02次の指示', '22:46今起動してみたけど、反映されてないように見えます。12']);
  });

  it('押すと、そのターンを開き、左のターミナルを跳ばす切り出しを送る', () => {
    const { container, onIntent } = setup();
    fireEvent.click(container.querySelectorAll('.turn-row')[2]!);
    expect(onIntent).toHaveBeenCalledWith({ type: 'turn.open', sessionId: 's1', seq: 20, runId: 'r1', jump: { heads: rows.map((r) => r.head), index: 2, from: 'bottom' } });
  });

  it('run が無ければ跳ばさずに開くだけ', () => {
    const { container, onIntent } = setup({ runId: null });
    fireEvent.click(container.querySelectorAll('.turn-row')[0]!);
    expect(onIntent).toHaveBeenCalledWith({ type: 'turn.open', sessionId: 's1', seq: 1, runId: null, jump: null });
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
    const { getByRole, onIntent } = setup();
    fireEvent.click(getByRole('button', { name: /最新へ/ }));
    expect(onIntent).toHaveBeenCalledWith({ type: 'turn.latest', sessionId: 's1', runId: 'r1' });
  });

  it('古いターンが残っていれば、読み込むボタンを先頭に出す', () => {
    const { getByRole, onIntent } = setup({ hasMore: true, remaining: 40, complete: false });
    fireEvent.click(getByRole('button', { name: '古いターンを読み込む（残り 40 件）' }));
    expect(onIntent).toHaveBeenCalledWith({ type: 'transcript.loadMore', sessionId: 's1' });
  });

  it('サブエージェントを見ている間は、主線へ戻る道を出す', () => {
    const { getByRole, onIntent } = setup({ agentId: 'abc' });
    fireEvent.click(getByRole('button', { name: '主線に戻る' }));
    expect(onIntent).toHaveBeenCalledWith({ type: 'transcript.selectAgent', sessionId: 's1', agentId: null });
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
    const { container, onIntent } = setup();
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
    expect(onIntent).not.toHaveBeenCalled();
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
    const { container, onIntent } = setup();
    const b = rowsOf(container);
    act(() => b[2]!.focus());
    fireEvent.keyDown(b[2]!, { key: 'k' });
    fireEvent.keyDown(b[1]!, { key: 'Enter' });
    expect(onIntent).toHaveBeenCalledTimes(1);
    // 押したときと同じ Intent を出す。
    const viaKey = onIntent.mock.calls[0]![0];
    onIntent.mockClear();
    fireEvent.click(b[1]!);
    expect(viaKey).toEqual(onIntent.mock.calls[0]![0]);
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
