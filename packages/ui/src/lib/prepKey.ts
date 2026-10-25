/**
 * 起動前の準備の鍵（LaunchParams.prepKey）を作る。起動を送るたび、整え直しを頼むたびに新しいものを作る。
 * サーバが受ける形は 8〜64 字の英数と _-（shared の isLaunchPrepKey）。randomUUID があればそれ（36 字）、無ければ乱数の 24 字。
 */
export function newPrepKey(): string {
  const c = globalThis.crypto as Crypto | undefined;
  if (c && typeof c.randomUUID === 'function') return c.randomUUID();
  return Array.from({ length: 24 }, () => Math.floor(Math.random() * 36).toString(36)).join('');
}
