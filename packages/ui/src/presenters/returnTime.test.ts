import { describe, expect, it } from 'vitest';
import type { ProjectDto, SessionDto, SessionStateDto } from '@agent-hangar/shared';
import { initialState } from '../mediator/transition.ts';
import type { State } from '../mediator/types.ts';
import { initialStore, type Store } from '../store/store.ts';
import { presentHome } from './home.ts';
import { presentPause } from './pause.ts';
import { candidateLabel, presentSessionRow, returnOnLabel } from './row.ts';
import { returnKey } from './sections.ts';

/** 戻る時刻（HH:MM）つきの Paused。2026-10-05（月）の 12:00 を今にする。 */
const at = (h: number, min = 0, d = 5) => new Date(2026, 9, d, h, min).getTime();
const NOW = at(12);
const H = 3_600_000;
const project = (id: string): ProjectDto => ({ id, name: id, status: 'active', isScratch: false, path: `/w/${id}`, resolved: true, lastActivityAt: NOW, runningCount: 0, openTodoCount: 0, memoHead: null, updatedAt: 1 });
const st = (o: Partial<SessionStateDto>): SessionStateDto => ({ status: null, note: null, returnOn: null, returnTime: null, setBy: null, setAt: null, candidate: null, ...o });
const dto = (id: string, hoursAgo: number, state: SessionStateDto): SessionDto => ({ id, provider: 'claude-code', providerSessionId: 'u' + id, projectId: 'alpha', name: id, cwd: '/w/alpha', firstPrompt: 'first', aiTitle: null, startedAt: NOW - (hoursAgo + 1) * H, lastActivityAt: NOW - hoursAgo * H, memo: null, hasTranscript: true, live: null, homeDevice: 'd', summary: null, stats: { filesChanged: 0, prUrl: null, model: null, effort: null, costUsd: null }, state } as unknown as SessionDto);
const paused = (id: string, returnOn: string | null, returnTime: string | null, hoursAgo = 1) => dto(id, hoursAgo, st({ status: 'paused', note: `${id} を確かめる`, returnOn, returnTime, setBy: 'user', setAt: 1 }));
function storeOf(list: SessionDto[]): Store {
  const s = initialStore();
  s.bootstrapped = true;
  s.projects = { alpha: project('alpha') };
  s.sessions = Object.fromEntries(list.map((x) => [x.id, x]));
  return s;
}
const rowOf = (s: SessionDto, now = NOW) => {
  const r = presentSessionRow(s, storeOf([s]), now);
  return { returnOn: r.returnOn, returnTime: r.returnTime, overdueDays: r.overdueDays, returnDue: r.returnDue };
};

describe('returnOnLabel の時刻', () => {
  it('時刻があれば日の後ろに添える。過ぎた日は日数だけを言う', () => {
    expect(returnOnLabel('2026-10-05', 0, '13:30')).toBe('今日 13:30');
    expect(returnOnLabel('2026-10-06', null, '13:30')).toBe('10/6（火）13:30');
    expect(returnOnLabel('2026-10-02', 3, '13:30')).toBe('3 日過ぎ');
  });
  it('時刻が無ければ今までどおり', () => {
    expect(returnOnLabel('2026-10-05', 0)).toBe('今日');
    expect(returnOnLabel('2026-10-05', 0, null)).toBe('今日');
    expect(returnOnLabel('2026-10-06', null, null)).toBe('10/6（火）');
  });
  it('形の違う時刻は出さない', () => {
    expect(returnOnLabel('2026-10-05', 0, '25:00')).toBe('今日');
  });
  it('提案の札にも時刻を出す', () => {
    expect(candidateLabel({ status: 'paused', returnOn: '2026-10-06', returnTime: '13:30' })).toBe('Paused · 10/6（火）13:30？');
    expect(candidateLabel({ status: 'paused', returnOn: '2026-10-06', returnTime: null })).toBe('Paused · 10/6（火）？');
    expect(candidateLabel({ status: 'paused', returnOn: '2026-10-06' })).toBe('Paused · 10/6（火）？');
  });
});

describe('presentSessionRow の戻る時刻', () => {
  it('時刻なしの Paused は今までどおりで、当日は朝から過ぎた扱い（塗る）', () => {
    expect(rowOf(paused('a', '2026-10-05', null), at(0, 1))).toEqual({ returnOn: '2026-10-05', returnTime: null, overdueDays: 0, returnDue: true });
    expect(rowOf(paused('a', '2026-10-06', null))).toEqual({ returnOn: '2026-10-06', returnTime: null, overdueDays: null, returnDue: false });
  });
  it('時刻つきは、当日でも時刻の前は過ぎておらず、時刻になったら過ぎた扱いにする', () => {
    const s = paused('a', '2026-10-05', '13:30');
    expect(rowOf(s, at(13, 29))).toEqual({ returnOn: '2026-10-05', returnTime: '13:30', overdueDays: 0, returnDue: false });
    expect(rowOf(s, at(13, 30))).toMatchObject({ returnDue: true });
    expect(rowOf(s, at(9, 0, 6))).toMatchObject({ overdueDays: 1, returnDue: true });
  });
  it('戻る日が欠けたものは過ぎた扱い。形の違う時刻は無いものとして読む', () => {
    expect(rowOf(paused('a', null, '13:30'))).toEqual({ returnOn: null, returnTime: null, overdueDays: null, returnDue: true });
    expect(rowOf(paused('a', '2026-10-05', '25:00'))).toEqual({ returnOn: '2026-10-05', returnTime: null, overdueDays: 0, returnDue: true });
  });
  it('Paused 以外は戻る時刻を持たず、過ぎた扱いにもしない', () => {
    expect(rowOf(dto('a', 1, st({ status: 'done', setBy: 'user', setAt: 1 })))).toEqual({ returnOn: null, returnTime: null, overdueDays: null, returnDue: false });
  });
  it('提案の時刻を行へ渡す', () => {
    const s = dto('a', 1, st({ candidate: { status: 'paused', note: 'n', returnOn: '2026-10-06', returnTime: '09:00', source: 'in_session', at: NOW - H } }));
    expect(presentSessionRow(s, storeOf([s]), NOW).candidate).toMatchObject({ returnOn: '2026-10-06', returnTime: '09:00' });
  });
});

describe('並びの鍵', () => {
  it('同じ日の中は時刻の早い順で、時刻なしはその日の最後に置く', () => {
    const items = [
      { id: 'allday', returnOn: '2026-10-05', returnTime: null },
      { id: 'night', returnOn: '2026-10-05', returnTime: '21:50' },
      { id: 'next', returnOn: '2026-10-06', returnTime: '00:00' },
      { id: 'noon', returnOn: '2026-10-05', returnTime: '13:30' },
      { id: 'broken', returnOn: null, returnTime: '09:00' },
    ];
    expect([...items].sort((a, b) => returnKey(a).localeCompare(returnKey(b))).map((i) => i.id)).toEqual(['broken', 'noon', 'night', 'allday', 'next']);
    // 欠けた日は今までどおり空で、先頭に来る。時刻なしの鍵は、日付だけの頃の鍵で始まる。
    expect(returnKey(items[4]!)).toBe('');
    expect(returnKey(items[0]!).startsWith('2026-10-05')).toBe(true);
  });
});

describe('presentHome の今日戻る', () => {
  it('当日のものは時刻の前から出し、時刻の早い順に並べ、過ぎたかどうかを札へ渡す', () => {
    const store = storeOf([paused('night', '2026-10-05', '21:50'), paused('allday', '2026-10-05', null), paused('timer', '2026-10-05', '11:30'), paused('old', '2026-10-03', '09:00'), paused('later', '2026-10-06', '09:00')]);
    const h = presentHome(initialState(), store, NOW);
    expect(h.returning.map((r) => [r.id, r.returnTime, r.due])).toEqual([
      ['old', '09:00', true],
      ['timer', '11:30', true],
      ['night', '21:50', false],
      ['allday', null, true],
    ]);
  });
});

describe('presentPause の時刻', () => {
  const open = (from: 'menu' | 'candidate'): State => ({ ...initialState(), overlay: { kind: 'pause', sessionId: 's', from } });
  it('Paused のセッションを開き直すと、今の時刻を入れておく。無ければ空', () => {
    expect(presentPause(open('menu'), storeOf([paused('s', '2026-10-06', '13:30')]), NOW)).toMatchObject({ initialReturnOn: '2026-10-06', initialReturnTime: '13:30' });
    expect(presentPause(open('menu'), storeOf([paused('s', '2026-10-06', null)]), NOW)).toMatchObject({ initialReturnTime: '' });
  });
  it('提案から開くと、提案の時刻を入れておく', () => {
    const s = dto('s', 1, st({ candidate: { status: 'paused', note: 'n', returnOn: '2026-10-06', returnTime: '09:00', source: 'in_session', at: 1 } }));
    expect(presentPause(open('candidate'), storeOf([s]), NOW)).toMatchObject({ initialReturnOn: '2026-10-06', initialReturnTime: '09:00', candidateReturnTime: '09:00' });
  });
});
