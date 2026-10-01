export type TerminalStatus = 'connecting' | 'connected' | 'closed' | 'error';
export type TerminalLike = { cols: number; rows: number; element: HTMLElement | null; open(el: HTMLElement): void; write(d: string): void; onData(cb: (d: string) => void): { dispose(): void }; onResize(cb: (s: { cols: number; rows: number }) => void): { dispose(): void }; fit(): void; focus(): void; dispose(): void;
  /** WebGL の描画を付け外しする。外すと DOM の描画に戻る。open のあとにだけ呼ぶ。 */
  setGpu(on: boolean): void;
  /** 貼り付けとして送る。xterm は括弧付き貼り付けが有効なら括弧で包む。 */
  paste(text: string): void;
  /** 文字の大きさ（px）を変える。合わせ直しは呼び手が fit で行う。 */
  setFontSize(px: number): void };
export type TerminalHost = { connect(tabId: string): void; paste(tabId: string, text: string): void; disconnect(tabId: string): void; mount(tabId: string, el: HTMLElement): void; status(tabId: string): TerminalStatus | null; fit(tabId: string): void; focus(tabId: string): void;
  /** 全部の端末の文字を 1px ずつ大きく、小さく、または既定に戻す。 */
  zoom(step: 'in' | 'out' | 'reset'): void;
  /** いまの文字の大きさ（px）。 */
  fontSize(): number;
  subscribe(cb: () => void): () => void; dispose(): void };

/** 端末の文字の大きさを覚えておく localStorage の鍵。値は px の数そのもの。 */
export const FONT_SIZE_KEY = 'terminal.fontSize';

/** 端末の文字の大きさ（px）。既定と、⌘+ と ⌘− で動ける範囲。 */
export const FONT_SIZE = { default: 13, min: 8, max: 32 } as const;

/** 覚えておいた値を範囲に収める。数でなければ既定に戻す。 */
function clampFontSize(v: unknown): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) return FONT_SIZE.default;
  return Math.min(FONT_SIZE.max, Math.max(FONT_SIZE.min, Math.round(v)));
}

type Entry = { term: TerminalLike; ws: WebSocket | null; status: TerminalStatus; opened: boolean; subs: { dispose(): void }[] };

/**
 * タブごとの xterm と WebSocket を React の外で持つ。
 * xterm とバッファとスクロール位置は残したまま、run の終了とタブを閉じたときとセッション画面を離れたときに接続を切る。
 */
export function createTerminalHost(deps: { wsUrl: (tabId: string) => string; createTerminal: () => TerminalLike; wsFactory?: (url: string) => WebSocket;
  /** 文字の大きさを覚えておく先。読めなくても書けなくても、大きさはその場では変わる。 */
  fontSize?: { load(): unknown; save(px: number): void } }): TerminalHost {
  const entries = new Map<string, Entry>();
  let fontSize: number = FONT_SIZE.default;
  try { fontSize = clampFontSize(deps.fontSize?.load() ?? FONT_SIZE.default); } catch { /* 読めなければ既定のまま */ }
  const listeners = new Set<() => void>();
  /**
   * mount の前に来た focus。open していない xterm には入力欄がなく、画面を離れて枠ごと外れた xterm の入力欄に当てても効かないので、mount のあとに当て直す。
   */
  let pendingFocus: string | null = null;
  const notify = () => { for (const l of listeners) l(); };
  const setStatus = (e: Entry, s: TerminalStatus) => { if (e.status !== s) { e.status = s; notify(); } };
  const ensure = (tabId: string): Entry => {
    let e = entries.get(tabId);
    if (!e) {
      const term = deps.createTerminal();
      term.setFontSize(fontSize);
      e = { term, ws: null, status: 'closed', opened: false, subs: [] };
      entries.set(tabId, e);
    }
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
      // WebGL の描画文脈はブラウザ全体で 16 個までなので、見えている 1 枚だけに持たせる。隠れたタブは DOM の描画に戻す。
      for (const [id, other] of entries) if (id !== tabId && other.opened) other.term.setGpu(false);
      e.term.setGpu(true);
      e.term.fit();
      if (pendingFocus === tabId) { pendingFocus = null; e.term.focus(); }
    },
    paste(tabId, text) {
      const e = entries.get(tabId);
      if (e?.opened) e.term.paste(text);
    },
    zoom(step) {
      const next = step === 'reset' ? FONT_SIZE.default : clampFontSize(fontSize + (step === 'in' ? 1 : -1));
      if (next === fontSize) return;
      fontSize = next;
      // 隠れたタブの端末にも効かせる。寸法の合わせ直しは、開いていない端末では mount のときに行われる。
      for (const e of entries.values()) { e.term.setFontSize(next); if (e.opened) e.term.fit(); }
      try { deps.fontSize?.save(next); } catch { /* 覚えられなくても、いまの画面には効いている */ }
    },
    fontSize: () => fontSize,
    status: (tabId) => entries.get(tabId)?.status ?? null,
    fit: (tabId) => entries.get(tabId)?.term.fit(),
    focus(tabId) {
      const e = entries.get(tabId);
      // 画面に戻ったときの focus は、新しい枠が付く前に走る。文書から外れた要素には当てずに mount を待つ。
      if (!e?.opened || !e.term.element?.isConnected) { pendingFocus = tabId; return; }
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
