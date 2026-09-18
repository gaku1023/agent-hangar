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
type FakeTerm = TerminalLike & { written: string[]; opened: HTMLElement | null; fitted: number; focused: number; disposed: boolean; type(d: string): void; resizeTo(c: number, r: number): void };
function fakeTerm(): FakeTerm {
  const data: ((d: string) => void)[] = []; const resize: ((s: { cols: number; rows: number }) => void)[] = [];
  const t: FakeTerm = {
    cols: 80, rows: 24, element: null, written: [], opened: null, fitted: 0, focused: 0, disposed: false,
    open(el) { t.opened = el; t.element = { parentElement: el, remove() { (t.element as unknown as { parentElement: HTMLElement | null }).parentElement = null; } } as unknown as HTMLElement; },
    write(d) { t.written.push(d); },
    onData(cb) { data.push(cb); return { dispose() {} }; },
    onResize(cb) { resize.push(cb); return { dispose() {} }; },
    fit() { t.fitted++; }, focus() { t.focused++; }, dispose() { t.disposed = true; },
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
