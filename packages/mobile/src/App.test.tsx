import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from './App.tsx';
import * as store from './store.ts';
import { feedOf, inboxOf, makeKey } from './test/fixtures.ts';
import { json, WORKER } from './test/pairText.ts';

let key: CryptoKey;

beforeEach(async () => {
  key = await makeKey();
  store.savePairing({ url: WORKER, token: 'tok-1', deviceId: 'phone-1' });
  await store.saveKey(key);
  const res = await inboxOf(key, [feedOf('pc-1', 'Mac')], { now: Date.now() });
  vi.stubGlobal('fetch', vi.fn(async () => json(res)));
});

afterEach(() => {
  vi.unstubAllGlobals();
  try {
    localStorage.clear();
  } catch {
    // 消せなくても次の試験が上書きする。
  }
});

describe('App', () => {
  it('閉じる動きの間に「＋ 新しい会話」を押し直すと、選んだものの残らない新しい画面で開く', async () => {
    const root = document.documentElement.style;
    root.setProperty('--dur-exit', '250ms');
    root.setProperty('--dur-fast', '200ms');
    try {
      render(<App pairText={null} />);
      const plus = await screen.findByRole('button', { name: '＋ 新しい会話' });
      await waitFor(() => expect(plus).toBeEnabled());
      fireEvent.click(plus);
      const projects = () => within(screen.getByRole('radiogroup', { name: 'プロジェクト' }));
      fireEvent.click(projects().getByRole('radio', { name: /project-a/ }));
      expect(projects().getByRole('radio', { name: /project-a/ })).toHaveAttribute('aria-checked', 'true');
      fireEvent.click(screen.getByRole('button', { name: '閉じる' }));
      // まだ畳んでいる間に開き直す。
      fireEvent.click(screen.getByRole('button', { name: '＋ 新しい会話' }));
      expect(screen.getAllByRole('dialog')).toHaveLength(1);
      expect(projects().getByRole('radio', { name: /project-a/ })).toHaveAttribute('aria-checked', 'false');
    } finally {
      root.removeProperty('--dur-exit');
      root.removeProperty('--dur-fast');
    }
  });
});
