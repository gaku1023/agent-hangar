import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { IntentRoot } from '../intent/chain.tsx';
import type { LivePaneProps } from '../presenters/live.ts';
import { LivePane } from './LivePane.tsx';

afterEach(cleanup);

const pane = (p: Partial<LivePaneProps> = {}): LivePaneProps => ({
  lamp: { tone: 'busy', head: '2 本動いている', sub: '失敗 1' },
  intent: { kind: 'said', text: '答え終えた会話だけ止める', meta: 'Claude いわく・01:40・その後 3 手', stale: false },
  steps: [{ text: 'テストを走らせる', mono: false, when: '01:41', mark: 'now' }],
  lanes: [
    { agentId: 'tool:t9', title: '壊れる担当', tone: 'error', elapsed: '1 分', line: '失敗した', quoted: false, selectable: false },
    { agentId: 'a1', title: 'クラウドを査読', tone: 'running', elapsed: '4 分', line: 'テストを走らせる', quoted: false, selectable: true },
    { agentId: 'a2', title: '文書を直す', tone: 'done', elapsed: '6 分', line: '済：README を直した', quoted: true, selectable: true },
  ],
  doneFolded: 2,
  ...p,
});
const mount = (p: LivePaneProps, onIntent = vi.fn()) => { render(<IntentRoot onIntent={onIntent}><LivePane sessionId="s1" pane={p}><div>目次</div></LivePane></IntentRoot>); return onIntent; };

describe('LivePane', () => {
  it('灯、意図、手、レーン、目次の順に並べる', () => {
    mount(pane());
    const text = document.querySelector('.live')!.textContent!;
    const order = ['2 本動いている', '「答え終えた会話だけ止める」', 'テストを走らせる', '壊れる担当', '済 2', '目次'].map((s) => text.indexOf(s));
    expect(order.every((n) => n >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });
  it('自己申告だけに引用符を付ける', () => {
    mount(pane());
    expect(screen.getByText('「済：README を直した」')).toBeTruthy();
    expect(screen.queryByText('「テストを走らせる」')).toBeNull();
  });
  it('結べたレーンを押すとその本の transcript を開き、結べないレーンは押せない', () => {
    const onIntent = mount(pane());
    fireEvent.click(screen.getByText('クラウドを査読').closest('button')!);
    expect(onIntent).toHaveBeenCalledWith({ type: 'transcript.selectAgent', sessionId: 's1', agentId: 'a1' });
    expect((screen.getByText('壊れる担当').closest('button') as HTMLButtonElement).disabled).toBe(true);
  });
  it('意図が無いときは言葉だけを出し、古い意図には印を付ける', () => {
    mount(pane({ intent: { kind: 'none', text: '意図は書かれていない' } }));
    expect(screen.getByText('意図は書かれていない')).toBeTruthy();
  });
  it('古い意図は data-stale を持つ', () => {
    mount(pane({ intent: { kind: 'said', text: 'x', meta: 'm', stale: true } }));
    expect(document.querySelector('.live-intent')!.getAttribute('data-stale')).toBe('true');
  });
});
