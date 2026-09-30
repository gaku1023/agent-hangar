import { cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { IntentRoot } from '../intent/chain.tsx';
import type { TranscriptItem, TurnRowProps } from '../presenters/session.ts';
import { TurnIndex, type TurnIndexProps } from './TurnIndex.tsx';

afterEach(cleanup);

const rows: TurnRowProps[] = [
  { seq: 1, when: '20:31', text: '最初の指示です\n2 行目', head: '最初の指示です', tools: 3, open: false },
  { seq: 10, when: '21:02', text: '次の指示', head: '次の指示', tools: 0, open: false },
  { seq: 20, when: '22:46', text: '今起動してみたけど、反映されてないように見えます。', head: '今起動してみたけど、反映されてない', tools: 12, open: false },
];

function setup(over: Partial<TurnIndexProps> = {}) {
  const onIntent = vi.fn();
  const props: TurnIndexProps = { sessionId: 's1', runId: 'r1', rows, complete: true, openItems: [], turnJump: null, hasMore: false, loading: false, remaining: 0, agentId: null, ...over };
  const r = render(<IntentRoot onIntent={onIntent}><TurnIndex {...props} /></IntentRoot>);
  return { ...r, onIntent };
}

describe('TurnIndex', () => {
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

  it('ターミナルで見つからなかったときは、開いたターンに一言添える', () => {
    const { container } = setup({ rows: rows.map((r) => ({ ...r, open: r.seq === 10 })), turnJump: { seq: 10, status: 'notFound' } });
    expect(container.querySelector('.turn-note')?.textContent).toBe('ターミナルでは見つかりませんでした');
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
