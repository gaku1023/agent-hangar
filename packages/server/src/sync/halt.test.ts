import { describe, expect, it } from 'vitest';
import { configSyncActive, syncHalted } from './halt.ts';

describe('一時停止は外と話さない', () => {
  it('設定の同期は、切っているときと一時停止のあいだは押し出さない', () => {
    // fs.watch からの push も 60 秒ごとの push も、この判定を通ってから出る。
    expect(configSyncActive({ syncClaudeConfig: true, paused: false })).toBe(true);
    expect(configSyncActive({ syncClaudeConfig: true, paused: true })).toBe(false);
    expect(configSyncActive({ syncClaudeConfig: false, paused: false })).toBe(false);
    expect(configSyncActive({ syncClaudeConfig: false, paused: true })).toBe(false);
  });
});

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
