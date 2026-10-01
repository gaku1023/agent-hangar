import { describe, expect, it, vi } from 'vitest';
import { createBrowserNotifier, createDesktopNotifier, pickNotifier, type BrowserEnv, type DesktopEnv } from './notifier.ts';

function doc(visible: boolean, focused: boolean) {
  return { visibilityState: visible ? 'visible' : 'hidden', hasFocus: () => focused };
}

describe('デスクトップの通知', () => {
  function env(over: Partial<DesktopEnv> = {}) {
    const invoke = vi.fn(async (cmd: string) => (cmd === 'notify_request' ? true : cmd === 'notify_status' ? 'denied' : null));
    const e: DesktopEnv = { __TAURI_INTERNALS__: { invoke }, document: doc(true, true), ...over };
    return { e, invoke };
  }
  it('既定で受け取り、許可は OS が持つので尋ねる前から出せるとみなす', () => {
    const n = createDesktopNotifier(env().e);
    expect(n.defaultOn).toBe(true);
    expect(n.available()).toBe(true);
    expect(n.granted()).toBe(true);
  });
  it('通知とバッジは殻のコマンドへ渡す', () => {
    const { e, invoke } = env();
    const n = createDesktopNotifier(e);
    n.show({ sessionId: 's1', title: '名前', body: '問い' });
    expect(invoke).toHaveBeenCalledWith('notify_waiting', { sessionId: 's1', title: '名前', body: '問い' });
    n.badge(3);
    expect(invoke).toHaveBeenCalledWith('plugin:window|set_badge_count', { value: 3 });
    n.badge(0);
    expect(invoke).toHaveBeenLastCalledWith('plugin:window|set_badge_count', { value: null });
  });
  it('許可を求めると殻が OS に尋ね、その答えを返す', async () => {
    const { e, invoke } = env();
    const n = createDesktopNotifier(e);
    await expect(n.request()).resolves.toBe(true);
    n.prepare();
    expect(invoke).toHaveBeenCalledTimes(2);
    expect(invoke).toHaveBeenLastCalledWith('notify_request', undefined);
  });
  // 許可は OS が持つ。システム設定で切られていれば、殻が UNUserNotificationCenter の状態を読んで返す。
  it('許可の状態は殻が OS から読んで返す。読めなければまだ決まっていないとみなす', async () => {
    const { e, invoke } = env();
    await expect(createDesktopNotifier(e).status()).resolves.toBe('denied');
    expect(invoke).toHaveBeenLastCalledWith('notify_status', undefined);
    for (const answer of ['granted', 'undetermined', 'unsupported'] as const) {
      const n = createDesktopNotifier({ __TAURI_INTERNALS__: { invoke: vi.fn(async () => answer) }, document: doc(true, true) });
      await expect(n.status()).resolves.toBe(answer);
    }
    // 古い殻（命令が無い）や、知らない答えのときは、これまでどおり出せるとみなす。
    const old = createDesktopNotifier({ __TAURI_INTERNALS__: { invoke: vi.fn(async () => { throw new Error('unknown command'); }) }, document: doc(true, true) });
    await expect(old.status()).resolves.toBe('undetermined');
    const odd = createDesktopNotifier({ __TAURI_INTERNALS__: { invoke: vi.fn(async () => 42) }, document: doc(true, true) });
    await expect(odd.status()).resolves.toBe('undetermined');
  });
  it('殻のコマンドが失敗しても、投げ出さない', async () => {
    const invoke = vi.fn(async () => { throw new Error('not allowed'); });
    const n = createDesktopNotifier({ __TAURI_INTERNALS__: { invoke }, document: doc(true, true) });
    expect(() => n.show({ sessionId: 's1', title: 't', body: 'b' })).not.toThrow();
    expect(() => n.badge(1)).not.toThrow();
    await expect(n.request()).resolves.toBe(false);
  });
  it('通知を押したときは、殻が __hangarOpenWaiting を呼ぶ', () => {
    const { e } = env();
    const n = createDesktopNotifier(e);
    const cb = vi.fn();
    const off = n.onOpen(cb);
    e.__hangarOpenWaiting?.('s1');
    expect(cb).toHaveBeenCalledWith('s1');
    off();
    expect(e.__hangarOpenWaiting).toBeUndefined();
  });
  it('隠れているか、窓にフォーカスが無ければ背面とみなす', () => {
    expect(createDesktopNotifier(env({ document: doc(true, true) }).e).background()).toBe(false);
    expect(createDesktopNotifier(env({ document: doc(true, false) }).e).background()).toBe(true);
    expect(createDesktopNotifier(env({ document: doc(false, true) }).e).background()).toBe(true);
  });
});

describe('ブラウザの通知', () => {
  function fakeNotification(permission: NotificationPermission, answer: NotificationPermission = 'granted') {
    const made: { title: string; opts: NotificationOptions | undefined; onclick: (() => void) | null; close: ReturnType<typeof vi.fn> }[] = [];
    const N = function (this: unknown, title: string, opts?: NotificationOptions) {
      const n = { title, opts, onclick: null as (() => void) | null, close: vi.fn() };
      made.push(n);
      return n;
    } as unknown as BrowserEnv['Notification'] & { permission: NotificationPermission };
    Object.assign(N, { permission, requestPermission: vi.fn(async () => { (N as { permission: NotificationPermission }).permission = answer; return answer; }) });
    return { N, made };
  }
  function env(over: Partial<BrowserEnv> = {}): BrowserEnv {
    return { Notification: fakeNotification('default').N, navigator: {}, document: doc(true, true), focus: vi.fn(), ...over };
  }
  it('既定では受け取らず、許可はまだ無い', () => {
    const n = createBrowserNotifier(env());
    expect(n.defaultOn).toBe(false);
    expect(n.available()).toBe(true);
    expect(n.granted()).toBe(false);
  });
  it('許可の状態はブラウザの permission から読む', async () => {
    await expect(createBrowserNotifier(env({ Notification: fakeNotification('granted').N })).status()).resolves.toBe('granted');
    await expect(createBrowserNotifier(env({ Notification: fakeNotification('denied').N })).status()).resolves.toBe('denied');
    await expect(createBrowserNotifier(env({ Notification: fakeNotification('default').N })).status()).resolves.toBe('undetermined');
    await expect(createBrowserNotifier(env({ Notification: undefined })).status()).resolves.toBe('unsupported');
  });
  it('拒まれた後と、Notification の無いブラウザでは出せない', () => {
    expect(createBrowserNotifier(env({ Notification: fakeNotification('denied').N })).available()).toBe(false);
    expect(createBrowserNotifier(env({ Notification: undefined })).available()).toBe(false);
  });
  it('許可を求めて、許されたかを返す', async () => {
    const { N } = fakeNotification('default', 'granted');
    const n = createBrowserNotifier(env({ Notification: N }));
    await expect(n.request()).resolves.toBe(true);
    expect(n.granted()).toBe(true);
    const denied = createBrowserNotifier(env({ Notification: fakeNotification('default', 'denied').N }));
    await expect(denied.request()).resolves.toBe(false);
  });
  it('通知を押すと窓を前に出し、そのセッションで呼び、通知を閉じる', () => {
    const { N, made } = fakeNotification('granted');
    const e = env({ Notification: N });
    const n = createBrowserNotifier(e);
    const cb = vi.fn();
    n.onOpen(cb);
    n.show({ sessionId: 's1', title: '名前', body: '問い' });
    expect(made[0]).toMatchObject({ title: '名前', opts: { body: '問い', tag: 'hangar-waiting-s1' } });
    made[0]!.onclick?.();
    expect(e.focus).toHaveBeenCalled();
    expect(cb).toHaveBeenCalledWith('s1');
    expect(made[0]!.close).toHaveBeenCalled();
  });
  it('バッジはあれば使い、無ければ何もしない', () => {
    const setAppBadge = vi.fn(async () => {});
    const clearAppBadge = vi.fn(async () => {});
    const n = createBrowserNotifier(env({ navigator: { setAppBadge, clearAppBadge } }));
    n.badge(2);
    expect(setAppBadge).toHaveBeenCalledWith(2);
    n.badge(0);
    expect(clearAppBadge).toHaveBeenCalled();
    expect(() => createBrowserNotifier(env()).badge(2)).not.toThrow();
  });
});

describe('どちらを使うか', () => {
  it('殻の IPC があればデスクトップ、無ければブラウザ', () => {
    const invoke = vi.fn(async () => true);
    expect(pickNotifier({ __TAURI_INTERNALS__: { invoke }, navigator: {}, document: doc(true, true), focus: () => {} }).defaultOn).toBe(true);
    expect(pickNotifier({ navigator: {}, document: doc(true, true), focus: () => {} }).defaultOn).toBe(false);
  });
});
