import { afterEach, describe, expect, it, vi } from 'vitest';
import { isIosSafari, isStandalone } from './platform.ts';

const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';
const IPAD_AS_MAC = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15';
const IPHONE_CHROME = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/130.0 Mobile/15E148 Safari/604.1';
const ANDROID = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Mobile Safari/537.36';

afterEach(() => vi.unstubAllGlobals());

describe('isIosSafari', () => {
  it('iPhone の Safari は true', () => {
    expect(isIosSafari(IPHONE, 5)).toBe(true);
  });

  it('Mac を名乗るタッチ付きの Safari（iPad）は true、タッチの無い Mac は false', () => {
    expect(isIosSafari(IPAD_AS_MAC, 5)).toBe(true);
    expect(isIosSafari(IPAD_AS_MAC, 0)).toBe(false);
  });

  it('iPhone の Chrome、Android、PC は false', () => {
    expect(isIosSafari(IPHONE_CHROME, 5)).toBe(false);
    expect(isIosSafari(ANDROID, 5)).toBe(false);
    expect(isIosSafari('Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/130.0 Safari/537.36', 0)).toBe(false);
  });
});

describe('isStandalone', () => {
  it('display-mode: standalone か navigator.standalone で true', () => {
    expect(isStandalone()).toBe(false);
    vi.stubGlobal('matchMedia', (q: string) => ({ matches: q.includes('standalone') }));
    expect(isStandalone()).toBe(true);
    vi.unstubAllGlobals();
    Object.defineProperty(navigator, 'standalone', { value: true, configurable: true });
    expect(isStandalone()).toBe(true);
    Reflect.deleteProperty(navigator, 'standalone');
  });
});
