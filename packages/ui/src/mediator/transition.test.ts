import { describe, expect, expectTypeOf, it } from 'vitest';
import type { SyncStatusBody } from '@agent-hangar/shared';
import type { Input, Overlay, SessionViewState } from './types.ts';
import { initialState, transition, type State } from './transition.ts';
import { defaultSessionView, persistedSessionView } from './sessionView.ts';
import { periodStart, toSearchParams } from './screen.ts';
import { liveStep } from './live.ts';
import { readDraft } from './launch.ts';

function run(inputs: Input[], start: State = initialState()) {
  const effects: unknown[] = [];
  let state = start;
  for (const i of inputs) { const r = transition(state, i); state = r.state; effects.push(...r.effects); }
  return { state, effects };
}
const intent = (i: Extract<Input, { kind: 'intent' }>['intent']): Input => ({ kind: 'intent', intent: i });
const server = (e: Extract<Input, { kind: 'server' }>['event']): Input => ({ kind: 'server', event: e });
const runtime = (e: Extract<Input, { kind: 'runtime' }>['event']): Input => ({ kind: 'runtime', event: e });
const T0 = 1_700_000_000_000;

describe('起動と接続', () => {
  it('ws が開いたら bootstrap を取り、hash で画面が決まる', () => {
    const { state, effects } = run([runtime({ type: 'ws.open' }), runtime({ type: 'hash.changed', route: { name: 'projects' } })]);
    expect(state.connection).toBe('connected');
    expect(state.screen).toEqual({ name: 'projects' });
    expect(effects).toEqual([{ kind: 'api.bootstrap' }]);
  });
  it('切断で指数バックオフ、再接続で bootstrap を取り直す', () => {
    const a = run([runtime({ type: 'ws.open' }), runtime({ type: 'ws.close', at: T0 })]);
    expect(a.state.connection).toBe('disconnected');
    expect(a.effects.at(-1)).toEqual({ kind: 'ws.reconnectAfter', ms: 2000 });
    const b = run([runtime({ type: 'ws.close', at: T0 + 2000 })], a.state);
    expect(b.effects.at(-1)).toEqual({ kind: 'ws.reconnectAfter', ms: 4000 });
    const c = run([runtime({ type: 'ws.open' })], b.state);
    expect(c.state).toMatchObject({ connection: 'connected', reconnectAttempt: 0 });
    expect(c.effects.at(0)).toEqual({ kind: 'api.bootstrap' });
  });
  it('バックオフは 15 秒で頭打ち', () => {
    let s = initialState();
    for (let i = 0; i < 8; i++) s = transition(s, runtime({ type: 'ws.close', at: T0 })).state;
    expect(transition(s, runtime({ type: 'ws.close', at: T0 })).effects).toEqual([{ kind: 'ws.reconnectAfter', ms: 15000 }]);
  });
  it('切れている間は、画面が古くなった時刻と次に試す時刻を持つ', () => {
    const a = run([runtime({ type: 'ws.open' }), runtime({ type: 'ws.close', at: T0 })]);
    expect(a.state).toMatchObject({ staleSince: T0, nextRetryAt: T0 + 2000 });
    // 再接続に失敗しても、画面が古くなった時刻は巻き戻さない。古さは切れた最初の瞬間から数える。
    const b = run([runtime({ type: 'ws.close', at: T0 + 2000 })], a.state);
    expect(b.state).toMatchObject({ staleSince: T0, nextRetryAt: T0 + 6000 });
    const c = run([runtime({ type: 'ws.open' })], b.state);
    expect(c.state).toMatchObject({ staleSince: null, nextRetryAt: null });
  });
  it('つなぎ直したときだけ、追いついたと知らせる', () => {
    const back = run([runtime({ type: 'ws.close', at: T0 }), runtime({ type: 'ws.open' })]);
    expect(back.effects).toEqual([{ kind: 'ws.reconnectAfter', ms: 2000 }, { kind: 'api.bootstrap' }, { kind: 'toast', level: 'info', message: '最新の状態に追いつきました' }]);
    // 最初の接続は「追いついた」ではないので黙る。
    expect(run([runtime({ type: 'ws.open' })]).effects).toEqual([{ kind: 'api.bootstrap' }]);
  });
  it('今すぐ再接続はその場で ws をつなぎ直す', () => {
    expect(run([intent({ type: 'conn.retry' })]).effects).toEqual([{ kind: 'ws.connect' }]);
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
    // 検索したらフォーカスを結果の一覧へ移す。同じ語で検索し直して画面が作り直されないときも移るように、毎回出す。
    expect(a.effects).toEqual([{ kind: 'navigate', route: { name: 'sessions', q: '動画' } }, { kind: 'focus', target: 'results' }]);
    const b = run([runtime({ type: 'hash.changed', route: { name: 'sessions', q: '動画' } })], a.state);
    expect(b.effects).toEqual([{ kind: 'api.search', params: { q: '動画', hideArchived: true, limit: 50 } }]);
    const c = run([intent({ type: 'search.filter', patch: { projectId: 'p1' } })], b.state);
    expect(c.state.search.filter).toEqual({ projectId: 'p1' });
    expect(c.effects).toEqual([{ kind: 'api.search', params: { q: '動画', projectId: 'p1', hideArchived: true, limit: 50 } }]);
    expect(run([intent({ type: 'search.query', text: '' })]).effects).toEqual([{ kind: 'navigate', route: { name: 'sessions' } }, { kind: 'focus', target: 'results' }]);
  });
  // 期間は日数のまま効果に載せ、時刻に直すのは問い合わせる瞬間（Runtime）に任せる。
  it('期間は日数のまま検索効果に載る', () => {
    const a = run([runtime({ type: 'hash.changed', route: { name: 'sessions', q: '動画' } })]);
    const b = run([intent({ type: 'search.filter', patch: { days: 7 } })], a.state);
    expect(b.state.search.filter).toEqual({ days: 7 });
    expect(b.effects).toEqual([{ kind: 'api.search', params: { q: '動画', days: 7, hideArchived: true, limit: 50 } }]);
  });
  it('期間の始まりは、今日の 0 時から数えて日数分さかのぼった 0 時', () => {
    const now = new Date(2026, 9, 1, 15, 30).getTime();
    expect(periodStart(1, now)).toBe(new Date(2026, 9, 1).getTime());
    expect(periodStart(7, now)).toBe(new Date(2026, 8, 25).getTime());
    expect(periodStart(30, now)).toBe(new Date(2026, 8, 2).getTime());
    expect(toSearchParams({ q: 'x', days: 1, projectId: 'p1' }, now)).toEqual({ q: 'x', projectId: 'p1', since: new Date(2026, 9, 1).getTime() });
    expect(toSearchParams({ q: 'x' }, now)).toEqual({ q: 'x' });
  });
  // 「条件をクリア」は語と絞り込みをまとめて外し、手元の全件の一覧へ戻す。語は URL にも乗っているので、URL からも外す。
  it('search.clear は語と絞り込みを外し、語の無い一覧の URL へ移る', () => {
    const a = run([runtime({ type: 'hash.changed', route: { name: 'sessions', q: '動画' } }), intent({ type: 'search.filter', patch: { projectId: 'p1', days: 7, file: 'a.md' } })]);
    const b = run([intent({ type: 'search.clear' })], a.state);
    expect(b.state.search).toEqual({ text: '', filter: {}, page: 1 });
    expect(b.effects).toEqual([{ kind: 'navigate', route: { name: 'sessions' } }]);
    // 着いた先では手元の一覧を組むので、問い合わせない。
    expect(run([runtime({ type: 'hash.changed', route: { name: 'sessions' } })], b.state).effects).toEqual([]);
  });
  it('状態の絞り込みは live としてサーバへ渡す', () => {
    const a = run([runtime({ type: 'hash.changed', route: { name: 'sessions', q: '動画' } }), intent({ type: 'search.filter', patch: { live: 'waiting' } })]);
    expect(a.effects).toContainEqual({ kind: 'api.search', params: { q: '動画', live: 'waiting', hideArchived: true, limit: 50 } });
  });
  // 触ったファイルは手元のセッションに無い情報なので、キーワードが無くてもサーバに問い合わせる。
  it('キーワードが無くても、触ったファイルがあれば検索効果になる', () => {
    const a = run([runtime({ type: 'hash.changed', route: { name: 'sessions' } })]);
    expect(a.effects).toEqual([]);
    const b = run([intent({ type: 'search.filter', patch: { file: 'a.md' } })], a.state);
    expect(b.effects).toEqual([{ kind: 'api.search', params: { q: '', file: 'a.md', hideArchived: true, limit: 50 } }]);
    // ほかの画面から戻ってきたときも、同じ絞り込みで問い合わせ直す。
    const c = run([runtime({ type: 'hash.changed', route: { name: 'home' } }), runtime({ type: 'hash.changed', route: { name: 'sessions' } })], b.state);
    expect(c.effects).toEqual([{ kind: 'api.search', params: { q: '', file: 'a.md', hideArchived: true, limit: 50 } }]);
    // ファイルを外せば手元の一覧に戻るので、問い合わせない。
    expect(run([intent({ type: 'search.filter', patch: { file: undefined } })], b.state).effects).toEqual([]);
    // ほかの絞り込みだけなら、これまでどおり手元で絞る。
    expect(run([intent({ type: 'search.filter', patch: { projectId: 'p1' } })], a.state).effects).toEqual([]);
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
  // 「あとで」を選んだプロジェクトは、同じ起動の間は聞き直さない。
  // 覚えるのは Mediator の状態だけなので、サーバを立て直せばまた聞く。
  it('あとでを選んだプロジェクトは、次の bootstrap でも聞き直さない', () => {
    const a = run([server({ type: 'project.unresolved', projectId: 'p1' }), server({ type: 'project.unresolved', projectId: 'p2' })]);
    const b = run([intent({ type: 'overlay.close' })], a.state);
    expect(b.state.overlay).toEqual({ kind: 'resolveProject', projectId: 'p2' });
    const c = run([intent({ type: 'overlay.close' })], b.state);
    expect(c.state.overlay).toEqual({ kind: 'none' });
    const again = run([server({ type: 'project.unresolved', projectId: 'p1' }), server({ type: 'project.unresolved', projectId: 'p2' })], c.state);
    expect(again.state.overlay).toEqual({ kind: 'none' });
    expect(again.state.unresolvedQueue).toEqual([]);
  });
  // 利用者が自分で解決しにいったときは、あとでを選んだ後でも開き、そこで覚えを忘れる。
  // 開き直したうえでまたあとでを選んだら、覚え直して次の通知では出さない。
  it('project.resolve.open は覚えを忘れ、あとでで閉じれば覚え直す', () => {
    const later = run([server({ type: 'project.unresolved', projectId: 'p1' }), intent({ type: 'overlay.close' })]).state;
    expect(later.resolveDeferred).toEqual(['p1']);
    const a = run([intent({ type: 'project.resolve.open', id: 'p1' })], later);
    expect(a.state.overlay).toEqual({ kind: 'resolveProject', projectId: 'p1' });
    expect(a.state.resolveDeferred).toEqual([]);
    const b = run([intent({ type: 'overlay.close' })], a.state);
    expect(b.state.overlay).toEqual({ kind: 'none' });
    expect(b.state.resolveDeferred).toEqual(['p1']);
    expect(run([server({ type: 'project.unresolved', projectId: 'p1' })], b.state).state.overlay).toEqual({ kind: 'none' });
  });
  // 解決してしまえば覚えは要らない。次に同じ id が未解決になったら、また聞く。
  it('project.resolve で決めたら覚えを持ち越さない', () => {
    const later = run([server({ type: 'project.unresolved', projectId: 'p1' }), intent({ type: 'overlay.close' })]).state;
    const a = run([intent({ type: 'project.resolve.open', id: 'p1' }), intent({ type: 'project.resolve', id: 'p1', action: { kind: 'archive' } })], later);
    expect(a.state.resolveDeferred).toEqual([]);
    expect(run([server({ type: 'project.unresolved', projectId: 'p1' })], a.state).state.overlay).toEqual({ kind: 'resolveProject', projectId: 'p1' });
  });
});

describe('ダイアログを開いている間の開く操作', () => {
  const opens = [intent({ type: 'palette.open' }), intent({ type: 'shortcuts.open' }), intent({ type: 'session.new.open', scratch: true })];
  const holding: [string, State][] = [
    ['未解決のプロジェクト', run([server({ type: 'project.unresolved', projectId: 'p1' })]).state],
    ['停止の確認', run([intent({ type: 'session.kill', runId: 'r1', working: true, shellTabs: 0 })]).state],
    ['書き込み中の保持期間', run([intent({ type: 'retention.edit', days: 365, from: 'banner' }), intent({ type: 'retention.write' })]).state],
    ['送信中の新しいセッション', run([intent({ type: 'session.new.open', projectId: 'p1' }), intent({ type: 'session.new.submit', params: { projectId: 'p1' } })]).state],
    ['昇格', run([intent({ type: 'session.promote.open', id: 's1' })]).state],
  ];
  // どの経路から来ても（キーでもボタンでも）、決めるまで閉じないダイアログや入力のあるダイアログを黙って差し替えない。
  it.each(holding)('%s の上では、パレットもキーの一覧も新しいセッションも開かない', (_name, before) => {
    expect(before.overlay.kind).not.toBe('none');
    for (const i of opens) {
      const r = run([i], before);
      expect(r.state).toEqual(before);
      expect(r.effects).toEqual([]);
    }
  });
  it('何も開いていなければ開き、パレットからは切り替えられる', () => {
    expect(run([opens[0]!]).state.overlay).toEqual({ kind: 'palette' });
    const palette = run([intent({ type: 'palette.open' })]).state;
    expect(run([intent({ type: 'shortcuts.open' })], palette).state.overlay).toEqual({ kind: 'shortcuts' });
    expect(run([intent({ type: 'session.new.open', scratch: true })], palette).state.overlay).toEqual({ kind: 'newSession', projectId: null, scratch: true });
    expect(run([intent({ type: 'palette.open' })], palette).state.overlay).toEqual({ kind: 'palette' });
  });
  // 読むだけのダイアログ（キーの一覧、昇格の完了）は、差し替えても失うものが無い。
  // 昇格の完了には「ここで新しいセッションを始める」のボタンもある。
  it('読むだけのダイアログからは切り替えられる', () => {
    const keys = run([intent({ type: 'shortcuts.open' })]).state;
    expect(run([intent({ type: 'palette.open' })], keys).state.overlay).toEqual({ kind: 'palette' });
    const promoted = { ...initialState(), overlay: { kind: 'promoted' as const, projectId: 'p1', moved: true, reason: null } };
    expect(run([intent({ type: 'session.new.open', projectId: 'p1' })], promoted).state.overlay).toEqual({ kind: 'newSession', projectId: 'p1', scratch: false });
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
    const { state, effects } = run([intent({ type: 'transcript.showThinking', sessionId: 's1', show: true }), intent({ type: 'transcript.showRaw', sessionId: 's1', show: true })]);
    expect(state.sessionView.s1).toMatchObject({ showThinking: true, showRaw: true, follow: true });
    expect(effects[0]).toMatchObject({ kind: 'storage.save', key: 'sv:s1' });
  });
  it('本文の追記は開いているセッションだけ読み直す', () => {
    const open = run([runtime({ type: 'hash.changed', route: { name: 'session', id: 's1' } })]).state;
    // -2 は追記の取り込み。末尾に足すだけで、過去へ遡らない。
    expect(run([server({ type: 'transcript.appended', sessionId: 's1', count: 2 })], open).effects).toEqual([{ kind: 'api.loadEvents', sessionId: 's1', fromSeq: -2 }]);
    expect(run([server({ type: 'transcript.appended', sessionId: 's2', count: 2 })], open).effects).toEqual([]);
  });
  it('loadMore は過去へ遡るページを要求する', () => {
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
});

const runDto = (id: string, sessionId: string, endedAt: number | null = null) => ({ id, sessionId, deviceId: 'd', kind: 'start' as const, tmuxName: `hangar-${id}`, pid: null, startedAt: 1, endedAt, endReason: null, heartbeatAt: 1 });
const tabDto = (id: string, runId: string, closedAt: number | null = null) => ({ id, runId, sessionId: 's1', kind: 'shell' as const, title: 'シェル 1', tmuxName: `hangar-${runId}-t1`, createdAt: 2, closedAt });
const onSession = (id = 's1') => run([runtime({ type: 'hash.changed', route: { name: 'session', id } })]).state;

describe('起動', () => {
  it('ダイアログを開き、送信で submitting になり、done で画面へ移る', () => {
    const a = run([intent({ type: 'session.new.open', projectId: 'p1' })]);
    expect(a.state.overlay).toEqual({ kind: 'newSession', projectId: 'p1', scratch: false });
    expect(a.effects).toEqual([{ kind: 'focus', target: 'newSessionName' }, { kind: 'api.workspaceDirs' }]);
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
    expect(s.effects).toEqual([{ kind: 'focus', target: 'newSessionName' }, { kind: 'api.workspaceDirs' }]);
    // スクラッチはプロジェクトが無くても送信できる。
    expect(run([intent({ type: 'session.new.submit', params: { scratch: true } })]).effects).toEqual([{ kind: 'api.launch', params: { scratch: true } }]);
  });
  it('再開、フォーク、停止、外部で開くは API 効果', () => {
    const { state, effects } = run([intent({ type: 'session.resume', id: 's1' }), intent({ type: 'session.fork', id: 's1' }), intent({ type: 'session.kill', runId: 'r1', working: false, shellTabs: 0 }), intent({ type: 'session.openTerminalApp', runId: 'r1', tabId: 't1' }), intent({ type: 'session.openTerminalApp', runId: 'r1' }), intent({ type: 'session.openEditor', sessionId: 's1' }), intent({ type: 'project.openEditor', id: 'p1' }), intent({ type: 'project.openTerminalApp', id: 'p1' })]);
    expect(effects).toEqual([
      { kind: 'api.resume', sessionId: 's1' }, { kind: 'api.fork', sessionId: 's1' }, { kind: 'api.killRun', runId: 'r1' },
      { kind: 'api.openTerminalApp', runId: 'r1', tabId: 't1' }, { kind: 'api.openTerminalApp', runId: 'r1', tabId: null },
      { kind: 'api.openEditor', sessionId: 's1' }, { kind: 'api.projectOpenEditor', projectId: 'p1' }, { kind: 'api.projectOpenTerminal', projectId: 'p1' },
    ]);
    expect(state.launch).toEqual({ kind: 'submitting' });
  });
  it('変更したファイルを押すと、そのファイルを VS Code で開く', () => {
    expect(run([intent({ type: 'session.openFile', sessionId: 's1', path: '/w/a.ts' })]).effects).toEqual([{ kind: 'api.openEditor', sessionId: 's1', file: '/w/a.ts' }]);
  });
});

describe('新しいセッションの下書きと前回値', () => {
  it('名前か初期プロンプトの書きかけを下書きとして持ち、端末に残す。両方空なら消す', () => {
    const a = run([intent({ type: 'session.new.draft', name: 'API の節', prompt: '' })]);
    expect(a.state.newSessionDraft).toEqual({ name: 'API の節', prompt: '', attachments: [] });
    expect(a.effects).toEqual([{ kind: 'storage.save', key: 'newSession.draft', value: { name: 'API の節', prompt: '', attachments: [] } }]);
    // 同じ中身なら書き直さない。
    expect(run([intent({ type: 'session.new.draft', name: 'API の節', prompt: '' })], a.state).effects).toEqual([]);
    const b = run([intent({ type: 'session.new.draft', name: ' ', prompt: '\n' })], a.state);
    expect(b.state.newSessionDraft).toBeNull();
    expect(b.effects).toEqual([{ kind: 'storage.save', key: 'newSession.draft', value: null }]);
  });
  it('下書きは添付も覚える。名前も本文も空でも、添付があれば残す', () => {
    const a = { path: '/h/drops/1-0-a.png', name: 'a.png', size: 3 };
    const r = run([intent({ type: 'session.new.draft', name: '', prompt: '', attachments: [a] })]);
    expect(r.state.newSessionDraft).toEqual({ name: '', prompt: '', attachments: [a] });
    expect(r.effects).toContainEqual({ kind: 'storage.save', key: 'newSession.draft', value: { name: '', prompt: '', attachments: [a] } });
  });
  it('添付を付けない下書きの Intent は、添付なしとして扱う', () => {
    const r = run([intent({ type: 'session.new.draft', name: 'n', prompt: '' })]);
    expect(r.state.newSessionDraft).toEqual({ name: 'n', prompt: '', attachments: [] });
  });
  it('readDraft は、古い形（添付なし）を空の添付として読み、形の違う添付は捨てる', () => {
    expect(readDraft({ name: 'n', prompt: 'p' })).toEqual({ name: 'n', prompt: 'p', attachments: [] });
    expect(readDraft({ name: 'n', prompt: 'p', attachments: [{ path: '/a', name: 'a', size: null }, { path: 1 }, 'x', { path: '/b', name: 'b', size: 2 }] })).toEqual({ name: 'n', prompt: 'p', attachments: [{ path: '/a', name: 'a', size: null }, { path: '/b', name: 'b', size: 2 }] });
    // 空のパスは捨て、同じパスは 1 件にする（手で書き換えられた保存値が、札の key の重複にならないように）。
    expect(readDraft({ name: 'n', prompt: 'p', attachments: [{ path: '', name: 'e', size: null }, { path: '/a', name: 'a', size: 1 }, { path: '/a', name: 'a2', size: 2 }] })).toEqual({ name: 'n', prompt: 'p', attachments: [{ path: '/a', name: 'a', size: 1 }] });
  });
  // 閉じた後に終わった送信は、いまの下書きへ添付だけを足す。閉じる前の名前と本文で下書きを置き換えると、開き直したダイアログの書きかけを上書きする。
  describe('session.new.draft.attach', () => {
    const a = { path: '/h/drops/1-0-a.png', name: 'a.png', size: 3 };
    const b = { path: '/h/drops/1-1-b.png', name: 'b.png', size: 4 };
    it('いまの下書きの名前と本文は残し、添付だけを足して端末に残す', () => {
      const start = run([intent({ type: 'session.new.draft', name: '開き直して書いた名前', prompt: '新しい本文', attachments: [a] })]);
      const r = run([intent({ type: 'session.new.draft.attach', attachments: [b] })], start.state);
      expect(r.state.newSessionDraft).toEqual({ name: '開き直して書いた名前', prompt: '新しい本文', attachments: [a, b] });
      expect(r.effects).toEqual([{ kind: 'storage.save', key: 'newSession.draft', value: { name: '開き直して書いた名前', prompt: '新しい本文', attachments: [a, b] } }]);
    });
    it('下書きが無ければ、名前と本文が空の下書きを作る', () => {
      const r = run([intent({ type: 'session.new.draft.attach', attachments: [a] })]);
      expect(r.state.newSessionDraft).toEqual({ name: '', prompt: '', attachments: [a] });
      expect(r.effects).toEqual([{ kind: 'storage.save', key: 'newSession.draft', value: { name: '', prompt: '', attachments: [a] } }]);
    });
    it('同じパスはもう一度足さない。足すものが無ければ書き直さない', () => {
      const start = run([intent({ type: 'session.new.draft', name: 'n', prompt: '', attachments: [a] })]);
      const r = run([intent({ type: 'session.new.draft.attach', attachments: [{ ...a, name: '別名.png' }] })], start.state);
      expect(r.state.newSessionDraft).toEqual({ name: 'n', prompt: '', attachments: [a] });
      expect(r.effects).toEqual([]);
    });
  });
  it('ダイアログから起動し終えたら下書きを消す', () => {
    const a = run([intent({ type: 'session.new.open', projectId: 'p1' }), intent({ type: 'session.new.draft', name: 'n', prompt: 'やって' }), intent({ type: 'session.new.submit', params: { projectId: 'p1', name: 'n', prompt: 'やって' } })]);
    expect(a.state.newSessionDraft).toEqual({ name: 'n', prompt: 'やって', attachments: [] });
    const b = run([runtime({ type: 'launch.done', sessionId: 's9', runId: 'r9' })], a.state);
    expect(b.state.newSessionDraft).toBeNull();
    expect(b.effects).toContainEqual({ kind: 'storage.save', key: 'newSession.draft', value: null });
    // 再開やフォークの完了では、書きかけの下書きに触れない。
    const c = run([intent({ type: 'session.new.draft', name: 'n', prompt: '' }), intent({ type: 'session.resume', id: 's1' }), runtime({ type: 'launch.done', sessionId: 's1', runId: 'r1' })]);
    expect(c.state.newSessionDraft).toEqual({ name: 'n', prompt: '', attachments: [] });
  });
  // 送った後に Esc で閉じても起動は止まらない。起動し終えたら、送った下書きは役目を終えている。
  it('送信中に閉じても、ダイアログから送った起動が終われば下書きを消す', () => {
    const a = run([intent({ type: 'session.new.open', projectId: 'p1' }), intent({ type: 'session.new.draft', name: 'n', prompt: 'やって' }), intent({ type: 'session.new.submit', params: { projectId: 'p1', name: 'n', prompt: 'やって' } }), intent({ type: 'overlay.close' })]);
    expect(a.state.overlay).toEqual({ kind: 'none' });
    expect(a.state.newSessionDraft).toEqual({ name: 'n', prompt: 'やって', attachments: [] });
    const b = run([runtime({ type: 'launch.done', sessionId: 's9', runId: 'r9' })], a.state);
    expect(b.state.newSessionDraft).toBeNull();
    expect(b.effects).toContainEqual({ kind: 'storage.save', key: 'newSession.draft', value: null });
    expect(b.effects).toContainEqual({ kind: 'navigate', route: { name: 'session', id: 's9' } });
    // 一度消したら印も外す。次の再開の完了では、新しく書いた下書きに触れない。
    const c = run([intent({ type: 'session.new.draft', name: '次', prompt: '' }), intent({ type: 'session.resume', id: 's1' }), runtime({ type: 'launch.done', sessionId: 's1', runId: 'r1' })], b.state);
    expect(c.state.newSessionDraft).toEqual({ name: '次', prompt: '', attachments: [] });
  });
  it('ダイアログから送った起動に失敗したら、閉じていても下書きを残し、印を外す', () => {
    const a = run([intent({ type: 'session.new.open', projectId: 'p1' }), intent({ type: 'session.new.draft', name: 'n', prompt: '' }), intent({ type: 'session.new.submit', params: { projectId: 'p1', name: 'n' } }), intent({ type: 'overlay.close' }), runtime({ type: 'launch.failed', message: 'x' })]);
    expect(a.state.newSessionDraft).toEqual({ name: 'n', prompt: '', attachments: [] });
    const b = run([intent({ type: 'session.resume', id: 's1' }), runtime({ type: 'launch.done', sessionId: 's1', runId: 'r1' })], a.state);
    expect(b.state.newSessionDraft).toEqual({ name: 'n', prompt: '', attachments: [] });
  });
  it('起動した詳細をプロジェクトごとの前回値として持ち、端末に残す', () => {
    const a = run([intent({ type: 'session.new.submit', params: { projectId: 'p1', name: 'n', model: 'opus', effort: 'high', permissionMode: 'acceptEdits', worktree: 'wt', addDirs: ['/a'] } })]);
    // worktree は前回値に残さない。同じ名前が毎回入ると、前の worktree の中で起動してしまうからである。
    const prefs = { p1: { model: 'opus', effort: 'high', permissionMode: 'acceptEdits', addDirs: ['/a'] } };
    expect(a.state.launchPrefs).toEqual(prefs);
    expect(a.effects).toContainEqual({ kind: 'storage.save', key: 'newSession.prefs', value: prefs });
    // スクラッチはプロジェクトを持たないので、スクラッチの 1 枠に持つ。
    const b = run([runtime({ type: 'launch.failed', message: 'x' }), intent({ type: 'session.new.submit', params: { scratch: true, effort: 'low' } })], a.state);
    expect(b.state.launchPrefs).toEqual({ ...prefs, ':scratch': { effort: 'low' } });
  });
  it('既定のまま起動したら、そのプロジェクトの前回値を消す。変わらなければ書き直さない', () => {
    const start = { ...initialState(), launchPrefs: { p1: { model: 'opus' } } };
    const a = run([intent({ type: 'session.new.submit', params: { projectId: 'p1', name: 'n' } })], start);
    expect(a.state.launchPrefs).toEqual({});
    expect(a.effects).toContainEqual({ kind: 'storage.save', key: 'newSession.prefs', value: {} });
    const b = run([intent({ type: 'session.new.submit', params: { projectId: 'p1', model: 'opus' } })], start);
    expect(b.effects).toEqual([{ kind: 'api.launch', params: { projectId: 'p1', model: 'opus' } }]);
  });
  it('プロジェクトを選ばずに送った失敗では前回値を残さない', () => {
    const a = run([intent({ type: 'session.new.submit', params: { model: 'opus' } })]);
    expect(a.state.launchPrefs).toEqual({});
    expect(a.effects).toEqual([]);
  });
});

describe('タブと接続', () => {
  it('タブの選択と追加と閉じる', () => {
    const s = onSession();
    const a = run([intent({ type: 'tab.select', tabId: 't1' })], s);
    expect(a.state.sessionView.s1?.selectedTab).toBe('t1');
    expect(a.effects).toEqual([{ kind: 'storage.save', key: 'sv:s1', value: persistedSessionView(a.state.sessionView.s1!) }, { kind: 'terminal.connect', sessionId: 's1', tabId: 't1' }, { kind: 'focus', target: 'terminal' }]);
    expect(run([intent({ type: 'tab.open', sessionId: 's1', kind: 'shell' })], s).effects).toEqual([{ kind: 'api.openTab', sessionId: 's1' }]);
    const b = run([intent({ type: 'tab.close', tabId: 't1' })], a.state);
    expect(b.state.sessionView.s1?.selectedTab).toBeNull();
    expect(b.effects.at(-1)).toEqual({ kind: 'api.closeTab', tabId: 't1' });
    expect(run([intent({ type: 'tab.select', tabId: 't1' })]).effects).toEqual([]);   // セッション画面の外では無視
  });
  it('run の開始と終了、タブの出現と消失', () => {
    const s = onSession();
    const a = run([server({ type: 'run.started', run: runDto('r1', 's1'), tabs: [] })], s);
    expect(a.effects).toEqual([{ kind: 'storage.save', key: 'sv:s1', value: persistedSessionView(a.state.sessionView.s1!) }, { kind: 'terminal.connect', sessionId: 's1', tabId: 'r1' }]);
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
  it('右ペインの上下の比率は、離したときに丸めて、そのセッションの値と最後に動かした値の両方に保存する', () => {
    expect(initialState().livePaneSplit).toBe(0.5);
    const a = run([intent({ type: 'livePane.split', sessionId: 's1', ratio: 0.3 })]);
    expect(a.state.livePaneSplit).toBe(0.3);
    expect(a.state.sessionView.s1?.livePaneSplit).toBe(0.3);
    expect(a.effects).toEqual([
      { kind: 'storage.save', key: 'livePane.split', value: 0.3 },
      { kind: 'storage.save', key: 'sv:s1', value: expect.objectContaining({ livePaneSplit: 0.3 }) },
    ]);
    // 端まで寄せられる。どちらの端でも、見出しの 1 行は CSS の下限で残る。
    const at = (ratio: number) => run([intent({ type: 'livePane.split', sessionId: 's1', ratio })]).state.sessionView.s1?.livePaneSplit;
    expect(at(0.99)).toBe(0.99);
    expect(at(-1)).toBe(0);
    expect(at(2)).toBe(1);
    expect(at(Number.NaN)).toBe(0.5);
  });
  it('右ペインの比率はセッションごとに持ち、ほかのセッションの値は変えない', () => {
    const a = run([intent({ type: 'livePane.split', sessionId: 's1', ratio: 0.3 })]);
    const b = run([intent({ type: 'livePane.split', sessionId: 's2', ratio: 0.7 })], a.state);
    expect(b.state.sessionView.s1?.livePaneSplit).toBe(0.3);
    expect(b.state.sessionView.s2?.livePaneSplit).toBe(0.7);
    expect(b.state.livePaneSplit).toBe(0.7);
    // まだ動かしていないセッションは自分の値を持たない（画面は最後に動かした値で開く）。
    expect(defaultSessionView().livePaneSplit).toBeNull();
  });
  it('サイドバーの折りたたみは開閉のたびに保存する', () => {
    expect(initialState().sidebarCollapsed).toBe(false);
    const a = run([intent({ type: 'sidebar.toggle' })]);
    expect(a.state.sidebarCollapsed).toBe(true);
    expect(a.effects).toEqual([{ kind: 'storage.save', key: 'sidebar.collapsed', value: true }]);
    const b = run([intent({ type: 'sidebar.toggle' })], a.state);
    expect(b.state.sidebarCollapsed).toBe(false);
    expect(b.effects).toEqual([{ kind: 'storage.save', key: 'sidebar.collapsed', value: false }]);
  });
  it('目次でターンを開くと、左の Claude のタブへ戻してからその指示へ跳ばす', () => {
    // シェルのタブを出していた。跳ぶ先は Claude のタブなので、そちらへ戻す。
    const start = run([intent({ type: 'tab.select', tabId: 't1' })], onSession()).state;
    const jump = { heads: ['a', 'b'], index: 0, from: 'bottom' as const };
    const a = run([intent({ type: 'turn.open', sessionId: 's1', seq: 7, runId: 'r1', jump })], start);
    expect(a.state.sessionView.s1).toMatchObject({ openTurn: 7, turnJump: { seq: 7, status: 'pending', runId: 'r1' }, selectedTab: null });
    expect(a.effects).toContainEqual({ kind: 'terminal.connect', sessionId: 's1', tabId: null });
    expect(a.effects).toContainEqual({ kind: 'api.jumpToPrompt', sessionId: 's1', runId: 'r1', seq: 7, ...jump });
    // 結果が届いたら、そのターンの注記に使う。
    const b = run([runtime({ type: 'turnJump.done', sessionId: 's1', seq: 7, status: 'notFound' })], a.state);
    expect(b.state.sessionView.s1?.turnJump).toEqual({ seq: 7, status: 'notFound', runId: 'r1' });
    // 別のターンを開いた後に届いた古い結果は捨てる。
    const c = run([intent({ type: 'turn.open', sessionId: 's1', seq: 9, runId: 'r1', jump }), runtime({ type: 'turnJump.done', sessionId: 's1', seq: 7, status: 'found' })], b.state);
    expect(c.state.sessionView.s1?.turnJump).toEqual({ seq: 9, status: 'pending', runId: 'r1' });
  });
  it('跳ばしたターンを閉じると、左の Claude も transcript から抜けさせる', () => {
    const jump = { heads: ['a', 'b'], index: 0, from: 'bottom' as const };
    const a = run([intent({ type: 'turn.open', sessionId: 's1', seq: 7, runId: 'r1', jump })], onSession());
    // 開いている行をもう一度押すと、目次は跳び先を持たずに来る。
    const b = run([intent({ type: 'turn.open', sessionId: 's1', seq: 7, runId: null, jump: null })], a.state);
    expect(b.state.sessionView.s1).toMatchObject({ openTurn: null, turnJump: null });
    expect(b.effects).toContainEqual({ kind: 'api.leaveTranscript', runId: 'r1' });
    // 跳ばしていないターンを閉じても、抜けさせる相手はいない。
    const c = run([intent({ type: 'turn.open', sessionId: 's1', seq: 3, runId: null, jump: null }), intent({ type: 'turn.open', sessionId: 's1', seq: 3, runId: null, jump: null })], b.state);
    expect(c.effects.some((e) => (e as { kind: string }).kind === 'api.leaveTranscript')).toBe(false);
  });
  it('跳ばしたまま画面を離れると、左の Claude を transcript から抜けさせ、開いたターンを忘れる', () => {
    const jump = { heads: ['a', 'b'], index: 0, from: 'bottom' as const };
    const a = run([intent({ type: 'turn.open', sessionId: 's1', seq: 7, runId: 'r1', jump })], onSession());
    const b = run([runtime({ type: 'hash.changed', route: { name: 'home' } })], a.state);
    expect(b.effects).toContainEqual({ kind: 'api.leaveTranscript', runId: 'r1' });
    expect(b.state.sessionView.s1).toMatchObject({ openTurn: null, turnJump: null });
    // 跳ばしていなければ何も送らない。
    const c = run([runtime({ type: 'hash.changed', route: { name: 'session', id: 's1' } }), runtime({ type: 'hash.changed', route: { name: 'home' } })], b.state);
    expect(c.effects.some((e) => (e as { kind: string }).kind === 'api.leaveTranscript')).toBe(false);
  });
  it('跳ばした run が終わるか替わったら跳び先を忘れ、離れても終わった run へ抜けさせに行かない', () => {
    const jump = { heads: ['a', 'b'], index: 0, from: 'bottom' as const };
    const a = run([intent({ type: 'turn.open', sessionId: 's1', seq: 7, runId: 'r1', jump })], onSession());
    const ended = run([server({ type: 'run.ended', run: runDto('r1', 's1', 5) })], a.state);
    expect(ended.state.sessionView.s1?.turnJump).toBeNull();
    // 開いたターンはそのまま読める。
    expect(ended.state.sessionView.s1?.openTurn).toBe(7);
    const away = run([runtime({ type: 'hash.changed', route: { name: 'home' } })], ended.state);
    expect(away.effects.some((e) => (e as { kind: string }).kind === 'api.leaveTranscript')).toBe(false);
    // 再開で run が替わったときも、前の run の跳び先は忘れる。
    const b = run([server({ type: 'run.started', run: runDto('r2', 's1'), tabs: [] })], a.state);
    expect(b.state.sessionView.s1?.turnJump).toBeNull();
    // 別のセッションの run や、同じセッションの前の run が終わっても、跳び先は残す。
    const c = run([server({ type: 'run.ended', run: runDto('r9', 's2', 5) }), server({ type: 'run.ended', run: runDto('r0', 's1', 5) })], a.state);
    expect(c.state.sessionView.s1?.turnJump).toEqual({ seq: 7, status: 'pending', runId: 'r1' });
  });
  it('跳ばした後に跳び先を持たない遠いターンを開くと、先に左の Claude を transcript から抜けさせる', () => {
    const jump = { heads: ['a', 'b'], index: 0, from: 'bottom' as const };
    const a = run([intent({ type: 'turn.open', sessionId: 's1', seq: 7, runId: 'r1', jump })], onSession());
    // 目次は、跳ぶには遠すぎるターンを跳び先なしで送ってくる。
    const b = run([intent({ type: 'turn.open', sessionId: 's1', seq: 3, runId: null, jump: null })], a.state);
    expect(b.state.sessionView.s1).toMatchObject({ openTurn: 3, turnJump: null });
    expect(b.effects).toContainEqual({ kind: 'api.leaveTranscript', runId: 'r1' });
    expect(b.effects.some((e) => (e as { kind: string }).kind === 'api.jumpToPrompt')).toBe(false);
  });
  it('開いているターンをもう一度押すと閉じ、run が無ければ跳ばない', () => {
    const a = run([intent({ type: 'turn.open', sessionId: 's1', seq: 7, runId: null, jump: null })], onSession());
    expect(a.state.sessionView.s1).toMatchObject({ openTurn: 7, turnJump: null });
    expect(a.effects.some((e) => (e as { kind: string }).kind === 'api.jumpToPrompt')).toBe(false);
    const b = run([intent({ type: 'turn.open', sessionId: 's1', seq: 7, runId: null, jump: null })], a.state);
    expect(b.state.sessionView.s1?.openTurn).toBeNull();
  });
  it('最新へ戻ると、ターンを閉じて transcript を抜け、末尾を追う', () => {
    const a = run([intent({ type: 'turn.open', sessionId: 's1', seq: 7, runId: null, jump: null }), intent({ type: 'transcript.follow', sessionId: 's1', follow: false })], onSession());
    const b = run([intent({ type: 'turn.latest', sessionId: 's1', runId: 'r1' })], a.state);
    expect(b.state.sessionView.s1).toMatchObject({ openTurn: null, turnJump: null, follow: true });
    expect(b.effects).toContainEqual({ kind: 'api.leaveTranscript', runId: 'r1' });
  });
  it('本文の中の検索は、開くたびに欄へ戻る合図を進め、語を変えると数え直し、前へ次へで進め、閉じると消える', () => {
    const a = run([intent({ type: 'transcript.find', sessionId: 's1', open: true })], onSession());
    expect(a.state.sessionView.s1?.find).toEqual({ query: '', caseSensitive: false, from: null, step: 0, n: 1 });
    // その場の操作なので保存しない。
    expect(a.effects).toEqual([]);
    const b = run([intent({ type: 'transcript.findQuery', sessionId: 's1', query: 'バリデーション', caseSensitive: true, from: 12 }), intent({ type: 'transcript.findStep', sessionId: 's1', delta: 1 }), intent({ type: 'transcript.findStep', sessionId: 's1', delta: 1 })], a.state);
    expect(b.state.sessionView.s1?.find).toEqual({ query: 'バリデーション', caseSensitive: true, from: 12, step: 2, n: 1 });
    const c = run([intent({ type: 'transcript.findQuery', sessionId: 's1', query: 'バリ', caseSensitive: true, from: 12 })], b.state);
    expect(c.state.sessionView.s1?.find?.step).toBe(0);
    // 開いたままもう一度 ⌘F を押すと、語は残したまま欄へ戻る。
    const d = run([intent({ type: 'transcript.find', sessionId: 's1', open: true })], c.state);
    expect(d.state.sessionView.s1?.find).toMatchObject({ query: 'バリ', n: 2 });
    const e = run([intent({ type: 'transcript.find', sessionId: 's1', open: false })], d.state);
    expect(e.state.sessionView.s1?.find).toBeNull();
    // 閉じているときの前へ次へは何もしない。
    expect(run([intent({ type: 'transcript.findStep', sessionId: 's1', delta: 1 })], e.state).state.sessionView.s1?.find).toBeNull();
  });
  it('検索の結果から開くと、跳び先を覚えて追うのをやめ、画面に着いたら跳び先の周りを読む', () => {
    const a = run([intent({ type: 'session.open', id: 's1', seq: 42, q: 'パスワード' })]);
    expect(a.state.sessionView.s1).toMatchObject({ jump: { seq: 42, query: 'パスワード', n: 1 }, follow: false });
    expect(a.effects).toContainEqual({ kind: 'navigate', route: { name: 'session', id: 's1' } });
    const b = run([runtime({ type: 'hash.changed', route: { name: 'session', id: 's1' } })], a.state);
    expect(b.effects).toContainEqual({ kind: 'api.loadEvents', sessionId: 's1', fromSeq: 0, aroundSeq: 42 });
    // 同じ所をもう一度開いたら、跳び直す合図を進める。
    expect(run([intent({ type: 'session.open', id: 's1', seq: 42, q: 'パスワード' })], b.state).state.sessionView.s1?.jump?.n).toBe(2);
    // 画面を離れたら跳び先は忘れる。検索を通さずに開いたときも跳ばない。
    const c = run([runtime({ type: 'hash.changed', route: { name: 'home' } })], b.state);
    expect(c.state.sessionView.s1?.jump).toBeNull();
    const d = run([intent({ type: 'session.open', id: 's1' }), runtime({ type: 'hash.changed', route: { name: 'session', id: 's1' } })], b.state);
    expect(d.state.sessionView.s1?.jump).toBeNull();
    expect(d.effects).toContainEqual({ kind: 'api.loadEvents', sessionId: 's1', fromSeq: 0 });
  });
  it('新しい行を読み足すのは、持っている中でいちばん新しい行の後ろから', () => {
    expect(run([intent({ type: 'transcript.loadNewer', sessionId: 's1' })]).effects).toEqual([{ kind: 'api.loadEvents', sessionId: 's1', fromSeq: -2 }]);
  });
  it('検索と検索の結果からの跳び先は保存しない', () => {
    const v = { ...defaultSessionView(), find: { query: 'x', caseSensitive: false, from: null, step: 0, n: 1 }, jump: { seq: 3, query: 'x', n: 1 } };
    expect(persistedSessionView(v)).not.toHaveProperty('find');
    expect(persistedSessionView(v)).not.toHaveProperty('jump');
  });
  it('開いたターンと跳んだ結果は保存しない', () => {
    const v = { ...defaultSessionView(), openTurn: 3, turnJump: { seq: 3, status: 'found' as const, runId: 'r1' } };
    expect(persistedSessionView(v)).not.toHaveProperty('openTurn');
    expect(persistedSessionView(v)).not.toHaveProperty('turnJump');
  });
  it('トランスクリプトの折りたたみ', () => {
    const a = run([intent({ type: 'transcript.toggle' })], onSession());
    expect(a.state.sessionView.s1?.transcriptOpen).toBe(false);
    expect(run([intent({ type: 'transcript.toggle' })], a.state).state.sessionView.s1?.transcriptOpen).toBe(true);
  });
});

describe('入力待ちの知らせ', () => {
  const waiting = (...ids: string[]) => runtime({ type: 'waiting.changed', ids });
  // transition はどの領域の後にも settleWaiting で開いているセッションのカードを下げるので、領域そのものも見る。
  it('live 領域は、開いているセッションをカードにしない。通知の効果は出す', () => {
    const at = { ...initialState(), screen: { name: 'session' as const, id: 's1' } };
    const r = liveStep(at, waiting('s1', 's2'))!;
    expect(r.state.waitingToasts).toEqual(['s2']);
    expect(r.effects).toContainEqual({ kind: 'notify.waiting', sessionId: 's1' });
  });
  it('新たに入力待ちになったセッションをカードに積み、通知とバッジの効果を出す', () => {
    const a = run([waiting('s1')]);
    expect(a.state.waitingToasts).toEqual(['s1']);
    expect(a.state.waitingSeen).toEqual(['s1']);
    expect(a.effects).toEqual([{ kind: 'notify.waiting', sessionId: 's1' }, { kind: 'badge', count: 1 }]);
    const b = run([waiting('s1', 's2')], a.state);
    expect(b.state.waitingToasts).toEqual(['s1', 's2']);
    expect(b.effects).toEqual([{ kind: 'notify.waiting', sessionId: 's2' }, { kind: 'badge', count: 2 }]);
  });
  it('入力待ちが解けたらカードを消し、同じ数なら数え直さない', () => {
    const a = run([waiting('s1', 's2')]);
    const b = run([waiting('s2', 's3')], a.state);
    expect(b.state.waitingToasts).toEqual(['s2', 's3']);
    expect(b.effects).toEqual([{ kind: 'notify.waiting', sessionId: 's3' }]);
    const c = run([waiting()], b.state);
    expect(c.state.waitingToasts).toEqual([]);
    expect(c.state.waitingSeen).toEqual([]);
    expect(c.effects).toEqual([{ kind: 'badge', count: 0 }]);
  });
  it('解けてからまた入力待ちになれば、もう一度知らせる', () => {
    const a = run([waiting('s1'), waiting(), waiting('s1')]);
    expect(a.state.waitingToasts).toEqual(['s1']);
    expect(a.effects.filter((e) => (e as { kind: string }).kind === 'notify.waiting')).toHaveLength(2);
  });
  it('いま開いているセッションの入力待ちはカードにしない。通知の効果は出す（窓が背面なら見えていないため）', () => {
    const a = run([waiting('s1', 's2')], onSession('s1'));
    expect(a.state.waitingToasts).toEqual(['s2']);
    expect(a.effects).toContainEqual({ kind: 'notify.waiting', sessionId: 's1' });
  });
  it('カードのセッションを開いたら、そのカードを消す', () => {
    const a = run([waiting('s1', 's2')]);
    const b = run([intent({ type: 'session.open', id: 's1', focus: 'terminal' }), runtime({ type: 'hash.changed', route: { name: 'session', id: 's1' } })], a.state);
    expect(b.state.waitingToasts).toEqual(['s2']);
    // 開いて見たので、離れても同じ入力待ちをまた積まない。
    const c = run([runtime({ type: 'hash.changed', route: { name: 'home' } }), waiting('s1', 's2')], b.state);
    expect(c.state.waitingToasts).toEqual(['s2']);
  });
  it('入力待ちのカードは info や error のトーストとは別に持つ', () => {
    const a = run([waiting('s1'), server({ type: 'toast', level: 'info', message: 'x' })]);
    expect(a.state.toasts.map((t) => t.message)).toEqual(['x']);
    expect(a.state.waitingToasts).toEqual(['s1']);
  });
  it('live.update そのものではカードを積まない（どのセッションかはランタイムが決めて返す）', () => {
    const live = { sessionId: 'u1', status: 'waiting' as const, name: 'alpha', nameSource: null, cwd: '/x', pid: 1 };
    const a = run([server({ type: 'live.update', live: [live] })]);
    expect(a.state.waitingToasts).toEqual([]);
    expect(a.effects).toEqual([]);
  });
});

describe('通知を受け取るか', () => {
  it('受け取るにすると、許可を求める効果だけを出す。結果が届いてから切り替える', () => {
    const a = run([intent({ type: 'notify.set', on: true })]);
    expect(a.effects).toEqual([{ kind: 'notify.request' }]);
    expect(a.state.notify.on).toBe(false);
    const b = run([runtime({ type: 'notify.changed', available: true, on: true })], a.state);
    expect(b.state.notify).toEqual({ available: true, on: true, blocked: false });
    // OS で切られていれば、その印を持つ。
    const c = run([runtime({ type: 'notify.changed', available: true, on: false, blocked: true })], b.state);
    expect(c.state.notify).toEqual({ available: true, on: false, blocked: true });
  });
  it('受け取らないにすると、その場で切り替えて覚える', () => {
    const on = run([runtime({ type: 'notify.changed', available: true, on: true })]).state;
    const a = run([intent({ type: 'notify.set', on: false })], on);
    expect(a.state.notify).toEqual({ available: true, on: false, blocked: false });
    expect(a.effects).toEqual([{ kind: 'storage.save', key: 'notify.waiting', value: false }]);
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
  it('完了ダイアログは画面を移ると閉じる', () => {
    const done = run([
      intent({ type: 'session.promote.open', id: 's1' }),
      intent({ type: 'session.promote.submit', id: 's1', name: 'newp', gitInit: false, moveFiles: false }),
      runtime({ type: 'promote.done', projectId: 'p9', moved: true, reason: null }),
    ]).state;
    const a = run([intent({ type: 'nav.go', to: { name: 'home' } })], done);
    expect(a.state.overlay).toEqual({ kind: 'none' });
    expect(a.effects).toEqual([{ kind: 'navigate', route: { name: 'home' } }]);
    // 戻るボタンやパレットのようにハッシュから画面が変わる経路でも閉じる。
    const b = run([runtime({ type: 'hash.changed', route: { name: 'settings' } })], done);
    expect(b.state.overlay).toEqual({ kind: 'none' });
    // 未解決プロジェクトのダイアログは決めるまで残す。
    const un = run([server({ type: 'project.unresolved', projectId: 'p1' })]).state;
    expect(run([intent({ type: 'nav.go', to: { name: 'home' } })], un).state.overlay).toEqual({ kind: 'resolveProject', projectId: 'p1' });
  });
  // 送信していないのに届いた完了や失敗で、開いているものを書き換えない。
  // ただし黙って捨てると、送信の直後に閉じた利用者が結果を知れないので、トーストでは知らせる。
  it('昇格の最中でなければ状態は変えず、結果をトーストで知らせる', () => {
    const base = run([server({ type: 'project.unresolved', projectId: 'p1' })]).state;
    const a = run([runtime({ type: 'promote.done', projectId: 'p9', moved: true, reason: null })], base);
    expect(a.state.overlay).toEqual({ kind: 'resolveProject', projectId: 'p1' });
    expect(a.state.promote).toEqual({ kind: 'idle' });
    expect(a.effects).toEqual([{ kind: 'toast', level: 'info', message: 'プロジェクトに昇格しました' }]);
    const b = run([runtime({ type: 'promote.failed', message: '同じ名前があります' })], base);
    expect(b.state.overlay).toEqual({ kind: 'resolveProject', projectId: 'p1' });
    expect(b.state.promote).toEqual({ kind: 'idle' });
    expect(b.effects).toEqual([{ kind: 'toast', level: 'error', message: '同じ名前があります' }]);
    // ダイアログを開いただけで、まだ送っていないときも開き直さない。
    const open = run([intent({ type: 'session.promote.open', id: 's1' })]).state;
    const c = run([runtime({ type: 'promote.done', projectId: 'p9', moved: true, reason: null })], open);
    expect(c.state.overlay).toEqual({ kind: 'promote', sessionId: 's1' });
  });
  // 送信の直後にダイアログを閉じても、失敗はトーストで届く。
  it('送信の直後に閉じても、失敗のトーストは出る', () => {
    const sent = run([
      intent({ type: 'session.promote.open', id: 's1' }),
      intent({ type: 'session.promote.submit', id: 's1', name: 'newp', gitInit: false, moveFiles: false }),
      intent({ type: 'overlay.close' }),
    ]).state;
    expect(sent.overlay).toEqual({ kind: 'none' });
    const a = run([runtime({ type: 'promote.failed', message: '同じ名前があります' })], sent);
    expect(a.state.overlay).toEqual({ kind: 'none' });
    expect(a.effects).toEqual([{ kind: 'toast', level: 'error', message: '同じ名前があります' }]);
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
      intent({ type: 'todo.confirm', id: 't1' }),
      intent({ type: 'todo.reject', id: 't1' }),
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
      { kind: 'api.confirmTodo', id: 't1' }, { kind: 'api.rejectTodo', id: 't1' },
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
    expect(a.effects).toEqual([{ kind: 'focus', target: 'newSessionName' }, { kind: 'api.workspaceDirs' }]);
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
    expect(g.effects).toEqual([{ kind: 'focus', target: 'newSessionName' }, { kind: 'api.workspaceDirs' }]);
    const f = run([intent({ type: 'palette.run', command: { id: 'nope', label: '' } })], opened());
    expect(f.state.overlay).toEqual({ kind: 'none' });
    expect(f.effects).toEqual([]);
  });
  // 新しいセッションは、パレットを開いた画面のプロジェクトを最初から選ぶ。どれを選ぶかは presenter が項目の ID に載せる。
  it('新しいセッションは、ID に載せたプロジェクトかスクラッチを選んで開く', () => {
    const a = run([intent({ type: 'palette.run', command: { id: 'cmd:new-session:project:p1', label: '新しいセッション' } })], opened());
    expect(a.state.overlay).toEqual({ kind: 'newSession', projectId: 'p1', scratch: false });
    expect(a.effects).toEqual([{ kind: 'focus', target: 'newSessionName' }, { kind: 'api.workspaceDirs' }]);
    const b = run([intent({ type: 'palette.run', command: { id: 'cmd:new-session:scratch', label: '新しいセッション' } })], opened());
    expect(b.state.overlay).toEqual({ kind: 'newSession', projectId: null, scratch: true });
  });
  it('移動の行は、画面を移るかサイドバーを開閉する', () => {
    expect(run([intent({ type: 'palette.run', command: { id: 'go:home', label: 'ホームへ' } })], opened()).effects).toEqual([{ kind: 'navigate', route: { name: 'home' } }]);
    expect(run([intent({ type: 'palette.run', command: { id: 'go:projects', label: 'プロジェクトへ' } })], opened()).effects).toEqual([{ kind: 'navigate', route: { name: 'projects' } }]);
    const s = run([intent({ type: 'palette.run', command: { id: 'go:sessions', label: 'セッション一覧へ' } })], opened());
    expect(s.state.overlay).toEqual({ kind: 'none' });
    expect(s.effects).toEqual([{ kind: 'navigate', route: { name: 'sessions' } }]);
    const bar = run([intent({ type: 'palette.run', command: { id: 'cmd:sidebar', label: 'サイドバーの開閉' } })], opened());
    expect(bar.state.overlay).toEqual({ kind: 'none' });
    expect(bar.state.sidebarCollapsed).toBe(true);
    expect(bar.effects).toEqual([{ kind: 'storage.save', key: 'sidebar.collapsed', value: true }]);
  });
  // 全文検索の行は、ヘッダーの検索欄が担っていた search.query と同じ経路でセッション一覧へ移る。
  it('全文検索の行は、語を持ってセッション一覧へ移り、結果の一覧へフォーカスする', () => {
    const a = run([intent({ type: 'palette.run', command: { id: 'search:索引 再構築', label: '『索引 再構築』を全文検索' } })], opened());
    expect(a.state.overlay).toEqual({ kind: 'none' });
    expect(a.state.search.text).toBe('索引 再構築');
    expect(a.effects).toEqual([{ kind: 'navigate', route: { name: 'sessions', q: '索引 再構築' } }, { kind: 'focus', target: 'results' }]);
  });
  // パレットが開いていないのにコマンドが届いても、開いている別のダイアログを消さない。
  it('パレットが開いていなければオーバーレイを閉じない', () => {
    const un = run([server({ type: 'project.unresolved', projectId: 'p1' })]).state;
    const a = run([intent({ type: 'palette.run', command: { id: 'cmd:settings', label: '設定' } })], un);
    expect(a.state.overlay).toEqual({ kind: 'resolveProject', projectId: 'p1' });
    // 裏の画面も移さない（ダイアログを開いている間の画面の移動を参照）。
    expect(a.effects).toEqual([]);
    const b = run([intent({ type: 'palette.run', command: { id: 'nope', label: '' } })], un);
    expect(b.state).toEqual(un);
    // ダイアログを開く行も、決めるまで閉じないダイアログを差し替えない。
    for (const id of ['cmd:new-session', 'cmd:new-scratch', 'cmd:shortcuts']) expect(run([intent({ type: 'palette.run', command: { id, label: '' } })], un).state).toEqual(un);
  });
});

describe('キーの一覧と履歴', () => {
  it('shortcuts.open でキーの一覧が開き、overlay.close で閉じる', () => {
    const a = run([intent({ type: 'shortcuts.open' })]);
    expect(a.state.overlay).toEqual({ kind: 'shortcuts' });
    const b = run([intent({ type: 'overlay.close' })], a.state);
    expect(b.state.overlay).toEqual({ kind: 'none' });
  });
  it('パレットからもキーの一覧を開ける', () => {
    const a = run([intent({ type: 'palette.run', command: { id: 'cmd:shortcuts', label: 'キーの一覧' } })], run([intent({ type: 'palette.open' })]).state);
    expect(a.state.overlay).toEqual({ kind: 'shortcuts' });
    expect(a.effects).toEqual([]);
  });
  it('戻ると進むは履歴を動かす効果になる', () => {
    expect(run([intent({ type: 'nav.back' })]).effects).toEqual([{ kind: 'history.go', delta: -1 }]);
    expect(run([intent({ type: 'nav.forward' })]).effects).toEqual([{ kind: 'history.go', delta: 1 }]);
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
    expect(b.effects).toEqual([{ kind: 'storage.save', key: 'sv:s1', value: persistedSessionView(b.state.sessionView.s1!) }]);
    const c = run([intent({ type: 'split.toggle' })], b.state);
    expect(c.state.sessionView.s1).toMatchObject({ split: false, splitTab: null });
    expect(c.effects).toEqual([{ kind: 'storage.save', key: 'sv:s1', value: persistedSessionView(c.state.sessionView.s1!) }]);
  });
  it('タブが 1 つしか無ければトーストを出す', () => {
    const a = run([intent({ type: 'split.toggle' })], onSession('s1'));
    const b = run([runtime({ type: 'split.resolved', sessionId: 's1', tabId: null })], a.state);
    expect(b.state.sessionView.s1?.split).toBeFalsy();
    expect(b.effects).toEqual([{ kind: 'toast', level: 'info', message: '横に並べるにはタブが 2 つ必要です' }]);
  });
  it('分割中に右のタブを選ぶと左右が入れ替わる', () => {
    const r = run([intent({ type: 'tab.select', tabId: 't2' })], split('t1', 't2'));
    expect(r.state.sessionView.s1).toMatchObject({ selectedTab: 't2', splitTab: 't1' });
  });
  it('右のタブが閉じたら分割を畳む', () => {
    const s = split('t1', 't2');
    const a = run([server({ type: 'tab.upsert', tab: { ...tabDto('t2', 'r1', 5), sessionId: 's1' } })], s);
    expect(a.state.sessionView.s1).toMatchObject({ selectedTab: 't1', split: false, splitTab: null });
    expect(a.effects).toEqual([{ kind: 'storage.save', key: 'sv:s1', value: persistedSessionView(a.state.sessionView.s1!) }, { kind: 'terminal.disconnect', tabId: 't2' }]);
  });
  it('tab.close で右のタブを閉じても分割を畳む', () => {
    const s = split('t1', 't2');
    const a = run([intent({ type: 'tab.close', tabId: 't2' })], s);
    expect(a.state.sessionView.s1).toMatchObject({ selectedTab: 't1', split: false, splitTab: null });
    expect(a.effects).toEqual([{ kind: 'storage.save', key: 'sv:s1', value: persistedSessionView(a.state.sessionView.s1!) }, { kind: 'api.closeTab', tabId: 't2' }]);
  });
  it('左のタブが閉じたら分割を畳み、次のタブで復活させない', () => {
    const s = split('t1', 't2');
    const a = run([intent({ type: 'tab.close', tabId: 't1' })], s);
    expect(a.state.sessionView.s1).toMatchObject({ selectedTab: null, split: false, splitTab: null });
    // 畳んだ後にシェルタブが増えても、押していない ⌘\ の分割を勝手に復活させない。
    const b = run([server({ type: 'tab.upsert', tab: tabDto('t3', 'r1') })], a.state);
    expect(b.state.sessionView.s1).toMatchObject({ selectedTab: 't3', split: false, splitTab: null });
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

const status = (over: Partial<SyncStatusBody> = {}): SyncStatusBody => ({ state: 'idle', url: 'https://h', lastPushAt: 100, lastPullAt: 200, pending: 0, error: null, deviceCount: 2, claudeConfig: { enabled: false, confirmed: false }, skipped: [], sweepPending: null, ...over });

describe('同期', () => {
  it('sync.status が領域の状態と未送信件数になる', () => {
    const a = run([server({ type: 'sync.status', status: status() })]);
    expect(a.state.sync).toEqual({ kind: 'idle', lastAt: 200 });
    expect(a.state.pending).toBe(0);
    const b = run([server({ type: 'sync.status', status: status({ state: 'error', error: '切れました', pending: 3 }) })]);
    expect(b.state.sync).toEqual({ kind: 'error', message: '切れました' });
    expect(b.state.pending).toBe(3);
    expect(run([server({ type: 'sync.status', status: status({ state: 'paused' }) })]).state.sync).toEqual({ kind: 'paused' });
    expect(run([server({ type: 'sync.status', status: status({ state: 'off', url: null }) })]).state.sync).toEqual({ kind: 'off' });
    expect(run([server({ type: 'sync.status', status: status({ state: 'pushing' }) })]).state.sync).toEqual({ kind: 'pushing' });
    expect(run([server({ type: 'sync.status', status: status({ state: 'pulling' }) })]).state.sync).toEqual({ kind: 'pulling' });
  });
  it('idle の最終時刻は pull を優先し、pull が無ければ push を採る', () => {
    expect(run([server({ type: 'sync.status', status: status({ lastPullAt: null }) })]).state.sync).toEqual({ kind: 'idle', lastAt: 100 });
    expect(run([server({ type: 'sync.status', status: status({ lastPullAt: null, lastPushAt: null }) })]).state.sync).toEqual({ kind: 'idle', lastAt: null });
  });
  it('error の本文が無いときは既定の文言にする', () => {
    expect(run([server({ type: 'sync.status', status: status({ state: 'error', error: null }) })]).state.sync).toEqual({ kind: 'error', message: '同期に失敗しました' });
  });
  it('今すぐ同期、一時停止、前面化が効果になる', () => {
    const { effects } = run([intent({ type: 'sync.now' }), intent({ type: 'sync.pause', paused: true }), runtime({ type: 'window.focus' })]);
    expect(effects).toEqual([{ kind: 'api.syncNow' }, { kind: 'api.syncPause', paused: true }, { kind: 'api.syncFocus' }]);
  });
  it('参加トークンの再表示と設定の下見と取り込み', () => {
    const a = run([intent({ type: 'sync.joinToken.show' })]);
    expect(a.effects).toEqual([{ kind: 'api.joinToken' }]);
    const b = run([intent({ type: 'sync.config.preview' })]);
    expect(b.state.overlay).toEqual({ kind: 'configPreview' });
    expect(b.effects).toEqual([{ kind: 'api.configPreview' }]);
    const c = run([intent({ type: 'sync.config.apply' })], b.state);
    expect(c.state.overlay).toEqual({ kind: 'none' });
    expect(c.effects).toEqual([{ kind: 'api.configPull' }]);
  });
});

describe('外で動くセッションを hangar で開く', () => {
  it('attach はそのまま送り、送信中の二度押しは捨てる', () => {
    const r = run([intent({ type: 'session.attach', id: 's1' }), intent({ type: 'session.attach', id: 's1' })]);
    expect(r.effects).toEqual([{ kind: 'api.attach', sessionId: 's1' }]);
    expect(r.state.launch).toEqual({ kind: 'submitting' });
  });
  it('引き取りは先に確認を出し、承諾で送る。やめれば何も送らない', () => {
    const a = run([intent({ type: 'session.adopt', id: 's1' })]);
    expect(a.effects).toEqual([]);
    expect(a.state.overlay).toEqual({ kind: 'confirm', confirm: { kind: 'adoptSession', sessionId: 's1' } });
    const closed = run([intent({ type: 'overlay.close' })], a.state);
    expect(closed.effects).toEqual([]);
    expect(closed.state).toEqual(initialState());
    const b = run([intent({ type: 'session.adopt', id: 's1', confirmed: true }), intent({ type: 'session.adopt', id: 's1', confirmed: true })], a.state);
    expect(b.state.overlay).toEqual({ kind: 'none' });
    expect(b.state.launch).toEqual({ kind: 'submitting' });
    expect(b.effects).toEqual([{ kind: 'toast', level: 'info', message: '引き取っています' }, { kind: 'api.adopt', sessionId: 's1' }]);
    // 失敗はトーストで知らせ、送信中を解く。
    const c = run([runtime({ type: 'launch.failed', message: '作業中のセッションは引き取れません' })], b.state);
    expect(c.state.launch).toEqual({ kind: 'failed', message: '作業中のセッションは引き取れません' });
    expect(c.effects).toEqual([{ kind: 'toast', level: 'error', message: '作業中のセッションは引き取れません' }]);
  });
});

describe('プロジェクトを一覧から削除する確認', () => {
  it('未解決のダイアログで一覧から削除を選ぶと、送らずに確認を出す', () => {
    const a = run([server({ type: 'project.unresolved', projectId: 'p1' }), intent({ type: 'project.resolve', id: 'p1', action: { kind: 'unlink' } })]);
    expect(a.effects).toEqual([]);
    expect(a.state.overlay).toEqual({ kind: 'confirm', confirm: { kind: 'unlinkProject', projectId: 'p1' } });
  });
  it('やめると未解決のダイアログに戻り、あとでの扱いにはしない', () => {
    const a = run([server({ type: 'project.unresolved', projectId: 'p1' }), server({ type: 'project.unresolved', projectId: 'p2' }), intent({ type: 'project.resolve', id: 'p1', action: { kind: 'unlink' } })]);
    const b = run([intent({ type: 'overlay.close' })], a.state);
    expect(b.effects).toEqual([]);
    expect(b.state.overlay).toEqual({ kind: 'resolveProject', projectId: 'p1' });
    expect(b.state.unresolvedQueue).toEqual(['p2']);
    expect(b.state.resolveDeferred).toEqual([]);
  });
  it('承諾で送り、同じプロジェクトを聞き直さずに次の未解決へ進む', () => {
    const a = run([server({ type: 'project.unresolved', projectId: 'p1' }), server({ type: 'project.unresolved', projectId: 'p2' }), intent({ type: 'project.resolve', id: 'p1', action: { kind: 'unlink' } })]);
    const b = run([intent({ type: 'project.resolve', id: 'p1', action: { kind: 'unlink' }, confirmed: true })], a.state);
    expect(b.effects).toEqual([{ kind: 'api.resolveProject', projectId: 'p1', action: { kind: 'unlink' } }]);
    expect(b.state.overlay).toEqual({ kind: 'resolveProject', projectId: 'p2' });
    expect(b.state.unresolvedQueue).toEqual([]);
    const c = run([intent({ type: 'project.resolve', id: 'p2', action: { kind: 'unlink' }, confirmed: true })], b.state);
    expect(c.state.overlay).toEqual({ kind: 'none' });
  });
  // 確認の最初のフォーカスは「やめる」なので、修飾の無い / や ? も Root に届く。
  // パレットやキーの一覧、新しいセッションで確認を差し替えると、未解決のダイアログもキューに戻らず消える。
  it('確認の上でパレットや新規セッションを開こうとしても、確認を差し替えない', () => {
    const a = run([server({ type: 'project.unresolved', projectId: 'p1' }), intent({ type: 'project.resolve', id: 'p1', action: { kind: 'unlink' } })]);
    for (const i of [intent({ type: 'palette.open' }), intent({ type: 'shortcuts.open' }), intent({ type: 'session.new.open', scratch: false })]) {
      const b = run([i], a.state);
      expect(b.state).toEqual(a.state);
      expect(b.effects).toEqual([]);
    }
    const c = run([intent({ type: 'overlay.close' })], a.state);
    expect(c.state.overlay).toEqual({ kind: 'resolveProject', projectId: 'p1' });
  });
  it('アーカイブと再指定は確認を挟まない', () => {
    const a = run([server({ type: 'project.unresolved', projectId: 'p1' }), intent({ type: 'project.resolve', id: 'p1', action: { kind: 'archive' } })]);
    expect(a.effects).toEqual([{ kind: 'api.resolveProject', projectId: 'p1', action: { kind: 'archive' } }]);
    expect(a.state.overlay).toEqual({ kind: 'none' });
  });
});

describe('停止の確認', () => {
  it('休みでシェルタブが無ければ、確認せずにすぐ止める', () => {
    const r = run([intent({ type: 'session.kill', runId: 'r1', working: false, shellTabs: 0 })]);
    expect(r.state.overlay).toEqual({ kind: 'none' });
    expect(r.effects).toEqual([{ kind: 'api.killRun', runId: 'r1' }]);
  });
  it('作業中なら先に確認を出し、やめれば何も送らない', () => {
    const a = run([intent({ type: 'session.kill', runId: 'r1', working: true, shellTabs: 0 })]);
    expect(a.effects).toEqual([]);
    expect(a.state.overlay).toEqual({ kind: 'confirm', confirm: { kind: 'killRun', runId: 'r1', working: true, shellTabs: 0 } });
    const closed = run([intent({ type: 'overlay.close' })], a.state);
    expect(closed.effects).toEqual([]);
    expect(closed.state).toEqual(initialState());
  });
  it('シェルタブがあれば休みでも確認を出し、承諾で止めて確認を閉じる', () => {
    const a = run([intent({ type: 'session.kill', runId: 'r1', working: false, shellTabs: 2 })]);
    expect(a.effects).toEqual([]);
    expect(a.state.overlay).toEqual({ kind: 'confirm', confirm: { kind: 'killRun', runId: 'r1', working: false, shellTabs: 2 } });
    const b = run([intent({ type: 'session.kill', runId: 'r1', working: false, shellTabs: 2, confirmed: true })], a.state);
    expect(b.state.overlay).toEqual({ kind: 'none' });
    expect(b.effects).toEqual([{ kind: 'api.killRun', runId: 'r1' }]);
  });
});

describe('この PC で再開', () => {
  it('この PC で再開の 409 は確認ダイアログになり、承諾で上書きを送る', () => {
    const a = run([intent({ type: 'session.resumeHere', id: 's1' })]);
    expect(a.effects).toEqual([{ kind: 'api.resumeHere', sessionId: 's1', overwrite: false }]);
    expect(a.state.overlay).toEqual({ kind: 'none' });
    const b = run([runtime({ type: 'api.conflict', kind: 'resumeHere', sessionId: 's1', localSize: 10, remoteSize: 99 })], a.state);
    expect(b.state.overlay).toEqual({ kind: 'confirm', confirm: { kind: 'overwriteTranscript', sessionId: 's1', localSize: 10, remoteSize: 99 } });
    const c = run([intent({ type: 'session.resumeHere', id: 's1', overwrite: true })], b.state);
    expect(c.state.overlay).toEqual({ kind: 'none' });
    expect(c.effects).toEqual([{ kind: 'api.resumeHere', sessionId: 's1', overwrite: true }]);
  });
  // Ruling 7: resumeHere 領域と overlay 領域の相互作用。
  it('確認ダイアログは Esc と外側のクリック（overlay.close）で閉じ、何も送らない', () => {
    const open = run([runtime({ type: 'api.conflict', kind: 'resumeHere', sessionId: 's1', localSize: 10, remoteSize: 99 })]);
    expect(open.state.overlay.kind).toBe('confirm');
    const closed = run([intent({ type: 'overlay.close' })], open.state);
    expect(closed.state.overlay).toEqual({ kind: 'none' });
    expect(closed.effects).toEqual([]);
    // 閉じても昇格や起動の状態を巻き込まない。
    expect(closed.state).toEqual(initialState());
  });
  it('設定の下見のダイアログも overlay.close で閉じ、取り込みは走らない', () => {
    const open = run([intent({ type: 'sync.config.preview' })]);
    const closed = run([intent({ type: 'overlay.close' })], open.state);
    expect(closed.state.overlay).toEqual({ kind: 'none' });
    expect(closed.effects).toEqual([]);
  });
  it('確認ダイアログを閉じても、待っている未解決プロジェクトは順番に出る', () => {
    // p1 が出ていて p2 が待っているところへ 409 が割り込む。
    const queued = run([
      server({ type: 'project.unresolved', projectId: 'p1' }),
      server({ type: 'project.unresolved', projectId: 'p2' }),
      runtime({ type: 'api.conflict', kind: 'resumeHere', sessionId: 's1', localSize: 1, remoteSize: 2 }),
    ]);
    expect(queued.state.overlay.kind).toBe('confirm');
    // 追い出された p1 はキューの先頭に戻る。並びは p1、p2 のままである。
    expect(queued.state.unresolvedQueue).toEqual(['p1', 'p2']);
    const a = run([intent({ type: 'overlay.close' })], queued.state);
    expect(a.state.overlay).toEqual({ kind: 'resolveProject', projectId: 'p1' });
    const b = run([intent({ type: 'overlay.close' })], a.state);
    expect(b.state.overlay).toEqual({ kind: 'resolveProject', projectId: 'p2' });
    const c = run([intent({ type: 'overlay.close' })], b.state);
    expect(c.state.overlay).toEqual({ kind: 'none' });
  });
  it('409 の割り込みは、出ていた未解決プロジェクトを落とさない', () => {
    const r = run([server({ type: 'project.unresolved', projectId: 'p1' }), runtime({ type: 'api.conflict', kind: 'resumeHere', sessionId: 's1', localSize: 1, remoteSize: 2 })]);
    expect(r.state.overlay.kind).toBe('confirm');
    expect(r.state.unresolvedQueue).toEqual(['p1']);
    // 確認を閉じれば、割り込まれた p1 がそのまま出直す。
    expect(run([intent({ type: 'overlay.close' })], r.state).state.overlay).toEqual({ kind: 'resolveProject', projectId: 'p1' });
  });
  it('409 が二度届いても、同じ未解決プロジェクトを二重に積まない', () => {
    const conflict = runtime({ type: 'api.conflict' as const, kind: 'resumeHere' as const, sessionId: 's1', localSize: 1, remoteSize: 2 });
    const r = run([server({ type: 'project.unresolved', projectId: 'p1' }), conflict, conflict]);
    expect(r.state.unresolvedQueue).toEqual(['p1']);
  });
  it('この PC で再開は二重送信を捨てる', () => {
    // 起動と昇格と同じ歯止めで、run が 2 つ立つのを防ぐ。
    const a = run([intent({ type: 'session.resumeHere', id: 's1' }), intent({ type: 'session.resumeHere', id: 's1' })]);
    expect(a.effects).toEqual([{ kind: 'api.resumeHere', sessionId: 's1', overwrite: false }]);
    expect(a.state.launch).toEqual({ kind: 'submitting' });
    // 409 は要求が終わった合図でもある。ここで解かないと確認に答えられない。
    const b = run([runtime({ type: 'api.conflict', kind: 'resumeHere', sessionId: 's1', localSize: 1, remoteSize: 2 })], a.state);
    expect(b.state.launch).toEqual({ kind: 'idle' });
    // 承諾の二連打も 1 回しか飛ばない。
    const c = run([intent({ type: 'session.resumeHere', id: 's1', overwrite: true }), intent({ type: 'session.resumeHere', id: 's1', overwrite: true })], b.state);
    expect(c.effects).toEqual([{ kind: 'api.resumeHere', sessionId: 's1', overwrite: true }]);
    expect(c.state.launch).toEqual({ kind: 'submitting' });
    // 起動と同じ状態を使うので、結果が届けば launchStep が idle に戻す。
    const d = run([runtime({ type: 'launch.done', sessionId: 's1', runId: 'r1' })], c.state);
    expect(d.state.launch).toEqual({ kind: 'idle' });
    // 解けたあとはまた押せる。
    expect(run([intent({ type: 'session.resumeHere', id: 's1' })], d.state).effects).toEqual([{ kind: 'api.resumeHere', sessionId: 's1', overwrite: false }]);
  });
  it('確認が出ている最中に接続が切れて戻っても、確認はそのまま残る', () => {
    const open = run([runtime({ type: 'api.conflict', kind: 'resumeHere', sessionId: 's1', localSize: 10, remoteSize: 99 })]);
    const r = run([runtime({ type: 'ws.close', at: T0 }), runtime({ type: 'ws.open' })], open.state);
    expect(r.state.overlay).toEqual({ kind: 'confirm', confirm: { kind: 'overwriteTranscript', sessionId: 's1', localSize: 10, remoteSize: 99 } });
    expect(r.effects).toContainEqual({ kind: 'api.bootstrap' });
  });
  it('別のセッションに移っても確認はそのまま残る', () => {
    const open = run([runtime({ type: 'api.conflict', kind: 'resumeHere', sessionId: 's1', localSize: 10, remoteSize: 99 })]);
    const r = run([runtime({ type: 'hash.changed', route: { name: 'session', id: 's2' } })], open.state);
    expect(r.state.overlay).toEqual({ kind: 'confirm', confirm: { kind: 'overwriteTranscript', sessionId: 's1', localSize: 10, remoteSize: 99 } });
  });
  it('確認ダイアログが出ていないときの再開は、開いているオーバーレイを閉じない', () => {
    const open = run([intent({ type: 'palette.open' })]);
    const r = run([intent({ type: 'session.resumeHere', id: 's1', overwrite: true })], open.state);
    expect(r.state.overlay).toEqual({ kind: 'palette' });
    expect(r.effects).toEqual([{ kind: 'api.resumeHere', sessionId: 's1', overwrite: true }]);
  });
  it('409 の確認は他端末のセッションごとに置き換わる', () => {
    const a = run([runtime({ type: 'api.conflict', kind: 'resumeHere', sessionId: 's1', localSize: 1, remoteSize: 2 })]);
    const b = run([runtime({ type: 'api.conflict', kind: 'resumeHere', sessionId: 's2', localSize: 3, remoteSize: 4 })], a.state);
    expect(b.state.overlay).toEqual({ kind: 'confirm', confirm: { kind: 'overwriteTranscript', sessionId: 's2', localSize: 3, remoteSize: 4 } });
  });
  it('同期の操作は未実装の案内を出さない', () => {
    expect(run([intent({ type: 'sync.now' })]).effects.some((e) => (e as { kind: string }).kind === 'toast')).toBe(false);
    expect(run([intent({ type: 'sync.pause', paused: false })]).effects.some((e) => (e as { kind: string }).kind === 'toast')).toBe(false);
  });
});

describe('ダイアログを開いている間の入力待ちのカードと通知', () => {
  // カードと通知は、ダイアログの上（右下の知らせ）や窓の外から来る。
  // 確認や入力のあるダイアログを開いたまま裏の画面だけを移すと、何に答えているのかが分からなくなる（⌘I と同じ考え方）。
  it('確認や入力のあるダイアログが開いていれば、画面を移さない', () => {
    const at = run([runtime({ type: 'hash.changed', route: { name: 'home' } })]).state;
    for (const before of [
      run([intent({ type: 'session.kill', runId: 'r1', working: true, shellTabs: 0 })], at).state,
      run([server({ type: 'project.unresolved', projectId: 'p1' })], at).state,
      run([intent({ type: 'session.new.open', scratch: true })], at).state,
    ]) {
      const r = run([intent({ type: 'session.open', id: 's1', focus: 'terminal' })], before);
      expect(r.state).toEqual(before);
      expect(r.effects).toEqual([]);
    }
  });
  it('パレットや読むだけのダイアログなら、閉じてから移る', () => {
    for (const open of [intent({ type: 'palette.open' }), intent({ type: 'shortcuts.open' })]) {
      const r = run([open, intent({ type: 'session.open', id: 's1', focus: 'terminal' })]);
      expect(r.state.overlay).toEqual({ kind: 'none' });
      expect(r.effects).toContainEqual({ kind: 'navigate', route: { name: 'session', id: 's1' } });
    }
  });
});

describe('ダイアログを開いている間の画面の移動', () => {
  // ⌘, の設定、⌘[ ⌘] の戻る進む、パレットの行など、ダイアログの裏で画面を移す経路は、入力待ちのカードと同じ規則で止める。
  const at = run([runtime({ type: 'hash.changed', route: { name: 'home' } })]).state;
  const holding: [string, State][] = [
    ['停止の確認', run([intent({ type: 'session.kill', runId: 'r1', working: true, shellTabs: 0 })], at).state],
    ['未解決のプロジェクト', run([server({ type: 'project.unresolved', projectId: 'p1' })], at).state],
    ['新しいセッション', run([intent({ type: 'session.new.open', scratch: true })], at).state],
    ['昇格', run([intent({ type: 'session.promote.open', id: 's1' })], at).state],
    ['保持期間', run([intent({ type: 'retention.edit', days: 365, from: 'banner' })], at).state],
    ['設定の取り込み', run([intent({ type: 'sync.config.preview' })], at).state],
  ];
  const moves: Input[] = [
    intent({ type: 'nav.go', to: { name: 'settings' } }),
    intent({ type: 'nav.back' }),
    intent({ type: 'nav.forward' }),
    intent({ type: 'project.open', id: 'p1' }),
    intent({ type: 'search.query', text: 'x' }),
    intent({ type: 'search.clear' }),
    intent({ type: 'palette.run', command: { id: 'cmd:settings', label: '設定' } }),
    intent({ type: 'palette.run', command: { id: 'go:sessions', label: 'セッション' } }),
    intent({ type: 'palette.run', command: { id: 'project:p1', label: 'p1' } }),
    intent({ type: 'palette.run', command: { id: 'session:s1', label: 's1' } }),
    intent({ type: 'palette.run', command: { id: 'search:x', label: 'x' } }),
  ];
  it.each(holding)('%s の上では、裏の画面を移さない', (_name, before) => {
    expect(before.overlay.kind).not.toBe('none');
    for (const m of moves) {
      const r = run([m], before);
      expect(r.state).toEqual(before);
      expect(r.effects).toEqual([]);
    }
  });
  // ブラウザの戻る・進む（マウスの戻るボタンなど）は Intent を通らず、URL の変化として届く。何段動いたか（moved）が添えてある。
  it.each(holding)('%s の上でブラウザの戻る・進むが来たら、画面を移さず履歴を同じ段だけ戻す', (_name, before) => {
    const back = run([runtime({ type: 'hash.changed', route: { name: 'settings' }, moved: -1 })], before);
    expect(back.state).toEqual(before);
    expect(back.effects).toEqual([{ kind: 'history.go', delta: 1 }]);
    expect(run([runtime({ type: 'hash.changed', route: { name: 'settings' }, moved: 2 })], before).effects).toEqual([{ kind: 'history.go', delta: -2 }]);
    // 段が分からない（URL を手で書き換えた）ときは、いまの画面の URL を入れ直す。
    expect(run([runtime({ type: 'hash.changed', route: { name: 'settings' }, moved: 0 })], before).effects).toEqual([{ kind: 'navigate', route: { name: 'home' } }]);
  });
  it('履歴の移動でいまの画面と同じ URL に着いたとき（戻し終えたとき）は、何もしない', () => {
    const before = holding[0]![1];
    const r = run([runtime({ type: 'hash.changed', route: { name: 'home' }, moved: 1 })], before);
    expect(r.state).toEqual(before);
    expect(r.effects).toEqual([]);
  });
  it('ダイアログが無ければ、ブラウザの戻るはそのまま画面を移す', () => {
    expect(run([runtime({ type: 'hash.changed', route: { name: 'settings' }, moved: -1 })], at).state.screen).toEqual({ name: 'settings' });
  });
  it('パレットや読むだけのダイアログなら、閉じてから移る', () => {
    for (const open of [intent({ type: 'palette.open' }), intent({ type: 'shortcuts.open' })]) {
      const r = run([open, intent({ type: 'nav.go', to: { name: 'settings' } })], at);
      expect(r.state.overlay).toEqual({ kind: 'none' });
      expect(r.effects).toEqual([{ kind: 'navigate', route: { name: 'settings' } }]);
      const b = run([open, intent({ type: 'nav.back' })], at);
      expect(b.effects).toEqual([{ kind: 'history.go', delta: -1 }]);
    }
  });
  // ダイアログの中の操作が意図して移すものは止めない。
  it('ダイアログの中から意図して移る経路は動く', () => {
    // 保持期間の「ほかの期間…」は設定へ移る。
    const retention = run([intent({ type: 'retention.settings' })], holding[4]![1]);
    expect(retention.state.overlay).toEqual({ kind: 'none' });
    expect(retention.effects).toEqual([{ kind: 'navigate', route: { name: 'settings' } }]);
    // 昇格の完了の「プロジェクトを開く」。
    const promoted = { ...at, overlay: { kind: 'promoted' as const, projectId: 'p9', moved: true, reason: null } };
    expect(run([intent({ type: 'project.open', id: 'p9' })], promoted).effects).toEqual([{ kind: 'navigate', route: { name: 'project', id: 'p9' } }]);
    // 新しいセッションの起動の完了は、ダイアログを閉じて開いたセッションへ移る。
    const launched = run([intent({ type: 'session.new.submit', params: { projectId: 'p1' } }), runtime({ type: 'launch.done', sessionId: 's9', runId: 'r9' })], holding[2]![1]);
    expect(launched.state.overlay).toEqual({ kind: 'none' });
    expect(launched.effects).toContainEqual({ kind: 'navigate', route: { name: 'session', id: 's9' } });
    // 確認の承諾の後の移動（引き取りの完了）。
    const adopt = run([intent({ type: 'session.adopt', id: 's1' })], at).state;
    const adopted = run([intent({ type: 'session.adopt', id: 's1', confirmed: true }), runtime({ type: 'launch.done', sessionId: 's1', runId: 'r1' })], adopt);
    expect(adopted.effects).toContainEqual({ kind: 'navigate', route: { name: 'session', id: 's1' } });
  });
});

describe('開いたら端末にフォーカス', () => {
  const focus = { kind: 'focus', target: 'terminal' };
  it('focus: terminal で開くと、その画面に着いたときに端末へフォーカスする', () => {
    const { state, effects } = run([intent({ type: 'session.open', id: 's1', focus: 'terminal' }), runtime({ type: 'hash.changed', route: { name: 'session', id: 's1' } })]);
    expect(effects).toContainEqual({ kind: 'navigate', route: { name: 'session', id: 's1' } });
    expect(effects).toContainEqual(focus);
    expect(state.focusOnOpen).toBeNull();
  });
  it('ふつうに開いたときと、別の画面に着いたときはフォーカスしない', () => {
    const a = run([intent({ type: 'session.open', id: 's1' }), runtime({ type: 'hash.changed', route: { name: 'session', id: 's1' } })]);
    expect(a.effects).not.toContainEqual(focus);
    const b = run([intent({ type: 'session.open', id: 's1', focus: 'terminal' }), runtime({ type: 'hash.changed', route: { name: 'home' } })]);
    expect(b.effects).not.toContainEqual(focus);
    expect(b.state.focusOnOpen).toBeNull();
  });
  it('もうその画面にいれば、移らずにフォーカスだけする', () => {
    const at = run([runtime({ type: 'hash.changed', route: { name: 'session', id: 's1' } })]).state;
    expect(run([intent({ type: 'session.open', id: 's1', focus: 'terminal' })], at).effects).toEqual([focus]);
  });
  // 問いは Claude のタブに出ている。シェルのタブを選んだまま離れていても、答える先は Claude のタブにする。
  const onShell = (start: State = initialState()): State => ({ ...start, sessionView: { s1: { ...defaultSessionView(), selectedTab: 'sh1' } } });
  it('focus: terminal で開くと、シェルのタブを選んでいても Claude のタブに戻す', () => {
    const { state, effects } = run([intent({ type: 'session.open', id: 's1', focus: 'terminal' })], onShell());
    expect(state.sessionView.s1!.selectedTab).toBeNull();
    expect(effects).toContainEqual({ kind: 'storage.save', key: 'sv:s1', value: persistedSessionView(state.sessionView.s1!) });
    expect(effects).toContainEqual({ kind: 'navigate', route: { name: 'session', id: 's1' } });
    // 一度も開いていないセッションは既定の見え方（Claude のタブ）のままなので、何も書かない。
    const fresh = run([intent({ type: 'session.open', id: 's2', focus: 'terminal' })]);
    expect(fresh.state.sessionView.s2).toBeUndefined();
    expect(fresh.effects).toEqual([{ kind: 'navigate', route: { name: 'session', id: 's2' } }]);
    // ふつうに開くときは選んだタブを残す。
    expect(run([intent({ type: 'session.open', id: 's1' })], onShell()).state.sessionView.s1!.selectedTab).toBe('sh1');
  });
  it('その画面でシェルのタブを見ていれば、Claude のタブをつないでからフォーカスする', () => {
    const at = run([runtime({ type: 'hash.changed', route: { name: 'session', id: 's1' } })], onShell()).state;
    const { state, effects } = run([intent({ type: 'session.open', id: 's1', focus: 'terminal' })], at);
    expect(state.sessionView.s1!.selectedTab).toBeNull();
    expect(effects).toEqual([{ kind: 'storage.save', key: 'sv:s1', value: persistedSessionView(state.sessionView.s1!) }, { kind: 'terminal.connect', sessionId: 's1', tabId: null }, focus]);
  });
  it('分割中なら分割を畳んで、Claude のタブだけにする', () => {
    // 右に Claude のタブが居たまま左も Claude にすると、同じ端末が左右に重なる。
    // どちらが Claude のタブかは run を知らない mediator には分からないので、畳むのが確かである。
    for (const [selectedTab, splitTab] of [['sh1', 'r1'], ['r1', 'sh1']] as const) {
      const start: State = { ...initialState(), sessionView: { s1: { ...defaultSessionView(), selectedTab, split: true, splitTab } } };
      const v = run([intent({ type: 'session.open', id: 's1', focus: 'terminal' })], start).state.sessionView.s1!;
      expect(v).toMatchObject({ selectedTab: null, split: false, splitTab: null });
    }
  });
});

describe('次の入力待ちへ（C5）', () => {
  it('どの入力待ちへ移るかはストアを見て決めるので、ランタイムに問う', () => {
    expect(run([intent({ type: 'session.nextWaiting' })]).effects).toEqual([{ kind: 'waiting.next', from: null }]);
    const onS1 = run([runtime({ type: 'hash.changed', route: { name: 'session', id: 's1' } })]).state;
    expect(run([intent({ type: 'session.nextWaiting' })], onS1).effects).toEqual([{ kind: 'waiting.next', from: 's1' }]);
  });
  it('決まったセッションは、ターミナルで答える経路（session.open の focus: terminal）で開く', () => {
    const via = run([runtime({ type: 'waiting.resolved', sessionId: 's2' })]);
    const direct = run([intent({ type: 'session.open', id: 's2', focus: 'terminal' })]);
    expect(via).toEqual(direct);
  });
  it('入力待ちが無ければ短く知らせる', () => {
    expect(run([runtime({ type: 'waiting.resolved', sessionId: null })]).effects).toEqual([{ kind: 'toast', level: 'info', message: '入力待ちのセッションはありません' }]);
  });
  it('パレットからも出せて、パレットは閉じる', () => {
    const opened = run([intent({ type: 'palette.open' })]).state;
    const a = run([intent({ type: 'palette.run', command: { id: 'cmd:next-waiting', label: '次の入力待ちへ' } })], opened);
    expect(a.state.overlay).toEqual({ kind: 'none' });
    expect(a.effects).toEqual([{ kind: 'waiting.next', from: null }]);
    // パレットの上でキーを打ったときも、パレットは閉じる。
    const b = run([intent({ type: 'session.nextWaiting' })], opened);
    expect(b.state.overlay).toEqual({ kind: 'none' });
  });
});

describe('保持期間', () => {
  it('閉じると覚え、保存する', () => {
    const r = run([intent({ type: 'retention.dismiss' })]);
    expect(r.state.retentionBannerDismissed).toBe(true);
    expect(r.effects).toEqual([{ kind: 'storage.save', key: 'retention.bannerDismissed', value: true }]);
  });
  it('開くと下見を取り、書くと送信中になり、書けたら閉じる', () => {
    let r = run([intent({ type: 'retention.edit', days: 365, from: 'banner' })]);
    expect(r.state.overlay).toEqual({ kind: 'retention', days: 365, from: 'banner', reloaded: false, writing: false, previewError: null });
    expect(r.effects).toEqual([{ kind: 'api.retentionPreview', days: 365 }]);
    r = run([intent({ type: 'retention.write' })], r.state);
    expect(r.state.overlay).toMatchObject({ kind: 'retention', writing: true });
    expect(r.effects).toEqual([{ kind: 'api.writeRetention', days: 365 }]);
    // 送信中にもう一度押しても二重に書かない。
    expect(run([intent({ type: 'retention.write' })], r.state).effects).toEqual([]);
    r = run([runtime({ type: 'retention.written', days: 365 })], r.state);
    expect(r.state.overlay).toEqual({ kind: 'none' });
  });
  it('409 なら下見を取り直し、読み直したことを出す', () => {
    const r = run([intent({ type: 'retention.edit', days: 365, from: 'settings' }), intent({ type: 'retention.write' }), runtime({ type: 'retention.conflict', days: 365 })]);
    expect(r.state.overlay).toEqual({ kind: 'retention', days: 365, from: 'settings', reloaded: true, writing: false, previewError: null });
    expect(r.effects.at(-1)).toEqual({ kind: 'api.retentionPreview', days: 365 });
  });
  it('下見に失敗したら、ダイアログの中に理由を残す。開き直すと消える', () => {
    const r = run([intent({ type: 'retention.edit', days: 365, from: 'banner' }), runtime({ type: 'retention.previewFailed', days: 365, message: '設定ファイルの書式を読み取れなかったので書き換えませんでした' })]);
    expect(r.state.overlay).toMatchObject({ kind: 'retention', previewError: '設定ファイルの書式を読み取れなかったので書き換えませんでした' });
    expect(run([intent({ type: 'retention.edit', days: 90, from: 'settings' })], r.state).state.overlay).toMatchObject({ days: 90, previewError: null });
    // 別の日数の下見の失敗は、いま開いている確認には書かない。
    expect(run([runtime({ type: 'retention.previewFailed', days: 90, message: 'x' })], r.state).state.overlay).toMatchObject({ previewError: '設定ファイルの書式を読み取れなかったので書き換えませんでした' });
  });
  it('書き込んでいる間は閉じられない。書き終われば閉じられる', () => {
    const writing = run([intent({ type: 'retention.edit', days: 365, from: 'banner' }), intent({ type: 'retention.write' })]).state;
    expect(run([intent({ type: 'overlay.close' })], writing).state.overlay).toMatchObject({ kind: 'retention', writing: true });
    const failed = run([runtime({ type: 'retention.failed', message: 'x' })], writing).state;
    expect(run([intent({ type: 'overlay.close' })], failed).state.overlay).toEqual({ kind: 'none' });
  });
  it('失敗したら送信中を解いてトーストを出す。「ほかの期間…」は設定画面へ移る', () => {
    const open = run([intent({ type: 'retention.edit', days: 365, from: 'banner' })]).state;
    const f = run([intent({ type: 'retention.write' }), runtime({ type: 'retention.failed', message: 'x' })], open);
    expect(f.state.overlay).toMatchObject({ writing: false });
    expect(f.effects.at(-1)).toEqual({ kind: 'toast', level: 'error', message: 'x' });
    const s = run([intent({ type: 'retention.settings' })], open);
    expect(s.state.overlay).toEqual({ kind: 'none' });
    expect(s.effects).toEqual([{ kind: 'navigate', route: { name: 'settings' } }]);
  });
});

describe('プロジェクトを作る', () => {
  const place = { kind: 'newDir' as const, name: 'fresh', gitInit: true };
  const opened = () => run([intent({ type: 'palette.open' })]).state;
  it('作成のダイアログを開くと、未登録の一覧を取りに行く', () => {
    const { state, effects } = run([intent({ type: 'project.new.open' })]);
    expect(state.overlay).toEqual({ kind: 'newProject' });
    expect(state.projectCreate).toEqual({ kind: 'idle' });
    expect(effects).toContainEqual({ kind: 'api.workspaceDirs' });
  });
  it('新しいセッションのダイアログを開いたときも、未登録の一覧を取りに行く', () => {
    expect(run([intent({ type: 'session.new.open' })]).effects).toContainEqual({ kind: 'api.workspaceDirs' });
    expect(run([intent({ type: 'palette.run', command: { id: 'cmd:new-session', label: '' } })], opened()).effects).toContainEqual({ kind: 'api.workspaceDirs' });
  });
  it('送ると作成を頼み、二重には送らない', () => {
    const { state, effects } = run([intent({ type: 'project.new.open' }), intent({ type: 'project.new.submit', place, startSession: false }), intent({ type: 'project.new.submit', place, startSession: false })]);
    expect(state.projectCreate).toEqual({ kind: 'submitting' });
    expect(effects.filter((e) => (e as { kind: string }).kind === 'api.createProject')).toEqual([{ kind: 'api.createProject', place, startSession: false }]);
  });
  it('作成だけなら閉じてプロジェクトの画面へ移る', () => {
    const { state, effects } = run([intent({ type: 'project.new.open' }), intent({ type: 'project.new.submit', place, startSession: false }), runtime({ type: 'project.create.done', projectId: 'p9', startSession: false })]);
    expect(state.overlay).toEqual({ kind: 'none' });
    expect(state.projectCreate).toEqual({ kind: 'idle' });
    expect(effects).toContainEqual({ kind: 'navigate', route: { name: 'project', id: 'p9' } });
  });
  it('作成して始めるなら、そのプロジェクトを選んだ新しいセッションのダイアログを開く', () => {
    const { state, effects } = run([intent({ type: 'project.new.open' }), intent({ type: 'project.new.submit', place, startSession: true }), runtime({ type: 'project.create.done', projectId: 'p9', startSession: true })]);
    expect(state.overlay).toEqual({ kind: 'newSession', projectId: 'p9', scratch: false });
    expect(state.launch).toEqual({ kind: 'idle' });
    expect(effects).toContainEqual({ kind: 'focus', target: 'newSessionName' });
  });
  it('失敗したらダイアログに残して文言を持つ。閉じた後に届いた失敗はトーストにする', () => {
    const a = run([intent({ type: 'project.new.open' }), intent({ type: 'project.new.submit', place, startSession: false }), runtime({ type: 'project.create.failed', message: '/w/fresh は既にあります' })]);
    expect(a.state.overlay).toEqual({ kind: 'newProject' });
    expect(a.state.projectCreate).toEqual({ kind: 'failed', message: '/w/fresh は既にあります' });
    const b = run([intent({ type: 'project.new.open' }), intent({ type: 'project.new.submit', place, startSession: false }), intent({ type: 'overlay.close' }), runtime({ type: 'project.create.failed', message: 'x' })]);
    expect(b.state.overlay).toEqual({ kind: 'none' });
    // トーストは effect で頼む（promote と同じ）。runtime がそれを server の toast に直して state.toasts に積む。
    expect(b.effects).toContainEqual({ kind: 'toast', level: 'error', message: 'x' });
  });
  it('起動のダイアログから place 付きで送ると、作ってから起動するよう頼む', () => {
    const { state, effects } = run([intent({ type: 'session.new.open' }), intent({ type: 'session.new.submit', params: { name: 'n' }, place })]);
    expect(state.launch).toEqual({ kind: 'submitting' });
    expect(effects).toContainEqual({ kind: 'api.createProjectThenLaunch', place, params: { name: 'n' } });
  });
  it('作れた後に起動だけ失敗したら、作ったプロジェクトを失敗の状態に持ち、詳細はそのプロジェクトの前回値にする', () => {
    const { state } = run([
      intent({ type: 'session.new.open' }),
      intent({ type: 'session.new.submit', params: { model: 'opus' }, place }),
      runtime({ type: 'project.created', projectId: 'p9', params: { model: 'opus', projectId: 'p9' } }),
      runtime({ type: 'launch.failed', message: 'tmux が見つかりません' }),
    ]);
    expect(state.launch).toEqual({ kind: 'failed', message: 'tmux が見つかりません', createdProjectId: 'p9' });
    expect(state.overlay).toMatchObject({ kind: 'newSession', projectId: null });
    expect(state.launchPrefs.p9).toEqual({ model: 'opus' });
  });
  it('Finder を頼むと殻に頼み、選ばれたパスは回数を添えて持つ', () => {
    const { state, effects } = run([intent({ type: 'folder.pick' }), runtime({ type: 'folder.picked', path: '/x' }), runtime({ type: 'folder.picked', path: '/x' })]);
    expect(effects).toEqual([{ kind: 'desktop.pickFolder' }]);
    expect(state.pickedFolder).toEqual({ path: '/x', n: 2 });
  });
  it('Finder のパスは NFC にそろえ、末尾の / を落とす（根の / はそのまま）', () => {
    const nfd = '/w/が'.normalize('NFD');
    expect(nfd).not.toBe('/w/が');
    expect(run([runtime({ type: 'folder.picked', path: `${nfd}/` })]).state.pickedFolder).toEqual({ path: '/w/が', n: 1 });
    expect(run([runtime({ type: 'folder.picked', path: '/' })]).state.pickedFolder).toEqual({ path: '/', n: 1 });
  });
  it('未登録の一覧が届いたら持つ', () => {
    const dirs = [{ name: 'a', path: '/w/a' }];
    expect(run([runtime({ type: 'workspaceDirs.loaded', dirs })]).state.workspaceDirs).toEqual(dirs);
  });
  it('作成のダイアログは Esc（overlay.close）で閉じ、状態を idle に戻す', () => {
    const { state } = run([intent({ type: 'project.new.open' }), intent({ type: 'project.new.submit', place, startSession: false }), intent({ type: 'overlay.close' })]);
    expect(state.overlay).toEqual({ kind: 'none' });
    expect(state.projectCreate).toEqual({ kind: 'idle' });
  });
  it('パレットの「新しいプロジェクト」で作成のダイアログを開く', () => {
    const { state } = run([intent({ type: 'palette.open' }), intent({ type: 'palette.run', command: { id: 'cmd:new-project', label: '新しいプロジェクト' } })]);
    expect(state.overlay).toEqual({ kind: 'newProject' });
  });
});

describe('セッションの状態', () => {
  it('状態の操作は api 効果になる。本文には渡されたものだけを載せる', () => {
    const r = run([
      intent({ type: 'session.state.set', id: 's1', status: 'done' }),
      intent({ type: 'session.state.set', id: 's1', status: 'paused', note: '明日見る', returnOn: '2026-10-02' }),
      intent({ type: 'session.state.set', id: 's1', status: null }),
      intent({ type: 'session.state.confirm', id: 's1' }),
      intent({ type: 'session.state.confirm', id: 's1', returnOn: '2026-10-05' }),
      intent({ type: 'session.state.reject', id: 's1' }),
      intent({ type: 'session.state.set', id: 's1', status: 'paused', returnOn: '2026-10-05', returnTime: '13:30' }),
      intent({ type: 'session.state.confirm', id: 's1', returnOn: '2026-10-05', returnTime: '21:50' }),
    ]);
    expect(r.effects).toEqual([
      { kind: 'api.setSessionState', id: 's1', body: { status: 'done' } },
      { kind: 'api.setSessionState', id: 's1', body: { status: 'paused', note: '明日見る', returnOn: '2026-10-02' } },
      { kind: 'api.setSessionState', id: 's1', body: { status: null } },
      { kind: 'api.confirmSessionState', id: 's1', body: {} },
      { kind: 'api.confirmSessionState', id: 's1', body: { returnOn: '2026-10-05' } },
      { kind: 'api.rejectSessionState', id: 's1' },
      { kind: 'api.setSessionState', id: 's1', body: { status: 'paused', returnOn: '2026-10-05', returnTime: '13:30' } },
      { kind: 'api.confirmSessionState', id: 's1', body: { returnOn: '2026-10-05', returnTime: '21:50' } },
    ]);
    expect(r.state).toEqual(initialState());
  });
  it('Paused の入力を開いて閉じる。そのセッションへ送ったら閉じる', () => {
    const opened = run([intent({ type: 'session.pause.open', id: 's1', from: 'candidate' })]);
    expect(opened.state.overlay).toEqual({ kind: 'pause', sessionId: 's1', from: 'candidate' });
    expect(run([intent({ type: 'session.pause.close' })], opened.state).state.overlay).toEqual({ kind: 'none' });
    expect(run([intent({ type: 'overlay.close' })], opened.state).state.overlay).toEqual({ kind: 'none' });
    expect(run([intent({ type: 'session.state.set', id: 's1', status: 'paused', returnOn: '2026-10-02' })], opened.state).state.overlay).toEqual({ kind: 'none' });
    expect(run([intent({ type: 'session.state.confirm', id: 's1', returnOn: '2026-10-02' })], opened.state).state.overlay).toEqual({ kind: 'none' });
    // 別のセッションへの操作では閉じない。
    expect(run([intent({ type: 'session.state.set', id: 's2', status: 'done' })], opened.state).state.overlay).toEqual({ kind: 'pause', sessionId: 's1', from: 'candidate' });
  });
  it('入力のあるダイアログの上には開かない', () => {
    const busy: State = { ...initialState(), overlay: { kind: 'promote', sessionId: 's9' } };
    expect(run([intent({ type: 'session.pause.open', id: 's1', from: 'menu' })], busy).state.overlay).toEqual({ kind: 'promote', sessionId: 's9' });
  });
});

describe('アカウント', () => {
  const effectsOf = (i: Extract<Input, { kind: 'intent' }>['intent'], start: State = initialState()) => run([intent(i)], start).effects;
  it('読み込み、選択、更新、ログイン、ログインの取り消し、取り直しは、それぞれの Effect を 1 つ出す', () => {
    expect(effectsOf({ type: 'accounts.load' })).toEqual([{ kind: 'api.accounts.load' }]);
    expect(effectsOf({ type: 'account.choose', accountId: 'a1' })).toEqual([{ kind: 'api.accounts.setCurrent', accountId: 'a1' }]);
    expect(effectsOf({ type: 'account.update', accountId: 'a1', name: '研究室', color: '#7a4a9e' })).toEqual([{ kind: 'api.accounts.update', accountId: 'a1', patch: { name: '研究室', color: '#7a4a9e' } }]);
    expect(effectsOf({ type: 'account.update', accountId: 'a1', color: '#7a4a9e' })).toEqual([{ kind: 'api.accounts.update', accountId: 'a1', patch: { color: '#7a4a9e' } }]);
    expect(effectsOf({ type: 'account.login', accountId: 'a1' })).toEqual([{ kind: 'api.accounts.login', accountId: 'a1' }]);
    expect(effectsOf({ type: 'account.login.cancel', accountId: 'a1' })).toEqual([{ kind: 'api.accounts.cancelLogin', accountId: 'a1' }]);
    expect(effectsOf({ type: 'account.refresh', accountId: 'a1' })).toEqual([{ kind: 'api.accounts.refresh', accountId: 'a1' }]);
  });
  it('更新の名前は前後の空白を落とし、空になれば patch に入れず、patch が空なら Effect を出さない', () => {
    expect(effectsOf({ type: 'account.update', accountId: 'a1', name: '  研究室 ' })).toEqual([{ kind: 'api.accounts.update', accountId: 'a1', patch: { name: '研究室' } }]);
    expect(effectsOf({ type: 'account.update', accountId: 'a1', name: '   ', color: '#7a4a9e' })).toEqual([{ kind: 'api.accounts.update', accountId: 'a1', patch: { color: '#7a4a9e' } }]);
    expect(effectsOf({ type: 'account.update', accountId: 'a1', name: '   ' })).toEqual([]);
    expect(effectsOf({ type: 'account.update', accountId: 'a1' })).toEqual([]);
  });
  it('追加は名前の前後の空白を落とし、空白だけなら何も出さない', () => {
    expect(effectsOf({ type: 'account.add', name: '  大学 ' })).toEqual([{ kind: 'api.accounts.add', name: '大学' }]);
    const blank = run([intent({ type: 'account.add', name: '   ' })]);
    expect(blank.effects).toEqual([]);
    expect(blank.state).toEqual(initialState());
  });
  it('切り替えは confirmed が無ければ確認（作業中の印を運ぶ）で止まり、Effect を出さない', () => {
    const a = run([intent({ type: 'account.switchSession', sessionId: 's1', accountId: 'a1', working: true })]);
    expect(a.state.overlay).toEqual({ kind: 'confirm', confirm: { kind: 'switchAccount', sessionId: 's1', accountId: 'a1', working: true } });
    expect(a.state.launch).toEqual({ kind: 'idle' });
    expect(a.effects).toEqual([]);
  });
  it('切り替えを承諾したら、確認を閉じ、launch を submitting にして Effect を 1 つ出す', () => {
    const asked = run([intent({ type: 'account.switchSession', sessionId: 's1', accountId: 'a1', working: false })]);
    const b = run([intent({ type: 'account.switchSession', sessionId: 's1', accountId: 'a1', working: false, confirmed: true })], asked.state);
    expect(b.state.overlay).toEqual({ kind: 'none' });
    expect(b.state.launch).toEqual({ kind: 'submitting' });
    expect(b.effects).toEqual([{ kind: 'api.accounts.switchSession', sessionId: 's1', accountId: 'a1' }]);
  });
  it('送信中の切り替え（承諾）は何もしない', () => {
    const busy: State = { ...initialState(), launch: { kind: 'submitting' } };
    const r = run([intent({ type: 'account.switchSession', sessionId: 's1', accountId: 'a1', working: false, confirmed: true })], busy);
    expect(r.effects).toEqual([]);
    expect(r.state).toEqual(busy);
  });
  it('削除は confirmed が無ければ確認、あれば確認を閉じて Effect を出す', () => {
    const asked = run([intent({ type: 'account.remove', accountId: 'a1' })]);
    expect(asked.state.overlay).toEqual({ kind: 'confirm', confirm: { kind: 'removeAccount', accountId: 'a1' } });
    expect(asked.effects).toEqual([]);
    const done = run([intent({ type: 'account.remove', accountId: 'a1', confirmed: true })], asked.state);
    expect(done.state.overlay).toEqual({ kind: 'none' });
    expect(done.effects).toEqual([{ kind: 'api.accounts.remove', accountId: 'a1' }]);
  });
  it('切り替えの結果：成功で画面はそのセッションへ、失敗でトーストと failed。確認を閉じた後でも成り立つ', () => {
    const submitted = run([
      intent({ type: 'account.switchSession', sessionId: 's1', accountId: 'a1', working: false }),
      intent({ type: 'account.switchSession', sessionId: 's1', accountId: 'a1', working: false, confirmed: true }),
    ]).state;
    const ok = run([runtime({ type: 'launch.done', sessionId: 's1', runId: 'r1' })], submitted);
    expect(ok.state.launch).toEqual({ kind: 'idle' });
    expect(ok.effects).toContainEqual({ kind: 'navigate', route: { name: 'session', id: 's1' } });
    const ng = run([runtime({ type: 'launch.failed', message: '同じアカウントです' })], submitted);
    expect(ng.state.launch).toEqual({ kind: 'failed', message: '同じアカウントです' });
    expect(ng.effects).toEqual([{ kind: 'toast', level: 'error', message: '同じアカウントです' }]);
  });
});

describe('使われていない口を消した後', () => {
  it('未実装の知らせのオーバーレイと、要約の開閉は持たない', () => {
    expectTypeOf<Extract<Overlay, { kind: 'notYet' }>>().toBeNever();
    expectTypeOf<SessionViewState>().not.toHaveProperty('summaryOpen');
  });
});
