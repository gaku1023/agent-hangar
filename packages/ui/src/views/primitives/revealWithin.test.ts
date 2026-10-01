import { describe, expect, it } from 'vitest';
import { revealWithin } from './revealWithin.ts';

/** 箱と要素の位置だけを持つ偽物。jsdom は配置を計算しないので、矩形を手で与える。 */
const box = (top: number, height: number, scrollTop = 0) => ({ scrollTop, getBoundingClientRect: () => ({ top, bottom: top + height, height }) as DOMRect });

describe('revealWithin', () => {
  it('見えていれば動かさない', () => {
    const list = box(100, 300, 40);
    revealWithin(list as unknown as HTMLElement, box(150, 50) as unknown as HTMLElement);
    expect(list.scrollTop).toBe(40);
  });
  it('上にはみ出していれば、頭が箱の上端に来るまで戻す', () => {
    const list = box(100, 300, 40);
    revealWithin(list as unknown as HTMLElement, box(70, 50) as unknown as HTMLElement);
    expect(list.scrollTop).toBe(10);
  });
  it('下にはみ出していれば、尻が箱の下端に来るまで進める', () => {
    const list = box(100, 300, 40);
    revealWithin(list as unknown as HTMLElement, box(380, 60) as unknown as HTMLElement);
    expect(list.scrollTop).toBe(80);
  });
  it('箱より高い要素は、頭を箱の上端に合わせる', () => {
    const list = box(100, 300, 40);
    revealWithin(list as unknown as HTMLElement, box(250, 500) as unknown as HTMLElement);
    expect(list.scrollTop).toBe(190);
  });
});
