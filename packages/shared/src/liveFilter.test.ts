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
  const base = { status: 'paused' as const, setBy: 'conversation' as const, setAt: 10_000, live: 'idle' as const, processStartedAt: 5_000 };
  it('状態が付いていて、休みで、プロセスの起動が印より前なら真', () => {
    expect(isParked(base)).toBe(true);
    expect(isParked({ ...base, status: 'done', setBy: 'user' })).toBe(true);
    expect(isParked({ ...base, status: 'archived', setBy: 'user' })).toBe(true);
  });
  it('印なしは偽', () => {
    expect(isParked({ ...base, status: null, setBy: null, setAt: null })).toBe(false);
    // 印なしに戻した時刻だけが残っている行も、印なしである。
    expect(isParked({ ...base, status: null })).toBe(false);
  });
  it('導入時の一括 Done（import）は偽。利用者が区切ると決めたものではない', () => {
    expect(isParked({ ...base, status: 'done', setBy: 'import' })).toBe(false);
  });
  it('作業中と入力待ちは偽。動いている間は今までどおり出す', () => {
    expect(isParked({ ...base, live: 'busy' })).toBe(false);
    expect(isParked({ ...base, live: 'waiting' })).toBe(false);
  });
  it('動いていないものは偽。止まったものを言う語ではない', () => {
    expect(isParked({ ...base, live: null })).toBe(false);
  });
  it('印より後に起動したプロセス（再開したもの）は偽', () => {
    expect(isParked({ ...base, processStartedAt: 10_001 })).toBe(false);
  });
  it('起動時刻は秒までしか取れないので、印の 1 秒以上前に起動したものだけを真にする。同じ秒の再開を止めない', () => {
    // 12:00:05.800 に再開したプロセスの起動時刻は 12:00:05.000 と読める。12:00:05.300 の印より前に見えても、前とは言い切れない。
    expect(isParked({ ...base, processStartedAt: 10_000 })).toBe(false);
    expect(isParked({ ...base, processStartedAt: 9_001 })).toBe(false);
    expect(isParked({ ...base, processStartedAt: 9_000 })).toBe(true);
  });
  it('起動時刻が取れなければ偽。見えない所で止めるより、残る方が害が小さい', () => {
    expect(isParked({ ...base, processStartedAt: null })).toBe(false);
  });
  it('印の時刻が欠けていれば偽', () => {
    expect(isParked({ ...base, setAt: null })).toBe(false);
  });
});
