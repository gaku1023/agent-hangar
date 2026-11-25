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
function fakeTerm(): TerminalLike {
  const node = { parentElement: null as HTMLElement | null, isConnected: true, remove() {} };
  const t = { cols: 80, rows: 24, element: null as HTMLElement | null, open(el: HTMLElement) { node.parentElement = el; t.element = node as unknown as HTMLElement; }, write(_d: string, done?: () => void) { done?.(); }, onData() { return { dispose() {} }; }, onResize() { return { dispose() {} }; }, fit() {}, focus() {}, dispose() {}, setGpu() {}, paste() {}, input() {}, setFontSize() {} };
  return t as unknown as TerminalLike;
}
function make() {
  FakeWs.all = [];
  return createTerminalHost({ wsUrl: (id) => `ws://x/ws/pty?tab=${id}`, createTerminal: fakeTerm, wsFactory: (u) => new FakeWs(u) as unknown as WebSocket, alive: () => true });
}

describe('terminals: SSH のシェルタブの札', () => {
  it('{t:remote} の札を受けて状態を持ち、知らないタブは null', () => {
    const host = make();
    expect(host.remote('r1')).toBeNull();
    host.connect('r1');
    const ws = FakeWs.all[0]!; ws.open();
    const seen = vi.fn(); host.subscribe(seen);
    ws.receive({ t: 'remote', phase: 'retrying', attempt: 2, retryAt: 5, address: '192.168.0.2', detail: 'timed out' });
    expect(host.remote('r1')).toEqual({ phase: 'retrying', attempt: 2, retryAt: 5, address: '192.168.0.2', detail: 'timed out' });
    ws.receive({ t: 'remote', phase: 'failed', reason: 'auth', detail: 'denied' });
    expect(host.remote('r1')).toEqual({ phase: 'failed', reason: 'auth', detail: 'denied' });
    expect(seen).toHaveBeenCalled();
  });

  it('failed の間に WS が切れても自動ではつなぎ直さない', () => {
    vi.useFakeTimers();
    try {
      const host = make();
      host.connect('r1');
      const ws = FakeWs.all[0]!; ws.open();
      ws.receive({ t: 'remote', phase: 'failed', reason: 'unreachable' });
      ws.close(1006, '');
      vi.advanceTimersByTime(60_000);
      expect(FakeWs.all).toHaveLength(1);
      expect(host.link('r1').retryAt).toBeNull();
    } finally { vi.useRealTimers(); }
  });

  it('retry は開いている WS に {t:retry} を送り、状態を connecting に戻す。disconnect で札を忘れる', () => {
    const host = make();
    host.connect('r1');
    const ws = FakeWs.all[0]!; ws.open();
    ws.receive({ t: 'remote', phase: 'failed', reason: 'auth' });
    host.retry('r1');
    expect(ws.sent.map((s) => JSON.parse(s))).toContainEqual({ t: 'retry' });
    expect(host.remote('r1')?.phase).toBe('connecting');
    host.disconnect('r1');
    expect(host.remote('r1')).toBeNull();
  });

  it('WS が閉じていれば retry は新しくつなぐ', () => {
    const host = make();
    host.connect('r1');
    FakeWs.all[0]!.open(); FakeWs.all[0]!.receive({ t: 'remote', phase: 'failed', reason: 'auth' }); FakeWs.all[0]!.close(1006, '');
    host.retry('r1');
    expect(FakeWs.all).toHaveLength(2);
  });
});
