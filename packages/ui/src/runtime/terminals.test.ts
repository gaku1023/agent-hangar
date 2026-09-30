import { describe, expect, it, vi } from 'vitest';
import { createTerminalHost, type TerminalLike } from './terminals.ts';

class FakeWs {
  static all: FakeWs[] = [];
  readyState = 0; sent: string[] = [];
  onopen: (() => void) | null = null; onmessage: ((m: { data: string }) => void) | null = null; onclose: (() => void) | null = null; onerror: (() => void) | null = null;
  constructor(public url: string) { FakeWs.all.push(this); }
  send(d: string) { this.sent.push(d); }
  close() { this.readyState = 3; this.onclose?.(); }
  open() { this.readyState = 1; this.onopen?.(); }
  receive(m: unknown) { this.onmessage?.({ data: JSON.stringify(m) }); }
}
type FakeTerm = TerminalLike & { written: string[]; opened: HTMLElement | null; fitted: number; focused: number; disposed: boolean; gpu: boolean; gpuBeforeOpen: boolean; pasted: string[]; type(d: string): void; resizeTo(c: number, r: number): void; detachHost(): void };
function fakeTerm(): FakeTerm {
  const data: ((d: string) => void)[] = []; const resize: ((s: { cols: number; rows: number }) => void)[] = [];
  // 画面を離れると React が枠ごと外すので、要素の親は残ったまま文書から外れる。isConnected はそれを表す。
  const node = { parentElement: null as HTMLElement | null, hostDetached: false, get isConnected() { return node.parentElement !== null && !node.hostDetached; }, remove() { node.parentElement = null; } };
  const t: FakeTerm = {
    cols: 80, rows: 24, element: null, written: [], opened: null, fitted: 0, focused: 0, disposed: false, gpu: false, gpuBeforeOpen: false, pasted: [],
    open(el) { t.opened = el; node.parentElement = el; t.element = node as unknown as HTMLElement; },
    detachHost() { node.hostDetached = true; },
    write(d) { t.written.push(d); },
    onData(cb) { data.push(cb); return { dispose() {} }; },
    onResize(cb) { resize.push(cb); return { dispose() {} }; },
    fit() { t.fitted++; }, focus() { t.focused++; }, dispose() { t.disposed = true; },
    paste(d) { t.pasted.push(d); },
    setGpu(on) { if (on && !t.opened) t.gpuBeforeOpen = true; t.gpu = on; },
    type(d) { for (const cb of data) cb(d); }, resizeTo(c, r) { for (const cb of resize) cb({ cols: c, rows: r }); },
  };
  return t;
}
function make() {
  FakeWs.all = [];
  const terms: FakeTerm[] = [];
  const host = createTerminalHost({ wsUrl: (id) => `ws://x/ws/pty?tab=${id}`, createTerminal: () => { const t = fakeTerm(); terms.push(t); return t; }, wsFactory: (u) => new FakeWs(u) as unknown as WebSocket });
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
