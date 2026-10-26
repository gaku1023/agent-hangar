import { describe, expect, it } from 'vitest';
import { AGENT_KINDS } from '@agent-hangar/shared';
import path from 'node:path';
import { AGENT_SYNC, agentOfSyncPath, codexHomePath, codexSessionOfPath, codexSyncPath, codexSyncPathOfFile, idsOfAnyLedgerKey, isCodexArchivedPath, isExportAgent } from './agentSync.ts';

const THREAD = '0198a7c2-0000-7000-8000-000000000000';
const NAME = `rollout-2026-10-26T14-00-00-${THREAD}.jsonl`;

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

  it('codex は rollout 1 ファイルを thread の UUID で引く行（削除の掃除は E2 まで ID を断る）', () => {
    const u = AGENT_SYNC.codex;
    expect(u.source).toBe('watched-file');
    expect(u.ledgerKey('d1', THREAD, null)).toBe(`codex/d1/${THREAD}.jsonl.gz`);
    expect(() => u.ledgerKey('d1', THREAD, 'sub')).toThrow();
    expect(() => u.ledgerKey('d1', 'ses_abc', null)).toThrow();
    expect(() => u.ledgerKey('../d', THREAD, null)).toThrow();
    expect(u.idsOfLedgerKey('d1', `codex/d1/${THREAD}.jsonl.gz`)).toEqual({ uuid: THREAD, agentId: null });
    expect(u.idsOfLedgerKey('d2', `codex/d1/${THREAD}.jsonl.gz`)).toBeNull();
    expect(u.idsOfLedgerKey('d1', `transcripts/d1/${THREAD}.jsonl.gz`)).toBeNull();
    expect(u.isSessionId(THREAD)).toBe(false);
    expect(u.relays).toBe(false);
    expect(isExportAgent('codex')).toBe(false);
    expect(agentOfSyncPath(codexSyncPath(NAME, false))).toEqual({ provider: 'codex', sessionId: THREAD });
    expect(agentOfSyncPath(codexSyncPath(NAME, true))).toEqual({ provider: 'codex', sessionId: THREAD });
    expect(idsOfAnyLedgerKey('d1', u.ledgerKey('d1', THREAD, null))).toEqual({ uuid: THREAD, agentId: null, provider: 'codex' });
  });

  it('codex の写しの path は、置き場（sessions か archived_sessions か）と元の名前（.jsonl に直す）を持ち、日付のフォルダは名前の日付にそろえる', () => {
    expect(codexSyncPath(NAME, false)).toBe(`codex/sessions/2026/10/26/${NAME}`);
    expect(codexSyncPath(`${NAME}.zst`, false)).toBe(`codex/sessions/2026/10/26/${NAME}`);
    expect(codexSyncPath(NAME, true)).toBe(`codex/archived_sessions/${NAME}`);
    expect(() => codexSyncPath('notes.jsonl', false)).toThrow();
    const home = path.join(path.sep, 'tmp', 'codex-home');
    expect(codexSyncPathOfFile(home, path.join(home, 'sessions', '2026', '10', '26', NAME))).toBe(`codex/sessions/2026/10/26/${NAME}`);
    // 日付のフォルダが名前と違っても（写したものでも codex は拾う）、上げる path は名前の日付にそろえる。
    expect(codexSyncPathOfFile(home, path.join(home, 'sessions', '2020', '01', '02', `${NAME}.zst`))).toBe(`codex/sessions/2026/10/26/${NAME}`);
    expect(codexSyncPathOfFile(home, path.join(home, 'archived_sessions', NAME))).toBe(`codex/archived_sessions/${NAME}`);
    for (const bad of [path.join(home, 'sessions', NAME), path.join(home, 'archived_sessions', '2026', NAME), path.join(home, 'sessions', '2026', '10', '26', 'x.jsonl'), path.join(home, '..', 'sessions', '2026', '10', '26', NAME), path.join(home, 'state_5.sqlite')]) {
      expect(codexSyncPathOfFile(home, bad)).toBeNull();
    }
  });

  it('codex の写しの path は決まった形だけを受け、Codex の置き場の中の降ろし先を組む', () => {
    for (const bad of [
      `codex/sessions/2026/10/27/${NAME}`, // 名前の日付と違うフォルダ
      `codex/sessions/2026/10/26/${NAME}.zst`,
      `codex/sessions/2026/10/26/../${NAME}`,
      `codex/${NAME}`,
      `codex/archived_sessions/x/${NAME}`,
      `projects/-x/${THREAD}.jsonl`,
      `opencode/${THREAD}.json`,
    ]) expect(codexSessionOfPath(bad)).toBeNull();
    const home = path.join(path.sep, 'tmp', 'codex-home');
    expect(codexHomePath(home, `codex/sessions/2026/10/26/${NAME}`)).toBe(path.join(home, 'sessions', '2026', '10', '26', NAME));
    expect(codexHomePath(home, `codex/archived_sessions/${NAME}`)).toBe(path.join(home, 'archived_sessions', NAME));
    expect(codexHomePath(home, `codex/sessions/2026/10/27/${NAME}`)).toBeNull();
    expect(isCodexArchivedPath(`codex/archived_sessions/${NAME}`)).toBe(true);
    expect(isCodexArchivedPath(`codex/sessions/2026/10/26/${NAME}`)).toBe(false);
  });

  it('codex の写しの path は projects/ と opencode/ の外にある（Codex を知らない版は鍵名を求め直せず、開かずに捨てる）', () => {
    for (const archived of [false, true]) {
      const rel = codexSyncPath(NAME, archived);
      expect(rel.startsWith('projects/')).toBe(false);
      expect(rel.startsWith('opencode/')).toBe(false);
      expect(AGENT_SYNC['claude-code'].sessionOfPath(rel)).toBeNull();
      expect(AGENT_SYNC.opencode.sessionOfPath(rel)).toBeNull();
    }
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
