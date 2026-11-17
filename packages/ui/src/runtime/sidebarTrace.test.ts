import { describe, expect, it } from 'vitest';
import { traceOf, watchInputs, resetSidebarTrace, RECENT_INPUT_MS } from './sidebarTrace.ts';

describe('サイドバーの開閉の経路の控え', () => {
  it('直前の打鍵があれば via は key で、文字でなくキーの名前と修飾キーを残す', () => {
    expect(traceOf(true, 1000, { kind: 'key', at: 900, key: 'b', ctrl: true, meta: false, shift: false, target: 'div' }))
      .toEqual({ at: 1000, collapsed: true, via: 'key', key: 'b', ctrl: true, meta: false, shift: false, target: 'div' });
  });
  it('入力が古いか無いときは none（画面の操作によらない書き込み）', () => {
    expect(traceOf(true, 1000 + RECENT_INPUT_MS, { kind: 'pointer', at: 999 })).toEqual({ at: 1500, collapsed: true, via: 'none' });
    expect(traceOf(true, 5, null)).toEqual({ at: 5, collapsed: true, via: 'none' });
  });
  it('document の打鍵と押下を覚える', () => {
    resetSidebarTrace();
    const h: Record<string, (e: unknown) => void> = {};
    watchInputs({ addEventListener: ((t: string, f: (e: unknown) => void) => { h[t] = f; }) as never }, () => 50);
    h.keydown({ key: 'b', ctrlKey: true, metaKey: false, shiftKey: false, target: { tagName: 'DIV' } });
    expect(traceOf(true, 100)).toMatchObject({ via: 'key', key: 'b', ctrl: true, target: 'div' });
    h.pointerdown({ target: { tagName: 'BUTTON' } });
    expect(traceOf(false, 100)).toMatchObject({ via: 'pointer', target: 'button' });
  });
});
