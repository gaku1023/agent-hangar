import { describe, expect, it } from 'vitest';
import { MAX_ID_CHARS } from '@agent-hangar/shared';
import { ledgerKeyOfPath, transcriptLedgerKey } from './ledgerKey.ts';

describe('台帳の鍵', () => {
  it('端末 ID とセッション UUID を含み、サブエージェントは下に置く', () => {
    expect(transcriptLedgerKey('dev1', 'u1', null)).toBe('transcripts/dev1/u1.jsonl.gz');
    expect(transcriptLedgerKey('dev1', 'u1', 'abc')).toBe('transcripts/dev1/u1/subagents/agent-abc.jsonl.gz');
    expect(transcriptLedgerKey('0199b0d1-2b3c-7def-8000-0123456789ab', '2f1c9a10-0000-4000-8000-0123456789ab', null))
      .toBe('transcripts/0199b0d1-2b3c-7def-8000-0123456789ab/2f1c9a10-0000-4000-8000-0123456789ab.jsonl.gz');
  });

  it('端末 ID とセッション ID とサブエージェント ID の形を検査する', () => {
    for (const bad of ['', '.', '..', 'a/b', '/a', 'a b', 'a\u0000', '-a', 'a'.repeat(MAX_ID_CHARS + 1)]) {
      expect(() => transcriptLedgerKey(bad, 'u1', null)).toThrow(/id/);
      expect(() => transcriptLedgerKey('dev1', bad, null)).toThrow(/id/);
      expect(() => transcriptLedgerKey('dev1', 'u1', bad)).toThrow(/id/);
    }
  });

  it('スラッシュ入りのセッション ID でサブエージェントの鍵と衝突させられない', () => {
    expect(() => transcriptLedgerKey('d', 'u/subagents/agent-x', null)).toThrow(/id/);
  });

  it('写しのパスから求めた鍵は、上げる側の鍵と同じ', () => {
    expect(ledgerKeyOfPath('dev1', 'projects/-w-p/u1.jsonl')).toBe(transcriptLedgerKey('dev1', 'u1', null));
    expect(ledgerKeyOfPath('dev1', 'projects/-w-p/u1/subagents/agent-abc.jsonl')).toBe(transcriptLedgerKey('dev1', 'u1', 'abc'));
    for (const bad of ['skills/x.md', 'projects/x.jsonl', 'projects/-w/../../x.jsonl', '/projects/-w/u.jsonl']) expect(ledgerKeyOfPath('dev1', bad), bad).toBeNull();
    expect(ledgerKeyOfPath('../evil', 'projects/-w/u.jsonl')).toBeNull();
  });
});
