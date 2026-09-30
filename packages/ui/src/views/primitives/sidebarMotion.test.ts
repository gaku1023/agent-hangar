// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { LAYOUT_SETTLED, MOVING_ATTR, playSidebarMotion, swingKeyframes, swingMs } from './sidebarMotion.ts';

const deg = (k: Keyframe) => Number(/rotate\((-?[\d.]+)deg\)/.exec(String(k.transform))![1]);

describe('サイドバーの開閉の動き', () => {
  // 図のハンガーは、起動画面と同じ振り子で揺れて止まる（角速度 6.3 rad/s、減衰 2.4 /s）。
  it('振り子は 0° から始まり、引かれた向きへ振れて、止まるころには 0° へ戻る', () => {
    const k = swingKeyframes(1);
    expect(deg(k[0]!)).toBe(0);
    expect(Math.max(...k.map(deg))).toBeGreaterThan(3);
    expect(Math.abs(deg(k.at(-1)!))).toBeLessThan(0.2);
    expect(Math.min(...swingKeyframes(-1).map(deg))).toBeLessThan(-3);
  });
  it('揺れの長さは減衰から決まる', () => {
    expect(swingMs()).toBeGreaterThan(1000);
    expect(swingMs()).toBeLessThan(2500);
  });
  // jsdom は --dur を読めず 0 になる。reduced motion のときと同じく、動かさずに止まったことだけを知らせる。
  it('長さが 0 なら動かさず、動いている印を残さずに、止まったことを知らせる', () => {
    document.body.innerHTML = '<div class="shell" data-sidebar="collapsed"></div>';
    const shell = document.querySelector<HTMLElement>('.shell')!;
    const settled = vi.fn();
    window.addEventListener(LAYOUT_SETTLED, settled);
    playSidebarMotion(shell);
    expect(shell.hasAttribute(MOVING_ATTR)).toBe(false);
    expect(settled).toHaveBeenCalledTimes(1);
    window.removeEventListener(LAYOUT_SETTLED, settled);
  });
});
