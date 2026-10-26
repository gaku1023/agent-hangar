import path from 'node:path';
import { codexBlobKey, isSafeKeyId, opencodeBlobKey, transcriptBlobKey } from '@agent-hangar/shared';
import type { AgentKind } from '../agent/types.ts';
import { parseRolloutName } from '../provider/codex/transcript/discover.ts';

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

/** Codex の thread の UUID（rollout の名前の末尾、session_meta の id）。 */
export const CODEX_THREAD_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * Codex の本文の写しの相対パス（封じたメタの path）。`projects/` と `opencode/` の外の `codex/` に置く。
 * 形は `$CODEX_HOME` の中の置き場にそろえ、`codex/sessions/YYYY/MM/DD/<名前>.jsonl` か、アーカイブ済みなら `codex/archived_sessions/<名前>.jsonl` である。
 * アーカイブの印はこの置き場で運ぶ（hangar の Archived とは別）。日付のフォルダは名前の日付にそろえる（codex unarchive の戻り先がこの形）。
 * 名前は .jsonl.zst でも .jsonl に直す（上げるのは展開した jsonl である）。rollout の名前でなければ投げる。
 */
export function codexSyncPath(name: string, archived: boolean): string {
  const n = parseRolloutName(name);
  if (!n) throw new Error('not a codex rollout name');
  if (archived) return `codex/archived_sessions/${n.logicalName}`;
  const [y, m, d] = n.localTime.slice(0, 10).split('-');
  return `codex/sessions/${y}/${m}/${d}/${n.logicalName}`;
}

const CODEX_SYNC_RE = /^codex\/(?:sessions\/(\d{4})\/(\d\d)\/(\d\d)|archived_sessions)\/([^/]+)$/;

/** 封じたメタの path が Codex の本文の写しなら、その thread の UUID を返す。決まった形（codexSyncPath が組む形）でなければ null。 */
export function codexSessionOfPath(rel: string): string | null {
  const m = CODEX_SYNC_RE.exec(rel);
  if (!m) return null;
  const n = parseRolloutName(m[4]!);
  if (!n || n.compressed || !CODEX_THREAD_ID.test(n.sessionId)) return null;
  return codexSyncPath(m[4]!, m[1] === undefined) === rel ? n.sessionId : null;
}

/** Codex の本文の写しが、アーカイブ済みの置き場のものか。 */
export const isCodexArchivedPath = (rel: string): boolean => codexSessionOfPath(rel) !== null && rel.startsWith('codex/archived_sessions/');

/**
 * `$CODEX_HOME` の中の rollout（.jsonl か .jsonl.zst、論理パスでも実体でもよい）から、写しの相対パスを求める。
 * sessions/YYYY/MM/DD/ の下ならアーカイブされていない、archived_sessions/ の直下ならアーカイブ済みである。どちらでもなければ null。
 */
export function codexSyncPathOfFile(codexHome: string, file: string): string | null {
  const rel = path.relative(codexHome, file);
  if (rel === '' || path.isAbsolute(rel)) return null;
  const parts = rel.split(/[\\/]+/);
  if (parts.includes('..')) return null;
  const name = parts[parts.length - 1]!;
  if (!parseRolloutName(name)) return null;
  if (parts.length === 2 && parts[0] === 'archived_sessions') return codexSyncPath(name, true);
  if (parts.length === 5 && parts[0] === 'sessions' && /^\d{4}$/.test(parts[1]!) && /^\d\d$/.test(parts[2]!) && /^\d\d$/.test(parts[3]!)) return codexSyncPath(name, false);
  return null;
}

/**
 * 写しの相対パスを、`$CODEX_HOME` の中の置き場（`sessions/YYYY/MM/DD/<名前>.jsonl` か `archived_sessions/<名前>.jsonl`）に直す。形が違えば null。
 * Codex の DB（state_5.sqlite など）と索引は触らない。codex が起動のときに拾い直す（probe-codex-e0）。
 * 書くのは「この PC で再開」（計画の E2）で、降ろした写し（remote/<元の PC>/codex/ の下）をここへ置く。
 */
export function codexHomePath(codexHome: string, rel: string): string | null {
  if (codexSessionOfPath(rel) === null) return null;
  return path.join(codexHome, ...rel.split('/').slice(1));
}

/** 台帳の鍵から、本文の鍵名を求めるのに要る ID を取り出す。この PC のものでなければ null。 */
export type LedgerKeyIds = { uuid: string; agentId: string | null };

/**
 * エージェントごとの「同期の単位」。同期の if (provider === …) は、ここを引く形にする。
 * 新しいエージェントは、AGENT_SYNC に 1 行足す（AgentKind に足すと、足し忘れは型で落ちる）。
 *
 * 上げ方（source）：
 * - watched-file：エージェントが書き足すファイルを、そのまま見張って上げる（Claude の jsonl と Codex の rollout）。
 *   Claude の写しの path は ~/.claude からの相対で、サブエージェントの本文は別の鍵になる。remote/ の写しは上げ直す。
 *   Codex の写しの path は専用の形（codexSyncPath）で、.jsonl.zst は展開してから上げる。remote/ の写しは上げ直さない。
 * - none：同期しない（上げも降ろしもしない）。ledgerKey と blobKey は呼ばれたら投げ、isSessionId はどの ID も断る。
 * - export：本文が DB にあり、上げる直前に書き出したファイルを上げる（opencode）。
 *   写しの path は projects/ の外の専用の形で、書き出しの口（deps）が要る。remote/ の写しは上げ直さない。
 */
export type AgentSyncUnit = {
  source: 'watched-file' | 'export' | 'none';
  /** 台帳の鍵。使えない ID は throw する。 */
  ledgerKey(deviceId: string, sessionId: string, agentId: string | null): string;
  /** 台帳の鍵から ID を取り出す（この PC のものだけ）。形が違えば null。削除の掃除が使う。 */
  idsOfLedgerKey(deviceId: string, ledgerKey: string): LedgerKeyIds | null;
  /** R2 の鍵名（世代の鍵で求める）。種類は Worker が受ける transcript のままで、path で見分ける。 */
  blobKey(indexKey: CryptoKey, deviceId: string, origin: string, sessionId: string, agentId: string | null): Promise<string>;
  /** 封じたメタの path が、このエージェントの専用の形（projects/ の外）ならその会話の ID。Claude は null を返す。 */
  sessionOfPath(rel: string): string | null;
  /** 専用の形の path を組む。export だけ。 */
  syncPath: ((sessionId: string) => string) | null;
  /** 降ろし先（remote/<元の PC>/ の下）の専用のフォルダ名。専用の形の path を持つ行だけ。 */
  remoteDir: string | null;
  /** 専用の形の path（sessionOfPath が ID を返したもの）の、remote/<元の PC>/ の下の置き場の区切り。Claude は null。 */
  remoteFile: ((rel: string, sessionId: string) => string[]) | null;
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
    remoteFile: null,
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
    remoteFile: (_rel, id) => ['opencode', `${id}.json`],
    exportFile: (home, id) => path.join(home, 'opencode', 'export', `${id}.json`),
    isSessionId: isSafeKeyId,
    relays: false,
  },
  // Codex は rollout 1 ファイルを会話 1 つとして、thread の UUID で台帳と鍵名を引く（`codex/<端末>/<UUID>.jsonl.gz`）。
  // 名前が .jsonl から .jsonl.zst に変わっても、アーカイブで置き場が変わっても、台帳と鍵名は 1 つのままである。
  // 降ろした写しは remote/<元の PC>/ の下に、写しの path のまま置く（codex/sessions/... か codex/archived_sessions/...）。
  // 削除の掃除（ゴミ箱の 30 日）は thread の UUID の形の ID だけを受ける（鍵名を求められない ID を外す）。
  codex: {
    source: 'watched-file',
    ledgerKey(deviceId, sessionId, agentId) {
      if (!isSafeKeyId(deviceId)) throw new Error('invalid device id');
      if (!CODEX_THREAD_ID.test(sessionId)) throw new Error('invalid session id');
      if (agentId !== null) throw new Error('codex has no separate subagent transcripts');
      return `codex/${deviceId}/${sessionId}.jsonl.gz`;
    },
    idsOfLedgerKey(deviceId, ledgerKey) {
      const m = /^codex\/([^/]+)\/([^/]+)\.jsonl\.gz$/.exec(ledgerKey);
      return m && m[1] === deviceId && CODEX_THREAD_ID.test(m[2]!) ? { uuid: m[2]!, agentId: null } : null;
    },
    blobKey: (indexKey, deviceId, origin, sessionId) => codexBlobKey(indexKey, deviceId, origin, sessionId),
    sessionOfPath: codexSessionOfPath,
    syncPath: null,
    remoteDir: 'codex',
    remoteFile: (rel) => rel.split('/'),
    exportFile: null,
    isSessionId: (id) => CODEX_THREAD_ID.test(id),
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
