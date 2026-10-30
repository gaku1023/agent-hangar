import { describe, expect, it } from 'vitest';
import type { InterruptedDto, ProjectDto, RunDto, SessionDto } from '@agent-hangar/shared';
import { initialState } from '../mediator/transition.ts';
import { interruptedStep } from '../mediator/interrupted.ts';
import type { State } from '../mediator/types.ts';
import { initialStore, type Store } from '../store/store.ts';
import { accountsFixture } from '../test/accounts.ts';
import { presentHomeScreen } from './home.ts';
import { translatorOf } from './i18n.ts';
import { interruptMark, presentInterrupted } from './interrupted.ts';
import { presentSessionRow } from './row.ts';

const NOW = new Date(2026, 9, 12, 9, 0).getTime();
const at = (h: number, m: number, d = 12) => new Date(2026, 9, d, h, m).getTime();
const project: ProjectDto = { id: 'p1', name: 'alpha-web', status: 'active', isScratch: false, path: '/w/alpha', resolved: true, lastActivityAt: NOW, runningCount: 0, openTodoCount: 0, memoHead: null, updatedAt: 1 };
const dto = (id: string, over: Partial<SessionDto> = {}): SessionDto => ({ id, provider: 'claude-code', providerSessionId: 'u' + id, projectId: 'p1', name: `n-${id}`, cwd: '/w/alpha', firstPrompt: `first ${id}`, aiTitle: null, startedAt: at(1, 0), lastActivityAt: at(3, 0), lastTurnAt: null, hasTranscript: true, live: null, summary: null, stats: { turns: 2, model: null, effort: null, filesChanged: 0, prUrl: null, inputTokens: 0, outputTokens: 0, contextPercent: null, costUsd: null }, fromScratch: false, lock: null, remoteOnly: false, transcriptMtime: null, activity: null, state: null, parked: false, stoppedByStatus: false, liveAside: null, waitingFor: null, permission: null, limit: null, interrupted: { at: at(3, 12), cause: 'restart' }, overlap: null, newerElsewhere: false, takenOver: null, fromPhone: null, unread: null, spawnedBy: null, ...over });
const group: InterruptedDto = {
  at: at(3, 12), cause: 'restart',
  items: [
    { sessionId: 'idle1', runId: 'r-idle1', lastLive: 'idle', endedAt: at(3, 12), account: null },
    { sessionId: 'busy1', runId: 'r-busy1', lastLive: 'busy', endedAt: at(3, 12), account: null },
    { sessionId: 'wait1', runId: 'r-wait1', lastLive: 'waiting', endedAt: at(3, 12), account: 'a1' },
    { sessionId: 'busy2', runId: 'r-busy2', lastLive: 'busy', endedAt: at(3, 12), account: null },
  ],
};
function storeOf(over: Partial<Store> = {}): Store {
  const sessions = [
    dto('idle1', { lastActivityAt: at(2, 51) }),
    dto('busy1', { lastActivityAt: at(3, 8) }),
    dto('wait1', { lastActivityAt: at(3, 10) }),
    dto('busy2', { lastActivityAt: at(3, 11), summary: { title: 't', oneLiner: 'lockfile を作り直す', body: '', state: 'in_progress', nextSteps: [], source: 'in_session', sourceId: null, sourceModel: null, basedOnTurns: 1, updatedAt: 1 } }),
  ];
  return { ...initialStore(), projects: { p1: project }, sessions: Object.fromEntries(sessions.map((s) => [s.id, s])), interrupted: group, ...over };
}

describe('presentInterrupted（帯の「前回実行中」の群）', () => {
  it('止まる前に作業中だったもの、入力待ち、アイドルの順で、同じなら新しい順に並べる', () => {
    const g = presentInterrupted(initialState(), storeOf(), NOW)!;
    expect(g).toMatchObject({ id: 'interrupted', label: '前回実行中', count: 4, summary: 'PC の再起動で中断（03:12）', morning: true });
    expect(g.rows.map((r) => r.key)).toEqual(['int:r-busy2', 'int:r-busy1', 'int:r-wait1', 'int:r-idle1']);
    expect(g.rows[0]).toMatchObject({ name: 'n-busy2', context: 'alpha-web', textHead: { text: '作業中だった', tone: 'busy' }, text: 'lockfile を作り直す', trail: [{ text: '03:11' }], lead: { kind: 'ring', spin: false } });
    expect(g.rows[2]!.textHead).toEqual({ text: '入力待ちだった', tone: 'wait' });
    expect(g.rows[3]!.textHead).toEqual({ text: 'アイドルだった', tone: 'faint' });
    expect(g.rows[0]!.actions.map((a) => [a.id, a.label, a.send])).toEqual([
      ['resume', '再開', { type: 'interrupted.resume', ids: ['busy2'] }],
      ['skip', '再開しない', { type: 'interrupted.dismiss', runIds: ['r-busy2'], dismissed: true, name: 'n-busy2' }],
    ]);
    expect(g.headActions?.map((a) => [a.id, a.send])).toEqual([
      ['resumeAll', { type: 'interrupted.resume', ids: ['busy2', 'busy1', 'wait1', 'idle1'] }],
      ['close', { type: 'interrupted.dismiss', runIds: ['r-busy2', 'r-busy1', 'r-wait1', 'r-idle1'], dismissed: true }],
    ]);
    // アカウントが 1 件の人には小見出しを出さない。
    expect(g.rows.every((r) => r.section === undefined)).toBe(true);
  });

  it('「すべて再開」を押した直後、同時に頼む 2 本だけが回り、残りは「順番待ち」の見た目（回らない）にする', () => {
    const store = storeOf();
    const g0 = presentInterrupted(initialState(), store, NOW)!;
    const send = g0.headActions!.find((a) => a.id === 'resumeAll')!.send;
    const step = interruptedStep(initialState(), store, { kind: 'action', action: send as never })!;
    const g = presentInterrupted(step.state, store, NOW)!;
    expect(g.rows.map((r) => [r.key, r.textHead?.text, r.lead.kind === 'ring' ? r.lead.spin : null])).toEqual([
      ['int:r-busy2', '再開中', true], ['int:r-busy1', '再開中', true], ['int:r-wait1', '順番待ち', false], ['int:r-idle1', '順番待ち', false],
    ]);
  });

  it('ステータスを付けたもの、再開したもの、中断の印が消えたものは出さない。全部消えたら null', () => {
    const run: RunDto = { id: 'new', sessionId: 'busy1', deviceId: 'd', kind: 'resume', tmuxName: 'hangar-new', pid: null, startedAt: NOW, endedAt: null, endReason: null, heartbeatAt: NOW };
    const s = storeOf();
    s.sessions = { ...s.sessions, idle1: { ...s.sessions.idle1!, state: { status: 'done', note: null, returnOn: null, returnTime: null, setBy: 'user', setAt: NOW, candidate: null } }, wait1: { ...s.sessions.wait1!, interrupted: null } };
    s.runs = { new: run };
    expect(presentInterrupted(initialState(), s, NOW)!.rows.map((r) => r.key)).toEqual(['int:r-busy2']);
    expect(presentInterrupted(initialState(), { ...s, interrupted: { ...group, items: [group.items[0]!] } }, NOW)).toBeNull();
    expect(presentInterrupted(initialState(), { ...s, interrupted: null }, NOW)).toBeNull();
  });

  it('順番待ち、再開中、失敗を行に出し、残りがあれば「残りをキャンセル」にする', () => {
    const state: State = { ...initialState(), resumeQueue: { queued: ['wait1'], active: ['busy2'], failed: { busy1: '作業ディレクトリが見つかりません' } } };
    const g = presentInterrupted(state, storeOf(), NOW)!;
    const row = (k: string) => g.rows.find((r) => r.key === k)!;
    expect(row('int:r-busy2')).toMatchObject({ textHead: { text: '再開中', tone: 'busy' }, lead: { kind: 'ring', spin: true } });
    expect(row('int:r-busy2').actions[0]).toMatchObject({ disabled: true });
    expect(row('int:r-wait1')).toMatchObject({ textHead: { text: '順番待ち', tone: 'faint' } });
    expect(row('int:r-busy1')).toMatchObject({ textHead: { text: '失敗', tone: 'error' }, text: '作業ディレクトリが見つかりません' });
    expect(row('int:r-busy1').actions[0]).toMatchObject({ label: '再試行', send: { type: 'interrupted.resume', ids: ['busy1'] } });
    expect(g.headActions?.map((a) => a.id)).toEqual(['cancelRest', 'close']);
  });

  it('アカウントが 2 件以上なら、アカウントごとの小見出しと使用率を置き、未ログインのアカウントの行は押せない', () => {
    const accounts = { ...accountsFixture, accounts: [accountsFixture.accounts[0]!, { ...accountsFixture.accounts[1]!, auth: { ...accountsFixture.accounts[1]!.auth!, loggedIn: false } }] };
    const g = presentInterrupted(initialState(), storeOf({ accounts }), NOW)!;
    expect(g.rows.map((r) => [r.key, r.section?.key])).toEqual([['int:r-busy2', 'primary'], ['int:r-busy1', 'primary'], ['int:r-idle1', 'primary'], ['int:r-wait1', 'a1']]);
    expect(g.rows[0]!.section).toMatchObject({ name: '会社', meter: { percent: 82, high: true }, note: { text: '使用制限に近づいています', tone: 'warn' } });
    expect(g.rows[3]!.section).toMatchObject({ name: '大学', note: { text: '未ログイン', tone: 'faint' }, action: { label: 'ログイン', send: { type: 'account.login', accountId: 'a1' } } });
    expect(g.rows[3]!.actions[0]).toMatchObject({ disabled: true });
    // すべて再開は未ログインの行を飛ばす。
    expect(g.headActions?.[0]?.send).toEqual({ type: 'interrupted.resume', ids: ['busy2', 'busy1', 'idle1'] });
  });

  it('tmux のサーバが止まったときの群と、24 時間を過ぎた群は朝に開かない', () => {
    const mux = presentInterrupted(initialState(), storeOf({ interrupted: { ...group, cause: 'mux' } }), NOW)!;
    expect(mux.summary).toBe('tmux の停止で中断（03:12）');
    expect(presentInterrupted(initialState(), storeOf(), group.at + 25 * 3_600_000)!.morning).toBe(false);
  });

  it('ホームの帯では、場所の不明なプロジェクトより前の群になり、静かな朝はこれが開く', () => {
    const p = presentHomeScreen(initialState(), storeOf(), NOW);
    expect(p.band.groups.map((g) => g.id)).toEqual(['interrupted']);
    expect(p.band.morning).toBe('interrupted');
    expect(p.idle).toBe(false);
  });
});

describe('中断の印（一覧の行と冒頭の 1 枚）', () => {
  it('原因ごとの文と時刻', () => {
    const s = storeOf();
    expect(interruptMark(translatorOf(s), { at: at(3, 12), cause: 'restart' }, NOW)).toEqual({ label: '中断', title: 'PC の再起動で中断 · 03:12' });
    expect(interruptMark(translatorOf(s), { at: at(3, 12, 11), cause: null }, NOW)).toEqual({ label: '中断', title: '中断 · 10/11 03:12' });
  });

  it('一覧の行は、終わっているときだけ右端に「中断」を持つ', () => {
    const s = storeOf();
    expect(presentSessionRow(s.sessions.busy1!, s, NOW).interrupted).toEqual({ label: '中断', title: 'PC の再起動で中断 · 03:12' });
    expect(presentSessionRow({ ...s.sessions.busy1!, interrupted: null }, s, NOW).interrupted).toBeUndefined();
    expect(presentSessionRow({ ...s.sessions.busy1!, live: 'busy' }, s, NOW).interrupted).toBeUndefined();
  });
});
