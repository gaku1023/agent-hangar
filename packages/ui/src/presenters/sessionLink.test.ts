import { describe, expect, it } from 'vitest';
import type { ProjectDto, SessionDto } from '@agent-hangar/shared';
import { initialStore, type Store } from '../store/store.ts';
import { sessionDto } from '../test/sessionDto.ts';
import { translatorOf } from './i18n.ts';
import { initialState } from '../mediator/transition.ts';
import { presentSessionChip } from './sessionLink.ts';
import { presentToasts } from './toasts.ts';

const project = (id: string, name: string): ProjectDto => ({ id, name, status: 'active', isScratch: false, path: `/w/${id}`, resolved: true, lastActivityAt: null, runningCount: 0, openTodoCount: 0, updatedAt: 1 });
const session = (id: string, over: Partial<SessionDto> = {}): SessionDto => sessionDto({ id, name: `題 ${id}`, projectId: 'a', ...over });
const lock = (deviceId: string, deviceName: string, over: Partial<NonNullable<SessionDto['lock']>> = {}): SessionDto['lock'] => ({ deviceId, deviceName, runId: 'r', heartbeatAt: 1, stale: false, ...over });

function storeWith(sessions: SessionDto[]): Store {
  const s = initialStore();
  s.device = { id: 'me', name: 'この PC' };
  s.projects = { a: project('a', 'alpha'), b: project('b', 'beta') };
  s.sessions = Object.fromEntries(sessions.map((x) => [x.id, x]));
  return s;
}

describe('presentSessionChip（本文の会話のリンクの札）', () => {
  it('同じプロジェクトで同じ PC なら、題と状態だけ', () => {
    const store = storeWith([session('s1', { live: 'busy' }), session('s2', { live: 'waiting' })]);
    const c = presentSessionChip(store, translatorOf(store), 's2', 's1');
    expect(c).toMatchObject({ id: 's2', name: '題 s2', live: 'waiting', project: null, device: null });
  });
  it('プロジェクトが違うときだけ、プロジェクト名を添える', () => {
    const store = storeWith([session('s1'), session('s2', { projectId: 'b' })]);
    expect(presentSessionChip(store, translatorOf(store), 's2', 's1')?.project).toBe('beta');
    expect(presentSessionChip(store, translatorOf(store), 's2', null)?.project).toBe('beta');
  });
  it('PC が違うときだけ、PC の名前を添える（別の PC の会話の状態はロックから読む）', () => {
    const store = storeWith([session('s1'), session('s2', { live: null, lock: lock('d2', 'MacBook', { live: 'waiting' }), remoteOnly: true })]);
    expect(presentSessionChip(store, translatorOf(store), 's2', 's1')).toMatchObject({ device: 'MacBook', live: 'waiting' });
    // 別の PC の会話を見ているときに、この PC の会話へのリンクなら、この PC の名前を添える。
    expect(presentSessionChip(store, translatorOf(store), 's1', 's2')?.device).toBe('この PC');
    // どちらも同じ PC なら添えない。
    const same = storeWith([session('s2', { live: null, lock: lock('d2', 'MacBook'), remoteOnly: true }), session('s3', { live: null, lock: lock('d2', 'MacBook'), remoteOnly: true })]);
    expect(presentSessionChip(same, translatorOf(same), 's3', 's2')?.device).toBeNull();
  });
  it('この PC で分からない会話は null（ただのリンクのまま）', () => {
    const store = storeWith([session('s1')]);
    expect(presentSessionChip(store, translatorOf(store), 'nope', 's1')).toBeNull();
  });
  it('名前が無い会話は「名前なし」の語を出す', () => {
    const store = storeWith([session('s1', { name: null })]);
    expect(presentSessionChip(store, translatorOf(store), 's1', null)?.name).toBe(translatorOf(store)('common.label.noName'));
  });
});

describe('presentToasts（open_in_hangar の知らせ）', () => {
  const toast = (fromSessionId: string | null) => ({ id: '7', level: 'info' as const, message: '', openPrompt: { sessionId: 's2', deviceId: 'd1', fromSessionId } });
  it('開く先の題と状態、求めた会話の題を、トーストの id で引ける', () => {
    const store = storeWith([session('s1'), session('s2', { live: 'busy' })]);
    const p = presentToasts({ ...initialState(), toasts: [toast('s1')] }, store, 0);
    expect(p.openPrompts).toEqual({ '7': { sessionId: 's2', name: '題 s2', live: 'busy', aside: false, reason: null, fromName: '題 s1' } });
  });
  it('求めた会話が無い（共通の URL から呼ばれた）ときと、この PC で分からないときは、2 行目を出さない', () => {
    const store = storeWith([session('s2')]);
    expect(presentToasts({ ...initialState(), toasts: [toast(null)] }, store, 0).openPrompts?.['7']?.fromName).toBeNull();
    expect(presentToasts({ ...initialState(), toasts: [toast('nope')] }, store, 0).openPrompts?.['7']?.fromName).toBeNull();
  });
  it('開く先がまだ分からなくても、札は出せる（題は「名前なし」）', () => {
    const store = storeWith([]);
    expect(presentToasts({ ...initialState(), toasts: [toast(null)] }, store, 0).openPrompts?.['7']).toMatchObject({ sessionId: 's2', live: null });
  });
});
