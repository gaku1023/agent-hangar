import { afterEach, describe, expect, it, vi } from 'vitest';
import { isLaunchPrepKey } from '@agent-hangar/shared';
import { newPrepKey } from './prepKey.ts';

describe('起動前の準備の鍵', () => {
  afterEach(() => { vi.unstubAllGlobals(); });
  it('サーバが受ける形（isLaunchPrepKey）で、呼ぶたびに違う', () => {
    const keys = new Set(Array.from({ length: 20 }, newPrepKey));
    expect(keys.size).toBe(20);
    for (const k of keys) expect(isLaunchPrepKey(k)).toBe(true);
  });
  it('randomUUID が無い環境でも、受けられる形の鍵を作る', () => {
    vi.stubGlobal('crypto', {});
    const k = newPrepKey();
    expect(isLaunchPrepKey(k)).toBe(true);
    expect(k).toHaveLength(24);
  });
});
