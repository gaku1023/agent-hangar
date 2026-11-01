import { describe, expect, it } from 'vitest';
import type { Input } from './types.ts';
import { initialState, transition, type State } from './transition.ts';
import { initialStore } from '../store/store.ts';

function run(inputs: Input[], start: State = initialState()) {
  const effects: unknown[] = [];
  let state = start;
  for (const i of inputs) { const r = transition(state, initialStore(), i); state = r.state; effects.push(...r.effects); }
  return { state, effects };
}
const action = (i: Extract<Input, { kind: 'action' }>['action']): Input => ({ kind: 'action', action: i });
const runtime = (e: Extract<Input, { kind: 'runtime' }>['event']): Input => ({ kind: 'runtime', event: e });
const server = (e: Extract<Input, { kind: 'server' }>['event']): Input => ({ kind: 'server', event: e });

describe('欄ごとの保存（設定の C1 と B1）', () => {
  it('欄の名前を添えた保存は、その名前を効果に載せ、欄の前の知らせを消す', () => {
    const a = run([action({ type: 'settings.update', patch: { tmuxPath: '/x' }, field: 'tmuxPath' }), runtime({ type: 'settings.failed', field: 'tmuxPath', message: '見つかりません' })]);
    expect(a.effects).toEqual([{ kind: 'api.updateSettings', patch: { tmuxPath: '/x' }, field: 'tmuxPath' }]);
    expect(a.state.settingsSave.tmuxPath).toEqual({ kind: 'error', message: '見つかりません' });
    const b = run([action({ type: 'settings.update', patch: { tmuxPath: '/y' }, field: 'tmuxPath' })], a.state);
    expect(b.state.settingsSave.tmuxPath).toBeUndefined();
  });
  it('保存できたら欄に印を付け、同じ欄の保存のたびに印の番号を進める', () => {
    const a = run([runtime({ type: 'settings.saved', field: 'workspaceRoot' })]);
    expect(a.state.settingsSave.workspaceRoot).toEqual({ kind: 'saved', n: 1 });
    const b = run([runtime({ type: 'settings.saved', field: 'workspaceRoot' })], a.state);
    expect(b.state.settingsSave.workspaceRoot).toEqual({ kind: 'saved', n: 2 });
    // 失敗はトーストにしない。欄の下に出すので、二重に言わない。
    const c = run([runtime({ type: 'settings.failed', field: 'workspaceRoot', message: 'x' })], b.state);
    expect(c.state.toasts).toEqual([]);
  });
  // 欄の値は画面を離れると保存済みの値に戻る。戻った欄の下に前の理由だけが残ると、いまの値が断られたように読める。
  it('設定の画面を離れたら、欄の下の理由を消す。保存済みの印は残す', () => {
    const at = run([runtime({ type: 'hash.changed', route: { name: 'settings' } }), runtime({ type: 'settings.saved', field: 'workspaceRoot' }), runtime({ type: 'settings.failed', field: 'tmuxPath', message: '見つかりません' })]).state;
    expect(at.settingsSave.tmuxPath).toEqual({ kind: 'error', message: '見つかりません' });
    const left = run([runtime({ type: 'hash.changed', route: { name: 'home' } })], at).state;
    expect(left.settingsSave).toEqual({ workspaceRoot: { kind: 'saved', n: 1 } });
    // 設定の画面の中で描き直すだけ（同じ画面の hash.changed）なら消さない。
    expect(run([runtime({ type: 'hash.changed', route: { name: 'settings' } })], at).state.settingsSave.tmuxPath).toEqual({ kind: 'error', message: '見つかりません' });
  });
});

describe('準備の確かめ', () => {
  it('もう一度確かめると取り直す', () => {
    expect(run([action({ type: 'readiness.check' })]).effects).toEqual([{ kind: 'api.readiness' }]);
  });
  it('設定の画面に入ると、他の値と一緒に準備の確かめも取る', () => {
    const { effects } = run([runtime({ type: 'ws.open' }), runtime({ type: 'hash.changed', route: { name: 'settings' } })]);
    expect(effects).toContainEqual({ kind: 'api.loadSettingsExtras' });
  });
});

describe('殻の操作', () => {
  it('ログを開く、再起動、コピーは効果にする', () => {
    const { effects } = run([action({ type: 'shell.openLog' }), action({ type: 'shell.restart' }), action({ type: 'clipboard.copy', text: '~/.agent-hangar/desktop.log' })]);
    expect(effects).toEqual([{ kind: 'shell.openLog' }, { kind: 'shell.restart' }, { kind: 'clipboard.copy', text: '~/.agent-hangar/desktop.log' }]);
  });
});

describe('ほかから変えられた設定（settings.changed）', () => {
  const dto = { workspaceRoot: '/w', claudeDir: '/c', tmuxPath: null, terminalApp: 'terminal' as const, editor: { id: 'vscode' as const, path: null, fileCmd: '', dirCmd: '', terminal: 'none' as const }, lmStudioUrl: 'http://127.0.0.1:1234', lmStudioModel: null, summaryFallback: true, summaryHourlyCap: 20, allowExternalSummarizer: false, nodePath: null, claudePath: null };
  it('準備の確かめに効く欄が変わったら、準備の確かめを取り直す', () => {
    for (const key of ['claudePath', 'tmuxPath', 'nodePath', 'editor', 'workspaceRoot', 'claudeDir'] as const) {
      expect(run([server({ type: 'settings.changed', settings: dto, keys: [key] })]).effects, key).toEqual([{ kind: 'api.readiness' }]);
    }
  });
  it('効かない欄だけが変わったときは取り直さない', () => {
    expect(run([server({ type: 'settings.changed', settings: dto, keys: ['summaryFallback', 'language'] })]).effects).toEqual([]);
  });
});

describe('宛先のコピー', () => {
  it('session.copyAddress は 1 行を組んでコピーの効果にし、写せたときの知らせを添える', () => {
    const st = initialStore();
    st.sessions = { s1: { id: 's1', provider: 'claude-code', providerSessionId: 'u1', projectId: null, name: 'N', cwd: '/w', firstPrompt: null, aiTitle: null, startedAt: null, lastActivityAt: null, lastTurnAt: null, hasTranscript: true, live: null, summary: null, stats: { turns: 0, model: null, effort: null, filesChanged: 0, prUrl: null, inputTokens: 0, outputTokens: 0, contextPercent: null, costUsd: null }, fromScratch: false, lock: null, remoteOnly: false, transcriptMtime: null, activity: null, state: null, parked: false, stoppedByStatus: false, woke: false, liveAside: null, waitingFor: null, permission: null, limit: null, interrupted: null, overlap: null, newerElsewhere: false, takenOver: null, fromPhone: null, pinnedAt: null, unread: null, spawnedBy: null } };
    const r = transition(initialState(), st, action({ type: 'session.copyAddress', id: 's1' }));
    expect(r.effects).toEqual([{ kind: 'clipboard.copy', text: 'hangar のセッション「N」（session_id: s1、終了）', done: '宛先をコピーしました。別の Claude のプロンプトに貼り付けられます' }]);
    // 知らないセッションでは何もしない。
    expect(transition(initialState(), st, action({ type: 'session.copyAddress', id: 'ghost' })).effects).toEqual([]);
  });
  it('session.copyId は claude -r に渡せる Claude Code のセッション ID だけを写す（hangar の ID ではない）', () => {
    const st = initialStore();
    st.sessions = { s1: { id: 's1', provider: 'claude-code', providerSessionId: 'u1', projectId: null, name: 'N', cwd: '/w', firstPrompt: null, aiTitle: null, startedAt: null, lastActivityAt: null, lastTurnAt: null, hasTranscript: true, live: null, summary: null, stats: { turns: 0, model: null, effort: null, filesChanged: 0, prUrl: null, inputTokens: 0, outputTokens: 0, contextPercent: null, costUsd: null }, fromScratch: false, lock: null, remoteOnly: false, transcriptMtime: null, activity: null, state: null, parked: false, stoppedByStatus: false, woke: false, liveAside: null, waitingFor: null, permission: null, limit: null, interrupted: null, overlap: null, newerElsewhere: false, takenOver: null, fromPhone: null, pinnedAt: null, unread: null, spawnedBy: null } };
    const r = transition(initialState(), st, action({ type: 'session.copyId', id: 's1' }));
    expect(r.effects).toEqual([{ kind: 'clipboard.copy', text: 'u1', done: 'セッション ID をコピーしました。claude -r に指定すると再開できます' }]);
    expect(transition(initialState(), st, action({ type: 'session.copyId', id: 'ghost' })).effects).toEqual([]);
  });
});
