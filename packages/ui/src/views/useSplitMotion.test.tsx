import { act, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PaneNode, PanesState } from '../mediator/panes.ts';
import { classify, frameOf, play, useSplitMotion, type Frame } from './useSplitMotion.ts';

const leaf = (id: string, sessionId: string | null): PaneNode => ({ kind: 'pane', id, sessionId, toc: false });
const row = (a: PaneNode, b: PaneNode): PaneNode => ({ kind: 'split', id: 'n1', dir: 'row', ratio: 0.5, a, b });
const panes = (root: PaneNode | null, zoom: string | null = null): PanesState => ({ root, focus: null, zoom, flash: null });

describe('frameOf と classify', () => {
  it('セッション画面でなければ count 0。ペインが 1 つなら 1 つ、2 つ以上なら分割', () => {
    expect(frameOf(false, null, panes(null)).count).toBe(0);
    expect(frameOf(true, 's1', panes(leaf('p1', 's1'))).count).toBe(1);
    const f = frameOf(true, 's1', panes(row(leaf('p1', 's1'), leaf('p2', 's2'))));
    expect(f.count).toBe(2);
    expect(f.leafIds).toEqual(['p1', 'p2']);
  });
  it('比率だけが替わっても鍵は同じ（境目のドラッグでは動かさない）。並びや最大化、中身では替わる', () => {
    const a = frameOf(true, 's1', panes(row(leaf('p1', 's1'), leaf('p2', 's2'))));
    const b = frameOf(true, 's1', panes({ ...(row(leaf('p1', 's1'), leaf('p2', 's2'))) as Extract<PaneNode, { kind: 'split' }>, ratio: 0.7 }));
    expect(b.key).toBe(a.key);
    expect(classify(a, b)).toBeNull();
    expect(frameOf(true, 's1', panes(row(leaf('p2', 's2'), leaf('p1', 's1')))).key).not.toBe(a.key);
    expect(frameOf(true, 's1', panes(row(leaf('p1', 's1'), leaf('p2', 's2')), 'p1')).key).not.toBe(a.key);
  });
  it('どの動きかを選ぶ。画面の行き来には動きが無い', () => {
    const one = (s: string): Frame => frameOf(true, s, panes(leaf('p1', s)));
    const two = frameOf(true, 's1', panes(row(leaf('p1', 's1'), leaf('p2', 's2'))));
    const three = frameOf(true, 's1', panes(row(leaf('p1', 's1'), row(leaf('p2', 's2'), leaf('p3', 's3')))));
    expect(classify(one('s1'), two)).toBe('split');
    expect(classify(two, one('s1'))).toBe('unsplit');
    expect(classify(one('s1'), one('s2'))).toBe('retitle');
    expect(classify(one('s1'), one('s1'))).toBeNull();
    expect(classify(two, three)).toBe('tree');
    const away = frameOf(false, null, panes(null));
    expect(classify(away, one('s1'))).toBeNull();
    expect(classify(two, away)).toBeNull();
  });
});

describe('useSplitMotion', () => {
  const animate = vi.fn(() => ({ finished: Promise.resolve(), cancel: vi.fn() }));
  let values: Record<string, string> = {};
  beforeEach(() => {
    values = { '--dur': '420ms', '--dur-fast': '200ms', '--dur-exit': '250ms', '--stagger': '30ms', '--ease-out': 'ease-out', '--ease-in': 'ease-in', '--blur-in': '6px', '--rise': '6px' };
    vi.spyOn(window, 'getComputedStyle').mockImplementation(() => ({ getPropertyValue: (n: string) => values[n] ?? '', fontSize: '15px', fontFamily: '' }) as unknown as CSSStyleDeclaration);
    (HTMLElement.prototype as unknown as { animate: unknown }).animate = animate;
    animate.mockClear();
  });
  afterEach(() => { vi.restoreAllMocks(); delete (HTMLElement.prototype as unknown as { animate?: unknown }).animate; document.body.innerHTML = ''; });

  const Probe = (p: { frame: Frame; split: boolean }) => {
    useSplitMotion(p.frame);
    return p.split
      ? <div data-pane-workspace="true"><div data-pane="p1" data-session="s1"><div className="pane-head"><span className="pane-head-title">A</span><span className="pane-head-ctl" /></div></div><div data-pane="p2" data-session="s2" /></div>
      : <div className="session-screen"><div className="page-head"><h1 className="page-title">A</h1></div></div>;
  };
  const one = frameOf(true, 's1', panes(leaf('p1', 's1')));
  const two = frameOf(true, 's1', panes(row(leaf('p1', 's1'), leaf('p2', 's2'))));

  it('最初の描画と、形が同じ再描画では動かさない', () => {
    const { rerender } = render(<Probe frame={one} split={false} />);
    rerender(<Probe frame={frameOf(true, 's1', panes(leaf('p1', 's1')))} split={false} />);
    expect(animate).not.toHaveBeenCalled();
  });

  it('1 つ → 分割で、新しいペインがぼかしと縮小から出て、元のペインの見出しが伸びる', () => {
    const { rerender } = render(<Probe frame={one} split={false} />);
    rerender(<Probe frame={two} split={true} />);
    const named = animate.mock.calls.map((c) => c as unknown as [Keyframe[], KeyframeAnimationOptions]);
    // 新しいペイン（p2）のぼかしと縮小。
    expect(named.some(([f]) => f[0]?.transform === 'scale(0.985)')).toBe(true);
    // 元のペインの見出し（growIn の高さ 0 からの伸び）。
    expect(named.some(([f]) => f[0]?.height === '0px')).toBe(true);
  });

  it('分割 → 1 つで、見出しへ飛ぶ名前は残ったペインのもの。薄れて縮むのは閉じるペインだけ', () => {
    // 操作中のセッション（画面の id）は s2 だが、残るのは p1（s1、名前 A）。
    const Two = (p: { frame: Frame; split: boolean }) => {
      useSplitMotion(p.frame);
      return p.split
        ? <div data-pane-workspace="true"><div data-pane="p1" data-session="s1" data-testid="p1"><div className="pane-head"><span className="pane-head-title">A</span></div></div><div data-pane="p2" data-session="s2" data-testid="p2"><div className="pane-head"><span className="pane-head-title">B</span></div></div></div>
        : <div className="session-screen"><div className="page-head"><h1 className="page-title">A</h1></div></div>;
    };
    const keep = frameOf(true, 's2', panes(leaf('p1', 's1')));
    const { rerender, getByTestId } = render(<Two frame={two} split={true} />);
    const p1 = getByTestId('p1');
    const p2 = getByTestId('p2');
    rerender(<Two frame={keep} split={false} />);
    expect(document.body.querySelector('.pane-fly')?.textContent).toBe('A');
    expect(p2.getAttribute('aria-hidden')).toBe('true');
    expect(p1.getAttribute('aria-hidden')).toBeNull();
  });

  describe('閉じるとき（矩形は data-r の [left, top, width, height]）', () => {
    beforeEach(() => {
      vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
        const [left, top, width, height] = JSON.parse(this.getAttribute('data-r') ?? '[0,0,0,0]') as number[];
        return { left, top, width, height, right: left! + width!, bottom: top! + height!, x: left, y: top, toJSON: () => ({}) } as DOMRect;
      });
    });
    const calls = () => animate.mock.calls.map((c) => c as unknown as [Keyframe[], KeyframeAnimationOptions]);

    it('分割 → 1 つで、1 つの画面は残ったペインの場所から広がり、閉じるペインはその下で薄れる', () => {
      const Two = (p: { frame: Frame; split: boolean }) => {
        useSplitMotion(p.frame);
        return p.split
          ? <div data-pane-workspace="true"><div data-pane="p1" data-session="s1" data-r="[0,0,400,600]" /><div data-pane="p2" data-session="s2" data-r="[400,0,400,600]" data-testid="p2" /></div>
          : <div data-testid="host"><div className="session-screen" data-r="[0,0,800,600]" data-testid="screen" /></div>;
      };
      const { rerender, getByTestId } = render(<Two frame={two} split={true} />);
      const p2 = getByTestId('p2');
      rerender(<Two frame={frameOf(true, 's1', panes(leaf('p1', 's1')))} split={false} />);
      const screen = getByTestId('screen');
      expect(p2.nextElementSibling).toBe(screen);
      expect(p2.style.zIndex).toBe('');
      expect(calls().find(([f]) => f[0]?.clipPath)?.[0][0]).toEqual({ transform: 'translate(0px, 0px)', clipPath: 'inset(0px 400px 0px 0px)' });
      expect(calls().map(([f]) => f)).toContainEqual([{ opacity: 1 }, { opacity: 0 }]);
    });

    it('分割 → 1 つで、新しい 1 つの画面の入場（CSS の enter）はすぐ終わらせる。同じセッションなので薄れて出し直さない', () => {
      const finished: Element[] = [];
      (Element.prototype as unknown as { getAnimations: unknown }).getAnimations = function (this: Element) {
        return [...this.querySelectorAll('.screen'), ...(this.matches('.screen') ? [this] : [])].map((target) => ({ animationName: 'enter', effect: { target }, finish: () => finished.push(target) }));
      };
      try {
        const Two = (p: { frame: Frame; split: boolean }) => {
          useSplitMotion(p.frame);
          return p.split
            ? <div data-pane-workspace="true"><div data-pane="p1" data-session="s1" data-r="[0,0,400,600]" /><div data-pane="p2" data-session="s2" data-r="[400,0,400,600]" /></div>
            : <div><div className="screen session-screen" data-r="[0,0,800,600]" data-testid="screen" /></div>;
        };
        const { rerender, getByTestId } = render(<Two frame={two} split={true} />);
        rerender(<Two frame={frameOf(true, 's1', panes(leaf('p1', 's1')))} split={false} />);
        expect(finished).toContain(getByTestId('screen'));
      } finally {
        delete (Element.prototype as unknown as { getAnimations?: unknown }).getAnimations;
      }
    });

    it('分割のまま閉じたら、残るペインは伸ばされず、元の場所から広がる。閉じるペインはその下で薄れる', () => {
      const three = frameOf(true, 's1', panes(row(leaf('p1', 's1'), { kind: 'split', id: 'n2', dir: 'col', ratio: 0.5, a: leaf('p2', 's2'), b: leaf('p3', 's3') })));
      const after = frameOf(true, 's2', panes({ kind: 'split', id: 'n2', dir: 'row', ratio: 0.5, a: leaf('p2', 's2'), b: leaf('p3', 's3') }));
      const Ws = (p: { frame: Frame; closed: boolean }) => {
        useSplitMotion(p.frame);
        return p.closed
          ? <div data-pane-workspace="true"><div key="p2" data-pane="p2" data-session="s2" data-r="[0,0,400,600]" data-testid="p2" /><div key="p3" data-pane="p3" data-session="s3" data-r="[400,0,400,600]" /></div>
          : <div data-pane-workspace="true"><div key="p1" data-pane="p1" data-session="s1" data-r="[0,0,400,600]" data-testid="p1" /><div key="p2" data-pane="p2" data-session="s2" data-r="[400,0,400,300]" /><div key="p3" data-pane="p3" data-session="s3" data-r="[400,300,400,300]" /></div>;
      };
      const { rerender, getByTestId } = render(<Ws frame={three} closed={false} />);
      const p1 = getByTestId('p1');
      rerender(<Ws frame={after} closed={true} />);
      const frames = calls().map(([f]) => f[0]!);
      expect(frames.some((f) => String(f.transform ?? '').includes('scale'))).toBe(false);
      expect(frames).toContainEqual({ transform: 'translate(400px, 0px)', clipPath: 'inset(0px 0px 300px 0px)' });
      expect(frames).toContainEqual({ transform: 'translate(0px, 300px)', clipPath: 'inset(0px 0px 300px 0px)' });
      expect(p1.nextElementSibling).toBe(getByTestId('p2'));
    });
  });

  it('動きを減らす設定（--dur が 0）では、測りも動かしもしない', () => {
    values['--dur'] = '0ms';
    const { rerender } = render(<Probe frame={one} split={false} />);
    rerender(<Probe frame={two} split={true} />);
    rerender(<Probe frame={one} split={false} />);
    expect(animate).not.toHaveBeenCalled();
    act(() => undefined);
  });

  it('play は、行き先の DOM が無くても落ちない', () => {
    play('split', { frame: one, head: null, screen: null, panes: new Map() }, two, document.createElement('div'));
    play('tree', { frame: two, head: null, screen: null, panes: new Map() }, two, document.createElement('div'));
    expect(animate).not.toHaveBeenCalled();
  });
});
