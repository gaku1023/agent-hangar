import { describe, expect, it } from 'vitest';
import { liveFilterOf } from './liveFilter.ts';

describe('liveFilterOf', () => {
  it('入力待ちは、hangar の run の有無によらず入力待ちに数える', () => {
    expect(liveFilterOf('waiting', false)).toBe('waiting');
    expect(liveFilterOf('waiting', true)).toBe('waiting');
  });
  it('作業中と休みは実行中に数える', () => {
    expect(liveFilterOf('busy', false)).toBe('running');
    expect(liveFilterOf('idle', false)).toBe('running');
  });
  it('Claude の一覧に載る前でも、hangar の run が生きていれば起動中として実行中に数える', () => {
    expect(liveFilterOf(null, true)).toBe('running');
  });
  it('どちらも無ければ終了', () => {
    expect(liveFilterOf(null, false)).toBe('ended');
  });
});
