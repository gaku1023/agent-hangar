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
    expect($('detail').textContent).toBe('インデックスを作成中 412 / 987 件');
    win.__hangarBootProgress!({ phase: 'indexing', done: 600, total: 987 });
    at(m.CYCLE_MS + 200);
    expect($('detail').textContent).toBe('インデックスを作成中 600 / 987 件');
  });
  it('進み具合が届く前は、サーバの起動を待っていると出す', async () => {
    await boot();
    at(m.CYCLE_MS + 100);
    expect($('detail').textContent).toBe('サーバーを起動中');
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
  // 見えている操作だけを、DOM の順（Tab の順）に並べる。
  const tabOrder = () => [...$('fail').querySelectorAll<HTMLElement>('button, [tabindex="0"]')].filter((el) => !el.closest('[hidden]')).map((el) => el.id);
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
    expect($('fail-title').textContent).toBe('ポート 4177 を別のアプリが使用しています');
    expect($('fail-what').textContent).toContain('hangar のサーバーではない別のプロセス');
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
    expect(invoke.mock.calls).toEqual([['boot_state'], ['retry_boot'], ['open_log']]);
    expect(($('boot-retry') as HTMLButtonElement).disabled).toBe(true);
  });
  it('やり直しを殻が断ったら、もう一度押せるように戻す', async () => {
    tauri.__TAURI_INTERNALS__ = { invoke: vi.fn(async () => { throw new Error('もう起動中…'); }) };
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
  it('操作は Tab の順に、命令のコピー、詳細、全文をコピー、更新を確認、ログを開く、もう一度試す', async () => {
    await boot();
    await fail();
    expect(tabOrder()).toEqual(['fail-command-copy', 'fail-detail', 'fail-copy-all', 'boot-update', 'boot-log', 'boot-retry']);
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
  // Node の札（利用者が選んだ形）。入れるコマンドを主にし、主の釦をその下に、調べた場所は畳んだ詳細に置く。
  // どの Node の札にも「node を選ぶ…」を置き、選んだ Node を殻が確かめて nodePath に書く（lib.rs の pick_node）。
  describe('Node の札', () => {
    const params = { min: '22.14', napi: 10, arch: 'arm64' };
    const nodeFail = (extra: Record<string, unknown> = {}) => fail({ kind: 'node-missing', params, detail: 'Node 22.14 以上（arm64）が見つかりません。\n確認したパス:\n  /opt/homebrew/bin/node: ありません', ...extra });
    const winOld = { kind: 'node-version-mismatch', params: { ...params, arch: 'x64', found: '20.18.0' }, os: 'Windows 11 24H2 (build 26100)', sep: '\\', home: '~\\.agent-hangar' };
    it('見出し、本文、前置きの文、入れるコマンドを出し、次にすることの列は出さない', async () => {
      await boot();
      await nodeFail();
      expect(document.body.dataset.fail).toBe('node-missing');
      expect($('fail-title').textContent).toBe('Node.js が見つかりません');
      expect($('fail-what').textContent).toBe('Hangar のデータベースとターミナルのネイティブモジュールは Node-API 10 を使うため、Node.js 22.14 以上が必要です。');
      expect($('fail-lead').hidden).toBe(false);
      expect($('fail-lead').textContent).toBe('ターミナルで次を実行してください：');
      expect($('fail-next').hidden).toBe(true);
      expect($('fail-steps').hidden).toBe(true);
      expect($('fail-command-box').hidden).toBe(false);
      expect($('fail-command').textContent).toBe('brew install node tmux');
    });
    it('主の釦は「入れたのでもう一度試す」で、コマンドのすぐ下に置き、その隣に「node を選ぶ…」を置く。焦点は主の釦', async () => {
      await boot();
      await nodeFail();
      expect($('boot-retry').textContent).toBe('インストール後にもう一度試す');
      expect($('boot-retry').parentElement).toBe($('fail-primary'));
      expect($('fail-primary').hidden).toBe(false);
      expect($('boot-pick-node').hidden).toBe(false);
      expect($('boot-pick-node').textContent).toBe('node を選択…');
      expect([...$('fail-primary').children].map((e) => e.id)).toEqual(['boot-retry', 'boot-pick-node']);
      expect($('boot-retry').classList.contains('btn-primary')).toBe(true);
      expect($('boot-pick-node').classList.contains('btn-primary')).toBe(false);
      expect(document.activeElement).toBe($('boot-retry'));
    });
    it('詳細は畳んで出し、押すと開き、もう一度押すと畳む', async () => {
      await boot();
      await nodeFail();
      const toggle = $('fail-detail-toggle');
      expect(toggle.hidden).toBe(false);
      expect(toggle.textContent).toBe('詳細（確認したパス、別のインストール方法）');
      expect(toggle.getAttribute('aria-expanded')).toBe('false');
      expect($('fail-detail-box').hidden).toBe(true);
      expect(tabOrder()).toEqual(['fail-command-copy', 'boot-retry', 'boot-pick-node', 'fail-detail-toggle', 'boot-update', 'boot-log']);
      click('fail-detail-toggle');
      expect(toggle.getAttribute('aria-expanded')).toBe('true');
      expect($('fail-detail-box').hidden).toBe(false);
      expect($('fail-detail').textContent).toContain('確認したパス');
      expect(tabOrder()).toEqual(['fail-command-copy', 'boot-retry', 'boot-pick-node', 'fail-detail-toggle', 'fail-detail', 'fail-copy-all', 'boot-update', 'boot-log']);
      click('fail-detail-toggle');
      expect($('fail-detail-box').hidden).toBe(true);
    });
    it('Windows では PowerShell で winget の LTS のコマンドを、英語ではその文を出す', async () => {
      await boot();
      await nodeFail({ os: 'Windows 11 24H2 (build 26100)', lang: 'en', sep: '\\', home: '~\\.agent-hangar' });
      expect($('fail-title').textContent).toBe('Node.js was not found');
      expect($('fail-lead').textContent).toBe('Run this in PowerShell:');
      expect($('fail-command').textContent).toBe('winget install -e --id OpenJS.NodeJS.LTS');
      expect($('boot-retry').textContent).toBe('I installed it, try again');
      expect($('boot-pick-node').textContent).toBe('Choose node.exe…');
      expect($('fail-detail-toggle').textContent).toBe('Details (places checked, other ways to install)');
    });
    // 古い Node がある Windows では、winget（今の Node を置き換える）を出さず、zip を別のフォルダに展開して選ぶ手順を出す。
    it('古い Node がある Windows では、手順の列を見出し無しで出し、「node.exe を選ぶ…」を主の釦にして焦点を置く', async () => {
      await boot();
      await fail(winOld);
      expect(document.body.dataset.fail).toBe('node-version-mismatch');
      expect($('fail-title').textContent).toBe('Node.js 20.18.0 を検出しましたが、Hangar には Node.js 22.14 以上が必要です');
      expect($('fail-lead').textContent).toBe('現在の Node.js を置き換えずにインストールするには：');
      expect($('fail-next').hidden).toBe(true);
      expect($('fail-steps').hidden).toBe(false);
      expect([...$('fail-steps').children].map((li) => li.textContent)).toHaveLength(3);
      expect($('fail-command-box').hidden).toBe(true);
      expect([...$('fail-primary').children].map((e) => e.id)).toEqual(['boot-pick-node', 'boot-retry']);
      expect($('boot-pick-node').classList.contains('btn-primary')).toBe(true);
      expect($('boot-retry').classList.contains('btn-primary')).toBe(false);
      expect($('boot-retry').textContent).toBe('もう一度試す');
      expect(document.activeElement).toBe($('boot-pick-node'));
    });
    it('コマンドのコピーは、入れるコマンドを写す', async () => {
      const writeText = vi.fn(async () => undefined);
      vi.stubGlobal('navigator', { clipboard: { writeText } });
      await boot();
      await nodeFail();
      click('fail-command-copy');
      expect(writeText).toHaveBeenCalledWith('brew install node tmux');
    });
    it('主の釦は、ほかの札と同じく起動のやり直しを頼む', async () => {
      const invoke = vi.fn(async () => null);
      tauri.__TAURI_INTERNALS__ = { invoke };
      await boot();
      await nodeFail();
      click('boot-retry');
      expect(invoke.mock.calls).toEqual([['boot_state'], ['retry_boot']]);
    });
    it('「node を選ぶ…」で選んだ Node が合えば、殻が保存したあと起動をやり直す', async () => {
      const invoke = vi.fn(async (cmd: string) => (cmd === 'pick_node' ? { result: 'ok', path: '/opt/node22/bin/node' } : null));
      tauri.__TAURI_INTERNALS__ = { invoke };
      await boot();
      await nodeFail();
      click('boot-pick-node');
      expect(($('boot-pick-node') as HTMLButtonElement).disabled).toBe(true);
      await flush();
      expect(invoke.mock.calls).toEqual([['boot_state'], ['pick_node'], ['retry_boot']]);
      expect($('fail-pick-note').hidden).toBe(true);
    });
    it('選んだ Node が合わなければ、理由を札に添えて、もう一度選べるように戻す。取り消しなら何も添えない', async () => {
      let answer: unknown = { result: 'version', path: '/x/node', found: '20.18.0', min: '22.14' };
      const invoke = vi.fn(async (cmd: string) => (cmd === 'pick_node' ? answer : null));
      tauri.__TAURI_INTERNALS__ = { invoke };
      await boot();
      await nodeFail();
      click('boot-pick-node');
      await flush();
      expect($('fail-pick-note').hidden).toBe(false);
      expect($('fail-pick-note').textContent).toBe('選択した Node.js は 20.18.0 です。Node.js 22.14 以上を選択してください。');
      expect(($('boot-pick-node') as HTMLButtonElement).disabled).toBe(false);
      expect(invoke.mock.calls.map((c) => c[0])).not.toContain('retry_boot');
      answer = { result: 'cancel' };
      click('boot-pick-node');
      await flush();
      expect($('fail-pick-note').hidden).toBe(true);
      expect(invoke.mock.calls.map((c) => c[0])).not.toContain('retry_boot');
    });
    it('殻が断ったら、もう一度選べるように戻す', async () => {
      const invoke = vi.fn(async (cmd: string) => { if (cmd === 'pick_node') throw new Error('no'); return null; });
      tauri.__TAURI_INTERNALS__ = { invoke };
      await boot();
      await nodeFail();
      click('boot-pick-node');
      await flush();
      expect(($('boot-pick-node') as HTMLButtonElement).disabled).toBe(false);
    });
    it('続けて別の種類が届いたら、元の並び（次にすること、開いた詳細、下端の釦）に戻し、選ぶ釦と添えた文を退ける', async () => {
      const invoke = vi.fn(async (cmd: string) => (cmd === 'pick_node' ? { result: 'notNode', path: '/x' } : null));
      tauri.__TAURI_INTERNALS__ = { invoke };
      await boot();
      await nodeFail();
      click('boot-pick-node');
      await flush();
      expect($('fail-pick-note').hidden).toBe(false);
      await fail();
      expect($('fail-lead').hidden).toBe(true);
      expect($('fail-next').hidden).toBe(false);
      expect($('fail-steps').hidden).toBe(false);
      expect($('fail-primary').hidden).toBe(true);
      expect($('fail-pick-note').hidden).toBe(true);
      expect($('fail-detail-toggle').hidden).toBe(true);
      expect($('fail-detail-box').hidden).toBe(false);
      expect($('boot-retry').textContent).toBe('もう一度試す');
      expect($('boot-retry').classList.contains('btn-primary')).toBe(true);
      expect(tabOrder()).toEqual(['fail-command-copy', 'fail-detail', 'fail-copy-all', 'boot-update', 'boot-log', 'boot-retry']);
    });
    it('二度目の Node の札は、開いていた詳細を畳み直す', async () => {
      await boot();
      await nodeFail();
      click('fail-detail-toggle');
      await nodeFail();
      expect($('fail-detail-box').hidden).toBe(true);
      expect($('fail-detail-toggle').getAttribute('aria-expanded')).toBe('false');
    });
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

// 殻の知らせ（評価）は、頁の口が出来る前に届くと落ちる。
// macOS では、読み込みの合図（PageLoadEvent::Finished）の時点でまだ boot.js が走っておらず、合図で渡し直した失敗も落ちた（2026-10-11、Node の無い Mac で再現）。
// なので頁は、口を作り終えた時点で殻に今の様子を問い合わせ（boot_state）、先に起きた失敗、進み具合、合図を引き取る。
describe('殻が先に知らせた分を引き取る', () => {
  const tauri = window as unknown as { __TAURI_INTERNALS__?: { invoke: (cmd: string) => Promise<unknown> } };
  const failWith = win as unknown as { __hangarBootFail?: unknown };
  const failure = { kind: 'other', params: {}, detail: 'Node 22（arm64）が見つかりません。', lang: 'ja', version: '0.2.0', os: 'macOS 15.5', home: '~/.agent-hangar', sep: '/' };
  const answer = (state: unknown) => {
    const invoke = vi.fn(async (cmd: string) => (cmd === 'boot_state' ? state : null));
    tauri.__TAURI_INTERNALS__ = { invoke };
    return invoke;
  };
  afterEach(() => { delete tauri.__TAURI_INTERNALS__; delete failWith.__hangarBootFail; document.documentElement.lang = ''; });

  it('頁の口を作り終えたら、殻に今の様子を一度だけ問い合わせる', async () => {
    const invoke = answer({ failure: null, progress: null, finishing: false });
    await boot();
    await flush();
    expect(invoke.mock.calls).toEqual([['boot_state']]);
    expect($('fail').hidden).toBe(true);
    expect($('status').dataset.level).toBeUndefined();
  });
  it('頁が出来る前に起きた失敗を引き取り、札を出す', async () => {
    answer({ failure, progress: null, finishing: false });
    await boot();
    await flush();
    expect($('fail').hidden).toBe(false);
    expect($('status').dataset.level).toBe('error');
    expect($('fail-detail').textContent).toBe('Node 22（arm64）が見つかりません。');
    expect(document.body.dataset.fail).toBe('other');
  });
  it('先に届いていた進み具合を引き取り、待っている間の文に使う', async () => {
    answer({ failure: null, progress: { phase: 'indexing', done: 412, total: 987 }, finishing: false });
    await boot();
    await flush();
    clock = T0 + m.CYCLE_MS + 100;
    vi.advanceTimersByTime(100);
    expect($('detail').textContent).toBe('インデックスを作成中 412 / 987 件');
  });
  it('先に打たれていた読み込みが終わった合図を引き取り、合図を描く', async () => {
    answer({ failure: null, progress: null, finishing: true });
    await boot();
    await flush();
    expect($('status').dataset.level).toBe('ready');
  });
  // 英語の OS で入れたばかりの状態。殻が起動の頭で書いた言語（boot_state の lang）で、待っている間の文から英語にする。
  it('殻の言語が英語なら、待っている間の文、何をしているかの文、合図の文を英語で出す', async () => {
    answer({ failure: null, progress: { phase: 'indexing', done: 412, total: 987 }, finishing: false, lang: 'en' });
    await boot();
    await flush();
    expect(document.documentElement.lang).toBe('en');
    clock = T0;
    vi.advanceTimersByTime(100);
    expect($('status').textContent).toBe('Loading.');
    clock = T0 + 3200;
    vi.advanceTimersByTime(100);
    expect($('status').textContent).toMatch(/^Loading\.+ \(3 s\)$/);
    expect($('detail').textContent).toBe('Indexing sessions 412 / 987');
    win.__hangarBootFinish!();
    expect($('status').textContent).toBe('Welcome');
  });
  it('殻の言語が届くまでは、待っている間の文を出さない（日本語を一瞬出さない）', async () => {
    let reply: (v: unknown) => void = () => {};
    tauri.__TAURI_INTERNALS__ = { invoke: vi.fn((cmd: string) => (cmd === 'boot_state' ? new Promise((r) => { reply = r; }) : Promise.resolve(null))) };
    await boot();
    clock = T0;
    vi.advanceTimersByTime(100);
    expect($('status').textContent).toBe('');
    reply({ failure: null, progress: null, finishing: false, lang: 'en' });
    await flush();
    vi.advanceTimersByTime(100);
    expect($('status').textContent).toBe('Loading.');
  });
  it('問い合わせが断られても、待っている間の画面のまま止まらない', async () => {
    tauri.__TAURI_INTERNALS__ = { invoke: vi.fn(async () => { throw new Error('not allowed'); }) };
    await boot();
    await flush();
    expect($('fail').hidden).toBe(true);
    step(500);
    expect(frames.size).toBe(1);
  });
});

// CI の「Node の無い Mac（と Windows）で札が出る」段は、頁が実際に描いた様子を殻にファイルへ書かせて読む（lib.rs の boot_probe）。
// 書き出しは、殻が HANGAR_BOOT_PROBE を持って起きたとき（boot_state が probe を真で返したとき）だけ行う。
// ふだんの起動では、頁は boot_probe を呼ばない。
describe('試験のために、描いた様子を殻へ渡す', () => {
  const tauri = window as unknown as { __TAURI_INTERNALS__?: { invoke: (cmd: string, args?: unknown) => Promise<unknown> } };
  const failWith = win as unknown as { __hangarBootFail?: (info: unknown) => void };
  const failure = { kind: 'other', params: {}, detail: 'Node 22（arm64）が見つかりません。', lang: 'ja', version: '0.2.0', os: 'macOS 15.5', home: '~/.agent-hangar', sep: '/' };
  const answer = (state: unknown) => {
    const invoke = vi.fn(async (cmd: string, _args?: unknown) => (cmd === 'boot_state' ? state : null));
    tauri.__TAURI_INTERNALS__ = { invoke };
    return invoke;
  };
  const probes = (invoke: ReturnType<typeof answer>) => invoke.mock.calls.filter(([cmd]) => cmd === 'boot_probe').map(([, args]) => (args as { drawn: Record<string, unknown> }).drawn);
  // 前の試験が札を出すと、body の印（data-fail）が残る。body の中身だけを入れ替える共通の準備では消えない。
  beforeEach(() => { delete document.body.dataset.fail; });
  afterEach(() => { delete tauri.__TAURI_INTERNALS__; delete failWith.__hangarBootFail; document.documentElement.lang = ''; });

  it('殻が probe を返さなければ、札が出ても boot_probe を呼ばない', async () => {
    const invoke = answer({ failure, progress: null, finishing: false });
    await boot();
    await flush();
    failWith.__hangarBootFail!(failure);
    await flush();
    expect($('fail').hidden).toBe(false);
    expect(invoke.mock.calls.map(([cmd]) => cmd)).toEqual(['boot_state']);
  });
  it('probe が偽でも呼ばない', async () => {
    const invoke = answer({ failure, progress: null, finishing: false, probe: false });
    await boot();
    await flush();
    expect(probes(invoke)).toEqual([]);
  });
  it('probe が真で、先に失敗が起きていたら、描いた札の見出し、印、種類、詳細を渡す', async () => {
    const invoke = answer({ failure, progress: null, finishing: false, probe: true });
    await boot();
    await flush();
    const got = probes(invoke);
    expect(got.at(-1)).toEqual({
      level: 'error',
      card: true,
      kind: 'other',
      lang: 'ja',
      title: $('fail-title').textContent,
      detail: 'Node 22（arm64）が見つかりません。',
    });
    expect(String(got.at(-1)!.title)).not.toBe('');
  });
  it('probe が真で、まだ何も起きていなければ待っている様子を渡し、後から届いた失敗の札も渡す', async () => {
    const invoke = answer({ failure: null, progress: null, finishing: false, probe: true });
    await boot();
    await flush();
    // 殻が言語を返さなければ、頁の言語は日本語（UI の既定）になる。
    expect(probes(invoke)).toEqual([{ level: null, card: false, kind: null, lang: 'ja', title: '', detail: '' }]);
    failWith.__hangarBootFail!({ ...failure, lang: 'en' });
    await flush();
    expect(probes(invoke).at(-1)).toMatchObject({ level: 'error', card: true, kind: 'other', lang: 'en', detail: failure.detail });
  });
  it('probe が真で、読み込みが終わった合図を描いたら、その印を渡す', async () => {
    const invoke = answer({ failure: null, progress: null, finishing: true, probe: true });
    await boot();
    await flush();
    expect(probes(invoke).at(-1)).toMatchObject({ level: 'ready', card: false });
  });
  it('書き出しを殻が断っても、札はそのまま出ている', async () => {
    const invoke = vi.fn(async (cmd: string) => {
      if (cmd === 'boot_state') return { failure, progress: null, finishing: false, probe: true };
      throw new Error('not allowed');
    });
    tauri.__TAURI_INTERNALS__ = { invoke };
    await boot();
    await flush();
    expect($('fail').hidden).toBe(false);
  });
});

// 起動に失敗する版を入れた人が、UI まで届かなくても新しいバージョンを受け取れるよう、札の中から更新を確かめ、ダウンロードしてインストールする。
// 命令は UI と同じ殻の 4 つ（update_check、update_download、update_status、update_install）で、起動画面にも与えてある（boot-screen.json）。
// 殻は起動に失敗したとき 1 度だけ自分でも確かめ、見つけた版を boot_state の update と __hangarBootUpdate で渡す。
describe('札の中の更新', () => {
  type Invoke = (cmd: string, args?: unknown) => Promise<unknown>;
  const tauri = window as unknown as { __TAURI_INTERNALS__?: { invoke: Invoke } };
  const w = win as unknown as { __hangarBootFail?: (info: unknown) => void; __hangarBootUpdate?: (u: unknown) => void };
  const failure = { kind: 'server-exited', params: {}, detail: 'exit 1', lang: 'ja', version: '0.2.0-rc.5', os: 'macOS 15.5', home: '~/.agent-hangar', sep: '/' };
  // 命令ごとの答えを、試験が後から決められる約束で返す。
  const pending = new Map<string, Array<{ resolve: (v: unknown) => void; reject: (e: unknown) => void }>>();
  const settle = (cmd: string, ok: boolean, v: unknown) => { const p = pending.get(cmd)!.shift()!; (ok ? p.resolve : p.reject)(v); };
  let state: unknown;
  let status: unknown;
  const calls = () => invoke.mock.calls.map(([cmd]) => cmd);
  const invoke = vi.fn<Invoke>();
  const btn = (id: string) => $(id) as HTMLButtonElement;
  const shown = (id: string) => !$(id).hidden && !$(id).closest('[hidden]');
  beforeEach(() => {
    pending.clear();
    state = { failure, progress: null, finishing: false };
    status = { current: '0.2.0-rc.5', done: 0, total: null };
    invoke.mockReset();
    invoke.mockImplementation((cmd: string) => {
      if (cmd === 'boot_state') return Promise.resolve(state);
      if (cmd === 'update_status') return Promise.resolve(status);
      if (!cmd.startsWith('update_')) return Promise.resolve(null);
      return new Promise((resolve, reject) => { pending.set(cmd, [...(pending.get(cmd) ?? []), { resolve, reject }]); });
    });
    tauri.__TAURI_INTERNALS__ = { invoke };
    delete document.body.dataset.fail;
  });
  afterEach(() => { delete tauri.__TAURI_INTERNALS__; delete w.__hangarBootFail; delete w.__hangarBootUpdate; document.documentElement.lang = ''; });

  it('札の下端に「更新を確認」を出す。押すまでは確かめない', async () => {
    await boot();
    await flush();
    expect(shown('boot-update')).toBe(true);
    expect(btn('boot-update').textContent).toBe('更新を確認');
    expect(shown('fail-update')).toBe(false);
    expect(calls()).toEqual(['boot_state']);
  });
  it('押すと殻に確かめさせ、その間は押せない「確認中…」にする。無ければ釦を退けて版の横に「最新」と添える', async () => {
    await boot();
    await flush();
    btn('boot-update').click();
    expect(calls()).toEqual(['boot_state', 'update_check']);
    expect(btn('boot-update').disabled).toBe(true);
    expect(btn('boot-update').textContent).toBe('確認中…');
    settle('update_check', true, { version: null });
    await flush();
    expect(shown('boot-update')).toBe(false);
    expect($('fail-update-note').textContent).toBe('最新');
    expect(shown('fail-update-note')).toBe(true);
    expect(shown('fail-update')).toBe(false);
  });
  it('新しいバージョンがあれば、札の中に帯を出し、「もう一度試す」を主の釦から外す', async () => {
    await boot();
    await flush();
    btn('boot-update').click();
    settle('update_check', true, { version: '0.2.1' });
    await flush();
    expect(shown('fail-update')).toBe(true);
    expect($('fail-update-title').textContent).toBe('Hangar 0.2.1 を利用できます');
    expect($('fail-update-detail').textContent).toContain('現在のバージョンは 0.2.0-rc.5 です。');
    expect(btn('fail-update-go').textContent).toBe('ダウンロードしてインストール');
    expect(shown('boot-update')).toBe(false);
    expect($('boot-retry').classList.contains('btn-primary')).toBe(false);
    expect($('fail-update-go').classList.contains('btn-primary')).toBe(true);
  });
  it('ダウンロードしてインストールは、取得の進みを出し、終わったらインストールを殻に頼む（殻が再起動する）', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    await boot();
    await flush();
    btn('boot-update').click();
    settle('update_check', true, { version: '0.2.1' });
    await flush();
    btn('fail-update-go').click();
    expect(calls().at(-1)).toBe('update_download');
    expect(shown('fail-update-go')).toBe(false);
    expect($('fail-update-detail').textContent).toBe('ダウンロード中…');
    status = { current: '0.2.0-rc.5', done: 50, total: 200 };
    vi.advanceTimersByTime(300);
    await flush();
    expect($('fail-update-detail').textContent).toBe('25%');
    expect($('fail-update-bar').getAttribute('aria-valuenow')).toBe('25');
    expect(shown('fail-update-bar')).toBe(true);
    settle('update_download', true, null);
    await flush();
    expect(calls().at(-1)).toBe('update_install');
    expect($('fail-update-detail').textContent).toContain('インストール中…');
    // 取得が済んだら、進みを読みに行かない。
    const n = calls().length;
    vi.advanceTimersByTime(1000);
    await flush();
    expect(calls().length).toBe(n);
  });
  it('ダウンロードに失敗したら、理由を出し、もう一度押せるようにする', async () => {
    await boot();
    await flush();
    btn('boot-update').click();
    settle('update_check', true, { version: '0.2.1' });
    await flush();
    btn('fail-update-go').click();
    // ダウンロードとインストールの途中は、起動のやり直しで頁を読み込み直させない。
    expect(btn('boot-retry').disabled).toBe(true);
    settle('update_download', false, { kind: 'network', detail: 'x' });
    await flush();
    expect(btn('boot-retry').disabled).toBe(false);
    expect($('fail-update').dataset.tone).toBe('error');
    expect($('fail-update-title').textContent).toBe('ダウンロードできませんでした');
    expect($('fail-update-detail').textContent).toBe('現在のバージョン 0.2.0-rc.5 は変わりません。ネットワークまたは配布元に接続できませんでした。');
    expect(shown('fail-update-go')).toBe(true);
    btn('fail-update-go').click();
    expect(calls().at(-1)).toBe('update_download');
  });
  it('確認に失敗したら、理由を帯に出し、「更新を確認」を戻す', async () => {
    await boot();
    await flush();
    btn('boot-update').click();
    settle('update_check', false, { kind: 'network', detail: 'x' });
    await flush();
    expect($('fail-update-title').textContent).toBe('更新を確認できませんでした');
    expect(shown('fail-update-go')).toBe(false);
    expect(shown('boot-update')).toBe(true);
    expect(btn('boot-update').disabled).toBe(false);
    expect($('boot-retry').classList.contains('btn-primary')).toBe(true);
  });
  it('殻が先に見つけていた版（boot_state の update）は、押さなくても帯に出す', async () => {
    state = { failure, progress: null, finishing: false, update: { version: '0.2.1' }, lang: 'ja' };
    await boot();
    await flush();
    expect(shown('fail-update')).toBe(true);
    expect($('fail-update-title').textContent).toBe('Hangar 0.2.1 を利用できます');
    expect(calls()).toEqual(['boot_state']);
    // 焦点は「もう一度試す」のまま動かさない。
    expect(document.activeElement).toBe($('boot-retry'));
  });
  it('札が出た後に殻が見つけた版（__hangarBootUpdate）も帯に出す。札の前に届いたものは札を出すときに出す', async () => {
    state = { failure: null, progress: null, finishing: false };
    await boot();
    await flush();
    w.__hangarBootUpdate!({ version: '0.2.1' });
    expect($('fail').hidden).toBe(true);
    w.__hangarBootFail!(failure);
    await flush();
    expect($('fail-update-title').textContent).toBe('Hangar 0.2.1 を利用できます');
    w.__hangarBootUpdate!({ version: '0.2.2' });
    expect($('fail-update-title').textContent).toBe('Hangar 0.2.2 を利用できます');
  });
  it('取得の途中に殻の知らせが届いても、取得の様子を崩さない。形の違う知らせは捨てる', async () => {
    await boot();
    await flush();
    btn('boot-update').click();
    settle('update_check', true, { version: '0.2.1' });
    await flush();
    btn('fail-update-go').click();
    w.__hangarBootUpdate!({ version: '0.2.2' });
    expect($('fail-update-title').textContent).toBe('Hangar 0.2.1');
    expect(shown('fail-update-go')).toBe(false);
    w.__hangarBootUpdate!({ version: 3 });
    w.__hangarBootUpdate!(null);
    expect($('fail-update-title').textContent).toBe('Hangar 0.2.1');
  });
  it('確かめている間の「確認中…」は、押せない見た目にする', () => {
    expect(fs.readFileSync(path.join(loading, 'index.html'), 'utf8')).toMatch(/\.btn-mini:disabled \{[^}]*opacity/);
  });
  it('英語の札では、更新の文と釦も英語にする（殻が boot_state で渡す言語と札の言語は同じ決め方）', async () => {
    state = { failure: { ...failure, lang: 'en' }, progress: null, finishing: false, update: { version: '0.2.1' }, lang: 'en' };
    await boot();
    await flush();
    expect(document.documentElement.lang).toBe('en');
    expect(btn('boot-update').textContent).toBe('Check for updates');
    expect($('fail-update-title').textContent).toBe('Hangar 0.2.1 is available');
    expect(btn('fail-update-go').textContent).toBe('Download and install');
  });

  // 札は出したときの高さで窓の縦の真ん中に置き、その上端を留める。後から帯が足されても上へ動かさず、下へ伸ばす。
  // jsdom は配置を計算しないので、札の高さと窓の高さを試験が決める（窓は 768px、札の上下の余白は 44px と 24px）。
  describe('札の上端を留める', () => {
    let height = 300;
    beforeEach(() => {
      height = 300;
      Object.defineProperty($('fail'), 'offsetHeight', { configurable: true, get: () => height });
      Object.defineProperty(window, 'innerHeight', { configurable: true, writable: true, value: 768 });
    });
    const top = () => $('fail').style.marginTop;
    it('はじめは窓の縦の真ん中に置き、帯が足されて高くなっても上端は動かない', async () => {
      await boot();
      await flush();
      // 44 + (768 - 68 - 300) / 2 = 244 が上端で、余白の 44 を引いた 200 を上へ足す。
      expect(document.body.dataset.failPinned).toBe('true');
      expect(top()).toBe('200px');
      height = 370;
      w.__hangarBootUpdate!({ version: '0.2.1' });
      expect($('fail-update').hidden).toBe(false);
      expect(top()).toBe('200px');
    });
    it('詳細を開いて高くなっても上端は動かない。窓の下端からはみ出すときだけ、収まる分だけ上げる', async () => {
      state = { failure: { ...failure, kind: 'node-missing' }, progress: null, finishing: false };
      await boot();
      await flush();
      expect(top()).toBe('200px');
      height = 420;
      btn('fail-detail-toggle').click();
      expect(top()).toBe('200px');
      // 768 - 24 - 600 = 144 が下端に収まる上端で、余白の 44 を引いて 100 になる。
      height = 600;
      btn('fail-detail-toggle').click();
      expect(top()).toBe('100px');
    });
    it('窓の大きさが変わったら、そのときの高さで真ん中に置き直す', async () => {
      await boot();
      await flush();
      height = 370;
      w.__hangarBootUpdate!({ version: '0.2.1' });
      window.innerHeight = 900;
      window.dispatchEvent(new Event('resize'));
      // 44 + (900 - 68 - 370) / 2 = 275 が上端で、余白の 44 を引いて 231 になる。
      expect(top()).toBe('231px');
    });
  });
});

// 起動に失敗したら、札はその場で出す。殻が更新を確かめるのは、札を描いたと知らせてから（lib.rs の boot_card_shown）である。
// 札を描く前に確かめ始めると、目録の取得と証明書の検証が札の最初の描画と重なる。確かめの結果は待たず、見つかったら後から帯を足す（__hangarBootUpdate）。
describe('札は更新の確認を待たずに出し、描いた後に確かめを頼む', () => {
  type Invoke = (cmd: string, args?: unknown) => Promise<unknown>;
  const tauri = window as unknown as { __TAURI_INTERNALS__?: { invoke: Invoke } };
  const w = win as unknown as { __hangarBootFail?: (info: unknown) => void; __hangarBootUpdate?: (u: unknown) => void };
  const failure = { kind: 'node-missing', params: { arch: 'arm64', os: 'macos' }, detail: 'Node 22.14 以上（arm64）が見つかりません。', lang: 'ja', version: '0.2.0-rc.6', os: 'macOS 15.5', home: '~/.agent-hangar', sep: '/' };
  let state: unknown;
  const invoke = vi.fn<Invoke>();
  const calls = () => invoke.mock.calls.map(([cmd]) => cmd);
  beforeEach(() => {
    state = { failure, progress: null, finishing: false, update: null, lang: 'ja' };
    invoke.mockReset();
    // 殻の答えは、boot_state のほかは返さない（確かめが終わらないまま）。
    invoke.mockImplementation((cmd: string) => (cmd === 'boot_state' ? Promise.resolve(state) : new Promise(() => {})));
    tauri.__TAURI_INTERNALS__ = { invoke };
    delete document.body.dataset.fail;
  });
  afterEach(() => { delete tauri.__TAURI_INTERNALS__; delete w.__hangarBootFail; delete w.__hangarBootUpdate; document.documentElement.lang = ''; });

  it('boot_state が失敗を返したら、その場で札を出し、確かめはまだ頼まない', async () => {
    await boot();
    await flush();
    expect($('fail').hidden).toBe(false);
    expect($('status').dataset.level).toBe('error');
    expect($('fail-title').textContent).toBe('Node.js が見つかりません');
    expect(calls()).toEqual(['boot_state']);
  });
  it('札を描いたコマの後で、殻に札を描いたと 1 度だけ知らせる。知らせの答えは待たない', async () => {
    await boot();
    await flush();
    step(16);
    await flush();
    expect(calls()).toEqual(['boot_state', 'boot_card_shown']);
    // 答えが返らなくても、札はそのまま押せる。
    expect(($('boot-retry') as HTMLButtonElement).disabled).toBe(false);
    expect(document.activeElement).toBe($('boot-retry'));
    // 別の種類の失敗が続けて届いても、知らせは重ねない。
    w.__hangarBootFail!({ ...failure, kind: 'server-exited', params: {}, detail: 'exit 1' });
    step(32);
    await flush();
    expect(calls().filter((c) => c === 'boot_card_shown')).toHaveLength(1);
  });
  it('札の言語は札が持つ言語で、boot_state の言語を待たずに決まる', async () => {
    state = new Promise(() => {});
    invoke.mockImplementation((cmd: string) => (cmd === 'boot_state' ? new Promise(() => {}) : new Promise(() => {})));
    await boot();
    w.__hangarBootFail!({ ...failure, lang: 'en', detail: 'Node 22 (arm64) was not found.' });
    expect($('fail').hidden).toBe(false);
    expect(document.documentElement.lang).toBe('en');
    expect($('fail-title').textContent).toBe('Node.js was not found');
  });
  it('札が出た後に殻が見つけた版は、後から帯に足す', async () => {
    await boot();
    await flush();
    step(16);
    await flush();
    expect($('fail-update').hidden).toBe(true);
    w.__hangarBootUpdate!({ version: '0.2.1' });
    expect($('fail-update').hidden).toBe(false);
    expect($('fail-update-title').textContent).toBe('Hangar 0.2.1 を利用できます');
  });
  it('待っている間（失敗が無い）は、コマが進んでも知らせない', async () => {
    state = { failure: null, progress: null, finishing: false, update: null, lang: 'ja' };
    await boot();
    await flush();
    step(16);
    step(32);
    await flush();
    expect(calls()).toEqual(['boot_state']);
  });
});
