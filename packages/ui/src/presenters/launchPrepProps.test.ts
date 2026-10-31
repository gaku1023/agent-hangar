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
  it('止まった問いの答えは、サーバが勧めたモデルの指定（既定のモデルで送ったときも）', () => {
    const ask = prep({ phase: 'asking', ask: { kind: 'memory', models: [], totalBytes: 2 * 1024 ** 3, limitBytes: 1024 ** 3, suggest: 'qwen', suggestRef: 'lmstudio/qwen' } });
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
  it('この画面が起こしていない準備（MCP の起動）も、会話に結び付いて段が動いていれば同じ札で出す（#545）', () => {
    const cmd = { id: '1', kind: 'command' as const, target: 'my-gpu', action: 'run' as const, state: 'running' as const, fromContext: null, toContext: null, startedAt: 2_000, endedAt: null, reason: null };
    const mcp = prep({ key: 'mcp-00000001', sessionId: 's1', startedAt: 2_000, steps: [cmd] });
    const idle = { ...initialState() };
    expect(presentToasts(idle, storeWith(mcp), 5_000).prepProgress).toMatchObject({ key: 'mcp-00000001', line: 'my-gpu を準備中…', startedAt: 2_000 });
    // 段がまだ無い（serve の立ち上がり）、会話が分からない、済んだものは出さない。
    expect(presentToasts(idle, storeWith({ ...mcp, steps: [] }), 5_000).prepProgress).toBeNull();
    expect(presentToasts(idle, storeWith({ ...mcp, sessionId: undefined }), 5_000).prepProgress).toBeNull();
    expect(presentToasts(idle, storeWith({ ...mcp, phase: 'ready' }), 5_000).prepProgress).toBeNull();
    // この画面の準備が走っていれば、そちらを先に出す。
    const both: Store = { ...initialStore(), launchPreps: { [mcp.key]: mcp, 'key-12345678': prep() } };
    expect(presentToasts(closed(), both, 5_000).prepProgress).toMatchObject({ key: 'key-12345678' });
    // ダイアログで送っている最中の自分の準備は、ほかの準備として出さない。
    expect(presentToasts(dialog(), storeWith(prep({ sessionId: 's2' })), 5_000).prepProgress).toBeNull();
  });
  it('再開の準備（接続先の準備のコマンド）は、ダイアログを経ずに同じ札で出す', () => {
    const resume = closed({ newSessionSent: false, launch: { kind: 'submitting' }, launchPrep: { key: 'key-12345678', model: null, name: null, resume: true } });
    const run = prep({ steps: [{ id: '1', kind: 'command', target: 'my-gpu', action: 'run', state: 'running', fromContext: null, toContext: null, startedAt: 1_000, endedAt: null, reason: null }] });
    expect(presentToasts(resume, storeWith(run), 5_000).prepProgress).toMatchObject({ key: 'key-12345678', line: 'my-gpu を準備中…' });
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
