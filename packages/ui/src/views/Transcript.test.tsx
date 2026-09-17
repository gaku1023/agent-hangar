import { fireEvent, render } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { IntentRoot } from '../intent/chain.tsx';
import type { TranscriptItem } from '../presenters/session.ts';
import { Transcript } from './Transcript.tsx';

const items: TranscriptItem[] = [
  { kind: 'user', seq: 0, text: 'hi', when: '10:00' },
  { kind: 'assistant', seq: 1, text: 'bye', when: '10:01' },
];

// jsdom はレイアウトを持たないので、寸法とスクロール位置を定義して流し込む。
function setup(follow: boolean) {
  const onIntent = vi.fn();
  const { container } = render(<IntentRoot onIntent={onIntent}><Transcript sessionId="s1" items={items} hasMore={false} loading={false} follow={follow} live remaining={0} /></IntentRoot>);
  const el = container.querySelector('.tr') as HTMLDivElement;
  Object.defineProperty(el, 'scrollHeight', { value: 1000, configurable: true });
  Object.defineProperty(el, 'clientHeight', { value: 200, configurable: true });
  const scrollTo = (top: number) => { Object.defineProperty(el, 'scrollTop', { value: top, configurable: true, writable: true }); fireEvent.scroll(el); };
  return { onIntent, scrollTo };
}

describe('Transcript の追従', () => {
  it('下へ向かう途中のスクロールでは追従を切らない', () => {
    // 追従中の自動スクロールは上から下へ進むので、scrollTop は増え続ける。
    const { onIntent, scrollTo } = setup(true);
    scrollTo(100); scrollTo(300); scrollTo(600);
    expect(onIntent).not.toHaveBeenCalled();
  });
  it('上へ戻ったら追従を切る', () => {
    const { onIntent, scrollTo } = setup(true);
    scrollTo(600); scrollTo(500);
    expect(onIntent).toHaveBeenCalledTimes(1);
    expect(onIntent).toHaveBeenCalledWith({ type: 'transcript.follow', sessionId: 's1', follow: false });
  });
  it('追従を切った状態で末尾に着いたら追従に戻す', () => {
    const { onIntent, scrollTo } = setup(false);
    scrollTo(400);
    expect(onIntent).not.toHaveBeenCalled();
    scrollTo(790);
    expect(onIntent).toHaveBeenCalledWith({ type: 'transcript.follow', sessionId: 's1', follow: true });
  });
});
