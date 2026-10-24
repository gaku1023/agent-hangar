import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from './App.tsx';
import { connectPhone, feedOf, inboxOf, makeKey } from './test/fixtures.ts';
import { json, makePairText } from './test/pairText.ts';

const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';
const ANDROID = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Mobile Safari/537.36';
const DESKTOP = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15';

const GUIDE = 'ホーム画面に追加して';

function as(ua: string, opts: { standalone?: boolean; touch?: number } = {}): void {
  Object.defineProperty(navigator, 'userAgent', { value: ua, configurable: true });
  Object.defineProperty(navigator, 'maxTouchPoints', { value: opts.touch ?? 0, configurable: true });
  vi.stubGlobal('matchMedia', (q: string) => ({ matches: !!opts.standalone && q.includes('standalone'), addEventListener() {}, removeEventListener() {} }));
}

beforeEach(() => {
  localStorage.clear();
  vi.stubGlobal('fetch', vi.fn());
});

afterEach(() => {
  vi.unstubAllGlobals();
  Reflect.deleteProperty(navigator, 'userAgent');
  Reflect.deleteProperty(navigator, 'maxTouchPoints');
});

describe('App の入口の案内（A1）', () => {
  it('iPhone の Safari で、ホーム画面のアプリでなく、未接続なら、案内を先に出す', async () => {
    as(IPHONE, { touch: 5 });
    render(<App pairText={null} />);
    expect(await screen.findByRole('heading', { name: new RegExp(GUIDE) })).toBeInTheDocument();
    expect(screen.getByText('画面下の共有 □↑ をタップ')).toBeInTheDocument();
    expect(screen.getByText('「ホーム画面に追加」を選ぶ')).toBeInTheDocument();
    expect(screen.getByText('ホーム画面の hangar を開く')).toBeInTheDocument();
    expect(screen.queryByText(/画面下の □↑ をタップ/)).not.toBeInTheDocument();
    expect(screen.getByText('一覧を下へスクロールすると表示されます')).toBeInTheDocument();
    expect(screen.getByText('この Safari の画面は閉じて構いません')).toBeInTheDocument();
    expect(screen.queryByText('このスマホはまだ接続していません')).not.toBeInTheDocument();
  });

  it('iPad（Mac を名乗るタッチ付き）の Safari でも出す', async () => {
    as(DESKTOP, { touch: 5 });
    render(<App pairText={null} />);
    expect(await screen.findByRole('heading', { name: new RegExp(GUIDE) })).toBeInTheDocument();
  });

  it('「このまま Safari で使う」で接続の画面へ進む', async () => {
    as(IPHONE, { touch: 5 });
    render(<App pairText={null} />);
    fireEvent.click(await screen.findByRole('button', { name: 'このまま Safari で使う' }));
    expect(await screen.findByText('このスマホはまだ接続していません')).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: new RegExp(GUIDE) })).not.toBeInTheDocument();
  });

  it('QR から開いたときは、QR の残り時間を出し、「このまま Safari で使う」で接続の確認へ進む', async () => {
    as(IPHONE, { touch: 5 });
    const { text } = makePairText({ expiresAt: Date.now() + 8 * 60_000 });
    render(<App pairText={text} />);
    expect(await screen.findByRole('heading', { name: new RegExp(GUIDE) })).toBeInTheDocument();
    expect(screen.getByText(/QR はあと/)).toHaveTextContent(/あと\s*[78]:\d\d\s*有効/);
    fireEvent.click(screen.getByRole('button', { name: 'このまま Safari で使う' }));
    expect(await screen.findByText('このスマホを hangar に接続する')).toBeInTheDocument();
  });

  it('ホーム画面のアプリ、Android、PC のブラウザでは出さない', async () => {
    for (const [ua, opts] of [
      [IPHONE, { standalone: true, touch: 5 }],
      [ANDROID, { touch: 5 }],
      [DESKTOP, { touch: 0 }],
    ] as const) {
      as(ua, opts);
      const { unmount } = render(<App pairText={null} />);
      // ホーム画面のアプリは接続の画面でカメラの読み取りを先に出す。ほかは今までの接続の画面。
      const joinHeading = 'standalone' in opts ? 'PC の QR を読み取ります' : 'このスマホはまだ接続していません';
      expect(await screen.findByRole('heading', { name: joinHeading })).toBeInTheDocument();
      expect(screen.queryByRole('heading', { name: new RegExp(GUIDE) })).not.toBeInTheDocument();
      unmount();
    }
  });

  it('接続済みなら出さずに受信箱を開く', async () => {
    as(IPHONE, { touch: 5 });
    const key = await makeKey();
    await connectPhone(key);
    const res = await inboxOf(key, [feedOf('pc-1', 'Mac')], { now: Date.now() });
    vi.stubGlobal('fetch', vi.fn(async () => json(res)));
    render(<App pairText={null} />);
    expect(await screen.findByRole('heading', { level: 1, name: /入力待ち/ })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: new RegExp(GUIDE) })).not.toBeInTheDocument();
    await waitFor(() => expect(fetch).toHaveBeenCalled());
  });
});
