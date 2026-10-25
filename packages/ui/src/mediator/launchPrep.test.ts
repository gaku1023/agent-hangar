import { describe, expect, it } from 'vitest';
import type { LaunchParams, LaunchPrepDto, SessionDto } from '@agent-hangar/shared';
import { initialStore, type Store } from '../store/store.ts';
import { initialState, transition, type State } from './transition.ts';
import type { Input } from './types.ts';

const action = (i: Extract<Input, { kind: 'action' }>['action']): Input => ({ kind: 'action', action: i });
const runtime = (event: Extract<Input, { kind: 'runtime' }>['event']): Input => ({ kind: 'runtime', event });
const server = (event: Extract<Input, { kind: 'server' }>['event']): Input => ({ kind: 'server', event });
const prep = (key: string, over: Partial<LaunchPrepDto> = {}): LaunchPrepDto => ({ key, phase: 'running', startedAt: 1, endedAt: null, steps: [], ask: null, reason: null, ...over });
const loading = { id: '1', kind: 'local-model' as const, target: 'm', action: 'load' as const, state: 'running' as const, fromContext: null, toContext: 65_536, startedAt: 1, endedAt: null, reason: null };
const withPrep = (p: LaunchPrepDto): Store => ({ ...initialStore(), launchPreps: { [p.key]: p } });
const params = (over: Partial<LaunchParams> = {}): LaunchParams => ({ projectId: 'p1', agent: 'opencode', model: 'lmstudio/qwen', name: '調べもの', prepKey: 'key-12345678', ...over });
const open = (): State => ({ ...initialState(), screen: { name: 'home', q: '' } }) as State;
const sent = (p: LaunchParams = params(), store: Store = initialStore()) => {
  const opened = transition(open(), store, action({ type: 'session.new.open', projectId: 'p1' })).state;
  return transition(opened, store, action({ type: 'session.new.submit', params: p })).state;
};
/** ダイアログを閉じても起動は続く。 */
const closed = (s: State, store: Store = initialStore()): State => transition(s, store, action({ type: 'overlay.close' })).state;

describe('起動前の準備の鍵', () => {
  it('prepKey を添えて送ると、鍵と起動のモデルと名前を覚える。起動はそのまま送る', () => {
    const opened = transition(open(), initialStore(), action({ type: 'session.new.open', projectId: 'p1' })).state;
    const r = transition(opened, initialStore(), action({ type: 'session.new.submit', params: params() }));
    expect(r.state.launchPrep).toEqual({ key: 'key-12345678', model: 'lmstudio/qwen', name: '調べもの' });
    expect(r.effects).toContainEqual({ kind: 'api.launch', params: params() });
  });
  it('prepKey が無い起動は何も覚えない（Claude Code）', () => {
    const { prepKey: _k, ...plain } = params({ agent: undefined });
    expect(sent(plain as LaunchParams).launchPrep).toBeNull();
  });
  it('開き直したとき、走っていない準備は忘れ、走っているものは残す', () => {
    const s = sent();
    const idle = transition(closed(s), withPrep(prep('key-12345678', { phase: 'failed' })), action({ type: 'session.new.open', projectId: 'p1' })).state;
    expect(idle.launchPrep).toBeNull();
    const running = transition(closed(s), withPrep(prep('key-12345678')), action({ type: 'session.new.open', projectId: 'p1' })).state;
    expect(running.launchPrep?.key).toBe('key-12345678');
  });
});

describe('準備のあとの起動の結果', () => {
  const done = runtime({ type: 'launch.done', sessionId: 's1', runId: 'r1' });
  it('ダイアログが開いたままなら、今までどおり会話の画面へ移り、準備の印を外す', () => {
    const store = withPrep(prep('key-12345678', { phase: 'ready', steps: [{ ...loading, state: 'done', endedAt: 5 }] }));
    const r = transition(sent(params(), store), store, done);
    expect(r.effects).toContainEqual({ kind: 'navigate', route: { name: 'session', id: 's1' } });
    expect(r.state.launchPrep).toBeNull();
  });
  it('段のあった準備で、閉じた後に済んだら、画面は移さず「開始しました」と「開く」を右下に出す', () => {
    const store: Store = { ...withPrep(prep('key-12345678', { phase: 'ready', steps: [{ ...loading, state: 'done', endedAt: 5 }] })), sessions: { s1: { id: 's1', name: 'サーバの名前' } as SessionDto } };
    const s = closed(sent(params(), store), store);
    const r = transition(s, store, done);
    expect(r.effects.find((e) => e.kind === 'navigate')).toBeUndefined();
    expect(r.state.launch).toEqual({ kind: 'idle' });
    expect(r.state.launchPrep).toBeNull();
    expect(r.state.toasts).toEqual([expect.objectContaining({ level: 'info', message: '「サーバの名前」を開始しました', action: { label: '開く', send: { type: 'session.open', id: 's1' } } })]);
  });
  it('会話の名前がまだ Store に無ければ、送った名前を使う', () => {
    const store = withPrep(prep('key-12345678', { phase: 'ready', steps: [{ ...loading, state: 'done', endedAt: 5 }] }));
    const r = transition(closed(sent(params(), store), store), store, done);
    expect(r.state.toasts[0]!.message).toBe('「調べもの」を開始しました');
  });
  it('段の無い準備（何も届いていない）は、閉じた後でも今までどおり画面を移す', () => {
    const r = transition(closed(sent()), initialStore(), done);
    expect(r.effects).toContainEqual({ kind: 'navigate', route: { name: 'session', id: 's1' } });
    expect(r.state.toasts).toEqual([]);
  });
  it('閉じたまま失敗したら、今までどおりエラーのトーストで理由を出す', () => {
    const store = withPrep(prep('key-12345678', { phase: 'failed', reason: 'メモリが足りません' }));
    const r = transition(closed(sent(params(), store), store), store, runtime({ type: 'launch.failed', message: 'メモリが足りません' }));
    expect(r.effects).toContainEqual({ kind: 'toast', level: 'error', message: 'メモリが足りません' });
  });
  it('開いたまま失敗したら、トーストは重ねず、準備の印を残す（失敗の札を出すため）', () => {
    const store = withPrep(prep('key-12345678', { phase: 'failed', reason: 'x' }));
    const r = transition(sent(params(), store), store, runtime({ type: 'launch.failed', message: 'x' }));
    expect(r.effects).toEqual([]);
    expect(r.state.launchPrep?.key).toBe('key-12345678');
  });
});

describe('準備が問いで止まったか、やめられた', () => {
  it('問いで止まったら、送信中を解き、準備の印は残す。ダイアログが開いていれば何も重ねない', () => {
    const r = transition(sent(), initialStore(), runtime({ type: 'launch.halted', why: 'ask', message: '続行するにはユーザーの確認が必要です。' }));
    expect(r.state.launch).toEqual({ kind: 'halted' });
    expect(r.state.newSessionSent).toBe(false);
    expect(r.state.launchPrep?.key).toBe('key-12345678');
    expect(r.effects).toEqual([]);
  });
  it('閉じた後に問いで止まったら、エラーのトーストで知らせる', () => {
    const r = transition(closed(sent()), initialStore(), runtime({ type: 'launch.halted', why: 'ask', message: '続行するにはユーザーの確認が必要です。' }));
    expect(r.effects).toContainEqual({ kind: 'toast', level: 'error', message: '続行するにはユーザーの確認が必要です。' });
  });
  it('利用者がやめたときは、エラーにせず、閉じていても何も出さない', () => {
    const r = transition(closed(sent()), initialStore(), runtime({ type: 'launch.halted', why: 'cancel', message: '準備を中止しました。' }));
    expect(r.state.launch).toEqual({ kind: 'halted' });
    expect(r.effects).toEqual([]);
  });
  it('作ってから起動する送信で止まっても、作ったプロジェクトは忘れない（押し直しで二重に作らない）', () => {
    const created = transition(sent(), initialStore(), runtime({ type: 'project.created', projectId: 'p9', params: params({ projectId: 'p9' }) })).state;
    const r = transition(created, initialStore(), runtime({ type: 'launch.halted', why: 'ask', message: 'm' }));
    expect(r.state.launch).toEqual({ kind: 'halted', createdProjectId: 'p9' });
  });
  it('同じ画面から送り直せる（halted のあとの送信は通る）', () => {
    const halted = transition(sent(), initialStore(), runtime({ type: 'launch.halted', why: 'ask', message: 'm' })).state;
    const r = transition(halted, initialStore(), action({ type: 'session.new.submit', params: params({ prepKey: 'key-87654321', prepChoice: { skip: true } }) }));
    expect(r.state.launch).toEqual({ kind: 'submitting' });
    expect(r.state.launchPrep?.key).toBe('key-87654321');
    expect(r.effects).toContainEqual({ kind: 'api.launch', params: params({ prepKey: 'key-87654321', prepChoice: { skip: true } }) });
  });
});

describe('起動後にコンテキストが足りなかった札', () => {
  const short = server({ type: 'opencode.contextShort', sessionId: 's1' });
  const at = (s: State, i: Input) => transition(s, initialStore(), i);

  it('届いたら 1 枚出し、同じ会話の札は 1 枚にまとめる', () => {
    const a = at(initialState(), short).state;
    expect(a.contextShorts).toEqual([{ sessionId: 's1', fix: null, done: false }]);
    expect(at(a, short).state.contextShorts).toHaveLength(1);
    expect(at(a, server({ type: 'opencode.contextShort', sessionId: 's2' })).state.contextShorts.map((c) => c.sessionId)).toEqual(['s1', 's2']);
  });
  it('「再ロードして再開」は鍵を添えて頼み、札の中を進み中にする。進み中の押し直しは無視する', () => {
    const a = at(initialState(), short).state;
    const r = at(a, action({ type: 'launchPrep.short.fix', sessionId: 's1', prepKey: 'key-12345678' }));
    expect(r.state.contextShorts).toEqual([{ sessionId: 's1', fix: { key: 'key-12345678' }, done: false }]);
    expect(r.effects).toEqual([{ kind: 'api.fixContextShort', sessionId: 's1', prepKey: 'key-12345678' }]);
    expect(at(r.state, action({ type: 'launchPrep.short.fix', sessionId: 's1', prepKey: 'key-99999999' })).effects).toEqual([]);
  });
  it('済んだら札を「済んだ」の知らせに替える', () => {
    const a = at(initialState(), short).state;
    const fixing = at(a, action({ type: 'launchPrep.short.fix', sessionId: 's1', prepKey: 'key-12345678' })).state;
    expect(at(fixing, runtime({ type: 'contextShort.done', sessionId: 's1' })).state.contextShorts).toEqual([{ sessionId: 's1', fix: null, done: true }]);
  });
  it('失敗したら札をもとに戻し、エラーのトーストで理由を出す', () => {
    const a = at(initialState(), short).state;
    const fixing = at(a, action({ type: 'launchPrep.short.fix', sessionId: 's1', prepKey: 'key-12345678' })).state;
    const r = at(fixing, runtime({ type: 'contextShort.failed', sessionId: 's1', message: 'メモリが足りません' }));
    expect(r.state.contextShorts).toEqual([{ sessionId: 's1', fix: null, done: false }]);
    expect(r.effects).toContainEqual({ kind: 'toast', level: 'error', message: 'メモリが足りません' });
  });
  it('「閉じる」でその会話の札だけを下げる', () => {
    const two = at(at(initialState(), short).state, server({ type: 'opencode.contextShort', sessionId: 's2' })).state;
    expect(at(two, action({ type: 'launchPrep.short.dismiss', sessionId: 's1' })).state.contextShorts.map((c) => c.sessionId)).toEqual(['s2']);
  });
  it('済んだあとにまた足りなくなったら、もう一度出す', () => {
    const done = { ...initialState(), contextShorts: [{ sessionId: 's1', fix: null, done: true }] } as State;
    expect(at(done, short).state.contextShorts).toEqual([{ sessionId: 's1', fix: null, done: false }]);
  });
});
