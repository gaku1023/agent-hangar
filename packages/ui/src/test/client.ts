/**
 * 画面を開いている PC の OS を、試験の中で偽る。
 * 打鍵の読み替えとキーの表示は、ブラウザの名乗り（navigator.userAgent）で OS を決める（keys.ts の isMacClient）。
 * jsdom と Node の名乗りはどちらも macOS と読めないので、setup.ts がはじめに macOS の名乗りにそろえ、試験ごとに戻す。
 */
export const MAC_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko)';
export const WINDOWS_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 Edg/130.0.0.0';
export const LINUX_UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';

export function setClientUserAgent(ua: string): void {
  Object.defineProperty(globalThis.navigator, 'userAgent', { value: ua, configurable: true });
}
