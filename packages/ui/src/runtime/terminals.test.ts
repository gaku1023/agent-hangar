import { describe, expect, it, vi } from 'vitest';
import { createTerminalHost, type TerminalLike } from './terminals.ts';

class FakeWs {
  static all: FakeWs[] = [];
  readyState = 0; sent: string[] = [];
  onopen: (() => void) | null = null; onmessage: ((m: { data: string }) => void) | null = null; onclose: ((e?: { code: number; reason: string }) => void) | null = null; onerror: (() => void) | null = null;
  constructor(public url: string) { FakeWs.all.push(this); }
  send(d: string) { this.sent.push(d); }
  close(code?: number, reason?: string) { this.readyState = 3; this.onclose?.(code === undefined ? undefined : { code, reason: reason ?? '' }); }
  open() { this.readyState = 1; this.onopen?.(); }
  receive(m: unknown) { this.onmessage?.({ data: JSON.stringify(m) }); }
}
type FakeTerm = TerminalLike & { fontSize: number | null; written: string[]; opened: HTMLElement | null; fitted: number; focused: number; disposed: boolean; gpu: boolean; gpuBeforeOpen: boolean; pasted: string[]; type(d: string): void; resizeTo(c: number, r: number): void; detachHost(): void };
function fakeTerm(): FakeTerm {
  const data: ((d: string) => void)[] = []; const resize: ((s: { cols: number; rows: number }) => void)[] = [];
  // 画面を離れると React が枠ごと外すので、要素の親は残ったまま文書から外れる。isConnected はそれを表す。
  const node = { parentElement: null as HTMLElement | null, hostDetached: false, get isConnected() { return node.parentElement !== null && !node.hostDetached; }, remove() { node.parentElement = null; } };
  const t: FakeTerm = {
    cols: 80, rows: 24, element: null, fontSize: null, written: [], opened: null, fitted: 0, focused: 0, disposed: false, gpu: false, gpuBeforeOpen: false, pasted: [],
    open(el) { t.opened = el; node.parentElement = el; t.element = node as unknown as HTMLElement; },
    detachHost() { node.hostDetached = true; },
    write(d) { t.written.push(d); },
    onData(cb) { data.push(cb); return { dispose() {} }; },
    onResize(cb) { resize.push(cb); return { dispose() {} }; },
    fit() { t.fitted++; }, focus() { t.focused++; }, dispose() { t.disposed = true; },
    paste(d) { t.pasted.push(d); },
    setFontSize(px) { t.fontSize = px; },
    setGpu(on) { if (on && !t.opened) t.gpuBeforeOpen = true; t.gpu = on; },
    type(d) { for (const cb of data) cb(d); }, resizeTo(c, r) { for (const cb of resize) cb({ cols: c, rows: r }); },
  };
  return t;
}
function make(fontSize?: { load(): unknown; save(px: number): void }) {
  FakeWs.all = [];
  const terms: FakeTerm[] = [];
  const host = createTerminalHost({ wsUrl: (id) => `ws://x/ws/pty?tab=${id}`, createTerminal: () => { const t = fakeTerm(); terms.push(t); return t; }, wsFactory: (u) => new FakeWs(u) as unknown as WebSocket, fontSize });
  return { host, terms };
}

describe('createTerminalHost', () => {
  it('接続すると resize を送り、入出力を中継する', () => {
    const { host, terms } = make();
    const changes = vi.fn();
    host.subscribe(changes);
    host.connect('t1');
    expect(FakeWs.all[0]!.url).toBe('ws://x/ws/pty?tab=t1');
    expect(host.status('t1')).toBe('connecting');
    FakeWs.all[0]!.open();
    expect(host.status('t1')).toBe('connected');
    expect(JSON.parse(FakeWs.all[0]!.sent[0]!)).toEqual({ t: 'resize', cols: 80, rows: 24 });
    FakeWs.all[0]!.receive({ t: 'data', d: 'hello' });
    expect(terms[0]!.written).toEqual(['hello']);
    terms[0]!.type('ls\r');
    terms[0]!.resizeTo(100, 30);
    expect(FakeWs.all[0]!.sent.slice(1).map((s) => JSON.parse(s))).toEqual([{ t: 'data', d: 'ls\r' }, { t: 'resize', cols: 100, rows: 30 }]);
    host.connect('t1');
    expect(FakeWs.all).toHaveLength(1);
    expect(changes).toHaveBeenCalled();
  });
  it('切断は WebSocket だけ閉じ、xterm は残す。エラーは本文に書く', () => {
    const { host, terms } = make();
    host.connect('t1');
    FakeWs.all[0]!.open();
    host.disconnect('t1');
    expect(FakeWs.all[0]!.readyState).toBe(3);
    expect(host.status('t1')).toBe('closed');
    expect(terms[0]!.disposed).toBe(false);
    host.connect('t1');
    expect(FakeWs.all).toHaveLength(2);
    expect(terms).toHaveLength(1);
    FakeWs.all[1]!.receive({ t: 'error', message: 'pty spawn failed' });
    expect(terms[0]!.written.at(-1)).toContain('pty spawn failed');
    expect(host.status('t1')).toBe('error');
    expect(host.status('nope')).toBeNull();
  });
  it('同じ枠に別のタブを mount したら、前のタブの要素を外す', () => {
    // 1 つの枠に xterm の要素が積み上がると、見えている端末と入力先がずれる。
    const { host, terms } = make();
    const el = { appendChild: vi.fn() } as unknown as HTMLElement;
    host.mount('t1', el);
    host.mount('t2', el);
    expect(terms[0]!.element?.parentElement).toBeNull();
    expect(terms[1]!.opened).toBe(el);
    host.mount('t1', el);
    expect(terms[1]!.element?.parentElement).toBeNull();
    expect((el as unknown as { appendChild: ReturnType<typeof vi.fn> }).appendChild).toHaveBeenCalledWith(terms[0]!.element);
  });
  it('WebGL の描画は最後に mount したタブだけが持つ', () => {
    // WebGL の描画文脈はブラウザ全体で 16 個まで。隠れたタブが持ち続けると、古い順に失われる。
    const { host, terms } = make();
    const el = { appendChild: vi.fn() } as unknown as HTMLElement;
    host.mount('t1', el);
    expect(terms[0]!.gpu).toBe(true);
    host.mount('t2', el);
    expect(terms[0]!.gpu).toBe(false);
    expect(terms[1]!.gpu).toBe(true);
    host.mount('t1', el);
    expect(terms[0]!.gpu).toBe(true);
    expect(terms[1]!.gpu).toBe(false);
    // WebGL は open で描画先の要素ができてからでないと付けられない。
    expect(terms.some((t) => t.gpuBeforeOpen)).toBe(false);
  });
  it('paste は開いた端末にだけ貼り付けとして渡す', () => {
    // xterm の paste は括弧付き貼り付けで送るので、Claude Code は落とされたパスを画像として受け取れる。
    const { host, terms } = make();
    host.paste('t1', '/a.png ');
    host.mount('t1', { appendChild: vi.fn() } as unknown as HTMLElement);
    host.paste('t1', '/a.png ');
    host.paste('nope', '/b.png ');
    expect(terms[0]!.pasted).toEqual(['/a.png ']);
  });
  it('open の前に来た focus は mount のあとに当てる', () => {
    const { host, terms } = make();
    host.connect('t1');
    host.focus('t1');
    expect(terms[0]!.focused).toBe(0);
    host.mount('t1', { appendChild: vi.fn() } as unknown as HTMLElement);
    expect(terms[0]!.focused).toBe(1);
    // 当て終わった保留は消えるので、別の枠に移しただけでは当たらない。
    host.mount('t1', { appendChild: vi.fn() } as unknown as HTMLElement);
    expect(terms[0]!.focused).toBe(1);
  });
  it('一度開いたあと枠ごと外れた端末への focus は、次の mount で当てる', () => {
    // セッション画面を離れて戻ると、focus の効果は新しい枠が付く前に走る。外れた入力欄に当てても効かない。
    const { host, terms } = make();
    host.connect('t1');
    host.mount('t1', { appendChild: vi.fn() } as unknown as HTMLElement);
    terms[0]!.detachHost();
    host.focus('t1');
    expect(terms[0]!.focused).toBe(0);
    const next = { appendChild: vi.fn((c: { parentElement: unknown; hostDetached: boolean }) => { c.parentElement = next; c.hostDetached = false; }) } as unknown as HTMLElement;
    host.mount('t1', next);
    expect(terms[0]!.focused).toBe(1);
  });
  it('壊れた本文では落ちず、dispose は購読も捨てる', () => {
    const { host, terms } = make();
    const changes = vi.fn();
    host.subscribe(changes);
    host.connect('t1');
    expect(() => FakeWs.all[0]!.onmessage!({ data: 'null' })).not.toThrow();
    expect(() => FakeWs.all[0]!.onmessage!({ data: '"x"' })).not.toThrow();
    expect(terms[0]!.written).toEqual([]);
    host.dispose();
    changes.mockClear();
    host.connect('t1');
    expect(changes).not.toHaveBeenCalled();
  });
  it('mount は初回に open し、2 回目は要素を移す', () => {
    const { host, terms } = make();
    const a = { appendChild: vi.fn() } as unknown as HTMLElement;
    const b = { appendChild: vi.fn() } as unknown as HTMLElement;
    host.mount('t1', a);
    expect(terms[0]!.opened).toBe(a);
    expect(terms[0]!.fitted).toBe(1);
    host.mount('t1', b);
    expect((b as unknown as { appendChild: ReturnType<typeof vi.fn> }).appendChild).toHaveBeenCalledWith(terms[0]!.element);
    host.focus('t1');
    expect(terms[0]!.focused).toBe(1);
    host.dispose();
    expect(terms[0]!.disposed).toBe(true);
  });
});

describe('文字の大きさ', () => {
  const mem = (initial?: unknown) => { const m = { value: initial, saved: [] as number[], load: () => m.value, save: (px: number) => { m.saved.push(px); m.value = px; } }; return m; };
  const el = () => ({}) as HTMLElement;

  it('既定は 13 で、作る端末にはいまの大きさを渡す', () => {
    const { host, terms } = make(mem());
    host.connect('t1');
    expect(terms[0]!.fontSize).toBe(13);
    expect(host.fontSize()).toBe(13);
  });

  it('覚えておいた大きさで始める', () => {
    const { host, terms } = make(mem(16));
    host.connect('t1');
    expect(host.fontSize()).toBe(16);
    expect(terms[0]!.fontSize).toBe(16);
  });

  it('覚えていた値が壊れていたら既定に戻し、範囲の外なら端に寄せる', () => {
    expect(make(mem('big')).host.fontSize()).toBe(13);
    expect(make(mem(Number.NaN)).host.fontSize()).toBe(13);
    expect(make(mem(3)).host.fontSize()).toBe(8);
    expect(make(mem(99)).host.fontSize()).toBe(32);
    expect(make({ load: () => { throw new Error('storage blocked'); }, save: () => {} }).host.fontSize()).toBe(13);
  });

  it('大きさを変えると全部の端末に効かせ、開いている端末は合わせ直し、覚えておく', () => {
    const store = mem();
    const { host, terms } = make(store);
    host.connect('t1'); host.mount('t1', el());
    host.connect('t2');
    const fitted = terms[0]!.fitted;
    host.zoom('in');
    expect(terms.map((t) => t.fontSize)).toEqual([14, 14]);
    // 開いていない端末は寸法が取れないので、合わせ直すのは mount のときに任せる。
    expect(terms[0]!.fitted).toBe(fitted + 1);
    expect(terms[1]!.fitted).toBe(0);
    expect(store.saved).toEqual([14]);
    host.zoom('out'); host.zoom('out');
    expect(host.fontSize()).toBe(12);
    host.zoom('reset');
    expect(terms.map((t) => t.fontSize)).toEqual([13, 13]);
    expect(store.saved).toEqual([14, 13, 12, 13]);
  });

  it('端では止まり、変わらなければ書き込まない', () => {
    const store = mem(32);
    const { host } = make(store);
    host.zoom('in');
    expect(host.fontSize()).toBe(32);
    expect(store.saved).toEqual([]);
  });

  it('覚える先が無くても、書き込みに失敗しても大きさは変わる', () => {
    const { host } = make();
    host.zoom('in');
    expect(host.fontSize()).toBe(14);
    const failing = make({ load: () => undefined, save: () => { throw new Error('quota'); } }).host;
    failing.zoom('in');
    expect(failing.fontSize()).toBe(14);
  });
});

describe('タブごとのつなぎ直し（F1）', () => {
  // 画面の外から閉じられたとき（サーバの再起動、スリープからの復帰）は、タブごとに間隔を延ばしながらつなぎ直す。
  it('思いがけず切れたら、1 秒、2 秒、4 秒と間を延ばしてつなぎ直し、つながったら間を戻す', () => {
    vi.useFakeTimers();
    try {
      const { host } = make();
      host.connect('t1');
      FakeWs.all[0]!.open();
      expect(host.link('t1')).toEqual({ retryAt: null, dropped: false });
      FakeWs.all[0]!.close();
      expect(host.status('t1')).toBe('closed');
      expect(host.link('t1')).toEqual({ retryAt: Date.now() + 1000, dropped: true });
      vi.advanceTimersByTime(999);
      expect(FakeWs.all).toHaveLength(1);
      vi.advanceTimersByTime(1);
      expect(FakeWs.all).toHaveLength(2);
      expect(host.status('t1')).toBe('connecting');
      expect(host.link('t1')).toEqual({ retryAt: null, dropped: true });
      // 繋がらないまま閉じたら、次は倍の間を空ける。
      FakeWs.all[1]!.close();
      expect(host.link('t1').retryAt).toBe(Date.now() + 2000);
      vi.advanceTimersByTime(2000);
      FakeWs.all[2]!.close();
      expect(host.link('t1').retryAt).toBe(Date.now() + 4000);
      vi.advanceTimersByTime(4000);
      FakeWs.all[3]!.open();
      expect(host.link('t1')).toEqual({ retryAt: null, dropped: false });
      FakeWs.all[3]!.close();
      expect(host.link('t1').retryAt).toBe(Date.now() + 1000);
    } finally { vi.useRealTimers(); }
  });
  it('間は 30 秒で頭打ちにする', () => {
    vi.useFakeTimers();
    try {
      const { host } = make();
      host.connect('t1');
      for (let i = 0; i < 8; i++) { FakeWs.all.at(-1)!.close(); vi.advanceTimersByTime(host.link('t1').retryAt! - Date.now()); }
      FakeWs.all.at(-1)!.close();
      expect(host.link('t1').retryAt).toBe(Date.now() + 30_000);
    } finally { vi.useRealTimers(); }
  });
  it('自分で切ったとき（画面を離れた、run が終わった）はつなぎ直さない', () => {
    vi.useFakeTimers();
    try {
      const { host } = make();
      host.connect('t1');
      FakeWs.all[0]!.open();
      FakeWs.all[0]!.close();
      host.disconnect('t1');
      expect(host.link('t1')).toEqual({ retryAt: null, dropped: false });
      vi.advanceTimersByTime(60_000);
      expect(FakeWs.all).toHaveLength(1);
      expect(host.status('t1')).toBe('closed');
    } finally { vi.useRealTimers(); }
  });
  // tmux の中の端末が終わると、サーバは 1000 と 'exited' で閉じる（pty/relay.ts）。
  // 切れたのではなく終わったので、つなぎ直さない。
  it('中の端末が終わって閉じたときはつなぎ直さず、切れたとも言わない', () => {
    vi.useFakeTimers();
    try {
      const { host } = make();
      host.connect('t1');
      FakeWs.all[0]!.open();
      FakeWs.all[0]!.close(1000, 'exited');
      expect(host.status('t1')).toBe('closed');
      expect(host.link('t1')).toEqual({ retryAt: null, dropped: false });
      vi.advanceTimersByTime(60_000);
      expect(FakeWs.all).toHaveLength(1);
    } finally { vi.useRealTimers(); }
  });
  it('サーバが断ったとき（エラーの知らせ）は待ってもつながらないので、自動ではつなぎ直さない', () => {
    vi.useFakeTimers();
    try {
      const { host } = make();
      host.connect('t1');
      FakeWs.all[0]!.receive({ t: 'error', message: 'gone' });
      FakeWs.all[0]!.close();
      expect(host.status('t1')).toBe('error');
      expect(host.link('t1').retryAt).toBeNull();
      vi.advanceTimersByTime(60_000);
      expect(FakeWs.all).toHaveLength(1);
    } finally { vi.useRealTimers(); }
  });
  it('「再接続」は待たずにすぐつなぎ、間を最初に戻す。エラーの後でもつなぐ', () => {
    vi.useFakeTimers();
    try {
      const { host } = make();
      const changes = vi.fn();
      host.subscribe(changes);
      host.connect('t1');
      FakeWs.all[0]!.close();
      vi.advanceTimersByTime(1000);
      FakeWs.all[1]!.close();
      expect(host.link('t1').retryAt).toBe(Date.now() + 2000);
      changes.mockClear();
      host.reconnect('t1');
      expect(FakeWs.all).toHaveLength(3);
      expect(host.link('t1').retryAt).toBeNull();
      expect(changes).toHaveBeenCalled();
      // 待っていた分の自動の試しは消える。
      vi.advanceTimersByTime(2000);
      expect(FakeWs.all).toHaveLength(3);
      FakeWs.all[2]!.close();
      expect(host.link('t1').retryAt).toBe(Date.now() + 1000);
      host.reconnect('t1');
      FakeWs.all[3]!.receive({ t: 'error', message: 'x' });
      FakeWs.all[3]!.close();
      expect(host.status('t1')).toBe('error');
      host.reconnect('t1');
      expect(FakeWs.all).toHaveLength(5);
      expect(host.status('t1')).toBe('connecting');
    } finally { vi.useRealTimers(); }
  });
  it('待っている間に外から connect が来たら、待たずにつなぐ', () => {
    vi.useFakeTimers();
    try {
      const { host } = make();
      host.connect('t1');
      FakeWs.all[0]!.close();
      host.connect('t1');
      expect(FakeWs.all).toHaveLength(2);
      expect(host.link('t1').retryAt).toBeNull();
      vi.advanceTimersByTime(1000);
      expect(FakeWs.all).toHaveLength(2);
    } finally { vi.useRealTimers(); }
  });
  it('知らないタブと、片付けた後', () => {
    vi.useFakeTimers();
    try {
      const { host } = make();
      expect(host.link('nope')).toEqual({ retryAt: null, dropped: false });
      host.connect('t1');
      FakeWs.all[0]!.close();
      host.dispose();
      vi.advanceTimersByTime(60_000);
      expect(FakeWs.all).toHaveLength(1);
    } finally { vi.useRealTimers(); }
  });
});
