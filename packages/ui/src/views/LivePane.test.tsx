import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { act } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { IntentRoot } from '../intent/chain.tsx';
import type { LivePaneProps } from '../presenters/live.ts';
import { fakeMotionTokens } from '../test/motion.ts';
import { LivePane, snapSplit } from './LivePane.tsx';

afterEach(cleanup);

const pane = (p: Partial<LivePaneProps> = {}): LivePaneProps => ({
  lamp: { tone: 'busy', head: '2 本動いている', sub: '失敗 1' },
  intent: { kind: 'said', text: '答え終えた会話だけ止める', meta: 'Claude いわく・01:40・その後 3 手', stale: false },
  steps: [{ key: '1', text: 'テストを走らせる', mono: false, when: '01:41', mark: 'now' }],
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
  it('意図の箱は 1 つで、古い文の控えは動かない環境では出さない', () => {
    const at = (text: string) => <IntentRoot onIntent={vi.fn()}><LivePane sessionId="s1" pane={pane({ intent: { kind: 'said', text, meta: 'm', stale: false } })}><div /></LivePane></IntentRoot>;
    const { rerender } = render(at('A'));
    rerender(at('B'));
    expect(document.querySelectorAll('.live-intent')).toHaveLength(1);
    expect(document.querySelector('.live-intent-ghost')).toBeNull();
    expect(document.querySelector('.live-intent')).toHaveTextContent('B');
  });
  it('動く環境では、文が替わると古い文の控えを重ね、薄れ終えたら外す', async () => {
    const restore = fakeMotionTokens({ '--dur-fast': '200ms', '--dur': '420ms', '--dur-exit': '250ms', '--ease-out': 'ease-out', '--ease-in': 'ease-in', '--rise': '6px', '--blur-in': '6px' }, { everywhere: true });
    const finish: (() => void)[] = [];
    const frames: { el: Element; frames: Keyframe[] }[] = [];
    (HTMLElement.prototype as unknown as { animate: unknown }).animate = function (this: Element, f: Keyframe[]) {
      frames.push({ el: this, frames: f });
      return { finished: new Promise<void>((r) => finish.push(r)), cancel: vi.fn() };
    };
    try {
      const at = (text: string) => <IntentRoot onIntent={vi.fn()}><LivePane sessionId="s1" pane={pane({ intent: { kind: 'said', text, meta: 'm', stale: false } })}><div /></LivePane></IntentRoot>;
      const { rerender } = render(at('A'));
      expect(document.querySelector('.live-intent-ghost')).toBeNull();
      rerender(at('B'));
      expect(document.querySelectorAll('.live-intent')).toHaveLength(1);
      expect(document.querySelector('.live-intent-ghost')).toHaveTextContent('A');
      expect(document.querySelector('.live-intent-now')).toHaveTextContent('B');
      // 箱の高さの滑り、新しい文の入り、控えの抜けの 3 つが動く。
      expect(frames.some((f) => f.el.classList.contains('live-intent') && 'height' in f.frames[0]!)).toBe(true);
      expect(frames.some((f) => f.el.classList.contains('live-intent-now'))).toBe(true);
      expect(frames.some((f) => f.el.classList.contains('live-intent-ghost'))).toBe(true);
      await act(async () => { finish.forEach((f) => f()); await Promise.resolve(); });
      expect(document.querySelector('.live-intent-ghost')).toBeNull();
    } finally {
      restore();
      delete (HTMLElement.prototype as unknown as { animate?: unknown }).animate;
    }
  });
  it('セッションを替えたときは、動く環境でも意図の入れ替えを動かさず、前の文の控えも出さない', () => {
    const restore = fakeMotionTokens({ '--dur-fast': '200ms', '--dur': '420ms', '--dur-exit': '250ms', '--ease-out': 'ease-out', '--ease-in': 'ease-in', '--rise': '6px', '--blur-in': '6px' }, { everywhere: true });
    const frames: { el: Element; frames: Keyframe[] }[] = [];
    (HTMLElement.prototype as unknown as { animate: unknown }).animate = function (this: Element, f: Keyframe[]) {
      frames.push({ el: this, frames: f });
      return { finished: new Promise<void>(() => {}), cancel: vi.fn() };
    };
    try {
      const at = (sessionId: string, text: string) => <IntentRoot onIntent={vi.fn()}><LivePane sessionId={sessionId} pane={pane({ intent: { kind: 'said', text, meta: 'm', stale: false } })}><div /></LivePane></IntentRoot>;
      const { rerender } = render(at('s1', 'A'));
      frames.length = 0;
      rerender(at('s2', 'B'));
      expect(document.querySelector('.live-intent-ghost')).toBeNull();
      expect(document.querySelector('.live-intent')).toHaveTextContent('B');
      expect(frames.filter((f) => f.el.classList.contains('live-intent') || f.el.classList.contains('live-intent-now') || f.el.classList.contains('live-intent-ghost'))).toHaveLength(0);
    } finally {
      restore();
      delete (HTMLElement.prototype as unknown as { animate?: unknown }).animate;
    }
  });
  it('古い意図は data-stale を持つ', () => {
    mount(pane({ intent: { kind: 'said', text: 'x', meta: 'm', stale: true } }));
    expect(document.querySelector('.live-intent')!.getAttribute('data-stale')).toBe('true');
  });

  describe('上下の境目', () => {
    const at = (split: number, onIntent = vi.fn()) => { render(<IntentRoot onIntent={onIntent}><LivePane sessionId="s1" pane={pane()} split={split}><div>目次</div></LivePane></IntentRoot>); return onIntent; };
    it('上の段と目次の間に境目を置き、いまの比率を上の段の上限として渡す', () => {
      at(0.4);
      const sep = screen.getByRole('separator', { name: '「いま」と目次の高さ' });
      expect(sep).toHaveAttribute('aria-orientation', 'horizontal');
      expect(sep).toHaveAttribute('aria-valuenow', '40');
      expect(sep.previousElementSibling).toHaveClass('live-top');
      expect(sep.nextElementSibling).toHaveClass('live-toc');
      expect((document.querySelector('.live') as HTMLElement).style.getPropertyValue('--live-split')).toBe('0.4');
    });
    it('上の段が切れて下に続きがあるときだけ、data-more を付ける', () => {
      const h = (sh: number) => {
        vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockImplementation(function (this: HTMLElement) { return this.classList.contains('live-top') ? sh : 0; });
        vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockImplementation(function (this: HTMLElement) { return this.classList.contains('live-top') ? 200 : 0; });
      };
      h(400);
      at(0.5);
      expect(document.querySelector('.live-top')).toHaveAttribute('data-more', 'true');
      cleanup();
      vi.restoreAllMocks();
      h(200);
      at(0.5);
      expect(document.querySelector('.live-top')).not.toHaveAttribute('data-more');
      vi.restoreAllMocks();
    });
    it('矢印キーで 2% ずつ動かし、ダブルクリックで半分に戻す', () => {
      const onIntent = at(0.5);
      const sep = screen.getByRole('separator');
      fireEvent.keyDown(sep, { key: 'ArrowDown' });
      expect(onIntent).toHaveBeenLastCalledWith({ type: 'livePane.split', ratio: 0.52 });
      fireEvent.keyDown(sep, { key: 'ArrowUp' });
      expect(onIntent).toHaveBeenLastCalledWith({ type: 'livePane.split', ratio: 0.48 });
      fireEvent.doubleClick(sep);
      expect(onIntent).toHaveBeenLastCalledWith({ type: 'livePane.split', ratio: 0.5 });
    });
    it('読み上げの範囲は 0〜100%', () => {
      at(0);
      const sep = screen.getByRole('separator');
      expect(sep).toHaveAttribute('aria-valuemin', '0');
      expect(sep).toHaveAttribute('aria-valuemax', '100');
      expect(sep).toHaveAttribute('aria-valuenow', '0');
    });
    it('矢印キーは端で 0 と 1 に止まる', () => {
      const onIntent = at(1);
      fireEvent.keyDown(screen.getByRole('separator'), { key: 'ArrowDown' });
      expect(onIntent).toHaveBeenLastCalledWith({ type: 'livePane.split', ratio: 1 });
    });
  });
  describe('成果物', () => {
    const art = { id: 'a1', title: '速習資料', description: null, favicon: '📄', url: 'https://claude.ai/code/artifact/a1', lastPublished: '11 時間前', versionCount: 1, canOpenEditor: true };
    it('上の段の終わりに、成果物を題名だけの 1 行ずつ並べ、押すと開く', () => {
      const onIntent = vi.fn();
      render(<IntentRoot onIntent={onIntent}><LivePane sessionId="s1" pane={pane()} artifacts={[art]}><div>目次</div></LivePane></IntentRoot>);
      const top = document.querySelector('.live-top')!;
      expect(top.textContent).toMatch(/成果物.*速習資料/);
      expect(top.textContent!.indexOf('成果物')).toBeGreaterThan(top.textContent!.indexOf('クラウドを査読'));
      fireEvent.click(screen.getByText('速習資料'));
      expect(onIntent).toHaveBeenCalledWith({ type: 'artifact.open', id: 'a1' });
      fireEvent.click(screen.getByRole('button', { name: '速習資料 を VS Code で開く' }));
      expect(onIntent).toHaveBeenCalledWith({ type: 'artifact.openEditor', id: 'a1' });
    });
    it('成果物が無ければ節ごと出さない', () => {
      mount(pane());
      expect(document.querySelector('.live-top')!.textContent).not.toMatch(/成果物/);
    });
  });
});

describe('snapSplit', () => {
  const m = { height: 600, topMin: 36, tocMin: 70 };
  it('上の段が下限まで 24px 以内なら 0 に畳む', () => {
    expect(snapSplit(50 / 600, m)).toBe(0);
    expect(snapSplit(70 / 600, m)).toBeCloseTo(70 / 600);
  });
  it('目次が下限まで 24px 以内なら 1 に畳む', () => {
    expect(snapSplit((600 - 80) / 600, m)).toBe(1);
    expect(snapSplit((600 - 120) / 600, m)).toBeCloseTo(480 / 600);
  });
  it('高さが測れない（0）ときは畳まない', () => {
    expect(snapSplit(0.4, { height: 0, topMin: 0, tocMin: 0 })).toBe(0.4);
  });
});
