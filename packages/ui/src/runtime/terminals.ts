export type TerminalStatus = 'connecting' | 'connected' | 'closed' | 'error';
export type TerminalLike = { cols: number; rows: number; element: HTMLElement | null; open(el: HTMLElement): void; write(d: string): void; onData(cb: (d: string) => void): { dispose(): void }; onResize(cb: (s: { cols: number; rows: number }) => void): { dispose(): void }; fit(): void; focus(): void; dispose(): void;
  /** WebGL の描画を付け外しする。外すと DOM の描画に戻る。open のあとにだけ呼ぶ。 */
  setGpu(on: boolean): void;
  /** 貼り付けとして送る。xterm は括弧付き貼り付けが有効なら括弧で包む。 */
  paste(text: string): void;
  /** 文字の大きさ（px）を変える。合わせ直しは呼び手が fit で行う。 */
  setFontSize(px: number): void };
/**
 * タブの接続の様子。
 * dropped は、つながっていた（またはつなごうとしていた）接続が思いがけず切れ、まだつなぎ直せていないこと。
 * retryAt は次に自動でつなぎ直す時刻で、待っていないときは null。
 * gaveUp は、続けて RETRY.attempts 回つながらず、自動のつなぎ直しをやめたこと。
 * detached は、サーバが 1000 と 'exited' で閉じたのに、その run とタブがまだ生きていること。
 * xterm の中で tmux から抜けた（C-b d）ときに起きる。
 * 自動ではつながず、利用者のつなぎ直しを待つ。
 */
export type TerminalLink = { retryAt: number | null; dropped: boolean; gaveUp: boolean; detached: boolean };
export type TerminalHost = { connect(tabId: string): void; paste(tabId: string, text: string): void; disconnect(tabId: string): void; mount(tabId: string, el: HTMLElement): void; status(tabId: string): TerminalStatus | null; fit(tabId: string): void; focus(tabId: string): void;
  /**
   * 切れたタブのつなぎ直しの様子。
   * 知らないタブは切れていない扱いにする。
   */
  link(tabId: string): TerminalLink;
  /**
   * 待たずに今つなぎ直す（「再接続」のボタン）。
   * 間隔は最初に戻す。
   */
  reconnect(tabId: string): void;
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

/**
 * つなぎ直しの間隔と回数。
 * 1 秒から倍ずつ延ばし、30 秒で頭打ちにする。
 * 続けて attempts 回つながらなければ、自動ではやめる。
 * upgrade を HTTP で断られた（404 や 401）タブは、ブラウザでは 1006 で閉じるだけで、待ってもつながらないからである。
 */
export const RETRY = { first: 1000, max: 30_000, attempts: 5 } as const;

/**
 * want は利用者の側がつないでおきたいタブか（connect の後、disconnect の前）。
 * 思いがけず切れたときだけつなぎ直すために持つ。
 * fails は続けて失敗した回数で、次の間隔を決める。
 * timer と retryAt は待っている自動の試し。
 */
type Entry = { term: TerminalLike; ws: WebSocket | null; status: TerminalStatus; opened: boolean; subs: { dispose(): void }[]; want: boolean; fails: number; dropped: boolean; gaveUp: boolean; detached: boolean; timer: ReturnType<typeof setTimeout> | null; retryAt: number | null };

/**
 * タブごとの xterm と WebSocket を React の外で持つ。
 * xterm とバッファとスクロール位置は残したまま、run の終了とタブを閉じたときとセッション画面を離れたときに接続を切る。
 */
export function createTerminalHost(deps: { wsUrl: (tabId: string) => string; createTerminal: () => TerminalLike; wsFactory?: (url: string) => WebSocket;
  /** 文字の大きさを覚えておく先。読めなくても書けなくても、大きさはその場では変わる。 */
  fontSize?: { load(): unknown; save(px: number): void };
  /**
   * そのタブの run とタブが、ストアの上でまだ生きているか。
   * 自動でつなぎ直す前に確かめ、生きていなければつなぎ直さない。
   * 渡さなければ生きているとみなす。
   */
  alive?: (tabId: string) => boolean }): TerminalHost {
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
      e = { term, ws: null, status: 'closed', opened: false, subs: [], want: false, fails: 0, dropped: false, gaveUp: false, detached: false, timer: null, retryAt: null };
      entries.set(tabId, e);
    }
    return e;
  };
  const send = (e: Entry, m: unknown) => { if (e.ws && e.ws.readyState === 1) e.ws.send(JSON.stringify(m)); };
  const stopRetry = (e: Entry) => { if (e.timer !== null) clearTimeout(e.timer); e.timer = null; e.retryAt = null; };
  /**
   * 思いがけず切れたタブを、間を延ばしながらつなぎ直す。
   * 本体の WebSocket が戻るのを待たないのは、ターミナルの接続だけが切れることがあるからである（スリープからの復帰、tmux attach の落ち）。
   */
  const scheduleRetry = (tabId: string, e: Entry) => {
    stopRetry(e);
    const wait = Math.min(RETRY.first * 2 ** e.fails, RETRY.max);
    e.fails++;
    e.retryAt = Date.now() + wait;
    e.timer = setTimeout(() => {
      e.timer = null; e.retryAt = null;
      if (!e.want) return;
      // 待つ間に run が終わったりタブが閉じたりしていたら、つなぎ直さない。
      // サーバの再起動中に終わった run には run.ended が届かないので、bootstrap の後のストアで確かめる。
      if (deps.alive && !deps.alive(tabId)) { e.want = false; e.fails = 0; e.dropped = false; notify(); return; }
      open(tabId, e);
    }, wait);
  };
  const open = (tabId: string, e: Entry) => {
    stopRetry(e);
    if (e.ws && (e.ws.readyState === 0 || e.ws.readyState === 1)) return;
    const ws = (deps.wsFactory ?? ((u) => new WebSocket(u)))(deps.wsUrl(tabId));
    e.ws = ws;
    setStatus(e, 'connecting');
    notify();
    ws.onopen = () => { e.fails = 0; e.dropped = false; e.gaveUp = false; e.detached = false; setStatus(e, 'connected'); send(e, { t: 'resize', cols: e.term.cols, rows: e.term.rows }); };
    ws.onmessage = (m) => {
      let parsed: unknown;
      try { parsed = JSON.parse(String(m.data)); } catch { return; }
      if (typeof parsed !== 'object' || parsed === null) return;
      const msg = parsed as { t?: unknown; d?: unknown; message?: unknown };
      if (msg.t === 'data' && typeof msg.d === 'string') e.term.write(msg.d);
      else if (msg.t === 'error') { e.term.write(`\r\n[agent-hangar] ${String(msg.message)}\r\n`); setStatus(e, 'error'); }
    };
    // 自分で閉じた接続（disconnect）は e.ws を先に外しているので、ここには来ない。
    // サーバが断った（error）ときは、待っても同じ答えなので自動ではつながず、「再接続」のボタンに任せる。
    // 中の端末が終わったとき（Claude の終了、タブを閉じた）は、サーバが 1000 と 'exited' で閉じる（server の pty/relay.ts）。
    // 切れたのではないので、つなぎ直さない。
    // ただし tmux から抜けた（C-b d）ときも同じ閉じ方になる。
    // そのとき run とタブはまだ生きているので、自動ではつながずに、つなぎ直す手を出す（detached）。
    // 本当に終わったときは、続いて届く run.ended か tab.upsert が disconnect で消す。
    ws.onclose = (ev?: { code?: number; reason?: string }) => {
      if (e.ws !== ws) return;
      e.ws = null;
      if (e.status === 'error') { notify(); return; }
      setStatus(e, 'closed');
      const exited = ev?.code === 1000 && ev.reason === 'exited';
      if (e.want && exited && (deps.alive?.(tabId) ?? true)) e.detached = true;
      if (e.want && !exited) {
        e.dropped = true;
        // 続けて何度もつながらなければ、自動ではやめて「再接続」に任せる。
        if (e.fails >= RETRY.attempts) e.gaveUp = true;
        else scheduleRetry(tabId, e);
      }
      notify();
    };
    ws.onerror = () => { /* onclose が続く */ };
    if (e.subs.length === 0) {
      e.subs.push(e.term.onData((d) => send(e, { t: 'data', d })));
      e.subs.push(e.term.onResize((s) => send(e, { t: 'resize', cols: s.cols, rows: s.rows })));
    }
  };

  return {
    connect(tabId) {
      const e = ensure(tabId);
      e.want = true;
      e.gaveUp = false;
      e.detached = false;
      open(tabId, e);
    },
    reconnect(tabId) {
      const e = ensure(tabId);
      e.want = true;
      e.fails = 0;
      e.gaveUp = false;
      e.detached = false;
      if (e.status === 'error') e.status = 'closed';
      open(tabId, e);
    },
    link(tabId) {
      const e = entries.get(tabId);
      return e ? { retryAt: e.retryAt, dropped: e.dropped, gaveUp: e.gaveUp, detached: e.detached } : { retryAt: null, dropped: false, gaveUp: false, detached: false };
    },
    disconnect(tabId) {
      const e = entries.get(tabId);
      if (!e) return;
      e.want = false; e.fails = 0; e.dropped = false; e.gaveUp = false; e.detached = false;
      stopRetry(e);
      const ws = e.ws; e.ws = null;
      ws?.close();
      setStatus(e, 'closed');
      notify();
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
      for (const e of entries.values()) { e.want = false; stopRetry(e); e.ws?.close(); for (const s of e.subs) s.dispose(); e.term.dispose(); }
      entries.clear(); listeners.clear(); pendingFocus = null;
    },
  };
}
