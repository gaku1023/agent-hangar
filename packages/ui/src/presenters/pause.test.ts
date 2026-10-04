import { describe, expect, it } from 'vitest';
import type { SessionDto } from '@agent-hangar/shared';
import { initialState } from '../mediator/transition.ts';
import type { State } from '../mediator/types.ts';
import { initialStore, type Store } from '../store/store.ts';
import { pauseChoices, presentPause } from './pause.ts';

/** 手元の暦の時刻。試験を走らせる機械のタイムゾーンによらず、同じ日付になる。 */
const at = (y: number, m: number, d: number, h = 9, min = 0) => new Date(y, m - 1, d, h, min).getTime();
const THU = at(2026, 10, 1);
const session = (state: SessionDto['state']): SessionDto => ({ id: 's1', provider: 'claude-code', providerSessionId: 'u1', projectId: 'p1', name: 'Worker の CPU 超過', cwd: '/w', firstPrompt: null, aiTitle: null, startedAt: 1, lastActivityAt: 2, memo: null, hasTranscript: true, live: null, summary: null, stats: { turns: 1, model: null, effort: null, filesChanged: 0, prUrl: null, inputTokens: 0, outputTokens: 0, contextPercent: null, costUsd: null }, fromScratch: false, lock: null, remoteOnly: false, transcriptMtime: null, state });
const open = (from: 'menu' | 'candidate'): State => ({ ...initialState(), overlay: { kind: 'pause', sessionId: 's1', from } });
const storeOf = (s: SessionDto): Store => ({ ...initialStore(), sessions: { [s.id]: s } });

describe('pauseChoices', () => {
  it('今日の夕方・明日・月曜・来週・日付を選ぶ… の 5 つ', () => {
    expect(pauseChoices(THU)).toEqual([
      { key: 'today', label: '今日の夕方', returnOn: '2026-10-01' },
      { key: 'tomorrow', label: '明日', returnOn: '2026-10-02' },
      { key: 'monday', label: '月曜', returnOn: '2026-10-05' },
      { key: 'nextWeek', label: '来週', returnOn: '2026-10-08' },
      { key: 'pick', label: '日付を選ぶ…', returnOn: null },
    ]);
  });
  it('月曜は次の月曜で、今日が月曜なら 7 日後。日曜なら翌日', () => {
    expect(pauseChoices(at(2026, 10, 5)).find((c) => c.key === 'monday')!.returnOn).toBe('2026-10-12');
    expect(pauseChoices(at(2026, 10, 4)).find((c) => c.key === 'monday')!.returnOn).toBe('2026-10-05');
  });
  it('夜中の 0 時の手前は、まだ今日', () => {
    expect(pauseChoices(at(2026, 10, 1, 23, 59))[0]!.returnOn).toBe('2026-10-01');
  });
});

describe('presentPause', () => {
  it('「⋯」から開くと、下書きは空で、戻る日は明日を選んでおく', () => {
    expect(presentPause(open('menu'), storeOf(session(null)), THU)).toMatchObject({ sessionId: 's1', sessionName: 'Worker の CPU 超過', from: 'menu', draft: '', candidateNote: null, initialReturnOn: '2026-10-02', today: '2026-10-01' });
  });
  it('Paused のセッションを開き直すと、今の理由と戻る日を入れておく', () => {
    const s = session({ status: 'paused', note: '数字を見る', returnOn: '2026-10-05', returnTime: null, setBy: 'user', setAt: 1, candidate: null });
    expect(presentPause(open('menu'), storeOf(s), THU)).toMatchObject({ draft: '数字を見る', initialReturnOn: '2026-10-05' });
  });
  it('提案から開くと、根拠を下書きに入れ、提案の日を選んでおく', () => {
    const s = session({ status: null, note: null, returnOn: null, returnTime: null, setBy: null, setAt: null, candidate: { status: 'paused', note: '明日の朝 CPU を見る', returnOn: '2026-10-02', returnTime: null, source: 'exit', at: 1 } });
    expect(presentPause(open('candidate'), storeOf(s), THU)).toMatchObject({ from: 'candidate', draft: '明日の朝 CPU を見る', candidateNote: '明日の朝 CPU を見る', initialReturnOn: '2026-10-02' });
  });
  it('開いていないか、セッションが無ければ null', () => {
    expect(presentPause(initialState(), storeOf(session(null)), THU)).toBeNull();
    expect(presentPause(open('menu'), initialStore(), THU)).toBeNull();
  });
});
