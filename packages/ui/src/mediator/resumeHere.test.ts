import { describe, expect, it } from 'vitest';
import { TAKEOVER_TIMEOUT_MS, type ResumeHerePlanDto, type TakeoverDto } from '@agent-hangar/shared';
import { initialStore, type Store } from '../store/store.ts';
import { initialState, transition, type State } from './transition.ts';
import type { Input } from './types.ts';

// ほかの PC で動いている会話を、停止を頼んでから引き継ぐ流れ（確認の 1 枚が進み具合に変わる）。

const action = (a: Extract<Input, { kind: 'action' }>['action']): Input => ({ kind: 'action', action: a });
const server = (event: Extract<Input, { kind: 'server' }>['event']): Input => ({ kind: 'server', event });
const store: Store = initialStore();

const plan: ResumeHerePlanDto = {
  sessionId: 's1',
  from: { deviceName: 'pc-b', platform: 'win32', path: 'D:\\src\\notes-app', lastAt: 1 },
  to: { deviceName: 'pc-a', platform: 'darwin', path: '/Users/me/src/notes-app' },
  replace: null,
  lock: { deviceName: 'pc-b', stale: false, working: false, heartbeatAt: 1 },
};
const dto: TakeoverDto = { sessionId: 's1', deviceName: 'pc-b', stage: 'waiting', startedAt: 1_000, deadline: 1_000 + TAKEOVER_TIMEOUT_MS };
const withResumeHereConfirm: State = { ...initialState(), overlay: { kind: 'confirm', confirm: { kind: 'resumeHere', sessionId: 's1', plan } } };
const waiting: State = { ...initialState(), overlay: { kind: 'confirm', confirm: { kind: 'takeover', sessionId: 's1', plan, takeover: dto } } };
const timedOut: State = { ...initialState(), overlay: { kind: 'confirm', confirm: { kind: 'takeover', sessionId: 's1', plan, takeover: { ...dto, stage: 'timeout' } } } };

describe('引き継ぎの流れ（takeover）', () => {
  it('確認から始めると、同じ 1 枚が進み具合に変わり、頼みを送る', () => {
    const r = transition(withResumeHereConfirm, store, action({ type: 'session.takeover.start', id: 's1', force: false }));
    expect(r.state.overlay).toEqual({ kind: 'confirm', confirm: { kind: 'takeover', sessionId: 's1', plan, takeover: null } });
    expect(r.effects).toEqual([{ kind: 'api.takeoverStart', sessionId: 's1', force: false }]);
  });
  it('出ている 1 枚がその会話のものでなければ、待ちを見せる先が無いので何もしない', () => {
    const other: State = { ...initialState(), overlay: { kind: 'confirm', confirm: { kind: 'resumeHere', sessionId: 's2', plan: { ...plan, sessionId: 's2' } } } };
    const r = transition(other, store, action({ type: 'session.takeover.start', id: 's1', force: false }));
    expect(r.state.overlay).toEqual(other.overlay);
    expect(r.effects).toEqual([]);
  });
  it('途中の知らせは進み具合を差し替える', () => {
    const r = transition(waiting, store, server({ type: 'takeover.update', takeover: { ...dto, stage: 'receiving' } }));
    expect(r.state.overlay).toEqual({ kind: 'confirm', confirm: { kind: 'takeover', sessionId: 's1', plan, takeover: { ...dto, stage: 'receiving' } } });
    expect(r.effects).toEqual([]);
  });
  it('ready が届いたら閉じて、今の再開に入る', () => {
    const r = transition(waiting, store, server({ type: 'takeover.update', takeover: { ...dto, stage: 'ready' } }));
    expect(r.state.overlay).toEqual({ kind: 'none' });
    expect(r.state.launch).toEqual({ kind: 'submitting' });
    expect(r.effects).toEqual([{ kind: 'api.resumeHere', sessionId: 's1', overwrite: false }]);
  });
  it('この PC のトランスクリプトを置き換える会話は、再開に上書きを付ける', () => {
    const replacing: State = { ...waiting, overlay: { kind: 'confirm', confirm: { kind: 'takeover', sessionId: 's1', plan: { ...plan, replace: { kind: 'ahead', localSize: 1, remoteSize: 2 } }, takeover: dto } } };
    const r = transition(replacing, store, server({ type: 'takeover.update', takeover: { ...dto, stage: 'ready' } }));
    expect(r.effects).toEqual([{ kind: 'api.resumeHere', sessionId: 's1', overwrite: true }]);
  });
  it('ほかの会話の知らせと、閉じた後の知らせは無視する', () => {
    const other = transition(waiting, store, server({ type: 'takeover.update', takeover: { ...dto, sessionId: 's2', stage: 'ready' } }));
    expect(other.state).toBe(waiting);
    expect(other.effects).toEqual([]);
    const closed = transition(initialState(), store, server({ type: 'takeover.update', takeover: { ...dto, stage: 'ready' } }));
    expect(closed.state.overlay).toEqual({ kind: 'none' });
    expect(closed.state.launch).toEqual({ kind: 'idle' });
    expect(closed.effects).toEqual([]);
    // 確認の 1 枚（頼む前）にも、頼む前の知らせは届かない。
    const before = transition(withResumeHereConfirm, store, server({ type: 'takeover.update', takeover: { ...dto, stage: 'ready' } }));
    expect(before.state).toBe(withResumeHereConfirm);
    expect(before.effects).toEqual([]);
  });
  it('取り下げの知らせは確認を閉じる', () => {
    const r = transition(waiting, store, server({ type: 'takeover.update', takeover: { ...dto, stage: 'cancelled' } }));
    expect(r.state.overlay).toEqual({ kind: 'none' });
    expect(r.effects).toEqual([]);
  });
  it('取り消すと閉じて取り下げを送る', () => {
    const r = transition(waiting, store, action({ type: 'session.takeover.cancel', id: 's1' }));
    expect(r.state.overlay).toEqual({ kind: 'none' });
    expect(r.effects).toEqual([{ kind: 'api.takeoverCancel', sessionId: 's1' }]);
  });
  it('「もう少し待つ」は延長を頼み、1 枚はそのまま', () => {
    const r = transition(timedOut, store, action({ type: 'session.takeover.extend', id: 's1' }));
    expect(r.state.overlay).toEqual(timedOut.overlay);
    expect(r.effects).toEqual([{ kind: 'api.takeoverExtend', sessionId: 's1' }]);
  });
  it('返事がない 1 枚の「このまま引き継ぐ」は force: true で送る', () => {
    const r = transition(timedOut, store, action({ type: 'session.takeover.start', id: 's1', force: true }));
    expect(r.state.overlay).toEqual(timedOut.overlay);
    expect(r.effects).toEqual([{ kind: 'api.takeoverStart', sessionId: 's1', force: true }]);
  });
  it('延長のあと、待ちに戻った知らせで返事がない 1 枚が進み具合に戻る', () => {
    const r = transition(timedOut, store, server({ type: 'takeover.update', takeover: { ...dto, stage: 'waiting', deadline: dto.deadline + TAKEOVER_TIMEOUT_MS } }));
    expect(r.state.overlay).toMatchObject({ kind: 'confirm', confirm: { kind: 'takeover', takeover: { stage: 'waiting' } } });
  });
});

// 進み具合の 1 枚で「取り消す」のフォーカスが外れると、Esc は Root の overlay.close として届く。
// そのまま閉じるとサーバに待ちが残るので、takeover の 1 枚では取り消しと同じに読む。
describe('引き継ぎの 1 枚に届いた overlay.close', () => {
  it('待っている 1 枚の overlay.close は取り下げを送って閉じる', () => {
    const r = transition(waiting, store, action({ type: 'overlay.close' }));
    expect(r.state.overlay).toEqual({ kind: 'none' });
    expect(r.effects).toEqual([{ kind: 'api.takeoverCancel', sessionId: 's1' }]);
  });
  it('返事がない 1 枚の overlay.close も取り下げを送って閉じる', () => {
    const r = transition(timedOut, store, action({ type: 'overlay.close' }));
    expect(r.state.overlay).toEqual({ kind: 'none' });
    expect(r.effects).toEqual([{ kind: 'api.takeoverCancel', sessionId: 's1' }]);
  });
  it('確認の 1 枚（頼む前）の overlay.close は、取り下げを送らずに閉じる', () => {
    const r = transition(withResumeHereConfirm, store, action({ type: 'overlay.close' }));
    expect(r.state.overlay).toEqual({ kind: 'none' });
    expect(r.effects).toEqual([]);
  });
});
