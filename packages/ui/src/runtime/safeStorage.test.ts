import { describe, expect, it } from 'vitest';
import { createSafeStorage } from './safeStorage.ts';

/** 呼ぶたびに投げる Storage。プライベートウィンドウや、サイトデータを塞いだときの形。 */
const hostile = (): Storage => new Proxy({} as Storage, { get: () => () => { throw new DOMException('blocked', 'SecurityError'); } });
/** 実物の localStorage と同じく、保存した鍵が自分の持ち物として数えられる入れ物。 */
class Memory {
  [k: string]: unknown;
  getItem(k: string) { return Object.hasOwn(this, k) ? (this[k] as string) : null; }
  setItem(k: string, v: string) { this[k] = String(v); }
}
const memory = (): Storage => new Memory() as unknown as Storage;

describe('createSafeStorage', () => {
  it('JSON で保存して読み戻し、鍵の一覧を返す', () => {
    const m = memory();
    const s = createSafeStorage(() => m);
    s.set('a', ['x', 1]);
    expect(s.get('a')).toEqual(['x', 1]);
    expect(s.keys()).toEqual(['a']);
  });
  it('未保存と壊れた JSON は undefined にする', () => {
    const m = memory();
    m.setItem('bad', '{oops');
    const s = createSafeStorage(() => m);
    expect(s.get('none')).toBeUndefined();
    expect(s.get('bad')).toBeUndefined();
  });
  it('localStorage の取得、読み、書き、鍵の一覧のどれが投げても、投げ返さない', () => {
    for (const make of [() => { throw new DOMException('denied', 'SecurityError'); }, hostile]) {
      const s = createSafeStorage(make as () => Storage);
      expect(() => s.set('a', 1)).not.toThrow();
      expect(s.get('a')).toBeUndefined();
      expect(s.keys()).toEqual([]);
    }
  });
});
