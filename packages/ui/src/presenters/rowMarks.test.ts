import { describe, expect, it } from 'vitest';
import { translator, type SessionDto, type SessionStateDto, type SessionSummaryDto } from '@agent-hangar/shared';
import { initialStore } from '../store/store.ts';
import { prNumberOf, presentSessionRow, statusMark } from './row.ts';

const ja = translator('ja');
const en = translator('en');
const st = (o: Partial<SessionStateDto>): SessionStateDto => ({ status: 'done', note: null, returnOn: null, returnTime: null, setBy: 'user', setAt: 1, candidate: null, ...o });
const sum = (state: SessionSummaryDto['state'], source: SessionSummaryDto['source'] = 'post_hoc'): SessionSummaryDto => ({ title: 't', oneLiner: 'o', body: 'b', state, nextSteps: [], source, sourceId: null, sourceModel: null, basedOnTurns: 5, updatedAt: 1 });
const turns = (n: number) => ({ turns: n, model: null, effort: null, filesChanged: 0, prUrl: null, inputTokens: 0, outputTokens: 0, contextPercent: null, costUsd: null });

// 状態の札は英語のまま、日本語の説明をツールチップで添える。自動で付いた Done は印で見分ける（2026-10-13 の決定、4a）。
describe('statusMark（状態の札の説明と自動の印）', () => {
  it('札ごとに、用語集の説明をツールチップにする', () => {
    expect(statusMark(ja, null, turns(5), null)).toEqual({ title: '進行中のもの', auto: false });
    expect(statusMark(ja, st({ status: 'paused' }), turns(5), null)).toEqual({ title: '一時的に止めているもの', auto: false });
    expect(statusMark(ja, st({ status: 'done' }), turns(5), null)).toEqual({ title: '完了したもの', auto: false });
    expect(statusMark(ja, st({ status: 'archived' }), turns(5), null)).toEqual({ title: '一覧に表示しないもの', auto: false });
    expect(statusMark(en, st({ status: 'paused' }), turns(5), null).title).toBe('On hold for now');
  });
  it('会話で利用者が選んだものは、その旨を添える', () => {
    expect(statusMark(ja, st({ status: 'done', setBy: 'conversation' }), turns(5), null).title).toBe('完了したもの · 会話で承認');
  });
  it('自動で付いた Done（set_by が import）は印を立て、理由を言う', () => {
    expect(statusMark(ja, st({ setBy: 'import' }), turns(2), null)).toEqual({ title: 'hangar が自動で Done にしました（3 ターン以下で止まった会話）', auto: true });
    expect(statusMark(ja, st({ setBy: 'import' }), turns(9), sum('abandoned'))).toEqual({ title: 'hangar が自動で Done にしました（要約が「完了」か「中止」）', auto: true });
    expect(statusMark(ja, st({ setBy: 'import', note: '直して main に入れた' }), turns(9), sum('done'))).toEqual({ title: 'Claude の Done の提案を、7 日たったので自動で確定しました', auto: true });
    // 理由の分からないもの（導入時の一括 Done など）は、自動で付いたことだけを言う。
    expect(statusMark(ja, st({ setBy: 'import' }), turns(9), sum('done', 'baseline'))).toEqual({ title: 'hangar が自動で Done にしました', auto: true });
    expect(statusMark(en, st({ setBy: 'import' }), turns(2), null).title).toBe('Hangar marked this Done automatically (stopped with 3 turns or fewer)');
  });
  it('一覧の行は、札の説明と自動の印を持つ', () => {
    const base = { id: 's1', provider: 'claude-code', providerSessionId: 'u', projectId: null, name: 'n', cwd: '/w', firstPrompt: null, aiTitle: null, startedAt: 1, lastActivityAt: 1, hasTranscript: true, live: null, summary: null, stats: turns(1), fromScratch: false, lock: null, remoteOnly: false, transcriptMtime: null, activity: null, state: st({ setBy: 'import' }), parked: false, stoppedByStatus: false, liveAside: null, waitingFor: null, permission: null, limit: null, interrupted: null, overlap: null } as SessionDto;
    const row = presentSessionRow(base, initialStore(), 10);
    expect(row).toMatchObject({ state: 'done', setBy: 'import', autoDone: true, statusTitle: 'hangar が自動で Done にしました（3 ターン以下で止まった会話）' });
    expect(presentSessionRow({ ...base, state: null }, initialStore(), 10)).toMatchObject({ autoDone: false, statusTitle: '進行中のもの' });
  });
});

describe('prNumberOf（行の 2 段目の右端の「PR #88」）', () => {
  it('PR の URL の末尾の番号を取る', () => {
    expect(prNumberOf('https://github.com/o/r/pull/88')).toBe('88');
    expect(prNumberOf('https://github.com/o/r/pull/88/files')).toBe('88');
    expect(prNumberOf('https://github.com/o/r/pull/88?x=1')).toBe('88');
    expect(prNumberOf('https://github.com/o/r/pull/88#issuecomment-1')).toBe('88');
  });
  it('この形でない URL と、URL が無いときは null（「PR」とだけ出す）', () => {
    expect(prNumberOf('https://gitlab.com/o/r/-/merge_requests/9')).toBeNull();
    expect(prNumberOf('https://github.com/o/r/pull/abc')).toBeNull();
    expect(prNumberOf(null)).toBeNull();
  });
});
