import { cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PeerChatRow } from '../presenters/peerChat.ts';
import { LanguageRoot } from './primitives/language.tsx';
import { PeerChatLog } from './PeerChatLog.tsx';

afterEach(cleanup);

const row = (key: string): PeerChatRow => ({ kind: 'user', key, text: `本文 ${key}`, from: null });
type Over = Partial<Parameters<typeof PeerChatLog>[0]>;
const draw = (rows: PeerChatRow[], over: Over = {}) => {
  const ui = (rs: PeerChatRow[], o: Over) => <LanguageRoot language="ja"><PeerChatLog rows={rs} loading={false} onCancel={() => {}} onAnswer={() => {}} {...o} /></LanguageRoot>;
  const r = render(ui(rows, over));
  return { ...r, again: (rs: PeerChatRow[], o: Over = over) => r.rerender(ui(rs, o)), log: r.container.querySelector('.pchat-log') as HTMLElement };
};
/** jsdom は寸法を持たないので、箱の高さと位置を差し替える。 */
function size(el: HTMLElement, o: { scrollHeight: () => number; clientHeight?: number }) {
  Object.defineProperty(el, 'scrollHeight', { configurable: true, get: o.scrollHeight });
  Object.defineProperty(el, 'clientHeight', { configurable: true, value: o.clientHeight ?? 100 });
}

describe('別の PC の会話の列: 上への読み足し', () => {
  it('先頭に着いたら、古い分を頼む。more が無いとき、読み込み中のときは頼まない', () => {
    const onLoadOlder = vi.fn();
    const { log, again } = draw([row('a'), row('b')], { hasMore: true, onLoadOlder });
    size(log, { scrollHeight: () => 500 });
    log.scrollTop = 300;
    fireEvent.scroll(log);
    expect(onLoadOlder).not.toHaveBeenCalled();
    log.scrollTop = 0;
    fireEvent.scroll(log);
    expect(onLoadOlder).toHaveBeenCalledTimes(1);
    again([row('a'), row('b')], { hasMore: true, loadingOlder: true, onLoadOlder });
    fireEvent.scroll(log);
    expect(onLoadOlder).toHaveBeenCalledTimes(1);
    again([row('a'), row('b')], { hasMore: false, onLoadOlder });
    fireEvent.scroll(log);
    expect(onLoadOlder).toHaveBeenCalledTimes(1);
  });

  it('読み足している間は、頭に手元の会話と同じ「読み込み中…」を出す', () => {
    const { container } = draw([row('a')], { hasMore: true, loadingOlder: true });
    expect(container.querySelector('.pchat-log > :first-child')).toHaveTextContent('読み込み中…');
  });

  it('頭に足したとき、見ていた行が動かないよう、増えた高さの分だけスクロール位置をずらす', () => {
    let h = 400;
    const { log, again } = draw([row('c'), row('d')], { hasMore: true });
    size(log, { scrollHeight: () => h });
    // 読み返している最中（末尾から離れている）。
    log.scrollTop = 10;
    fireEvent.scroll(log);
    again([row('c'), row('d')], { hasMore: true });
    h = 700;
    again([row('a'), row('b'), row('c'), row('d')], { hasMore: true });
    expect(log.scrollTop).toBe(310);
  });
});

describe('別の PC の会話の列: 目次から跳ぶ', () => {
  it('jump の uuid の行へ寄せ、n が増えるたびに目印（data-hit）を付ける', () => {
    const { container, again } = draw([row('a'), row('b'), row('c')], { jump: null });
    expect(container.querySelector('[data-hit]')).toBeNull();
    again([row('a'), row('b'), row('c')], { jump: { uuid: 'b', n: 1 } });
    expect(container.querySelector('[data-hit]')).toHaveTextContent('本文 b');
  });
});
