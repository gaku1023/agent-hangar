import { describe, expect, it } from 'vitest';
import { configKey, decodeJoinToken, encodeJoinToken, SHARED_TABLES, TABLE_PK, transcriptKey } from './cloud.ts';

describe('参加トークン', () => {
  it('URL と秘密を base64url の JSON で往復する', () => {
    const t = { url: 'https://hangar.example.workers.dev', secret: 'abc+/=xyz' };
    const s = encodeJoinToken(t);
    expect(s).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(decodeJoinToken(s)).toEqual(t);
  });
  it('壊れた文字列と欠けた項目は Error', () => {
    expect(() => decodeJoinToken('!!!')).toThrow();
    expect(() => decodeJoinToken(encodeJoinToken({ url: 'x', secret: '' } as never))).toThrow('参加トークン');
    expect(() => decodeJoinToken(btoa('{"url":1}'))).toThrow('参加トークン');
  });
});

describe('鍵と表', () => {
  it('本文の鍵は端末 ID とセッション UUID を含み、サブエージェントは下に置く', () => {
    expect(transcriptKey('dev1', 'u1', null)).toBe('transcripts/dev1/u1.jsonl.gz');
    expect(transcriptKey('dev1', 'u1', 'abc')).toBe('transcripts/dev1/u1/subagents/agent-abc.jsonl.gz');
    expect(configKey('skills/x/SKILL.md')).toBe('config/skills/x/SKILL.md');
  });
  it('共有テーブルの主キーは session_summaries と project_memos だけが違う', () => {
    expect(SHARED_TABLES).toHaveLength(12);
    expect(TABLE_PK.session_summaries).toBe('session_id');
    expect(TABLE_PK.project_memos).toBe('project_id');
    expect(TABLE_PK.runs).toBe('id');
  });
});
