// @vitest-environment jsdom
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// 起動画面（loading/boot.js）を jsdom で動かす。
// 描画の時計（requestAnimationFrame と performance.now）は試験が進める。
type BootFrames = { CYCLE_MS: number; frameSvg(T: number): string; nearestBoundary(ms: number): number };
const loading = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'loading');
const m = (await import(pathToFileURL(path.join(loading, 'boot-frames.js')).href)) as BootFrames;
const body = fs.readFileSync(path.join(loading, 'index.html'), 'utf8').match(/<body>([\s\S]*)<\/body>/)![1]!.replace(/<script[\s\S]*?<\/script>/g, '');
const win = window as unknown as { __hangarBootSettle?: () => void };

let frames: Map<number, FrameRequestCallback>;
let clock: number;
let loads = 0;
const T0 = 1000;
// 1 コマ進める。待っている描画を、その時刻で呼ぶ。
const step = (ms: number) => {
  clock = T0 + ms;
  const due = [...frames.entries()];
  frames.clear();
  for (const [, cb] of due) cb(clock);
};
const boot = async (reduced = false) => {
  vi.stubGlobal('matchMedia', (q: string) => ({ matches: reduced && q.includes('reduce'), media: q }));
  // 同じ頁を試験ごとに新しく読み込む。
  await import(`${pathToFileURL(path.join(loading, 'boot.js')).href}?n=${++loads}`);
};
const svg = () => document.querySelector('main svg');
// innerHTML は書いた文字列を整え直して返すので、同じ整え方を通した絵と比べる。
const drawn = (T: number) => { const el = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); el.innerHTML = m.frameSvg(T); return el.innerHTML; };

beforeEach(() => {
  document.body.innerHTML = body;
  frames = new Map();
  clock = T0;
  let seq = 0;
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => { frames.set(++seq, cb); return seq; });
  vi.stubGlobal('cancelAnimationFrame', (id: number) => { frames.delete(id); });
  vi.spyOn(performance, 'now').mockImplementation(() => clock);
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
  delete win.__hangarBootSettle;
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('起動画面の動き', () => {
  it('頁の読み込みから数えた時刻の絵を、コマごとに描き続ける', async () => {
    await boot();
    expect(document.getElementById('logo')).toBeNull();
    step(500);
    expect(svg()!.innerHTML).toBe(drawn(0.5));
    expect(frames.size).toBe(1);
  });
  it('失敗の文が出たら、流れを止め、いちばん近い周の境目の絵で静止する', async () => {
    await boot();
    step(500);
    document.getElementById('status')!.dataset.level = 'error';
    step(3 * m.CYCLE_MS + 40);
    expect(svg()!.innerHTML).toBe(drawn(3 * m.CYCLE_MS / 1000));
    expect(frames.size).toBe(0);
  });
  it('殻が止める口を呼ぶと、流れを止め、待った周の境目の絵で静止する', async () => {
    await boot();
    step(500);
    clock = T0 + 2 * m.CYCLE_MS + 3;
    win.__hangarBootSettle!();
    expect(svg()!.innerHTML).toBe(drawn(2 * m.CYCLE_MS / 1000));
    // 止めた後に残っていたコマが走っても、描き直さない。
    step(2 * m.CYCLE_MS + 16);
    expect(svg()!.innerHTML).toBe(drawn(2 * m.CYCLE_MS / 1000));
    expect(frames.size).toBe(0);
  });
  it('reduced motion では静止した原図のまま動かさず、止める口を呼ばれても何も起きない', async () => {
    await boot(true);
    expect(document.getElementById('logo')).not.toBeNull();
    expect(frames.size).toBe(0);
    expect(() => win.__hangarBootSettle?.()).not.toThrow();
    expect(document.getElementById('logo')).not.toBeNull();
  });
});
