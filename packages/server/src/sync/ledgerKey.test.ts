import { describe, expect, it } from 'vitest';
import { MAX_ID_CHARS } from '@agent-hangar/shared';
import { ledgerKeyFor, ledgerKeyOfPath, opencodeSyncPath, transcriptLedgerKey } from './ledgerKey.ts';

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

  it('ledgerKeyFor は Claude なら transcriptLedgerKey と 1 字も変わらない', () => {
    expect(ledgerKeyFor('claude-code', 'dev1', 'u1', null)).toBe('transcripts/dev1/u1.jsonl.gz');
    expect(ledgerKeyFor('claude-code', 'dev1', 'u1', 'abc')).toBe('transcripts/dev1/u1/subagents/agent-abc.jsonl.gz');
    expect(ledgerKeyFor('claude-code', 'dev1', 'u1', 'abc')).toBe(transcriptLedgerKey('dev1', 'u1', 'abc'));
  });

  it('opencode の台帳の鍵は opencode/<端末>/<会話>.json.gz で、Claude の鍵と交わらない', () => {
    const ses = 'ses_f55764078ffeDvMj180Fvan87g';
    expect(ledgerKeyFor('opencode', 'dev1', ses, null)).toBe(`opencode/dev1/${ses}.json.gz`);
    expect(ledgerKeyFor('opencode', 'dev1', ses, null).startsWith('transcripts/')).toBe(false);
    // 写しのパスから求める鍵（降ろす側、projects/ の下だけ）にも当たらない。
    expect(ledgerKeyOfPath('dev1', opencodeSyncPath(ses))).toBeNull();
    for (const bad of ['', '..', 'a/b', '-a']) {
      expect(() => ledgerKeyFor('opencode', bad, ses, null)).toThrow(/id/);
      expect(() => ledgerKeyFor('opencode', 'dev1', bad, null)).toThrow(/id/);
    }
    // opencode はサブエージェントを別の本文に分けない（子の会話も同じ export に入る）。
    expect(() => ledgerKeyFor('opencode', 'dev1', ses, 'abc')).toThrow(/subagent/);
  });

  it('opencode の写しの path は projects/ の外の opencode/<会話>.json', () => {
    expect(opencodeSyncPath('ses_abc')).toBe('opencode/ses_abc.json');
    expect(() => opencodeSyncPath('../x')).toThrow(/id/);
  });
});
