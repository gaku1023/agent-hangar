import { describe, expect, it } from 'vitest';
import { AGENT_KINDS } from '@agent-hangar/shared';
import { AGENT_SYNC, agentOfSyncPath, idsOfAnyLedgerKey, isExportAgent } from './agentSync.ts';

describe('AGENT_SYNC（エージェントごとの同期の単位）', () => {
  it('AgentKind の全部に行があり、export の行は専用の path と降ろし先を持つ', () => {
    for (const k of AGENT_KINDS) {
      const u = AGENT_SYNC[k];
      expect(typeof u.ledgerKey).toBe('function');
      if (u.source === 'export') {
        expect(u.syncPath).not.toBeNull();
        expect(u.remoteDir).not.toBeNull();
        expect(u.exportFile).not.toBeNull();
        expect(u.relays).toBe(false);
      } else {
        expect(u.syncPath).toBeNull();
        expect(u.sessionOfPath('projects/x/y.jsonl')).toBeNull();
      }
    }
  });

  it('codex は同期しない行（E1 で本物の行に替えるまで、上げも降ろしも台帳も作らない）', () => {
    const u = AGENT_SYNC.codex;
    expect(u.source).toBe('none');
    expect(() => u.ledgerKey('d1', 'abc', null)).toThrow();
    expect(u.idsOfLedgerKey('d1', 'transcripts/d1/abc.jsonl.gz')).toBeNull();
    expect(u.isSessionId('0198a7c2-0000-7000-8000-000000000000')).toBe(false);
    expect(u.relays).toBe(false);
    expect(isExportAgent('codex')).toBe(false);
    expect(agentOfSyncPath('codex/x.json')).toBeNull();
  });

  it('台帳の鍵は組み立てと取り出しが往復し、持ち主のエージェントが分かる', () => {
    expect(idsOfAnyLedgerKey('d1', AGENT_SYNC['claude-code'].ledgerKey('d1', 'abc', 'sub1'))).toEqual({ uuid: 'abc', agentId: 'sub1', provider: 'claude-code' });
    expect(idsOfAnyLedgerKey('d1', AGENT_SYNC.opencode.ledgerKey('d1', 'ses_a', null))).toEqual({ uuid: 'ses_a', agentId: null, provider: 'opencode' });
    expect(idsOfAnyLedgerKey('d2', AGENT_SYNC.opencode.ledgerKey('d1', 'ses_a', null))).toBeNull();
  });

  it('専用の path の持ち主と、書き出す形かの見分け', () => {
    expect(agentOfSyncPath('opencode/ses_a.json')).toEqual({ provider: 'opencode', sessionId: 'ses_a' });
    expect(agentOfSyncPath('projects/x/y.jsonl')).toBeNull();
    expect(isExportAgent('opencode')).toBe(true);
    expect(isExportAgent('claude-code')).toBe(false);
    expect(isExportAgent(undefined)).toBe(false);
  });
});
