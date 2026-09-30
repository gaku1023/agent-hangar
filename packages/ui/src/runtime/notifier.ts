/**
 * 窓の外へ入力待ちを知らせる口。
 * デスクトップの殻（Tauri）では macOS の通知と Dock のバッジ、ブラウザでは Web Notification とアプリのバッジを使う。
 * どちらも無い環境では、ランタイムは通知を出さず、右下のカードとサイドバーの数だけで知らせる。
 */
export type Notifier = {
  /**
   * 選んでいないときに受け取るか。
   * デスクトップは受け取る、ブラウザは受け取らない。
   */
  defaultOn: boolean;
  /**
   * 通知を出せる環境か。
   * ブラウザで拒まれた後は false になる。
   */
  available(): boolean;
  /**
   * いま許可が出ているか。
   * OS が許可を持つデスクトップでは、尋ねる前も true とみなす。
   */
  granted(): boolean;
  /**
   * 許可を求める。
   * ブラウザでは利用者の操作の中から呼ばないとダイアログが出ない。
   */
  request(): Promise<boolean>;
  /** 既定で受け取る環境で、起動したときに OS の許可をあらかじめ尋ねておく。 */
  prepare(): void;
  /**
   * 窓が背面にあるか。
   * 前にあるときは右下のカードで足りるので、通知を出さない。
   */
  background(): boolean;
  show(n: { sessionId: string; title: string; body: string }): void;
  /**
   * 入力待ちの数をバッジに出す。
   * 0 で消す。
   */
  badge(count: number): void;
  /**
   * 通知が押されたら、そのセッションの id で呼ぶ。
   * 返り値で購読を外す。
   */
  onOpen(cb: (sessionId: string) => void): () => void;
};

type Doc = { visibilityState: string; hasFocus(): boolean };
/**
 * 隠れているか、窓にフォーカスが無ければ背面とみなす。
 * 別のアプリを前に出したときは後者で分かる。
 */
const inBackground = (d: Doc): boolean => d.visibilityState !== 'visible' || !d.hasFocus();

/**
 * デスクトップの殻が頁に置く IPC と、殻が通知を押されたときに呼ぶ受け口。
 * 頁は 127.0.0.1:4177 から読む remote の頁なので、呼べるコマンドは capabilities/remote-notify.json が許したものだけである。
 */
export type DesktopEnv = {
  __TAURI_INTERNALS__: { invoke: (cmd: string, args?: Record<string, unknown>) => Promise<unknown> };
  __hangarOpenWaiting?: (sessionId: string) => void;
  document: Doc;
};

/**
 * macOS の通知（殻の notify_waiting）と Dock のバッジ（Tauri の set_badge_count）。
 * 許可は OS が持つ。
 * 尋ねる前も出せるとみなし、起動したときに notify_request で一度だけ尋ねておく（決まった後は OS が黙って答える）。
 * 殻の失敗は画面に出さない。
 * 通知が出ないだけで、右下のカードとサイドバーの数は残るからである。
 */
export function createDesktopNotifier(env: DesktopEnv): Notifier {
  const invoke = (cmd: string, args?: Record<string, unknown>) => env.__TAURI_INTERNALS__.invoke(cmd, args);
  const ask = () => invoke('notify_request', undefined).then((r) => r === true, () => false);
  return {
    defaultOn: true,
    available: () => true,
    granted: () => true,
    request: ask,
    prepare: () => { void ask(); },
    background: () => inBackground(env.document),
    show: (n) => { invoke('notify_waiting', { sessionId: n.sessionId, title: n.title, body: n.body }).catch(() => {}); },
    badge: (count) => { invoke('plugin:window|set_badge_count', { value: count > 0 ? count : null }).catch(() => {}); },
    onOpen: (cb) => {
      env.__hangarOpenWaiting = cb;
      return () => { delete env.__hangarOpenWaiting; };
    },
  };
}

type WebNotification = { onclick: (() => void) | null; close(): void };
/**
 * ブラウザの Notification とバッジ。
 * どれも無いブラウザがあるので、すべて省けるようにしておく。
 */
export type BrowserEnv = {
  Notification?: { permission: NotificationPermission; requestPermission(): Promise<NotificationPermission>; new (title: string, options?: NotificationOptions): WebNotification };
  navigator: { setAppBadge?: (n?: number) => Promise<void>; clearAppBadge?: () => Promise<void> };
  document: Doc;
  focus(): void;
};

/**
 * Web Notification とアプリのバッジ（navigator.setAppBadge）。
 * 既定では受け取らない。
 * 許可を求めるのは、利用者が「通知を受け取る」を押したときだけにする（押した操作の中でないとダイアログが出ない）。
 */
export function createBrowserNotifier(env: BrowserEnv): Notifier {
  let open: ((sessionId: string) => void) | null = null;
  const N = env.Notification;
  return {
    defaultOn: false,
    available: () => !!N && N.permission !== 'denied',
    granted: () => !!N && N.permission === 'granted',
    request: async () => {
      if (!N) return false;
      if (N.permission === 'granted') return true;
      return (await N.requestPermission()) === 'granted';
    },
    prepare: () => {},
    background: () => inBackground(env.document),
    show: (n) => {
      if (!N || N.permission !== 'granted') return;
      // 同じセッションの知らせは tag で 1 つにまとめる。
      const note = new N(n.title, { body: n.body, tag: `hangar-waiting-${n.sessionId}` });
      note.onclick = () => { env.focus(); open?.(n.sessionId); note.close(); };
    },
    badge: (count) => {
      const nav = env.navigator;
      const p = count > 0 ? nav.setAppBadge?.(count) : nav.clearAppBadge?.();
      p?.catch(() => {});
    },
    onOpen: (cb) => { open = cb; return () => { open = null; }; },
  };
}

/** 殻の IPC があればデスクトップ、無ければブラウザの口を使う。 */
export function pickNotifier(win: Partial<DesktopEnv> & BrowserEnv): Notifier {
  if (typeof win.__TAURI_INTERNALS__?.invoke === 'function') return createDesktopNotifier(win as DesktopEnv & BrowserEnv);
  return createBrowserNotifier(win);
}
