// @vitest-environment jsdom
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// 起動画面（loading/boot.js）を jsdom で動かす。
// 描画の時計（requestAnimationFrame と performance.now）は試験が進める。
type BootFrames = { CYCLE_MS: number; FINISH_MS: number; BEAT_S: number; frameSvg(T: number): string; finishSvg(Tb: number, tb: number): string; nearestBoundary(ms: number): number };
const loading = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'loading');
const m = (await import(pathToFileURL(path.join(loading, 'boot-frames.js')).href)) as BootFrames;
const body = fs.readFileSync(path.join(loading, 'index.html'), 'utf8').match(/<body>([\s\S]*)<\/body>/)![1]!.replace(/<script[\s\S]*?<\/script>/g, '');
const win = window as unknown as { __hangarBootFinish?: () => void; __hangarBootProgress?: (p: { phase: string; done: number; total: number }) => void };

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
const tidy = (html: string) => { const el = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); el.innerHTML = html; return el.innerHTML; };
const drawn = (T: number) => tidy(m.frameSvg(T));
const finished = (Tb: number, tb: number) => tidy(m.finishSvg(Tb, tb));
const $ = (id: string) => document.getElementById(id)!;
// MutationObserver の知らせは、今の処理が終わった後に届く。
const flush = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  document.body.innerHTML = body;
  frames = new Map();
  clock = T0;
  let seq = 0;
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => { frames.set(++seq, cb); return seq; });
  vi.stubGlobal('cancelAnimationFrame', (id: number) => { frames.delete(id); });
  vi.spyOn(performance, 'now').mockImplementation(() => clock);
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
  delete win.__hangarBootFinish;
  delete win.__hangarBootProgress;
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// 待っている間の文は頁が受け持つ。殻が書くのは失敗の文と、索引の進み具合（__hangarBootProgress）だけである。
describe('待っている間の文', () => {
  const text = () => $('status').textContent;
  const at = (ms: number) => { clock = T0 + ms; vi.advanceTimersByTime(100); };
  it('「読み込み中」の後ろの点が、ハンガーの周期で増えて戻る', async () => {
    await boot();
    at(0);
    expect(text()).toBe('読み込み中.');
    at(m.CYCLE_MS / 3 + 1);
    expect(text()).toBe('読み込み中..');
    at((2 * m.CYCLE_MS) / 3 + 1);
    expect(text()).toBe('読み込み中...');
    at(m.CYCLE_MS + 1);
    expect(text()).toBe('読み込み中.');
  });
  it('3 秒を超えたら秒数を添える', async () => {
    await boot();
    at(3200);
    expect(text()).toMatch(/^読み込み中\.+（3 秒）$/);
  });
  it('最初の周の境目を過ぎても済んでいなければ、殻から届いた進み具合を下に出す', async () => {
    await boot();
    win.__hangarBootProgress!({ phase: 'indexing', done: 412, total: 987 });
    at(m.CYCLE_MS - 100);
    expect($('detail').textContent).toBe('');
    at(m.CYCLE_MS + 100);
    expect($('detail').textContent).toBe('セッションを索引中 412 / 987 件');
    win.__hangarBootProgress!({ phase: 'indexing', done: 600, total: 987 });
    at(m.CYCLE_MS + 200);
    expect($('detail').textContent).toBe('セッションを索引中 600 / 987 件');
  });
  it('進み具合が届く前は、サーバの起動を待っていると出す', async () => {
    await boot();
    at(m.CYCLE_MS + 100);
    expect($('detail').textContent).toBe('サーバを起動中');
  });
  it('失敗の文が出たら、何をしているかの文を消し、殻の文を上書きしない', async () => {
    await boot();
    at(m.CYCLE_MS + 100);
    $('status').textContent = 'サーバを起動できません';
    $('status').dataset.level = 'error';
    at(4000);
    expect(text()).toBe('サーバを起動できません');
    expect($('detail').textContent).toBe('');
  });
  it('reduced motion では点を増やさず、3 つのまま出す', async () => {
    await boot(true);
    for (const ms of [0, 600, 1100]) { at(ms); expect(text()).toBe('読み込み中...'); }
  });
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
  it('殻が合図の口を呼ぶと、周の境目を待たず、呼ばれた時刻の札の並びから合図を描き、ループの絵には戻らない', async () => {
    await boot();
    step(500);
    clock = T0 + 2 * m.CYCLE_MS + 700;
    win.__hangarBootFinish!();
    const Tb = (2 * m.CYCLE_MS + 700) / 1000;
    expect(svg()!.innerHTML).toBe(finished(Tb, 0));
    step(2 * m.CYCLE_MS + 700 + 250);
    expect(svg()!.innerHTML).toBe(finished(Tb, 0.25));
    // 合図の間は一枚の描画だけが走る。流れのコマは止めてある。
    expect(frames.size).toBe(1);
  });
  it('合図の頭で、文を「ようこそ」に替え、何をしているかの文を消し、待ちの文ではもう上書きしない', async () => {
    await boot();
    step(500);
    clock = T0 + 3 * m.CYCLE_MS;
    win.__hangarBootProgress!({ phase: 'indexing', done: 3, total: 9 });
    vi.advanceTimersByTime(100);
    expect($('detail').textContent).not.toBe('');
    win.__hangarBootFinish!();
    expect($('status').dataset.level).toBe('ready');
    expect($('status').textContent).toBe('ようこそ');
    expect($('status').querySelector('svg')).toBeNull();
    expect($('detail').textContent).toBe('');
    clock += 5000;
    vi.advanceTimersByTime(5000);
    expect($('status').textContent).toBe('ようこそ');
    expect($('detail').textContent).toBe('');
  });
  it('光が満ち切ると、ロゴと文字は消え、UI の背景の光だけが残って描画が止まる', async () => {
    await boot();
    step(500);
    clock = T0 + 2 * m.CYCLE_MS;
    win.__hangarBootFinish!();
    step(2 * m.CYCLE_MS + (m.BEAT_S * 1000));
    expect($('aura').style.opacity).toBe('0');
    expect(Number(document.querySelector('main')!.style.opacity)).toBe(1);
    step(2 * m.CYCLE_MS + m.FINISH_MS);
    expect(document.querySelector('main')!.style.opacity).toBe('0');
    expect($('aura').style.opacity).toBe('1');
    // 満ち切った絵は UI の背景そのものにする。縁の暈しも輪も残さない。
    expect($('aura').style.maskImage ?? '').toBe('');
    expect($('fx').innerHTML).toBe('');
    expect(frames.size).toBe(0);
  });
  it('合図の途中では、光の輪をロゴから広げ、光は輪を追って満ちる', async () => {
    await boot();
    step(500);
    clock = T0 + 2 * m.CYCLE_MS;
    win.__hangarBootFinish!();
    step(2 * m.CYCLE_MS + 300);
    expect($('fx').querySelectorAll('circle').length).toBe(2);
    step(2 * m.CYCLE_MS + 700);
    expect(Number($('aura').style.opacity)).toBeGreaterThan(0);
    expect($('aura').style.maskImage).toContain('radial-gradient');
  });
  it('合図の口を二度呼んでも、打ち直さない', async () => {
    await boot();
    step(500);
    clock = T0 + 2 * m.CYCLE_MS;
    win.__hangarBootFinish!();
    step(2 * m.CYCLE_MS + 300);
    win.__hangarBootFinish!();
    expect(svg()!.innerHTML).toBe(finished(2 * m.CYCLE_MS / 1000, 0.3));
    expect(frames.size).toBe(1);
  });
  it('合図の後に失敗の文が出たら、ロゴと文を元の見え方に戻し、光と輪を消す', async () => {
    await boot();
    step(500);
    clock = T0 + 2 * m.CYCLE_MS;
    win.__hangarBootFinish!();
    step(2 * m.CYCLE_MS + m.FINISH_MS);
    $('status').textContent = 'サーバの画面へ移れません';
    $('status').dataset.level = 'error';
    await flush();
    expect(document.querySelector('main')!.style.opacity).toBe('');
    expect(document.querySelector('main')!.style.transform).toBe('');
    expect($('aura').style.opacity).toBe('0');
    expect($('fx').innerHTML).toBe('');
    expect($('status').textContent).toBe('サーバの画面へ移れません');
    expect(svg()!.innerHTML).toBe(finished(2 * m.CYCLE_MS / 1000, m.BEAT_S));
    expect(frames.size).toBe(0);
  });
  it('reduced motion では静止した原図のまま動かさない', async () => {
    await boot(true);
    expect(document.getElementById('logo')).not.toBeNull();
    expect(frames.size).toBe(0);
  });
  it('reduced motion の合図は、文を替え、光と文字を溶かして替えるだけにする（弾み、輪、動きは無い）', async () => {
    await boot(true);
    win.__hangarBootFinish!();
    expect($('status').textContent).toBe('ようこそ');
    step(300);
    expect($('fx').innerHTML).toBe('');
    step(700);
    expect($('aura').style.maskImage ?? '').toBe('');
    expect(Number($('aura').style.opacity)).toBeGreaterThan(0);
    expect(document.querySelector('main')!.style.transform).toBe('');
    step(m.FINISH_MS);
    expect($('aura').style.opacity).toBe('1');
    expect(document.querySelector('main')!.style.opacity).toBe('0');
    expect(document.getElementById('logo')).not.toBeNull();
    expect(frames.size).toBe(0);
  });
});
