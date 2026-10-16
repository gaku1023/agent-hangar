// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { wrapComposition } from './compositionWrap.ts';
import { createTerminalHost, type TerminalLike } from './terminals.ts';

/**
 * xterm.js 6 の要素の並びをまねた偽物。
 * 変換が進むと、xterm は composition-view の textContent を差し替え、left と top と height をカーソルの位置に置く（CompositionHelper.updateCompositionElements）。
 * ここでも同じことを textarea の composition の知らせで行う。
 */
function fakeXterm(screenWidth: number, cursorLeft: number, opts: { screenHeight?: number; cursorTop?: number } = {}) {
  const size = { width: screenWidth, height: opts.screenHeight ?? 216 };
  /** 折り返した箱の行の数。jsdom は配置を計らないので、試験が決める。 */
  const box = { lines: 1 };
  const root = document.createElement('div');
  root.className = 'xterm';
  const screen = document.createElement('div');
  screen.className = 'xterm-screen';
  Object.defineProperty(screen, 'offsetWidth', { get: () => size.width });
  Object.defineProperty(screen, 'offsetHeight', { get: () => size.height });
  const helpers = document.createElement('div');
  helpers.className = 'xterm-helpers';
  const textarea = document.createElement('textarea');
  const view = document.createElement('div');
  view.className = 'composition-view';
  Object.defineProperty(view, 'offsetHeight', { get: () => box.lines * 18 });
  helpers.append(textarea, view);
  root.append(screen, helpers);
  document.body.append(root);
  textarea.addEventListener('compositionstart', () => { view.textContent = ''; view.classList.add('active'); });
  textarea.addEventListener('compositionupdate', (e) => {
    view.textContent = (e as CompositionEvent).data;
    view.style.left = `${cursorLeft}px`;
    view.style.top = `${opts.cursorTop ?? 36}px`;
    view.style.height = '18px';
    view.style.lineHeight = '18px';
  });
  const compose = (data: string) => {
    textarea.dispatchEvent(new CompositionEvent('compositionstart', { data: '' }));
    textarea.dispatchEvent(new CompositionEvent('compositionupdate', { data }));
  };
  textarea.addEventListener('compositionend', () => { view.classList.remove('active'); });
  const end = () => { textarea.dispatchEvent(new CompositionEvent('compositionend', { data: '' })); };
  return { root, screen, view, compose, end, size, box };
}

/** jsdom に ResizeObserver は無いので、見ている要素を覚え、試験が知らせを出す偽物を置く。 */
class FakeResizeObserver {
  static all: FakeResizeObserver[] = [];
  targets = new Set<Element>();
  constructor(private readonly cb: ResizeObserverCallback) { FakeResizeObserver.all.push(this); }
  observe(el: Element) { this.targets.add(el); }
  unobserve(el: Element) { this.targets.delete(el); }
  disconnect() { this.targets.clear(); }
  /** el を見ている観察者すべてに、大きさが変わったと知らせる。 */
  static fire(el: Element) {
    for (const o of FakeResizeObserver.all) if (o.targets.has(el)) o.cb([], o as unknown as ResizeObserver);
  }
  static watching(el: Element) { return FakeResizeObserver.all.some((o) => o.targets.has(el)); }
}

/** MutationObserver の知らせは microtask で届く。 */
const flush = () => new Promise<void>((r) => { setTimeout(r, 0); });
const px = (v: string) => parseFloat(v);

beforeEach(() => { FakeResizeObserver.all = []; vi.stubGlobal('ResizeObserver', FakeResizeObserver); });
afterEach(() => { document.body.innerHTML = ''; vi.unstubAllGlobals(); });
const marginTop = (v: HTMLElement) => px(v.style.marginTop || '0');

describe('wrapComposition（変換中の文字をターミナルの右端で折り返す）', () => {
  it('箱の幅をターミナルの幅に合わせ、左端まで戻し、1 行目だけカーソルの位置まで字下げする', async () => {
    const x = fakeXterm(640, 200);
    wrapComposition(x.root);
    x.compose('きょうはとてもいいてんきなのでさんぽにいこうとおもっています');
    await flush();
    // xterm が置いた left はそのまま使う。
    expect(x.view.style.left).toBe('200px');
    expect(px(x.view.style.width)).toBe(640);
    expect(px(x.view.style.marginLeft)).toBe(-200);
    expect(px(x.view.style.textIndent)).toBe(200);
    // 箱の右端（left＋margin＋width）がターミナルの右端を超えない。
    expect(px(x.view.style.left) + px(x.view.style.marginLeft) + px(x.view.style.width)).toBeLessThanOrEqual(640);
  });
  it('文字は 1 つの span に入れ、xterm が差し替えるたびに入れ直す。文字そのものは変えない', async () => {
    const x = fakeXterm(640, 80);
    wrapComposition(x.root);
    x.compose('かんじ');
    await flush();
    expect(x.view.children).toHaveLength(1);
    expect(x.view.firstElementChild).toHaveClass('composition-text');
    expect(x.view.textContent).toBe('かんじ');
    x.compose('かんじへんかん');
    await flush();
    expect(x.view.children).toHaveLength(1);
    expect(x.view.textContent).toBe('かんじへんかん');
  });
  it('カーソルが動けば字下げも追う', async () => {
    let left = 40;
    const x = fakeXterm(500, 0);
    wrapComposition(x.root);
    x.view.ownerDocument.querySelector('textarea')!.addEventListener('compositionupdate', () => { x.view.style.left = `${left}px`; });
    x.compose('あ');
    await flush();
    expect(px(x.view.style.textIndent)).toBe(40);
    left = 120;
    x.compose('あい');
    await flush();
    expect(px(x.view.style.textIndent)).toBe(120);
    expect(px(x.view.style.marginLeft)).toBe(-120);
  });
  it('止めた後は手を出さない', async () => {
    const x = fakeXterm(640, 200);
    const stop = wrapComposition(x.root);
    stop();
    x.compose('あいう');
    await flush();
    expect(x.view.style.width).toBe('');
    expect(x.view.firstElementChild).toBeNull();
  });
  it('composition-view が無ければ何もしない', () => {
    const root = document.createElement('div');
    expect(() => wrapComposition(root)()).not.toThrow();
  });
});

describe('wrapComposition（ターミナルの下端を超える分は上へずらす）', () => {
  it('下端の近くで 3 行に折り返すと、超えた行の数だけ箱を上へずらし、下端を超えない', async () => {
    // 12 行のターミナル（216px）の最後の行（top 198px）で打つ。
    const x = fakeXterm(640, 200, { screenHeight: 216, cursorTop: 198 });
    wrapComposition(x.root);
    x.box.lines = 3;
    x.compose('きょうはとてもいいてんきなのでさんぽにいこうとおもっています');
    await flush();
    // xterm が置いた top はそのまま使い、margin-top で 2 行分上げる。
    expect(x.view.style.top).toBe('198px');
    expect(marginTop(x.view)).toBe(-36);
    expect(px(x.view.style.top) + marginTop(x.view) + x.view.offsetHeight).toBeLessThanOrEqual(216);
    // 1 行目の字下げは変えない。
    expect(px(x.view.style.textIndent)).toBe(200);
    expect(px(x.view.style.marginLeft)).toBe(-200);
  });
  it('下端を超えなければずらさない', async () => {
    const x = fakeXterm(640, 200, { screenHeight: 216, cursorTop: 36 });
    wrapComposition(x.root);
    x.box.lines = 3;
    x.compose('かんじ');
    await flush();
    expect(marginTop(x.view)).toBe(0);
  });
  it('行が減れば上げた分も戻す', async () => {
    const x = fakeXterm(640, 200, { screenHeight: 216, cursorTop: 198 });
    wrapComposition(x.root);
    x.box.lines = 3;
    x.compose('ながいながいもじ');
    await flush();
    expect(marginTop(x.view)).toBe(-36);
    x.box.lines = 1;
    x.compose('みじかい');
    await flush();
    expect(marginTop(x.view)).toBe(0);
  });
  it('ターミナルの高さより行が多いときは、末尾（いま打っている所）が見える側を取る', async () => {
    // 4 行のターミナル（72px）の 4 行目（top 54px）で、7 行に折り返す。
    const x = fakeXterm(640, 200, { screenHeight: 72, cursorTop: 54 });
    wrapComposition(x.root);
    x.box.lines = 7;
    x.compose('あ'.repeat(200));
    await flush();
    // 箱の下端がちょうどターミナルの下端に来る。上の行は切れてよい。
    expect(px(x.view.style.top) + marginTop(x.view) + x.view.offsetHeight).toBe(72);
  });
});

describe('wrapComposition（ターミナルの大きさが変わったら当て直す）', () => {
  it('変換中に幅が変わると、幅と字下げを当て直す', async () => {
    const x = fakeXterm(640, 200);
    wrapComposition(x.root);
    x.compose('かんじ');
    await flush();
    expect(px(x.view.style.width)).toBe(640);
    x.size.width = 400;
    FakeResizeObserver.fire(x.screen);
    expect(px(x.view.style.width)).toBe(400);
  });
  it('変換中に高さが変わると、上へのずらしを当て直す', async () => {
    const x = fakeXterm(640, 200, { screenHeight: 400, cursorTop: 198 });
    wrapComposition(x.root);
    x.box.lines = 3;
    x.compose('ながいながいもじ');
    await flush();
    expect(marginTop(x.view)).toBe(0);
    x.size.height = 216;
    FakeResizeObserver.fire(x.screen);
    expect(marginTop(x.view)).toBe(-36);
  });
  it('変換中でなければ、大きさが変わっても手を出さない', async () => {
    const x = fakeXterm(640, 200);
    wrapComposition(x.root);
    x.compose('かんじ');
    await flush();
    x.end();
    await flush();
    x.size.width = 400;
    FakeResizeObserver.fire(x.screen);
    expect(px(x.view.style.width)).toBe(640);
  });
  it('止めると大きさの見張りも外す', () => {
    const x = fakeXterm(640, 200);
    const stop = wrapComposition(x.root);
    expect(FakeResizeObserver.watching(x.screen)).toBe(true);
    stop();
    expect(FakeResizeObserver.watching(x.screen)).toBe(false);
  });
  it('文書から外れても見張りを止めず、付け直したあとの変換で幅と字下げを当てる', async () => {
    // アプリはターミナルを捨てずに取っておき、別の画面へ移ると文書から外し、戻ると付け直す（terminals.ts）。
    const x = fakeXterm(640, 200);
    wrapComposition(x.root);
    x.root.remove();
    // 外れている間は大きさが 0 になる。知らせが来ても何もしないで返す。
    x.size.width = 0;
    FakeResizeObserver.fire(x.screen);
    expect(FakeResizeObserver.watching(x.screen)).toBe(true);
    document.body.append(x.root);
    x.size.width = 924;
    FakeResizeObserver.fire(x.screen);
    x.compose('ながいながいもじ');
    await flush();
    expect(px(x.view.style.width)).toBe(924);
    expect(px(x.view.style.marginLeft)).toBe(-200);
    expect(px(x.view.style.textIndent)).toBe(200);
  });
  it('外れている間に変換中の知らせが来ても、幅を 0 にしない', async () => {
    const x = fakeXterm(640, 200);
    wrapComposition(x.root);
    x.compose('かんじ');
    await flush();
    x.root.remove();
    x.size.width = 0;
    FakeResizeObserver.fire(x.screen);
    expect(px(x.view.style.width)).toBe(640);
  });
  it('ResizeObserver が無い環境でも動く', async () => {
    vi.stubGlobal('ResizeObserver', undefined);
    const x = fakeXterm(640, 200);
    const stop = wrapComposition(x.root);
    x.compose('かんじ');
    await flush();
    expect(px(x.view.style.width)).toBe(640);
    expect(() => stop()).not.toThrow();
  });
});

describe('wrapComposition（取っておいたターミナルを付け直す流れ）', () => {
  /** open で偽の xterm の要素を枠に入れ、xterm.ts と同じく wrapComposition を掛ける TerminalLike。 */
  function hostWithFakeXterm() {
    const xs: ReturnType<typeof fakeXterm>[] = [];
    const createTerminal = (): TerminalLike => {
      let x: ReturnType<typeof fakeXterm> | null = null;
      let stopWrap = () => {};
      return {
        cols: 80, rows: 24,
        get element() { return x?.root ?? null; },
        open(el) { x = fakeXterm(924, 200); xs.push(x); el.appendChild(x.root); stopWrap(); stopWrap = wrapComposition(x.root); },
        write() {}, onData: () => ({ dispose() {} }), onResize: () => ({ dispose() {} }),
        fit() {}, focus() {}, dispose() { stopWrap(); }, setGpu() {}, paste() {}, setFontSize() {},
      };
    };
    const host = createTerminalHost({ wsUrl: (id) => `ws://x/${id}`, createTerminal, wsFactory: () => ({ close() {} }) as unknown as WebSocket, held: () => false });
    return { host, xs };
  }
  it('別の画面へ移って戻ったあとも、変換中の文字に幅と字下げを当てる', async () => {
    const { host, xs } = hostWithFakeXterm();
    const first = document.createElement('div');
    document.body.append(first);
    host.mount('t1', first);
    const x = xs[0]!;
    // 別の画面へ移ると、React が枠ごと文書から外す。外れている間の大きさは 0 で、ResizeObserver が知らせる。
    first.remove();
    x.size.width = 0;
    FakeResizeObserver.fire(x.screen);
    // 戻ると新しい枠に付け直す。
    const second = document.createElement('div');
    document.body.append(second);
    host.mount('t1', second);
    x.size.width = 924;
    FakeResizeObserver.fire(x.screen);
    x.compose('ながいながいもじ');
    await flush();
    expect(x.root.parentElement).toBe(second);
    expect(px(x.view.style.width)).toBe(924);
    expect(px(x.view.style.marginLeft)).toBe(-200);
    expect(px(x.view.style.textIndent)).toBe(200);
  });
  it('ターミナルを捨てると見張りを止める', () => {
    const { host, xs } = hostWithFakeXterm();
    const el = document.createElement('div');
    document.body.append(el);
    host.mount('t1', el);
    expect(FakeResizeObserver.watching(xs[0]!.screen)).toBe(true);
    host.dispose();
    expect(FakeResizeObserver.watching(xs[0]!.screen)).toBe(false);
  });
});
