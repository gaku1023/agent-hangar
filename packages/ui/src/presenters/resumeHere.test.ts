import { describe, expect, it } from 'vitest';
import { translator, type ProjectDto, type ResumeHerePlanDto, type SessionDto, type SessionLockDto } from '@agent-hangar/shared';
import { initialState } from '../mediator/transition.ts';
import { initialStore, type Store } from '../store/store.ts';
import { presentSessionRow } from './row.ts';
import { presentSession, sessionActions } from './session.ts';
import { presentResumeHere, resumeHereOf } from './resumeHere.ts';

const NOW = new Date(2026, 9, 13, 12, 0).getTime();
const ja = translator('ja');
const session = (over: Partial<SessionDto> = {}): SessionDto => ({ id: 's1', provider: 'claude-code', providerSessionId: 'u1', projectId: 'p1', name: 'notes', cwd: 'D:\\src\\notes-app', firstPrompt: 'first', aiTitle: null, startedAt: NOW - 7_200_000, lastActivityAt: NOW - 60_000, hasTranscript: true, live: null, summary: null, stats: { turns: 2, model: null, effort: null, filesChanged: 0, prUrl: null, inputTokens: 0, outputTokens: 0, contextPercent: null, costUsd: null }, fromScratch: false, lock: null, remoteOnly: true, transcriptMtime: null, activity: null, state: null, parked: false, stoppedByStatus: false, liveAside: null, waitingFor: null, permission: null, limit: null, interrupted: null, overlap: null, newerElsewhere: false, ...over });
const project = (over: Partial<ProjectDto> = {}): ProjectDto => ({ id: 'p1', name: 'notes-app', status: 'active', isScratch: false, path: '/Users/me/src/notes-app', resolved: true, lastActivityAt: null, runningCount: 0, openTodoCount: 0, memoHead: null, updatedAt: 1, unresolved: null, ...over });
const lock = (over: Partial<SessionLockDto> = {}): SessionLockDto => ({ deviceId: 'win', deviceName: 'work-pc', runId: 'r1', heartbeatAt: NOW - 60_000, stale: false, ...over });
const storeWith = (s: SessionDto, p: ProjectDto | null = project()): Store => ({ ...initialStore(), sessions: { [s.id]: s }, projects: p ? { [p.id]: p } : {} } as Store);
const NO_ROOT = 'この PC にこのプロジェクトのディレクトリがありません。先にパスを指定してください。';

describe('この PC で再開を押せるか（resumeHereOf）', () => {
  it('ほかの PC の会話でなければ出さない', () => {
    expect(resumeHereOf(storeWith(session({ remoteOnly: false })), session({ remoteOnly: false }), ja)).toBeNull();
  });
  it('この PC にプロジェクトの場所があれば押せる', () => {
    expect(resumeHereOf(storeWith(session()), session(), ja)).toEqual({ disabled: null, noRoot: null });
  });
  it('この PC にプロジェクトの場所が無い（ほかの PC から届いただけ、見つからない）なら、理由と場所の指定の先を返す', () => {
    for (const unresolved of [{ kind: 'elsewhere' as const, previousPath: 'D:\\src\\notes-app', deviceName: 'work-pc' }, { kind: 'missing' as const, previousPath: '/gone', deviceName: null }]) {
      const s = session();
      expect(resumeHereOf(storeWith(s, project({ resolved: false, path: null, unresolved })), s, ja)).toEqual({ disabled: NO_ROOT, noRoot: { reason: NO_ROOT, projectId: 'p1' } });
    }
  });
  it('プロジェクトに属さない会話とスクラッチは、場所で止めない', () => {
    expect(resumeHereOf(storeWith(session({ projectId: null }), null), session({ projectId: null }), ja)?.noRoot).toBeNull();
    const s = session();
    expect(resumeHereOf(storeWith(s, project({ isScratch: true, resolved: false, path: null, unresolved: null })), s, ja)?.noRoot).toBeNull();
  });
  it('ほかの PC で実行中（生きたロック）でも押せる（理由にしない）。場所が無ければ場所を理由にする', () => {
    const s = session({ lock: lock() });
    expect(resumeHereOf(storeWith(s), s, ja)?.disabled).toBeNull();
    const r = resumeHereOf(storeWith(s, project({ resolved: false, path: null, unresolved: { kind: 'elsewhere', previousPath: null, deviceName: null } })), s, ja)!;
    expect(r.disabled).toBe(NO_ROOT);
    expect(r.noRoot).toEqual({ reason: NO_ROOT, projectId: 'p1' });
  });
});

describe('ほかの PC の続きの方が新しい会話（A → B → A）', () => {
  const back = session({ remoteOnly: false, newerElsewhere: true });
  it('手元にトランスクリプトがあっても「この PC で再開」を出す', () => {
    expect(resumeHereOf(storeWith(back), back, ja)).toEqual({ disabled: null, noRoot: null });
  });
  it('見出しの主の操作を「この PC で再開」にし、素の再開は「…」に名前を替えて残す', () => {
    const p = presentSession(initialState(), storeWith(back), NOW, 's1');
    expect(p.actions.primary).toMatchObject({ id: 'resumeHere', disabled: null });
    const resume = p.actions.menu.find((a) => a.id === 'resume');
    expect(resume).toMatchObject({ label: 'この PC のトランスクリプトのまま再開', disabled: null, note: '他の PC で進めた続きは反映されません' });
  });
  it('一覧の行の「⋯」にも「この PC で再開」を足す', () => {
    expect(presentSessionRow(back, storeWith(back), NOW).resumeHere).toEqual({ disabled: null });
  });
  it('ほかの PC で実行中（生きたロック）でも押せる（確認の 1 枚で停止して引き継ぐ）', () => {
    const s = session({ remoteOnly: false, newerElsewhere: true, lock: lock() });
    expect(presentSession(initialState(), storeWith(s), NOW, 's1').actions.primary).toMatchObject({ id: 'resumeHere', disabled: null });
  });
  it('新しい続きが無ければ、今までどおり「再開」が主', () => {
    const s = session({ remoteOnly: false, newerElsewhere: false });
    const p = presentSession(initialState(), storeWith(s), NOW, 's1');
    expect(p.actions.primary).toMatchObject({ id: 'resume', label: '再開' });
    expect(resumeHereOf(storeWith(s), s, ja)).toBeNull();
  });
});

describe('セッション画面の見出しと一覧の行', () => {
  const lost = project({ resolved: false, path: null, unresolved: { kind: 'elsewhere', previousPath: 'D:\\src\\notes-app', deviceName: 'work-pc' } });
  it('場所が無ければ「この PC で再開」を押せなくし、見出しの下の理由と場所の指定の先を持つ', () => {
    const p = presentSession(initialState(), storeWith(session(), lost), NOW, 's1');
    expect(p.actions.primary).toMatchObject({ id: 'resumeHere', disabled: NO_ROOT });
    expect(p.noRoot).toEqual({ reason: NO_ROOT, projectId: 'p1' });
    const ok = presentSession(initialState(), storeWith(session()), NOW, 's1');
    expect(ok.actions.primary).toMatchObject({ id: 'resumeHere', disabled: null });
    expect(ok.noRoot).toBeNull();
  });
  it('sessionActions は noRoot を省いた事実でも、今までどおりに組む', () => {
    const facts: Parameters<typeof sessionActions>[0] = { run: null, live: null, lock: null, remoteOnly: true, hasTranscript: true, canResume: false, canFork: false, canResumeHere: true, outsideOpen: null, canPromote: false, gone: null, summaryPending: false, summaryError: null, fromScratch: false };
    expect(sessionActions(facts, ja).primary).toMatchObject({ id: 'resumeHere', disabled: null });
  });
  it('一覧の行は、ほかの PC の会話にだけ「この PC で再開」を持ち、押せない理由を添える', () => {
    expect(presentSessionRow(session(), storeWith(session(), lost), NOW).resumeHere).toEqual({ disabled: NO_ROOT });
    expect(presentSessionRow(session(), storeWith(session()), NOW).resumeHere).toEqual({ disabled: null });
    expect(presentSessionRow(session({ remoteOnly: false }), storeWith(session({ remoteOnly: false })), NOW).resumeHere).toBeUndefined();
  });
});

describe('この PC で再開の確認（presentResumeHere）', () => {
  const plan: ResumeHerePlanDto = {
    sessionId: 's1',
    from: { deviceName: 'work-pc', platform: 'win32', path: 'D:\\src\\notes-app', lastAt: new Date(2026, 9, 12, 18, 42).getTime() },
    to: { deviceName: 'this-mac', platform: 'darwin', path: '/Users/me/src/notes-app' },
    replace: null,
  };
  it('前の PC とこの PC を 2 枚のカードにし、最後に使った日時と同期されないものを添える', () => {
    expect(presentResumeHere(ja, plan, '/Users/me', NOW)).toEqual({
      sessionId: 's1',
      title: '他の PC で進めた会話を、この PC で再開しますか',
      lead: 'この会話は work-pc で進めたものです。',
      from: { label: '前の PC', name: 'work-pc', os: 'Windows', path: 'D:\\src\\notes-app', at: '最終使用日時：2026-10-12 18:42', note: null },
      to: { label: 'この PC', name: 'this-mac', os: 'macOS', path: '~/src/notes-app', at: null, note: null },
      band: { strong: 'プロジェクトのファイル、未コミットの変更、開発環境（ツール、環境変数、シークレット）は同期されません。', text: '同期されるのは会話のトランスクリプトと hangar の記録だけです。' },
      action: 'この PC で再開',
      blocked: null,
      replace: null,
      overwrite: false,
      mode: 'resume',
      takeover: null,
    });
  });
  it('手元のトランスクリプトを置き換えるときは、バックアップに残すことを 1 行で言い、承諾は上書きつきにする（A → B → A）', () => {
    const ahead = presentResumeHere(ja, { ...plan, replace: { kind: 'ahead', localSize: 10, remoteSize: 99 } }, '/Users/me', NOW);
    expect(ahead).toMatchObject({ replace: 'この PC の古いトランスクリプトはバックアップに残し、他の PC で進めた続きから再開します。', overwrite: true, action: 'この PC で再開' });
    const diverged = presentResumeHere(ja, { ...plan, replace: { kind: 'diverged', localSize: 10, remoteSize: 99 } }, '/Users/me', NOW);
    expect(diverged).toMatchObject({ replace: 'この PC で進めた続きはバックアップに残し、他の PC の続きから再開します。', overwrite: true });
    expect(presentResumeHere(translator('en'), { ...plan, replace: { kind: 'diverged', localSize: 10, remoteSize: 99 } }, '/Users/me', NOW).replace).toMatch(/backup/);
  });
  it('分からない名前と OS は言い換え、この PC で場所が決まらなければ押せなくして理由を言う', () => {
    const p = presentResumeHere(ja, { sessionId: 's1', from: { deviceName: null, platform: null, path: '/x', lastAt: null }, to: { deviceName: null, platform: 'linux', path: null }, replace: null }, null, NOW);
    expect(p.lead).toBe('この会話は 他の PC で進めたものです。');
    expect(p.from).toMatchObject({ name: '他の PC', os: null, at: '最終使用日時：不明' });
    expect(p.to).toMatchObject({ name: 'この PC', os: 'Linux', path: null });
    expect(p.blocked).toBe(NO_ROOT);
  });
  it('ほかの PC のクイックセッションは、作って再開するフォルダのパスと、作ることの 1 行を出し、場所の指定は求めない（6A）', () => {
    const quick: ResumeHerePlanDto = { ...plan, from: { ...plan.from, path: 'C:\\Users\\x\\.agent-hangar\\quick-sessions\\20261016-101010' }, to: { deviceName: 'this-mac', platform: 'darwin', path: '/Users/me/.agent-hangar/quick-sessions/20261016-101010', createsFolder: true } };
    const p = presentResumeHere(ja, quick, '/Users/me', NOW);
    expect(p.to).toEqual({ label: 'この PC', name: 'this-mac', os: 'macOS', path: '~/.agent-hangar/quick-sessions/20261016-101010', at: null, note: 'クイックセッションの保存先に同じ名前の空のディレクトリを作成して、そこで再開します' });
    expect(p.blocked).toBeNull();
    expect(presentResumeHere(translator('en'), quick, '/Users/me', NOW).to.note).toMatch(/quick session/i);
    // 作らないとき（フォルダがある、古いサーバ）は添えない。
    expect(presentResumeHere(ja, { ...quick, to: { ...quick.to, createsFolder: false } }, '/Users/me', NOW).to.note).toBeNull();
  });
  it('英語の画面では英語で出す', () => {
    const p = presentResumeHere(translator('en'), plan, '/Users/me', NOW);
    expect(p.title).toBe('Resume a conversation from another computer on this computer?');
    expect(p.from.label).toBe('Previous computer');
    expect(p.action).toBe('Resume on this computer');
  });
});

describe('ほかの PC で動いている会話を引き継ぐ確認（presentResumeHere）', () => {
  const plan = (lockOver: Partial<NonNullable<ResumeHerePlanDto['lock']>> | null): ResumeHerePlanDto => ({
    sessionId: 's1',
    from: { deviceName: 'pc-b', platform: 'win32', path: 'D:\\src\\notes-app', lastAt: NOW - 3_600_000 },
    to: { deviceName: 'pc-a', platform: 'darwin', path: '/Users/me/src/notes-app' },
    replace: null,
    lock: lockOver === null ? null : { deviceName: 'pc-b', stale: false, working: false, heartbeatAt: NOW - 10_000, ...lockOver },
  });
  it('ロックが無ければ今のまま（mode: resume、赤みの帯なし）', () => {
    expect(presentResumeHere(ja, plan(null), null, NOW)).toMatchObject({ mode: 'resume', title: '他の PC で進めた会話を、この PC で再開しますか', action: 'この PC で再開', takeover: null });
    // 古いサーバは lock を送らない。
    const old = plan(null);
    delete old.lock;
    expect(presentResumeHere(ja, old, null, NOW).mode).toBe('resume');
  });
  it('アイドルの相手には実行中の帯と「停止して引き継ぐ」', () => {
    const p = presentResumeHere(ja, plan({ stale: false, working: false }), null, NOW);
    expect(p).toMatchObject({ mode: 'takeover', title: 'ほかの PC で実行中の会話を、この PC で引き継ぎますか', action: '停止して引き継ぐ' });
    expect(p.takeover).toEqual({ strong: 'pc-b で実行中です', text: '引き継ぐと、pc-b の claude を停止してから、この PC で再開します。' });
    // カードと黄の帯は今のまま。
    expect(p.band.strong).toBe('プロジェクトのファイル、未コミットの変更、開発環境（ツール、環境変数、シークレット）は同期されません。');
  });
  it('作業中の相手には作業中の帯', () => {
    expect(presentResumeHere(ja, plan({ stale: false, working: true }), null, NOW).takeover).toEqual({ strong: 'pc-b で作業中です', text: '停止するとそのターンは途中で切れます。そのあと、この PC で再開します。' });
  });
  it('stale の相手は題を替え、前の PC のカードに最後の応答を出す', () => {
    const p = presentResumeHere(ja, plan({ stale: true, heartbeatAt: NOW - 5 * 60_000 }), null, NOW);
    expect(p).toMatchObject({ mode: 'stale', title: 'pc-b が応答していません。この PC で引き継ぎますか', action: 'このまま引き継ぐ', takeover: null });
    expect(p.from.at).toBe('最後の応答：5 分前');
  });
});
