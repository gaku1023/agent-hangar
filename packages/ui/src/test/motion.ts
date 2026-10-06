import { vi } from 'vitest';

/**
 * 試験の中で、ルート（document.documentElement）の動きのトークンの値を差し込む。
 * jsdom は tokens.css を読まないので、計算済みの値を直に返す。
 * ほかの要素の getComputedStyle は本物のままにする（testing-library が見え方の判断に使う）。
 * jsdom は子要素へカスタムプロパティを継がせないので、li などの上で動かす試験は everywhere を真にする。
 * その場合は任意の要素で「--」で始まる名前だけ差し込み（無ければ空）、ほかの名前は本物の値を返す。
 * 返した関数で元に戻す。
 */
export function fakeMotionTokens(values: Record<string, string> = { '--dur-fast': '200ms', '--dur': '420ms', '--dur-exit': '250ms', '--ease-out': 'cubic-bezier(0.16, 1, 0.3, 1)', '--ease-in': 'cubic-bezier(0.4, 0, 1, 1)', '--rise': '6px', '--blur-in': '6px' }, opts: { everywhere?: boolean } = {}): () => void {
  const real = window.getComputedStyle.bind(window);
  const spy = vi.spyOn(window, 'getComputedStyle').mockImplementation((el, pseudo) => {
    if (opts.everywhere) {
      return new Proxy(real(el, pseudo), {
        get(target, prop) {
          if (prop === 'getPropertyValue') return (n: string) => (n.startsWith('--') ? (values[n] ?? '') : target.getPropertyValue(n));
          const v = Reflect.get(target, prop, target) as unknown;
          return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(target) : v;
        },
      });
    }
    return el === document.documentElement ? ({ getPropertyValue: (n: string) => values[n] ?? '' } as CSSStyleDeclaration) : real(el, pseudo);
  });
  return () => spy.mockRestore();
}
