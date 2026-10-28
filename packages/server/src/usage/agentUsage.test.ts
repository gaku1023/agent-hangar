import { describe, expect, it, vi } from 'vitest';
import { AgentUsageTracker } from './agentUsage.ts';

const W = (usedPercent: number, resetsAt: number | null) => ({ usedPercent, resetsAt });

describe('Claude 以外のエージェントの枠', () => {
  it('窓を入れると、値と更新の時刻と plan を返す', () => {
    const t = new AgentUsageTracker({ now: () => 5000 });
    t.set('codex', { fiveHour: W(10, 9000), sevenDay: W(20, 99000), plan: 'plus' }, 4000);
    expect(t.of('codex')).toEqual({ fiveHour: W(10, 9000), sevenDay: W(20, 99000), updatedAt: 4000, plan: 'plus' });
    expect(t.all()).toEqual({ codex: t.of('codex') });
  });
  it('届いていない間は何も返さない', () => {
    const t = new AgentUsageTracker();
    expect(t.of('codex')).toBeNull();
    expect(t.all()).toBeUndefined();
  });
  it('疎な更新は、無い窓と plan を前の値のままにする', () => {
    const t = new AgentUsageTracker({ now: () => 1 });
    t.set('codex', { fiveHour: W(10, 9000), sevenDay: W(20, 99000), plan: 'plus' }, 100);
    t.set('codex', { fiveHour: W(30, 9500), sevenDay: null, plan: null }, 200);
    expect(t.of('codex')).toEqual({ fiveHour: W(30, 9500), sevenDay: W(20, 99000), updatedAt: 200, plan: 'plus' });
  });
  it('観測の時刻が古い値は、新しいものを上書きしない（いちばん新しいものを使う）', () => {
    const t = new AgentUsageTracker({ now: () => 1 });
    t.set('codex', { fiveHour: W(30, 9500), sevenDay: null, plan: null }, 200);
    expect(t.set('codex', { fiveHour: W(5, 9000), sevenDay: W(1, 8), plan: null }, 100)).toBe(false);
    expect(t.of('codex')?.fiveHour).toEqual(W(30, 9500));
    expect(t.of('codex')?.sevenDay).toBeNull();
  });
  it('戻る時刻を過ぎた窓は 0% として返す（Claude と同じ読み）', () => {
    let now = 1000;
    const t = new AgentUsageTracker({ now: () => now });
    t.set('codex', { fiveHour: W(80, 2000), sevenDay: W(50, 90000), plan: 'plus' }, 900);
    now = 2500;
    expect(t.of('codex')?.fiveHour).toEqual(W(0, null));
    expect(t.of('codex')?.sevenDay).toEqual(W(50, 90000));
  });
  it('設定で切の間は、受けず、返さない', () => {
    let on = false;
    const t = new AgentUsageTracker({ enabled: () => on });
    expect(t.set('codex', { fiveHour: W(1, 1), sevenDay: null, plan: null }, 1)).toBe(false);
    on = true;
    expect(t.all()).toBeUndefined();
    t.set('codex', { fiveHour: W(1, 1), sevenDay: null, plan: null }, 1);
    on = false;
    expect(t.all()).toBeUndefined();
    expect(t.of('codex')).toBeNull();
  });
  it('値が変わったときだけ onChange を呼ぶ', () => {
    const t = new AgentUsageTracker();
    const cb = vi.fn();
    t.onChange(cb);
    t.set('codex', { fiveHour: W(1, 1), sevenDay: null, plan: 'plus' }, 10);
    t.set('codex', { fiveHour: W(1, 1), sevenDay: null, plan: 'plus' }, 20);
    t.set('codex', { fiveHour: W(2, 1), sevenDay: null, plan: 'plus' }, 30);
    expect(cb).toHaveBeenCalledTimes(2);
  });
  it('refresh：切にした瞬間に、持っていた値を捨てて、変わったと知らせる。入れ直しても古い値は戻らない', () => {
    let on = true;
    const t = new AgentUsageTracker({ now: () => 1, enabled: () => on });
    t.set('codex', { fiveHour: W(10, 9000), sevenDay: null, plan: 'plus' }, 100);
    const cb = vi.fn();
    t.onChange(cb);
    on = false;
    t.refresh();
    expect(cb).toHaveBeenCalledTimes(1);
    expect(t.all()).toBeUndefined();
    on = true;
    expect(t.of('codex')).toBeNull();
  });
  it('refresh：入のままなら、値を保ったまま配り直しを頼むだけ', () => {
    const t = new AgentUsageTracker({ now: () => 1 });
    t.set('codex', { fiveHour: W(10, 9000), sevenDay: null, plan: null }, 100);
    const cb = vi.fn();
    t.onChange(cb);
    t.refresh();
    expect(cb).toHaveBeenCalledTimes(1);
    expect(t.of('codex')?.fiveHour).toEqual(W(10, 9000));
  });
  it('アカウントごとに枠を持つ。all() は渡されたアカウントの枠を返し、渡さなければ primary', () => {
    const t = new AgentUsageTracker({ now: () => 1 });
    t.set('codex', { fiveHour: W(10, 9000), sevenDay: null, plan: 'plus' }, 5);
    t.set('codex', { fiveHour: W(70, 9000), sevenDay: null, plan: 'pro' }, 6, 'work');
    expect(t.of('codex')?.fiveHour?.usedPercent).toBe(10);
    expect(t.of('codex', 'work')?.fiveHour?.usedPercent).toBe(70);
    expect(t.of('codex', 'none')).toBeNull();
    expect(t.all()?.codex?.fiveHour?.usedPercent).toBe(10);
    expect(t.all('work')?.codex?.fiveHour?.usedPercent).toBe(70);
    expect(t.all('none')).toBeUndefined();
  });
});
