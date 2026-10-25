import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { enterAgent, leaveAgent } from './agentSwap.ts';

// jsdom は tokens.css を読まないので、getComputedStyle がトークンの値を返すようにする（motionKit.test.ts と同じ作り）。
const values: Record<string, string> = { '--dur': '420ms', '--dur-fast': '200ms', '--dur-exit': '250ms', '--dur-swap': '150ms', '--stagger': '30ms', '--ease-out': 'ease-out', '--ease-in': 'ease-in', '--rise': '6px', '--blur-in': '6px' };
type Call = { el: Element; frames: Keyframe[]; opts: KeyframeAnimationOptions };
let calls: Call[];
beforeEach(() => {
  calls = [];
  vi.spyOn(window, 'getComputedStyle').mockImplementation(() => ({ getPropertyValue: (n: string) => values[n] ?? '' }) as CSSStyleDeclaration);
  (HTMLElement.prototype as unknown as { animate: unknown }).animate = function (this: Element, frames: Keyframe[], opts: KeyframeAnimationOptions) {
    calls.push({ el: this, frames, opts });
    return { finished: Promise.resolve(), cancel: vi.fn() } as unknown as Animation;
  };
});
afterEach(() => { vi.restoreAllMocks(); delete (HTMLElement.prototype as unknown as { animate?: unknown }).animate; document.body.innerHTML = ''; });

const at = (el: Element, left: number, top = 0) => { el.getBoundingClientRect = () => ({ left, top, width: 10, height: 10, right: left + 10, bottom: top + 10, x: left, y: top, toJSON: () => ({}) }) as DOMRect; };

describe('エージェントの切り替えの動き（M1）', () => {
  it('消える札を --dur-swap で薄れさせ、残る札を滑らせ、新しい札を --stagger ずつずらして入れ、ダイアログの高さを動かす', async () => {
    document.body.innerHTML = `<div class="dialog"><div class="launch-chips"><button id="agent"></button><button id="proj"></button><button id="m" data-agent-only="claude-code"></button><button id="e" data-agent-only="claude-code"></button></div><div id="trust" data-agent-only="claude-code"></div></div>`;
    const dialog = document.querySelector<HTMLElement>('.dialog')!;
    Object.defineProperty(dialog, 'offsetHeight', { configurable: true, get: () => 300 });
    at(document.getElementById('proj')!, 100);
    const snap = await leaveAgent(dialog, 'claude-code');
    expect(calls.map((c) => (c.el as HTMLElement).id)).toEqual(['m', 'e', 'trust']);
    expect(calls.every((c) => c.opts.duration === 150 && c.opts.fill === 'forwards')).toBe(true);
    expect([...snap.rects.keys()].map((e) => (e as HTMLElement).id)).toEqual(['agent', 'proj']);
    expect(snap.height).toBe(300);

    // 入れ替えた後の描画。プロジェクトの札は左へ寄り、opencode の札が 3 枚入る。ダイアログは低くなる。
    calls = [];
    const chips = dialog.querySelector('.launch-chips')!;
    for (const id of ['m', 'e']) document.getElementById(id)!.remove();
    document.getElementById('trust')!.remove();
    chips.insertAdjacentHTML('beforeend', '<button id="mode" data-agent-only="opencode"></button><button id="model" data-agent-only="opencode"></button><button id="auto" data-agent-only="opencode"></button>');
    at(document.getElementById('proj')!, 60);
    Object.defineProperty(dialog, 'offsetHeight', { configurable: true, get: () => 260 });
    enterAgent(snap, 'opencode');
    const by = (id: string) => calls.filter((c) => (c.el as HTMLElement).id === id);
    expect(calls.find((c) => c.el === dialog)?.frames).toEqual([{ height: '300px' }, { height: '260px' }]);
    expect(by('proj')[0]?.frames[0]).toEqual({ transform: 'translate(40px, 0px)' });
    expect(['mode', 'model', 'auto'].map((id) => by(id)[0]?.opts.delay)).toEqual([0, 30, 60]);
  });
});
