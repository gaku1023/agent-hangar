import { describe, expect, it } from 'vitest';
import type { LaunchPrepDto } from '@agent-hangar/shared';
import { applyServerEvent, initialStore, LAUNCH_PREPS_KEPT } from './store.ts';

const prep = (key: string, over: Partial<LaunchPrepDto> = {}): LaunchPrepDto => ({ key, phase: 'running', startedAt: 1, endedAt: null, steps: [], ask: null, reason: null, ...over });
const apply = (s: ReturnType<typeof initialStore>, p: LaunchPrepDto) => applyServerEvent(s, { type: 'launch.prep', prep: p });

describe('起動前の準備の進み（launch.prep）', () => {
  it('鍵ごとに全体を持ち、同じ鍵の次の知らせは置き換える', () => {
    expect(initialStore().launchPreps).toEqual({});
    const a = apply(initialStore(), prep('key-aaaaaaaa'));
    const b = apply(a, prep('key-bbbbbbbb'));
    const c = apply(b, prep('key-aaaaaaaa', { phase: 'ready', endedAt: 9 }));
    expect(Object.keys(c.launchPreps)).toEqual(['key-aaaaaaaa', 'key-bbbbbbbb']);
    expect(c.launchPreps['key-aaaaaaaa']!.phase).toBe('ready');
  });
  it('同じ中身の知らせでは Store を作り直さない', () => {
    const a = apply(initialStore(), prep('key-aaaaaaaa'));
    expect(apply(a, prep('key-aaaaaaaa'))).toBe(a);
  });
  it('古いものから捨て、走っているものは捨てない', () => {
    let s = apply(initialStore(), prep('run-aaaaaaaa'));
    for (let i = 0; i < LAUNCH_PREPS_KEPT + 3; i++) s = apply(s, prep(`end-${String(i).padStart(8, '0')}`, { phase: 'ready', endedAt: 2 }));
    expect(Object.keys(s.launchPreps)).toHaveLength(LAUNCH_PREPS_KEPT);
    expect(s.launchPreps['run-aaaaaaaa']).toBeDefined();
    expect(s.launchPreps[`end-${String(LAUNCH_PREPS_KEPT + 2).padStart(8, '0')}`]).toBeDefined();
    expect(s.launchPreps['end-00000000']).toBeUndefined();
  });
});
