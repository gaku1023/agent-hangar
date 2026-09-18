/** 端末とクラウド Worker の間の契約。サーバ、CLI、Worker が共有する。 */
export type SharedTable = 'devices' | 'projects' | 'project_roots' | 'sessions' | 'runs' | 'run_tabs' | 'session_summaries' | 'todos' | 'project_memos' | 'artifacts' | 'artifact_versions' | 'takeover_requests';

/** 親から子の順。pull の適用はこの順に並べ替えて外部キーの順序違反を避ける。 */
export const SHARED_TABLES: readonly SharedTable[] = ['devices', 'projects', 'project_roots', 'sessions', 'runs', 'run_tabs', 'session_summaries', 'todos', 'project_memos', 'artifacts', 'artifact_versions', 'takeover_requests'];

export const TABLE_PK: Record<SharedTable, string> = {
  devices: 'id', projects: 'id', project_roots: 'id', sessions: 'id', runs: 'id', run_tabs: 'id',
  session_summaries: 'session_id', todos: 'id', project_memos: 'project_id', artifacts: 'id', artifact_versions: 'id', takeover_requests: 'id',
};

export type ChangeOp = 'upsert' | 'delete';
export type ChangeIn = { tableName: SharedTable; rowId: string; op: ChangeOp; payload: Record<string, unknown>; updatedAt: number };
export type ChangeOut = ChangeIn & { seq: number; deviceId: string };
export type PushChangesResponse = { seq: number; accepted: number; skipped: number };
export type PullChangesResponse = { changes: ChangeOut[]; nextSeq: number; more: boolean };
export type SnapshotResponse = { changes: ChangeOut[]; nextAfter: string | null; seq: number };

export type FileKind = 'transcript' | 'config';
export type FileMetaIn = { key: string; path: string; kind: FileKind; sha256: string; size: number; mtime: number; encrypted: boolean };
export type FileEntry = FileMetaIn & { seq: number; deviceId: string; uploadedAt: number; storedSize: number };
export type ListFilesResponse = { files: FileEntry[]; nextSeq: number; more: boolean };

export type JoinRequest = { secret: string; device: { id: string; name: string; platform: string } };
export type JoinResponse = { deviceToken: string; deviceId: string };
export type JoinToken = { url: string; secret: string };

export const CLOUD_HEADERS = { path: 'x-hangar-path', kind: 'x-hangar-kind', sha256: 'x-hangar-sha256', size: 'x-hangar-size', mtime: 'x-hangar-mtime', encrypted: 'x-hangar-encrypted' } as const;

/** 1 回の POST /changes に載せる上限。Worker は 1 行を 2 文で書くので 81 文以内に収まる。 */
export const MAX_PUSH_BATCH = 40;
/** GET /changes、GET /rows、GET /files が 1 回に返す上限。 */
export const PULL_LIMIT = 500;

const toB64Url = (s: string): string => btoa(String.fromCharCode(...new TextEncoder().encode(s))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const fromB64Url = (s: string): string => {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (s.length % 4)) % 4);
  const bin = atob(b64);
  return new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
};

/** 参加トークン。Worker の URL と参加用の秘密を JSON にして base64url で包む。 */
export function encodeJoinToken(t: JoinToken): string {
  return toB64Url(JSON.stringify({ url: t.url, secret: t.secret }));
}

export function decodeJoinToken(s: string): JoinToken {
  let v: unknown;
  try { v = JSON.parse(fromB64Url(s.trim())); } catch { throw new Error('参加トークンを読めません'); }
  const o = v as Partial<JoinToken> | null;
  if (!o || typeof o.url !== 'string' || !o.url || typeof o.secret !== 'string' || !o.secret) throw new Error('参加トークンの形式が違います');
  return { url: o.url, secret: o.secret };
}

/** R2 の鍵。端末ごとに分けるので、同じセッション ID の本文が端末間で上書きされない。 */
export function transcriptKey(deviceId: string, sessionUuid: string, agentId: string | null): string {
  return agentId === null ? `transcripts/${deviceId}/${sessionUuid}.jsonl.gz` : `transcripts/${deviceId}/${sessionUuid}/subagents/agent-${agentId}.jsonl.gz`;
}

export function configKey(rel: string): string {
  return `config/${rel}`;
}
