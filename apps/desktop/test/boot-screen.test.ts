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

// 起動に失敗したら、殻は種類と数を渡し（__hangarBootFail）、頁が 1 枚の札で出す。
// 札には、何が起きたか、番号つきの次にすること、命令、詳細、版と OS、「ログを開く」「もう一度試す」を並べる。
// 文は頁の表（boot-fail.js）が持ち、ここでは並べ方と操作だけを確かめる。
describe('起動の失敗の札', () => {
  type Fail = (info: Record<string, unknown>) => void;
  const failWith = win as unknown as { __hangarBootFail?: Fail };
  const tauri = window as unknown as { __TAURI_INTERNALS__?: { invoke: (cmd: string) => Promise<unknown> } };
  const info = (extra: Record<string, unknown> = {}) => ({ kind: 'port-in-use', params: { port: 4177 }, detail: 'listen EADDRINUSE: address already in use 127.0.0.1:4177', lang: 'ja', version: '0.1.0', os: 'macOS 15.1', home: '~/.agent-hangar', ...extra });
  const fail = async (extra: Record<string, unknown> = {}) => { failWith.__hangarBootFail!(info(extra)); await flush(); };
  const click = (id: string) => ($(id) as HTMLButtonElement).click();
  afterEach(() => { delete tauri.__TAURI_INTERNALS__; delete failWith.__hangarBootFail; document.documentElement.lang = ''; });

  it('殻が呼ぶ失敗の口（__hangarBootFail）を持つ。待っている間は札を出さない', async () => {
    await boot();
    expect(typeof failWith.__hangarBootFail).toBe('function');
    expect($('fail').hidden).toBe(true);
    expect(document.querySelector('main')!.hidden).toBe(false);
  });
  it('失敗が届いたら、読み込みの絵を退けて札を出し、流れを止める', async () => {
    await boot();
    step(500);
    await fail();
    expect($('fail').hidden).toBe(false);
    expect(document.querySelector('main')!.hidden).toBe(true);
    expect($('status').dataset.level).toBe('error');
    expect(document.body.dataset.fail).toBe('port-in-use');
    expect($('fail-brand').hidden).toBe(false);
    step(3 * m.CYCLE_MS + 40);
    expect(frames.size).toBe(0);
  });
  it('札は、見出し、何が起きたか、番号つきの次にすること、命令、詳細、版と OS を並べる', async () => {
    await boot();
    await fail();
    expect($('fail-title').textContent).toBe('ポート 4177 を別のアプリが使っています');
    expect($('fail-what').textContent).toContain('hangar のサーバではありません');
    const steps = [...$('fail-steps').querySelectorAll('li')].map((li) => li.textContent);
    expect($('fail-steps').tagName).toBe('OL');
    expect(steps).toHaveLength(3);
    expect(steps[1]).toContain('もう一度試す');
    expect($('fail-command').textContent).toBe('lsof -nP -iTCP:4177 -sTCP:LISTEN');
    expect($('fail-detail').textContent).toBe('listen EADDRINUSE: address already in use 127.0.0.1:4177');
    expect($('fail-env').textContent).toBe('Hangar 0.1.0 · macOS 15.1');
    expect($('fail-next').textContent).toBe('次にすること');
    expect($('fail-log-at').textContent).toContain('~/.agent-hangar/desktop.log');
  });
  it('詳細は文字のまま入れ、タグとして読まない', async () => {
    await boot();
    await fail({ detail: '<img src=x onerror="alert(1)">\nline2' });
    expect($('fail-detail').textContent).toBe('<img src=x onerror="alert(1)">\nline2');
    expect($('fail-detail').querySelector('img')).toBeNull();
  });
  it('命令の無い種類では、命令の枠を出さない', async () => {
    await boot();
    await fail();
    expect($('fail-command-box').hidden).toBe(false);
    await fail({ kind: 'other', params: {} });
    expect($('fail-command-box').hidden).toBe(true);
  });
  it('言語が en なら、頁の言語と札の文を英語にする', async () => {
    await boot();
    await fail({ lang: 'en' });
    expect(document.documentElement.lang).toBe('en');
    expect($('fail-title').textContent).toBe('Port 4177 is in use by another app');
    expect($('fail-next').textContent).toBe('What to do next');
    expect($('boot-retry').textContent).toBe('Try again');
    expect($('boot-log').textContent).toBe('Open log');
    expect($('fail-copy-all').textContent).toBe('Copy all');
  });
  it('二度届いたら、札を作り直す（前の種類の文を残さない）', async () => {
    await boot();
    await fail();
    await fail({ kind: 'db-backup-failed', params: { dir: '~/.agent-hangar/backups/db' }, detail: 'ENOSPC' });
    expect($('fail-title').textContent).toContain('バックアップ');
    expect($('fail-steps').querySelectorAll('li')).toHaveLength(3);
    expect($('fail-command').textContent).toBe('ls -la ~/.agent-hangar/backups/db');
    expect($('fail-detail').textContent).toBe('ENOSPC');
  });
  it('もう一度試すは起動のやり直しを、ログを開くはログを殻に頼む。やり直しは二度押せない', async () => {
    const invoke = vi.fn(async () => null);
    tauri.__TAURI_INTERNALS__ = { invoke };
    await boot();
    await fail();
    click('boot-retry');
    click('boot-retry');
    click('boot-log');
    expect(invoke.mock.calls).toEqual([['retry_boot'], ['open_log']]);
    expect(($('boot-retry') as HTMLButtonElement).disabled).toBe(true);
  });
  it('やり直しを殻が断ったら、もう一度押せるように戻す', async () => {
    tauri.__TAURI_INTERNALS__ = { invoke: vi.fn(async () => { throw new Error('もう起動しています'); }) };
    await boot();
    await fail();
    click('boot-retry');
    await flush();
    expect(($('boot-retry') as HTMLButtonElement).disabled).toBe(false);
  });
  it('札が出たら、「もう一度試す」に焦点を置く（Enter で押せる）', async () => {
    await boot();
    await fail();
    expect(document.activeElement).toBe($('boot-retry'));
  });
  it('操作は Tab の順に、命令のコピー、詳細、全文をコピー、ログを開く、もう一度試す', async () => {
    await boot();
    await fail();
    const order = [...$('fail').querySelectorAll<HTMLElement>('button, [tabindex="0"]')].map((el) => el.id);
    expect(order).toEqual(['fail-command-copy', 'fail-detail', 'fail-copy-all', 'boot-log', 'boot-retry']);
  });
  it('命令のコピーと全文のコピーは、それぞれの文をクリップボードへ書き、押した印を出して戻す', async () => {
    const writeText = vi.fn(async () => undefined);
    vi.stubGlobal('navigator', { clipboard: { writeText } });
    // 「押した印」を戻す待ちだけを捕まえて、試験が好きな時に進める。
    const later: Array<() => void> = [];
    const realSetTimeout = globalThis.setTimeout;
    vi.stubGlobal('setTimeout', ((fn: () => void, ms?: number) => (ms !== undefined && ms >= 1000 ? later.push(fn) : realSetTimeout(fn, ms))) as unknown as typeof setTimeout);
    await boot();
    await fail();
    click('fail-command-copy');
    click('fail-copy-all');
    expect(writeText.mock.calls).toEqual([
      ['lsof -nP -iTCP:4177 -sTCP:LISTEN'],
      ['Hangar 0.1.0 · macOS 15.1\nport-in-use\n\nlisten EADDRINUSE: address already in use 127.0.0.1:4177'],
    ]);
    await flush();
    expect($('fail-copy-all').textContent).toBe('コピーしました');
    expect(later).toHaveLength(2);
    later.forEach((fn) => fn());
    expect($('fail-copy-all').textContent).toBe('全文をコピー');
  });
  it('クリップボードの口が無い頁でも、選択と copy の命令で写す', async () => {
    vi.stubGlobal('navigator', {});
    const exec = vi.fn(() => true);
    (document as unknown as { execCommand: unknown }).execCommand = exec;
    await boot();
    await fail();
    click('fail-copy-all');
    await flush();
    expect(exec).toHaveBeenCalledWith('copy');
    delete (document as unknown as { execCommand?: unknown }).execCommand;
  });
});
