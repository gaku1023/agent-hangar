import { describe, expect, it } from 'vitest';
import { translator, type ProjectDto, type ResumeHerePlanDto, type SessionDto, type SessionLockDto } from '@agent-hangar/shared';
import { initialState } from '../mediator/transition.ts';
import { initialStore, type Store } from '../store/store.ts';
import { presentSessionRow } from './row.ts';
import { presentSession, sessionActions } from './session.ts';
import { presentResumeHere, resumeHereOf } from './resumeHere.ts';

const NOW = new Date(2026, 9, 13, 12, 0).getTime();
const ja = translator('ja');
const session = (over: Partial<SessionDto> = {}): SessionDto => ({ id: 's1', provider: 'claude-code', providerSessionId: 'u1', projectId: 'p1', name: 'notes', cwd: 'D:\\src\\notes-app', firstPrompt: 'first', aiTitle: null, startedAt: NOW - 7_200_000, lastActivityAt: NOW - 60_000, hasTranscript: true, live: null, summary: null, stats: { turns: 2, model: null, effort: null, filesChanged: 0, prUrl: null, inputTokens: 0, outputTokens: 0, contextPercent: null, costUsd: null }, fromScratch: false, lock: null, remoteOnly: true, transcriptMtime: null, activity: null, state: null, parked: false, stoppedByStatus: false, liveAside: null, waitingFor: null, permission: null, limit: null, interrupted: null, overlap: null, ...over });
const project = (over: Partial<ProjectDto> = {}): ProjectDto => ({ id: 'p1', name: 'notes-app', status: 'active', isScratch: false, path: '/Users/me/src/notes-app', resolved: true, lastActivityAt: null, runningCount: 0, openTodoCount: 0, memoHead: null, updatedAt: 1, unresolved: null, ...over });
const lock = (over: Partial<SessionLockDto> = {}): SessionLockDto => ({ deviceId: 'win', deviceName: 'work-pc', runId: 'r1', heartbeatAt: NOW - 60_000, stale: false, ...over });
const storeWith = (s: SessionDto, p: ProjectDto | null = project()): Store => ({ ...initialStore(), sessions: { [s.id]: s }, projects: p ? { [p.id]: p } : {} } as Store);
const NO_ROOT = 'この PC にこのプロジェクトのフォルダがありません。先に場所を指定してください。';

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
  it('ほかの PC で実行中なら、場所より先に実行中を理由にする', () => {
    const s = session({ lock: lock() });
    const r = resumeHereOf(storeWith(s, project({ resolved: false, path: null, unresolved: { kind: 'elsewhere', previousPath: null, deviceName: null } })), s, ja)!;
    expect(r.disabled).toBe('work-pc で実行中です。止まるか応答が無くなると選べます');
    expect(r.noRoot).toEqual({ reason: NO_ROOT, projectId: 'p1' });
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
  };
  it('前の PC とこの PC を 2 枚のカードにし、最後に使った日時と同期されないものを添える', () => {
    expect(presentResumeHere(ja, plan, '/Users/me')).toEqual({
      sessionId: 's1',
      title: 'ほかの PC で進めた会話を、この PC で再開しますか',
      lead: 'この会話は work-pc で進めたものです。',
      from: { label: '前の PC', name: 'work-pc', os: 'Windows', path: 'D:\\src\\notes-app', at: '最後に使った日時：2026-10-12 18:42' },
      to: { label: 'この PC', name: 'this-mac', os: 'macOS', path: '~/src/notes-app', at: null },
      band: { strong: 'プロジェクトのファイル、未コミットの変更、開発環境（道具、環境変数、秘密の値）は同期されません。', text: '同期されるのは会話のトランスクリプトと hangar の記録だけです。' },
      action: 'この PC で再開',
      blocked: null,
    });
  });
  it('分からない名前と OS は言い換え、この PC で場所が決まらなければ押せなくして理由を言う', () => {
    const p = presentResumeHere(ja, { sessionId: 's1', from: { deviceName: null, platform: null, path: '/x', lastAt: null }, to: { deviceName: null, platform: 'linux', path: null } }, null);
    expect(p.lead).toBe('この会話は ほかの PC で進めたものです。');
    expect(p.from).toMatchObject({ name: 'ほかの PC', os: null, at: '最後に使った日時：不明' });
    expect(p.to).toMatchObject({ name: 'この PC', os: 'Linux', path: null });
    expect(p.blocked).toBe(NO_ROOT);
  });
  it('英語の画面では英語で出す', () => {
    const p = presentResumeHere(translator('en'), plan, '/Users/me');
    expect(p.title).toBe('Resume a conversation from another computer on this computer?');
    expect(p.from.label).toBe('Previous computer');
    expect(p.action).toBe('Resume on this computer');
  });
});
