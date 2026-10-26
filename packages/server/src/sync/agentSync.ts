import path from 'node:path';
import { isSafeKeyId, opencodeBlobKey, transcriptBlobKey } from '@agent-hangar/shared';
import type { AgentKind } from '../agent/types.ts';

/**
 * 台帳（file_sync）の本文の鍵。Claude の鍵は 1 字も変えない（上げた本文の台帳を引き直せなくなる）。
 * ID は他端末から届いた値が混ざる経路があるので、組み立ての側でも形を検査する。
 * 検査が無いと、スラッシュ入りのセッション ID がサブエージェントの鍵と衝突する。
 */
export function transcriptLedgerKey(deviceId: string, sessionUuid: string, agentId: string | null): string {
  if (!isSafeKeyId(deviceId)) throw new Error('invalid device id');
  if (!isSafeKeyId(sessionUuid)) throw new Error('invalid session id');
  if (agentId !== null && !isSafeKeyId(agentId)) throw new Error('invalid subagent id');
  return agentId === null ? `transcripts/${deviceId}/${sessionUuid}.jsonl.gz` : `transcripts/${deviceId}/${sessionUuid}/subagents/agent-${agentId}.jsonl.gz`;
}

/** opencode の本文の写しの相対パス（封じたメタの path）。`projects/` の外に置く（下に置くと、opencode を知らない版の PC が Claude の本文として取り込む）。 */
export function opencodeSyncPath(sessionId: string): string {
  if (!isSafeKeyId(sessionId)) throw new Error('invalid session id');
  return `opencode/${sessionId}.json`;
}

/** 封じたメタの path が opencode の本文の写しなら、その会話の ID を返す。違えば null。 */
export function opencodeSessionOfPath(rel: string): string | null {
  const m = /^opencode\/([^/]+)\.json$/.exec(rel);
  return m && isSafeKeyId(m[1]!) ? m[1]! : null;
}

/** 台帳の鍵から、本文の鍵名を求めるのに要る ID を取り出す。この PC のものでなければ null。 */
export type LedgerKeyIds = { uuid: string; agentId: string | null };

/**
 * エージェントごとの「同期の単位」。同期の if (provider === …) は、ここを引く形にする。
 * 新しいエージェントは、AGENT_SYNC に 1 行足す（AgentKind に足すと、足し忘れは型で落ちる）。
 *
 * 上げ方（source）：
 * - watched-file：エージェントが書き足すファイルを、そのまま見張って上げる（Claude の jsonl。Codex の rollout もこの形の予定）。
 *   写しの path は ~/.claude からの相対で、サブエージェントの本文は別の鍵になる。remote/ の写しは上げ直す。
 * - export：本文が DB にあり、上げる直前に書き出したファイルを上げる（opencode）。
 *   写しの path は projects/ の外の専用の形で、書き出しの口（deps）が要る。remote/ の写しは上げ直さない。
 */
export type AgentSyncUnit = {
  source: 'watched-file' | 'export';
  /** 台帳の鍵。使えない ID は throw する。 */
  ledgerKey(deviceId: string, sessionId: string, agentId: string | null): string;
  /** 台帳の鍵から ID を取り出す（この PC のものだけ）。形が違えば null。削除の掃除が使う。 */
  idsOfLedgerKey(deviceId: string, ledgerKey: string): LedgerKeyIds | null;
  /** R2 の鍵名（世代の鍵で求める）。種類は Worker が受ける transcript のままで、path で見分ける。 */
  blobKey(indexKey: CryptoKey, deviceId: string, origin: string, sessionId: string, agentId: string | null): Promise<string>;
  /** 封じたメタの path が、このエージェントの専用の形（projects/ の外）ならその会話の ID。watched-file は null を返す。 */
  sessionOfPath(rel: string): string | null;
  /** 専用の形の path を組む。export だけ。 */
  syncPath: ((sessionId: string) => string) | null;
  /** 降ろし先（remote/<元の PC>/ の下）の専用のフォルダ名。export だけ。 */
  remoteDir: string | null;
  /** 上げた書き出しの、この PC の置き場（home は ~/.agent-hangar）。降ろし直しを省くのに見る。export だけ。 */
  exportFile: ((home: string, sessionId: string) => string) | null;
  /** 会話の ID として受けられる形か（削除の掃除が、鍵名にならない ID を外す）。 */
  isSessionId(id: string): boolean;
  /** remote/ の写しを、作り直しで上げ直すか。 */
  relays: boolean;
};

const CLAUDE_SESSION_UUID = /^[0-9a-f-]{36}$/i;

const claudeLedgerIds = (deviceId: string, ledgerKey: string): LedgerKeyIds | null => {
  const head = `transcripts/${deviceId}/`;
  if (!ledgerKey.startsWith(head)) return null;
  const rest = ledgerKey.slice(head.length);
  const agent = /^([^/]+)\/subagents\/agent-([^/]+)\.jsonl\.gz$/.exec(rest);
  if (agent) return { uuid: agent[1]!, agentId: agent[2]! };
  const main = /^([^/]+)\.jsonl\.gz$/.exec(rest);
  return main ? { uuid: main[1]!, agentId: null } : null;
};

export const AGENT_SYNC: Record<AgentKind, AgentSyncUnit> = {
  'claude-code': {
    source: 'watched-file',
    ledgerKey: transcriptLedgerKey,
    idsOfLedgerKey: claudeLedgerIds,
    blobKey: transcriptBlobKey,
    sessionOfPath: () => null,
    syncPath: null,
    remoteDir: null,
    exportFile: null,
    isSessionId: (id) => CLAUDE_SESSION_UUID.test(id),
    relays: true,
  },
  // opencode は `opencode/<端末>/<会話>.json.gz` で、Claude の `transcripts/` と頭で分ける（台帳を引く問い合わせが混ざらない）。
  // 子の会話（サブエージェント）も親の書き出しに入るので、サブエージェントの鍵は無い。
  opencode: {
    source: 'export',
    ledgerKey(deviceId, sessionId, agentId) {
      if (!isSafeKeyId(deviceId)) throw new Error('invalid device id');
      if (!isSafeKeyId(sessionId)) throw new Error('invalid session id');
      if (agentId !== null) throw new Error('opencode has no separate subagent transcripts');
      return `opencode/${deviceId}/${sessionId}.json.gz`;
    },
    idsOfLedgerKey(deviceId, ledgerKey) {
      const m = /^opencode\/([^/]+)\/([^/]+)\.json\.gz$/.exec(ledgerKey);
      return m && m[1] === deviceId ? { uuid: m[2]!, agentId: null } : null;
    },
    blobKey: (indexKey, deviceId, origin, sessionId) => opencodeBlobKey(indexKey, deviceId, origin, sessionId),
    sessionOfPath: opencodeSessionOfPath,
    syncPath: opencodeSyncPath,
    remoteDir: 'opencode',
    exportFile: (home, id) => path.join(home, 'opencode', 'export', `${id}.json`),
    isSessionId: isSafeKeyId,
    relays: false,
  },
};

/** 台帳の鍵から ID を取り出す。どのエージェントの形でもなければ null。取れた鍵の持ち主のエージェントも返す。 */
export function idsOfAnyLedgerKey(deviceId: string, ledgerKey: string): (LedgerKeyIds & { provider: AgentKind }) | null {
  for (const provider of Object.keys(AGENT_SYNC) as AgentKind[]) {
    const ids = AGENT_SYNC[provider].idsOfLedgerKey(deviceId, ledgerKey);
    if (ids) return { ...ids, provider };
  }
  return null;
}

/** 本文が、専用の形の写し（projects/ の外）か。そうならその持ち主のエージェントと会話の ID。 */
export function agentOfSyncPath(rel: string): { provider: AgentKind; sessionId: string } | null {
  for (const provider of Object.keys(AGENT_SYNC) as AgentKind[]) {
    const id = AGENT_SYNC[provider].sessionOfPath(rel);
    if (id !== null) return { provider, sessionId: id };
  }
  return null;
}

/** 上げる直前に書き出す形のエージェントか。 */
export const isExportAgent = (provider: string | undefined): provider is AgentKind =>
  provider !== undefined && provider in AGENT_SYNC && AGENT_SYNC[provider as AgentKind].source === 'export';
