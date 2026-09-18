import { describe, expect, it } from 'vitest';
import type { Input } from './types.ts';
import { initialState, transition, type State } from './transition.ts';

function run(inputs: Input[], start: State = initialState()) {
  const effects: unknown[] = [];
  let state = start;
  for (const i of inputs) { const r = transition(state, i); state = r.state; effects.push(...r.effects); }
  return { state, effects };
}
const intent = (i: Extract<Input, { kind: 'intent' }>['intent']): Input => ({ kind: 'intent', intent: i });
const server = (e: Extract<Input, { kind: 'server' }>['event']): Input => ({ kind: 'server', event: e });
const runtime = (e: Extract<Input, { kind: 'runtime' }>['event']): Input => ({ kind: 'runtime', event: e });

describe('起動と接続', () => {
  it('ws が開いたら bootstrap を取り、hash で画面が決まる', () => {
    const { state, effects } = run([runtime({ type: 'ws.open' }), runtime({ type: 'hash.changed', route: { name: 'projects' } })]);
    expect(state.connection).toBe('connected');
    expect(state.screen).toEqual({ name: 'projects' });
    expect(effects).toEqual([{ kind: 'api.bootstrap' }]);
  });
  it('切断で指数バックオフ、再接続で bootstrap を取り直す', () => {
    const a = run([runtime({ type: 'ws.open' }), runtime({ type: 'ws.close' })]);
    expect(a.state.connection).toBe('disconnected');
    expect(a.effects.at(-1)).toEqual({ kind: 'ws.reconnectAfter', ms: 2000 });
    const b = run([runtime({ type: 'ws.close' })], a.state);
    expect(b.effects.at(-1)).toEqual({ kind: 'ws.reconnectAfter', ms: 4000 });
    const c = run([runtime({ type: 'ws.open' })], b.state);
    expect(c.state).toMatchObject({ connection: 'connected', reconnectAttempt: 0 });
    expect(c.effects).toEqual([{ kind: 'api.bootstrap' }]);
  });
  it('バックオフは 15 秒で頭打ち', () => {
    let s = initialState();
    for (let i = 0; i < 8; i++) s = transition(s, runtime({ type: 'ws.close' })).state;
    expect(transition(s, runtime({ type: 'ws.close' })).effects).toEqual([{ kind: 'ws.reconnectAfter', ms: 15000 }]);
  });
});

describe('ナビゲーション', () => {
  it('nav.go と project.open と session.open は navigate 効果だけを出す', () => {
    const { state, effects } = run([intent({ type: 'nav.go', to: { name: 'settings' } }), intent({ type: 'project.open', id: 'p1' }), intent({ type: 'session.open', id: 's1' })]);
    expect(state.screen).toEqual({ name: 'booting' });
    expect(effects).toEqual([{ kind: 'navigate', route: { name: 'settings' } }, { kind: 'navigate', route: { name: 'project', id: 'p1' } }, { kind: 'navigate', route: { name: 'session', id: 's1' } }]);
  });
  it('session 画面に入ると本文の先頭ページを読む', () => {
    const { effects } = run([runtime({ type: 'hash.changed', route: { name: 'session', id: 's1' } })]);
    expect(effects).toEqual([{ kind: 'api.loadEvents', sessionId: 's1', fromSeq: 0 }, { kind: 'terminal.connect', sessionId: 's1', tabId: null }]);
  });
  it('検索語は URL に乗り、sessions 画面で検索効果になる', () => {
    const a = run([intent({ type: 'search.query', text: '動画' })]);
    expect(a.state.search.text).toBe('動画');
    expect(a.effects).toEqual([{ kind: 'navigate', route: { name: 'sessions', q: '動画' } }]);
    const b = run([runtime({ type: 'hash.changed', route: { name: 'sessions', q: '動画' } })], a.state);
    expect(b.effects).toEqual([{ kind: 'api.search', params: { q: '動画' } }]);
    const c = run([intent({ type: 'search.filter', patch: { projectId: 'p1' } })], b.state);
    expect(c.state.search.filter).toEqual({ projectId: 'p1' });
    expect(c.effects).toEqual([{ kind: 'api.search', params: { q: '動画', projectId: 'p1' } }]);
    expect(run([intent({ type: 'search.query', text: '' })]).effects).toEqual([{ kind: 'navigate', route: { name: 'sessions' } }]);
  });
});

describe('オーバーレイ', () => {
  it('未解決プロジェクトはダイアログになり、複数はキューに積む', () => {
    const a = run([server({ type: 'project.unresolved', projectId: 'p1' }), server({ type: 'project.unresolved', projectId: 'p2' })]);
    expect(a.state.overlay).toEqual({ kind: 'resolveProject', projectId: 'p1' });
    expect(a.state.unresolvedQueue).toEqual(['p2']);
    const b = run([intent({ type: 'project.resolve', id: 'p1', action: { kind: 'archive' } })], a.state);
    expect(b.effects).toEqual([{ kind: 'api.resolveProject', projectId: 'p1', action: { kind: 'archive' } }]);
    expect(b.state.overlay).toEqual({ kind: 'resolveProject', projectId: 'p2' });
    const c = run([intent({ type: 'overlay.close' })], b.state);
    expect(c.state.overlay).toEqual({ kind: 'none' });
  });
  it('カードからの project.resolve.open でもダイアログを開き、開いていればキューに積む', () => {
    const a = run([intent({ type: 'project.resolve.open', id: 'p1' })]);
    expect(a.state.overlay).toEqual({ kind: 'resolveProject', projectId: 'p1' });
    expect(a.effects).toEqual([]);
    const b = run([intent({ type: 'project.resolve.open', id: 'p2' })], a.state);
    expect(b.state.overlay).toEqual({ kind: 'resolveProject', projectId: 'p1' });
    expect(b.state.unresolvedQueue).toEqual(['p2']);
    const c = run([intent({ type: 'project.resolve.open', id: 'p1' })], b.state);
    expect(c.state.unresolvedQueue).toEqual(['p2']);
  });
  it('同じプロジェクトの重複通知は積まない', () => {
    const { state } = run([server({ type: 'project.unresolved', projectId: 'p1' }), server({ type: 'project.unresolved', projectId: 'p1' })]);
    expect(state.unresolvedQueue).toEqual([]);
  });
});

describe('索引の進み', () => {
  it('走査が終わった瞬間に bootstrap を取り直す', () => {
    const a = run([server({ type: 'index.progress', progress: { phase: 'scanning', done: 0, total: 0 } })]);
    expect(a.effects).toEqual([]);
    const b = run([server({ type: 'index.progress', progress: { phase: 'indexing', done: 1, total: 3 } })], a.state);
    expect(b.effects).toEqual([]);
    const c = run([server({ type: 'index.progress', progress: { phase: 'idle', done: 3, total: 3 } })], b.state);
    expect(c.effects).toEqual([{ kind: 'api.bootstrap' }]);
    // 同じ idle が続いても取り直さない。
    const d = run([server({ type: 'index.progress', progress: { phase: 'idle', done: 3, total: 3 } })], c.state);
    expect(d.effects).toEqual([]);
  });
});

describe('セッション表示の一時状態', () => {
  it('思考と生 JSON と追従の切り替えを保存する', () => {
    const { state, effects } = run([intent({ type: 'transcript.showThinking', sessionId: 's1', show: true }), intent({ type: 'summary.toggle', sessionId: 's1' })]);
    expect(state.sessionView.s1).toMatchObject({ showThinking: true, summaryOpen: true, showRaw: false, follow: true });
    expect(effects[0]).toMatchObject({ kind: 'storage.save', key: 'sv:s1' });
  });
  it('本文の追記は開いているセッションだけ読み直す', () => {
    const open = run([runtime({ type: 'hash.changed', route: { name: 'session', id: 's1' } })]).state;
    expect(run([server({ type: 'transcript.appended', sessionId: 's1', count: 2 })], open).effects).toEqual([{ kind: 'api.loadEvents', sessionId: 's1', fromSeq: -1 }]);
    expect(run([server({ type: 'transcript.appended', sessionId: 's2', count: 2 })], open).effects).toEqual([]);
  });
  it('loadMore は次のページを要求する', () => {
    expect(run([intent({ type: 'transcript.loadMore', sessionId: 's1' })]).effects).toEqual([{ kind: 'api.loadEvents', sessionId: 's1', fromSeq: -1 }]);
  });
  it('サブエージェントの切替は agentId を保存して先頭から読み直す', () => {
    const { state, effects } = run([intent({ type: 'transcript.selectAgent', sessionId: 's1', agentId: 'abc' })]);
    expect(state.sessionView.s1?.agentId).toBe('abc');
    expect(effects[1]).toEqual({ kind: 'api.loadEvents', sessionId: 's1', fromSeq: 0 });
  });
});

describe('その他', () => {
  it('トーストは追加と消去ができ、失敗は error になる', () => {
    const a = run([server({ type: 'toast', level: 'info', message: 'a' }), runtime({ type: 'api.failed', message: 'b' })]);
    expect(a.state.toasts.map((t) => [t.level, t.message])).toEqual([['info', 'a'], ['error', 'b']]);
    const b = run([intent({ type: 'toast.dismiss', id: a.state.toasts[0]!.id })], a.state);
    expect(b.state.toasts).toHaveLength(1);
  });
  it('設定と状態変更と索引の作り直しは API 効果', () => {
    const { effects } = run([intent({ type: 'project.setStatus', id: 'p1', status: 'paused' }), intent({ type: 'settings.update', patch: { workspaceRoot: '/w' } }), intent({ type: 'index.rebuild' })]);
    expect(effects[0]).toEqual({ kind: 'api.setProjectStatus', projectId: 'p1', status: 'paused' });
    expect(effects[1]).toEqual({ kind: 'api.updateSettings', patch: { workspaceRoot: '/w' } });
    expect(effects[2]).toEqual({ kind: 'api.rebuildIndex' });
  });
  it('次のフェーズの操作はトーストで知らせる', () => {
    const { state, effects } = run([intent({ type: 'sync.now' }), intent({ type: 'session.takeover', id: 's1', force: false })]);
    expect(effects).toEqual([{ kind: 'toast', level: 'info', message: 'この操作は次のフェーズで実装します' }, { kind: 'toast', level: 'info', message: 'この操作は次のフェーズで実装します' }]);
    expect(state).toEqual(initialState());
  });
});

const runDto = (id: string, sessionId: string, endedAt: number | null = null) => ({ id, sessionId, deviceId: 'd', kind: 'start' as const, tmuxName: `hangar-${id}`, pid: null, startedAt: 1, endedAt, endReason: null, heartbeatAt: 1 });
const tabDto = (id: string, runId: string, closedAt: number | null = null) => ({ id, runId, sessionId: 's1', kind: 'shell' as const, title: 'シェル 1', tmuxName: `hangar-${runId}-t1`, createdAt: 2, closedAt });
const onSession = (id = 's1') => run([runtime({ type: 'hash.changed', route: { name: 'session', id } })]).state;

describe('起動', () => {
  it('ダイアログを開き、送信で submitting になり、done で画面へ移る', () => {
    const a = run([intent({ type: 'session.new.open', projectId: 'p1' })]);
    expect(a.state.overlay).toEqual({ kind: 'newSession', projectId: 'p1', scratch: false });
    expect(a.effects).toEqual([{ kind: 'focus', target: 'newSessionName' }]);
    const b = run([intent({ type: 'session.new.submit', params: { projectId: 'p1', name: 'n' } })], a.state);
    expect(b.state.launch).toEqual({ kind: 'submitting' });
    expect(b.effects).toEqual([{ kind: 'api.launch', params: { projectId: 'p1', name: 'n' } }]);
    const dup = run([intent({ type: 'session.new.submit', params: { projectId: 'p1' } })], b.state);
    expect(dup.effects).toEqual([]);
    const c = run([runtime({ type: 'launch.done', sessionId: 's9', runId: 'r9' })], b.state);
    expect(c.state.launch).toEqual({ kind: 'idle' });
    expect(c.state.overlay).toEqual({ kind: 'none' });
    expect(c.effects).toEqual([{ kind: 'navigate', route: { name: 'session', id: 's9' } }]);
  });
  it('失敗はダイアログを開いたまま failed になり、閉じると idle に戻る', () => {
    const a = run([intent({ type: 'session.new.open' }), intent({ type: 'session.new.submit', params: { projectId: 'p1' } }), runtime({ type: 'launch.failed', message: 'tmux が見つかりません' })]);
    expect(a.state.launch).toEqual({ kind: 'failed', message: 'tmux が見つかりません' });
    expect(a.state.overlay).toEqual({ kind: 'newSession', projectId: null, scratch: false });
    // ダイアログの中に同じ文言が出るので、トーストは重ねない。
    expect(a.effects.filter((e) => (e as { kind: string }).kind === 'toast')).toEqual([]);
    // 再開とフォークはダイアログを持たないので、そのときだけトーストで知らせる。
    const r = run([intent({ type: 'session.resume', id: 's1' }), runtime({ type: 'launch.failed', message: 'tmux が見つかりません' })]);
    expect(r.effects.at(-1)).toEqual({ kind: 'toast', level: 'error', message: 'tmux が見つかりません' });
    const b = run([intent({ type: 'overlay.close' })], a.state);
    expect(b.state).toMatchObject({ overlay: { kind: 'none' }, launch: { kind: 'idle' } });
  });
  it('プロジェクト無しの送信は failed、スクラッチはプロジェクトを選ばずに開く', () => {
    expect(run([intent({ type: 'session.new.submit', params: {} })]).state.launch).toEqual({ kind: 'failed', message: 'プロジェクトを選んでください' });
    const s = run([intent({ type: 'session.new.open', scratch: true })]);
    expect(s.state.overlay).toEqual({ kind: 'newSession', projectId: null, scratch: true });
    expect(s.effects).toEqual([{ kind: 'focus', target: 'newSessionName' }]);
    // スクラッチはプロジェクトが無くても送信できる。
    expect(run([intent({ type: 'session.new.submit', params: { scratch: true } })]).effects).toEqual([{ kind: 'api.launch', params: { scratch: true } }]);
  });
  it('再開、フォーク、停止、外部で開くは API 効果', () => {
    const { state, effects } = run([intent({ type: 'session.resume', id: 's1' }), intent({ type: 'session.fork', id: 's1' }), intent({ type: 'session.kill', runId: 'r1' }), intent({ type: 'session.openTerminalApp', runId: 'r1', tabId: 't1' }), intent({ type: 'session.openTerminalApp', runId: 'r1' }), intent({ type: 'session.openEditor', sessionId: 's1' }), intent({ type: 'project.openEditor', id: 'p1' }), intent({ type: 'project.openTerminalApp', id: 'p1' })]);
    expect(effects).toEqual([
      { kind: 'api.resume', sessionId: 's1' }, { kind: 'api.fork', sessionId: 's1' }, { kind: 'api.killRun', runId: 'r1' },
      { kind: 'api.openTerminalApp', runId: 'r1', tabId: 't1' }, { kind: 'api.openTerminalApp', runId: 'r1', tabId: null },
      { kind: 'api.openEditor', sessionId: 's1' }, { kind: 'api.projectOpenEditor', projectId: 'p1' }, { kind: 'api.projectOpenTerminal', projectId: 'p1' },
    ]);
    expect(state.launch).toEqual({ kind: 'submitting' });
  });
});

describe('タブと接続', () => {
  it('タブの選択と追加と閉じる', () => {
    const s = onSession();
    const a = run([intent({ type: 'tab.select', tabId: 't1' })], s);
    expect(a.state.sessionView.s1?.selectedTab).toBe('t1');
    expect(a.effects).toEqual([{ kind: 'storage.save', key: 'sv:s1', value: a.state.sessionView.s1 }, { kind: 'terminal.connect', sessionId: 's1', tabId: 't1' }, { kind: 'focus', target: 'terminal' }]);
    expect(run([intent({ type: 'tab.open', sessionId: 's1', kind: 'shell' })], s).effects).toEqual([{ kind: 'api.openTab', sessionId: 's1' }]);
    const b = run([intent({ type: 'tab.close', tabId: 't1' })], a.state);
    expect(b.state.sessionView.s1?.selectedTab).toBeNull();
    expect(b.effects.at(-1)).toEqual({ kind: 'api.closeTab', tabId: 't1' });
    expect(run([intent({ type: 'tab.select', tabId: 't1' })]).effects).toEqual([]);   // セッション画面の外では無視
  });
  it('run の開始と終了、タブの出現と消失', () => {
    const s = onSession();
    const a = run([server({ type: 'run.started', run: runDto('r1', 's1'), tabs: [] })], s);
    expect(a.effects).toEqual([{ kind: 'storage.save', key: 'sv:s1', value: a.state.sessionView.s1 }, { kind: 'terminal.connect', sessionId: 's1', tabId: 'r1' }]);
    expect(run([server({ type: 'run.started', run: runDto('r2', 's2'), tabs: [] })], s).effects).toEqual([]);
    const b = run([server({ type: 'tab.upsert', tab: tabDto('t1', 'r1') })], a.state);
    expect(b.state.sessionView.s1?.selectedTab).toBe('t1');
    expect(b.effects.slice(1)).toEqual([{ kind: 'terminal.connect', sessionId: 's1', tabId: 't1' }, { kind: 'focus', target: 'terminal' }]);
    const c = run([server({ type: 'tab.upsert', tab: tabDto('t1', 'r1', 5) })], b.state);
    expect(c.state.sessionView.s1?.selectedTab).toBeNull();
    expect(c.effects.slice(1)).toEqual([{ kind: 'terminal.disconnect', tabId: 't1' }, { kind: 'terminal.connect', sessionId: 's1', tabId: null }]);
    expect(run([server({ type: 'run.ended', run: runDto('r1', 's1', 9) })], c.state).effects).toEqual([{ kind: 'terminal.disconnect', tabId: 'r1' }]);
  });
  it('セッション画面を離れると、そのセッションの接続を切る', () => {
    // 見ていないセッションの PTY と tmux attach を残さない。
    const s = onSession('s1');
    expect(run([runtime({ type: 'hash.changed', route: { name: 'home' } })], s).effects).toEqual([{ kind: 'terminal.disconnectSession', sessionId: 's1' }]);
    expect(run([runtime({ type: 'hash.changed', route: { name: 'session', id: 's2' } })], s).effects).toEqual([
      { kind: 'terminal.disconnectSession', sessionId: 's1' },
      { kind: 'api.loadEvents', sessionId: 's2', fromSeq: 0 },
      { kind: 'terminal.connect', sessionId: 's2', tabId: null },
    ]);
    // 同じセッションに入り直すときは切らない。
    expect(run([runtime({ type: 'hash.changed', route: { name: 'session', id: 's1' } })], s).effects).toEqual([
      { kind: 'api.loadEvents', sessionId: 's1', fromSeq: 0 },
      { kind: 'terminal.connect', sessionId: 's1', tabId: null },
    ]);
  });
  it('見ていないセッションのタブが閉じても、そのセッションに繋ぎ直さない', () => {
    const chosen = run([intent({ type: 'tab.select', tabId: 't9' })], onSession('s2')).state;
    const away = run([runtime({ type: 'hash.changed', route: { name: 'session', id: 's1' } })], chosen).state;
    const r = run([server({ type: 'tab.upsert', tab: { ...tabDto('t9', 'r9', 5), sessionId: 's2' } })], away);
    expect(r.state.sessionView.s2?.selectedTab).toBeNull();
    expect(r.effects.filter((e) => String((e as { kind: string }).kind).startsWith('terminal.'))).toEqual([{ kind: 'terminal.disconnect', tabId: 't9' }]);
  });
  it('トランスクリプトの折りたたみ', () => {
    const a = run([intent({ type: 'transcript.toggle' })], onSession());
    expect(a.state.sessionView.s1?.transcriptOpen).toBe(false);
    expect(run([intent({ type: 'transcript.toggle' })], a.state).state.sessionView.s1?.transcriptOpen).toBe(true);
  });
});

describe('waiting のトースト', () => {
  const live = (id: string, status: 'busy' | 'waiting', name: string | null = null) => ({ sessionId: id, status, name, nameSource: null, cwd: '/x', pid: 1 });
  it('新たに waiting になったものだけ知らせ、戻れば忘れる', () => {
    const a = run([server({ type: 'live.update', live: [live('u1', 'waiting', 'alpha'), live('u2', 'busy')] })]);
    expect(a.effects).toEqual([{ kind: 'toast', level: 'info', message: '「alpha」があなたの入力を待っています' }]);
    expect(a.state.waitingSeen).toEqual(['u1']);
    const b = run([server({ type: 'live.update', live: [live('u1', 'waiting', 'alpha'), live('u2', 'waiting')] })], a.state);
    expect(b.effects).toEqual([{ kind: 'toast', level: 'info', message: '「u2」があなたの入力を待っています' }]);
    const c = run([server({ type: 'live.update', live: [live('u1', 'busy')] })], b.state);
    expect(c.effects).toEqual([]);
    expect(c.state.waitingSeen).toEqual([]);
    expect(run([server({ type: 'live.update', live: [live('u1', 'waiting', 'alpha')] })], c.state).effects).toHaveLength(1);
  });
});

describe('設定', () => {
  it('iTerm2 を選ぶと許可ダイアログの案内を出す', () => {
    const { effects } = run([intent({ type: 'settings.update', patch: { terminalApp: 'iterm' } })]);
    expect(effects).toEqual([{ kind: 'api.updateSettings', patch: { terminalApp: 'iterm' } }, { kind: 'toast', level: 'info', message: 'iTerm2 で開くとき、初回に macOS の自動化の許可ダイアログが出ます' }]);
  });
  it('terminalApp を含まない保存では案内を出さない', () => {
    const { effects } = run([intent({ type: 'settings.update', patch: { tmuxPath: '/opt/homebrew/bin/tmux' } })]);
    expect(effects).toEqual([{ kind: 'api.updateSettings', patch: { tmuxPath: '/opt/homebrew/bin/tmux' } }]);
  });
});

describe('昇格', () => {
  it('ダイアログを開き、送信して完了ダイアログに移る', () => {
    const a = run([intent({ type: 'session.promote.open', id: 's1' })]);
    expect(a.state.overlay).toEqual({ kind: 'promote', sessionId: 's1' });
    expect(a.effects).toEqual([{ kind: 'focus', target: 'promoteName' }]);
    const b = run([intent({ type: 'session.promote.submit', id: 's1', name: 'newp', gitInit: true, moveFiles: true })], a.state);
    expect(b.state.promote).toEqual({ kind: 'submitting' });
    expect(b.effects).toEqual([{ kind: 'api.promote', sessionId: 's1', name: 'newp', gitInit: true, moveFiles: true }]);
    const dup = run([intent({ type: 'session.promote.submit', id: 's1', name: 'newp', gitInit: true, moveFiles: true })], b.state);
    expect(dup.effects).toEqual([]);
    const c = run([runtime({ type: 'promote.done', projectId: 'p9', moved: true, reason: null })], b.state);
    expect(c.state.overlay).toEqual({ kind: 'promoted', projectId: 'p9', moved: true, reason: null });
    expect(c.state.promote).toEqual({ kind: 'idle' });
    const d = run([intent({ type: 'overlay.close' })], c.state);
    expect(d.state.overlay).toEqual({ kind: 'none' });
  });
  it('名前を検査し、失敗はダイアログに残す', () => {
    const open = run([intent({ type: 'session.promote.open', id: 's1' })]).state;
    const bad = run([intent({ type: 'session.promote.submit', id: 's1', name: 'a/b', gitInit: false, moveFiles: false })], open);
    expect(bad.state.promote).toEqual({ kind: 'failed', message: '名前に / は使えません' });
    expect(bad.effects).toEqual([]);
    const empty = run([intent({ type: 'session.promote.submit', id: 's1', name: '  ', gitInit: false, moveFiles: false })], open);
    expect(empty.state.promote).toEqual({ kind: 'failed', message: '名前を入力してください' });
    const sent = run([intent({ type: 'session.promote.submit', id: 's1', name: 'ok', gitInit: false, moveFiles: false })], open);
    const failed = run([runtime({ type: 'promote.failed', message: '同じ名前があります' })], sent.state);
    expect(failed.state.promote).toEqual({ kind: 'failed', message: '同じ名前があります' });
    expect(failed.state.overlay).toEqual({ kind: 'promote', sessionId: 's1' });
    expect(failed.effects).toEqual([{ kind: 'toast', level: 'error', message: '同じ名前があります' }]);
  });
});

describe('作業台の操作', () => {
  it('TODO とメモとアーティファクトと要約は api 効果になる', () => {
    const r = run([
      intent({ type: 'todo.add', projectId: 'p1', text: '買う' }),
      intent({ type: 'todo.toggle', id: 't1' }),
      intent({ type: 'todo.remove', id: 't1' }),
      intent({ type: 'memo.save', projectId: 'p1', markdown: '# m' }),
      intent({ type: 'session.setMemo', id: 's1', text: '一行' }),
      intent({ type: 'artifact.open', id: 'a1' }),
      intent({ type: 'artifact.openEditor', id: 'a1' }),
      intent({ type: 'artifact.add', projectId: 'p1', url: 'https://claude.ai/code/artifact/x' }),
      intent({ type: 'summary.regenerate', sessionId: 's1' }),
      intent({ type: 'summarizer.test' }),
    ]);
    expect(r.effects).toEqual([
      { kind: 'api.addTodo', projectId: 'p1', text: '買う' }, { kind: 'focus', target: 'todoInput' },
      { kind: 'api.toggleTodo', id: 't1' }, { kind: 'api.removeTodo', id: 't1' },
      { kind: 'api.saveMemo', projectId: 'p1', markdown: '# m' },
      { kind: 'api.setSessionMemo', sessionId: 's1', text: '一行' },
      { kind: 'api.openArtifact', id: 'a1' },
      { kind: 'api.openArtifactEditor', id: 'a1' },
      { kind: 'api.addArtifact', projectId: 'p1', url: 'https://claude.ai/code/artifact/x' },
      { kind: 'api.regenerateSummary', sessionId: 's1' },
      { kind: 'api.testSummarizer' },
    ]);
    expect(r.state).toEqual(initialState());
  });
  it('空の TODO と空の URL は何もしない', () => {
    const r = run([intent({ type: 'todo.add', projectId: 'p1', text: '   ' }), intent({ type: 'artifact.add', projectId: 'p1', url: ' ' })]);
    expect(r.effects).toEqual([]);
  });
  it('split.resize は中間層で処理済みなので無視する', () => {
    const r = run([intent({ type: 'split.resize', ratio: 0.3 })]);
    expect(r.effects).toEqual([]);
    expect(r.state).toEqual(initialState());
  });
  it('要約の失敗は画面に残し、次の pending で消える', () => {
    const a = run([server({ type: 'summary.failed', sessionId: 's1', message: 'LM Studio に繋がりません' })]);
    expect(a.state.summaryFailed).toEqual({ s1: 'LM Studio に繋がりません' });
    const b = run([server({ type: 'summary.pending', sessionId: 's1' })], a.state);
    expect(b.state.summaryFailed).toEqual({});
    const c = run([server({ type: 'summary.failed', sessionId: 's1', message: 'x' }), server({ type: 'summary.updated', sessionId: 's1' })]);
    expect(c.state.summaryFailed).toEqual({});
  });
});

describe('パレット', () => {
  const opened = () => run([intent({ type: 'palette.open' })]).state;
  it('コマンドを実行して閉じる', () => {
    const a = run([intent({ type: 'palette.run', command: { id: 'cmd:new-scratch', label: 'スクラッチで始める' } })], opened());
    expect(a.state.overlay).toEqual({ kind: 'newSession', projectId: null, scratch: true });
    expect(a.effects).toEqual([{ kind: 'focus', target: 'newSessionName' }]);
    const b = run([intent({ type: 'palette.run', command: { id: 'cmd:settings', label: '設定' } })], opened());
    expect(b.state.overlay).toEqual({ kind: 'none' });
    expect(b.effects).toEqual([{ kind: 'navigate', route: { name: 'settings' } }]);
    const c = run([intent({ type: 'palette.run', command: { id: 'cmd:rebuild-index', label: '索引を作り直す' } })], opened());
    expect(c.effects).toEqual([{ kind: 'api.rebuildIndex' }]);
    const d = run([intent({ type: 'palette.run', command: { id: 'project:p1', label: 'alpha' } })], opened());
    expect(d.effects).toEqual([{ kind: 'navigate', route: { name: 'project', id: 'p1' } }]);
    const e = run([intent({ type: 'palette.run', command: { id: 'session:s1', label: 'x' } })], opened());
    expect(e.effects).toEqual([{ kind: 'navigate', route: { name: 'session', id: 's1' } }]);
    const g = run([intent({ type: 'palette.run', command: { id: 'cmd:new-session', label: '新しいセッション' } })], opened());
    expect(g.state.overlay).toEqual({ kind: 'newSession', projectId: null, scratch: false });
    expect(g.effects).toEqual([{ kind: 'focus', target: 'newSessionName' }]);
    const f = run([intent({ type: 'palette.run', command: { id: 'nope', label: '' } })], opened());
    expect(f.state.overlay).toEqual({ kind: 'none' });
    expect(f.effects).toEqual([]);
  });
});

describe('分割', () => {
  // 左に left、右に right を置いた分割中のセッション画面を作る。
  const split = (left: string, right: string) => {
    let s = run([intent({ type: 'tab.select', tabId: left })], onSession('s1')).state;
    s = run([intent({ type: 'split.toggle' })], s).state;
    return run([runtime({ type: 'split.resolved', sessionId: 's1', tabId: right })], s).state;
  };
  it('開くときはランタイムに右のタブを決めさせ、閉じるときはその場で消す', () => {
    const on = onSession('s1');
    const a = run([intent({ type: 'split.toggle' })], on);
    expect(a.effects).toEqual([{ kind: 'split.resolve', sessionId: 's1' }]);
    expect(a.state.sessionView.s1?.split).toBeFalsy();
    const b = run([runtime({ type: 'split.resolved', sessionId: 's1', tabId: 't2' })], a.state);
    expect(b.state.sessionView.s1).toMatchObject({ split: true, splitTab: 't2' });
    expect(b.effects).toEqual([{ kind: 'storage.save', key: 'sv:s1', value: b.state.sessionView.s1 }]);
    const c = run([intent({ type: 'split.toggle' })], b.state);
    expect(c.state.sessionView.s1).toMatchObject({ split: false, splitTab: null });
    expect(c.effects).toEqual([{ kind: 'storage.save', key: 'sv:s1', value: c.state.sessionView.s1 }]);
  });
  it('タブが 1 つしか無ければトーストを出す', () => {
    const a = run([intent({ type: 'split.toggle' })], onSession('s1'));
    const b = run([runtime({ type: 'split.resolved', sessionId: 's1', tabId: null })], a.state);
    expect(b.state.sessionView.s1?.split).toBeFalsy();
    expect(b.effects).toEqual([{ kind: 'toast', level: 'info', message: '分割にはタブが 2 つ必要です' }]);
  });
  it('分割中に右のタブを選ぶと左右が入れ替わる', () => {
    const r = run([intent({ type: 'tab.select', tabId: 't2' })], split('t1', 't2'));
    expect(r.state.sessionView.s1).toMatchObject({ selectedTab: 't2', splitTab: 't1' });
  });
  it('右のタブが閉じたら分割を畳む', () => {
    const s = split('t1', 't2');
    const a = run([server({ type: 'tab.upsert', tab: { ...tabDto('t2', 'r1', 5), sessionId: 's1' } })], s);
    expect(a.state.sessionView.s1).toMatchObject({ selectedTab: 't1', split: false, splitTab: null });
    expect(a.effects).toEqual([{ kind: 'storage.save', key: 'sv:s1', value: a.state.sessionView.s1 }, { kind: 'terminal.disconnect', tabId: 't2' }]);
  });
  it('tab.close で右のタブを閉じても分割を畳む', () => {
    const s = split('t1', 't2');
    const a = run([intent({ type: 'tab.close', tabId: 't2' })], s);
    expect(a.state.sessionView.s1).toMatchObject({ selectedTab: 't1', split: false, splitTab: null });
    expect(a.effects).toEqual([{ kind: 'storage.save', key: 'sv:s1', value: a.state.sessionView.s1 }, { kind: 'api.closeTab', tabId: 't2' }]);
  });
  it('左のタブが閉じても右は残す', () => {
    const s = split('t1', 't2');
    const a = run([intent({ type: 'tab.close', tabId: 't1' })], s);
    expect(a.state.sessionView.s1).toMatchObject({ selectedTab: null, split: true, splitTab: 't2' });
  });
  it('セッション画面にいないときの split.toggle は何もしない', () => {
    const r = run([intent({ type: 'split.toggle' })]);
    expect(r.effects).toEqual([]);
  });
});

describe('画面に入るときの読み込み', () => {
  it('プロジェクト画面はメモを、設定画面は付属の値を読む', () => {
    const p = run([runtime({ type: 'hash.changed', route: { name: 'project', id: 'p1' } })]);
    expect(p.effects).toEqual([{ kind: 'api.loadMemo', projectId: 'p1' }]);
    const s = run([runtime({ type: 'hash.changed', route: { name: 'settings' } })]);
    expect(s.effects).toEqual([{ kind: 'api.loadSettingsExtras' }]);
  });
});
