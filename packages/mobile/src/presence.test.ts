import fs from 'node:fs';
import path from 'node:path';
import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { phaseClass, usePresence } from './presence.ts';

type It = { id: string };
const keyOf = (i: It): string => i.id;
const phases = (list: { key: string; phase: string }[]): string[] => list.map((p) => `${p.key}:${p.phase}`);

afterEach(() => {
  vi.useRealTimers();
  document.documentElement.style.removeProperty('--dur-exit');
  document.documentElement.style.removeProperty('--dur-fast');
});

describe('usePresence', () => {
  it('最初の並びは initial（薄れから現した形のまま残す）、あとから増えたものは enter', () => {
    const a = { id: 'a' };
    const { result, rerender } = renderHook(({ items }) => usePresence(items, keyOf), { initialProps: { items: [a] } });
    expect(phases(result.current)).toEqual(['a:initial']);
    rerender({ items: [a, { id: 'b' }] });
    expect(phases(result.current)).toEqual(['a:initial', 'b:enter']);
  });

  it('動きの長さが 0（動きを減らす設定）なら、消えたものをすぐ外す', () => {
    const { result, rerender } = renderHook(({ items }) => usePresence(items, keyOf), { initialProps: { items: [{ id: 'a' }, { id: 'b' }] } });
    rerender({ items: [{ id: 'b' }] });
    expect(phases(result.current)).toEqual(['b:initial']);
  });

  it('動きがあるときは、消えたものを畳み終わるまで元の位置に残す', () => {
    vi.useFakeTimers();
    document.documentElement.style.setProperty('--dur-exit', '250ms');
    document.documentElement.style.setProperty('--dur-fast', '200ms');
    const { result, rerender } = renderHook(({ items }) => usePresence(items, keyOf), { initialProps: { items: [{ id: 'a' }, { id: 'b' }, { id: 'c' }] } });
    rerender({ items: [{ id: 'a' }, { id: 'c' }] });
    expect(phases(result.current)).toEqual(['a:initial', 'b:leave', 'c:initial']);
    act(() => {
      vi.advanceTimersByTime(450);
    });
    expect(phases(result.current)).toEqual(['a:initial', 'c:initial']);
  });

  it('段階ごとの動きの名前', () => {
    expect(['initial', 'enter', 'stay', 'leave'].map((p) => phaseClass(p as never))).toEqual(['m-fade', 'm-grow', '', 'm-collapse']);
  });
});

describe('styles.css の動き', () => {
  const css = fs.readFileSync(path.join(import.meta.dirname, 'styles.css'), 'utf8');
  it('出入りの形を持ち、動きを減らす設定では長さを 0 にする', () => {
    for (const k of ['m-fade', 'm-grow', 'm-collapse']) expect(css).toMatch(new RegExp(`@keyframes ${k}\\b`));
    expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\)\s*\{\s*:root \{ --dur-fast: 0ms; --dur: 0ms; --dur-exit: 0ms;/);
  });
  it('長さと曲線は PC と同じ値', () => {
    expect(css).toContain('--dur-fast: 200ms;');
    expect(css).toContain('--dur: 420ms;');
    expect(css).toContain('--dur-exit: 250ms;');
    expect(css).toContain('--ease-out: cubic-bezier(0.16, 1, 0.3, 1);');
    expect(css).toContain('--ease-in: cubic-bezier(0.4, 0, 1, 1);');
  });
  it('下の帯は動かさない', () => {
    const bar = /\.bottom-bar \{[^}]*\}/.exec(css)?.[0] ?? '';
    expect(bar).toContain('position: fixed');
    expect(bar).not.toMatch(/animation|transition/);
  });
});
