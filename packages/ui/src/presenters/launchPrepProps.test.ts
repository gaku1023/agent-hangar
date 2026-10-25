import { describe, expect, it } from 'vitest';
import type { LaunchPrepDto } from '@agent-hangar/shared';
import { initialState } from '../mediator/transition.ts';
import type { State } from '../mediator/types.ts';
import { initialStore, type Store } from '../store/store.ts';
import { presentNewSession } from './newSession.ts';
import { presentToasts } from './toasts.ts';

const prep = (over: Partial<LaunchPrepDto> = {}): LaunchPrepDto => ({ key: 'key-12345678', phase: 'running', startedAt: 1_000, endedAt: null, steps: [{ id: '1', kind: 'local-model', target: 'qwen', action: 'load', state: 'running', fromContext: null, toContext: 65_536, startedAt: 1_000, endedAt: null, reason: null }], ask: null, reason: null, ...over });
const storeWith = (p: LaunchPrepDto | null): Store => ({ ...initialStore(), launchPreps: p ? { [p.key]: p } : {} });
const dialog = (over: Partial<State> = {}): State => ({ ...initialState(), overlay: { kind: 'newSession', projectId: null, scratch: true }, launchPrep: { key: 'key-12345678', model: 'lmstudio/qwen', name: null }, launch: { kind: 'submitting' }, ...over });

describe('新しいセッションのダイアログに渡す準備の進み', () => {
  it('準備の鍵の進みが Store にあれば、その分を画面の形にして渡す。無ければ null（今までどおりの見た目）', () => {
    expect(presentNewSession(dialog(), storeWith(prep()), 5_000)!.prep?.line.text).toBe('qwen をロード中…（64K）');
    expect(presentNewSession(dialog(), storeWith(null), 5_000)!.prep).toBeNull();
    expect(presentNewSession(dialog({ launchPrep: null }), storeWith(prep()), 5_000)!.prep).toBeNull();
  });
  it('止まった問いの答えの provider は、送ったモデルから取る', () => {
    const ask = prep({ phase: 'asking', ask: { kind: 'memory', models: [], totalBytes: 2 * 1024 ** 3, limitBytes: 1024 ** 3, suggest: 'qwen' } });
    expect(presentNewSession(dialog({ launch: { kind: 'halted' } }), storeWith(ask), 5_000)!.prep?.ask?.choices[0]!.choice).toEqual({ singleModel: 'lmstudio/qwen' });
  });
  it('準備が止まった（halted）あとも、作ったプロジェクトを渡す', () => {
    expect(presentNewSession(dialog({ launch: { kind: 'halted', createdProjectId: 'p9' } }), storeWith(prep()), 5_000)!.createdProjectId).toBe('p9');
  });
});

describe('右下の知らせの準備の進み', () => {
  const closed = (over: Partial<State> = {}): State => dialog({ overlay: { kind: 'none' }, launch: { kind: 'idle' }, newSessionSent: true, ...over });
  it('ダイアログを閉じて（閉じると送信中は解ける）、準備が走っている間だけ、進みの札を出す', () => {
    expect(presentToasts(closed(), storeWith(prep()), 5_000).prepProgress).toMatchObject({ key: 'key-12345678', line: 'qwen をロード中…（64K）', startedAt: 1_000 });
    expect(presentToasts(dialog(), storeWith(prep()), 5_000).prepProgress).toBeNull();
    expect(presentToasts(closed(), storeWith(prep({ phase: 'failed' })), 5_000).prepProgress).toBeNull();
    expect(presentToasts(closed({ newSessionSent: false }), storeWith(prep()), 5_000).prepProgress).toBeNull();
    expect(presentToasts(closed({ launchPrep: null }), storeWith(prep()), 5_000).prepProgress).toBeNull();
  });
});

describe('右下の知らせのコンテキスト不足の札', () => {
  it('会話ごとに 1 枚。整え直しの最中は鍵の進みの 1 行を、鍵の進みがまだ届かなければ確認中の文を出す', () => {
    const state = { ...initialState(), contextShorts: [{ sessionId: 's1', fix: null, done: false }, { sessionId: 's2', fix: { key: 'key-12345678' }, done: false }, { sessionId: 's3', fix: { key: 'key-none0000' }, done: false }, { sessionId: 's4', fix: null, done: true }] } as State;
    const cards = presentToasts(state, storeWith(prep()), 5_000).contextShorts!;
    expect(cards).toEqual([
      { sessionId: 's1', fix: null, done: false },
      { sessionId: 's2', fix: { text: 'qwen をロード中…（64K）', startedAt: 1_000 }, done: false },
      { sessionId: 's3', fix: { text: 'LM Studio を確認中…', startedAt: null }, done: false },
      { sessionId: 's4', fix: null, done: true },
    ]);
  });
});
