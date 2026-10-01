import { describe, expect, it } from 'vitest';
import type { SessionCandidateDto, SessionStateDto } from '@agent-hangar/shared';
import { exitPromptText } from './exitPrompt.ts';

const state = (o: Partial<SessionStateDto> = {}): SessionStateDto => ({ status: null, note: null, returnOn: null, setBy: null, setAt: null, candidate: null, ...o });
const cand = (o: Partial<SessionCandidateDto> = {}): SessionCandidateDto => ({ status: 'done', note: null, returnOn: null, source: 'in_session', at: 1, ...o });

describe('exitPromptText', () => {
  it('状態も提案も無ければ、頭も下書きも空で ask', () => {
    expect(exitPromptText(null)).toBe('ask\n\n\n');
    expect(exitPromptText(state())).toBe('ask\n\n\n');
  });
  it('状態がもう付いていれば skip。提案が残っていても状態を正とする', () => {
    expect(exitPromptText(state({ status: 'done', setBy: 'import', setAt: 1 }))).toBe('skip\n');
    // 同期で両方を持つ行が届いたときは、読むときに状態を正とする（仕様の「失敗の扱い」）。
    expect(exitPromptText(state({ status: 'archived', candidate: cand() }))).toBe('skip\n');
  });
  it('提案があれば頭に出し、根拠を Paused の理由の下書きにする', () => {
    expect(exitPromptText(state({ candidate: cand({ note: '直して main に入れた' }) }))).toBe('ask\nClaude の提案：Done（直して main に入れた）\n直して main に入れた\n');
    expect(exitPromptText(state({ candidate: cand({ status: 'paused', returnOn: '2026-10-03', note: '本番で確かめる' }) }))).toBe('ask\nClaude の提案：Paused · 10/3（本番で確かめる）\n本番で確かめる\n');
    expect(exitPromptText(state({ candidate: cand({ note: null }) }))).toBe('ask\nClaude の提案：Done\n\n');
  });
  it('根拠の改行やタブは空白に寄せ、行の区切りを崩さない。引用符と \\ はそのまま渡す', () => {
    const t = exitPromptText(state({ candidate: cand({ note: '1 行目\n2 行目\t"引用"\\' }) }));
    expect(t).toBe('ask\nClaude の提案：Done（1 行目 2 行目 "引用"\\）\n1 行目 2 行目 "引用"\\\n');
    expect(t.split('\n')).toHaveLength(4);
  });
});
