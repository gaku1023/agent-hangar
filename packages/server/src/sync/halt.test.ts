import { describe, expect, it } from 'vitest';
import { syncHalted } from './halt.ts';

describe('互換の版', () => {
  it('版で止まっている間は、本文と設定の出し入れも止める。頼まれた 1 巡の最中でも止める', () => {
    expect(syncHalted({ paused: false, oncePass: false, compatBlocked: false, limited: false })).toBe(false);
    expect(syncHalted({ paused: true, oncePass: false, compatBlocked: false, limited: false })).toBe(true);
    expect(syncHalted({ paused: true, oncePass: true, compatBlocked: false, limited: false })).toBe(false);
    expect(syncHalted({ paused: false, oncePass: false, compatBlocked: true, limited: false })).toBe(true);
    expect(syncHalted({ paused: true, oncePass: true, compatBlocked: true, limited: false })).toBe(true);
    expect(syncHalted({ paused: false, oncePass: false, compatBlocked: false, limited: true })).toBe(true);
    expect(syncHalted({ paused: true, oncePass: true, compatBlocked: false, limited: true })).toBe(true);
  });
});
