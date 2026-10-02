import { describe, expect, it } from 'vitest';
import { isParked, liveFilterOf } from './liveFilter.ts';

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
  it('区切りを付けて休みのまま残っているものは、hangar の run が生きていても終了に数える', () => {
    expect(liveFilterOf('idle', true, true)).toBe('ended');
    expect(liveFilterOf('idle', false, true)).toBe('ended');
  });
});

describe('isParked', () => {
  const base = { status: 'paused' as const, setAt: 1000, live: 'idle' as const, processStartedAt: 500 };
  it('状態が付いていて、休みで、プロセスの起動が印より前なら真', () => {
    expect(isParked(base)).toBe(true);
    expect(isParked({ ...base, status: 'done' })).toBe(true);
    expect(isParked({ ...base, status: 'archived' })).toBe(true);
  });
  it('印なしは偽', () => {
    expect(isParked({ ...base, status: null, setAt: null })).toBe(false);
    // 印なしに戻した時刻だけが残っている行も、印なしである。
    expect(isParked({ ...base, status: null })).toBe(false);
  });
  it('作業中と入力待ちは偽。動いている間は今までどおり出す', () => {
    expect(isParked({ ...base, live: 'busy' })).toBe(false);
    expect(isParked({ ...base, live: 'waiting' })).toBe(false);
  });
  it('動いていないものは偽。止まったものを言う語ではない', () => {
    expect(isParked({ ...base, live: null })).toBe(false);
  });
  it('印より後に起動したプロセス（再開したもの）は偽', () => {
    expect(isParked({ ...base, processStartedAt: 1001 })).toBe(false);
  });
  it('印と同じ時刻に起動したものは真。秒より細かい起動時刻は取れない', () => {
    expect(isParked({ ...base, processStartedAt: 1000 })).toBe(true);
  });
  it('起動時刻が取れなければ偽。見えない所で止めるより、残る方が害が小さい', () => {
    expect(isParked({ ...base, processStartedAt: null })).toBe(false);
  });
  it('印の時刻が欠けていれば偽', () => {
    expect(isParked({ ...base, setAt: null })).toBe(false);
  });
});
