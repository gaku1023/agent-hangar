export type TerminalStatus = 'connecting' | 'connected' | 'closed' | 'error';
export type TerminalLike = { cols: number; rows: number; element: HTMLElement | null; open(el: HTMLElement): void; write(d: string): void; onData(cb: (d: string) => void): { dispose(): void }; onResize(cb: (s: { cols: number; rows: number }) => void): { dispose(): void }; fit(): void; focus(): void; dispose(): void };
export type TerminalHost = { connect(tabId: string): void; disconnect(tabId: string): void; mount(tabId: string, el: HTMLElement): void; status(tabId: string): TerminalStatus | null; fit(tabId: string): void; focus(tabId: string): void; subscribe(cb: () => void): () => void; dispose(): void };

type Entry = { term: TerminalLike; ws: WebSocket | null; status: TerminalStatus; opened: boolean; subs: { dispose(): void }[] };

/**
 * タブごとの xterm と WebSocket を React の外で持つ。
 * xterm とバッファとスクロール位置は残したまま、run の終了とタブを閉じたときとセッション画面を離れたときに接続を切る。
 */
export function createTerminalHost(deps: { wsUrl: (tabId: string) => string; createTerminal: () => TerminalLike; wsFactory?: (url: string) => WebSocket }): TerminalHost {
  const entries = new Map<string, Entry>();
  const listeners = new Set<() => void>();
  /** open の前に来た focus。open していない xterm には入力欄がないので、mount のあとに当て直す。 */
  let pendingFocus: string | null = null;
  const notify = () => { for (const l of listeners) l(); };
  const setStatus = (e: Entry, s: TerminalStatus) => { if (e.status !== s) { e.status = s; notify(); } };
  const ensure = (tabId: string): Entry => {
    let e = entries.get(tabId);
    if (!e) { e = { term: deps.createTerminal(), ws: null, status: 'closed', opened: false, subs: [] }; entries.set(tabId, e); }
    return e;
  };
  const send = (e: Entry, m: unknown) => { if (e.ws && e.ws.readyState === 1) e.ws.send(JSON.stringify(m)); };

  return {
    connect(tabId) {
      const e = ensure(tabId);
      if (e.ws && (e.ws.readyState === 0 || e.ws.readyState === 1)) return;
      const ws = (deps.wsFactory ?? ((u) => new WebSocket(u)))(deps.wsUrl(tabId));
      e.ws = ws;
      setStatus(e, 'connecting');
      ws.onopen = () => { setStatus(e, 'connected'); send(e, { t: 'resize', cols: e.term.cols, rows: e.term.rows }); };
      ws.onmessage = (m) => {
        let parsed: unknown;
        try { parsed = JSON.parse(String(m.data)); } catch { return; }
        if (typeof parsed !== 'object' || parsed === null) return;
        const msg = parsed as { t?: unknown; d?: unknown; message?: unknown };
        if (msg.t === 'data' && typeof msg.d === 'string') e.term.write(msg.d);
        else if (msg.t === 'error') { e.term.write(`\r\n[agent-hangar] ${String(msg.message)}\r\n`); setStatus(e, 'error'); }
      };
      ws.onclose = () => { if (e.ws === ws) { e.ws = null; if (e.status !== 'error') setStatus(e, 'closed'); } };
      ws.onerror = () => { /* onclose が続く */ };
      if (e.subs.length === 0) {
        e.subs.push(e.term.onData((d) => send(e, { t: 'data', d })));
        e.subs.push(e.term.onResize((s) => send(e, { t: 'resize', cols: s.cols, rows: s.rows })));
      }
    },
    disconnect(tabId) {
      const e = entries.get(tabId);
      if (!e) return;
      const ws = e.ws; e.ws = null;
      ws?.close();
      setStatus(e, 'closed');
    },
    mount(tabId, el) {
      const e = ensure(tabId);
      // 同じ枠に別のタブの要素が残っていると、見えている端末と入力先がずれる。
      for (const [id, other] of entries) if (id !== tabId && other.term.element?.parentElement === el) other.term.element.remove();
      if (!e.opened) { e.term.open(el); e.opened = true; }
      else if (e.term.element && e.term.element.parentElement !== el) el.appendChild(e.term.element);
      e.term.fit();
      if (pendingFocus === tabId) { pendingFocus = null; e.term.focus(); }
    },
    status: (tabId) => entries.get(tabId)?.status ?? null,
    fit: (tabId) => entries.get(tabId)?.term.fit(),
    focus(tabId) {
      const e = entries.get(tabId);
      if (!e?.opened) { pendingFocus = tabId; return; }
      if (pendingFocus === tabId) pendingFocus = null;
      e.term.focus();
    },
    subscribe(cb) { listeners.add(cb); return () => { listeners.delete(cb); }; },
    dispose() {
      for (const e of entries.values()) { e.ws?.close(); for (const s of e.subs) s.dispose(); e.term.dispose(); }
      entries.clear(); listeners.clear(); pendingFocus = null;
    },
  };
}
