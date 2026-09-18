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

/** 参加トークンの文字数の上限。実物は 200 字ほどなので、これを超える入力は貼り間違いか攻撃である。 */
export const MAX_JOIN_TOKEN_CHARS = 2048;
/** 参加トークンの中の URL の文字数の上限。 */
export const MAX_JOIN_URL_CHARS = 512;
/** R2 の鍵に入れる ID（端末 ID、セッション ID、サブエージェント ID）の文字数の上限。 */
export const MAX_ID_CHARS = 64;
/** config の相対パスの文字数の上限。 */
export const MAX_REL_PATH_CHARS = 512;

const toB64Url = (s: string): string => btoa(String.fromCharCode(...new TextEncoder().encode(s))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const fromB64Url = (s: string): string => {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (s.length % 4)) % 4);
  const bin = atob(b64);
  return new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
};

/**
 * 参加トークンの宛先として許す URL か。
 *
 * 許すのは素の origin の `https:` だけである。
 * 例外として、開発と `packages/cloud` のテストで `wrangler dev` を指すために
 * loopback（127.0.0.1、localhost、::1）に限り `http:` を許す。
 * 外向きの平文は許さない。deviceToken を Bearer で載せる線だからである。
 *
 * パス、問い合わせ、素片、ユーザ情報が付いた URL は断る。Worker の入口は素の origin のはずである。
 */
export function isAllowedJoinUrl(url: string): boolean {
  if (url.length > MAX_JOIN_URL_CHARS) return false;
  let u: URL;
  try { u = new URL(url); } catch { return false; }
  if (u.username !== '' || u.password !== '') return false;
  if (u.hostname === '') return false;
  if (u.pathname !== '' && u.pathname !== '/') return false;
  if (u.search !== '' || u.hash !== '') return false;
  if (u.protocol === 'https:') return true;
  if (u.protocol !== 'http:') return false;
  const host = u.hostname.replace(/^\[|\]$/g, '');
  return host === '127.0.0.1' || host === 'localhost' || host === '::1';
}

/** 参加トークン。Worker の URL と参加用の秘密を JSON にして base64url で包む。 */
export function encodeJoinToken(t: JoinToken): string {
  return toB64Url(JSON.stringify({ url: t.url, secret: t.secret }));
}

/**
 * 参加トークンを解く。利用者が手で貼る入口なので、ここで宛先まで検査する。
 * 例外の文言は固定の 3 種類だけにして、入力も秘密も断片すら載せない。
 */
export function decodeJoinToken(s: string): JoinToken {
  if (s.length > MAX_JOIN_TOKEN_CHARS) throw new Error('参加トークンが長すぎます'); // 長さは空白を取り除く前に見る。
  // 1Password やメールを経由すると途中に折り返しが入る。空白は base64url の文字ではないので、取り除いてから読む。
  const t = s.replace(/\s+/g, '');
  let v: unknown;
  try { v = JSON.parse(fromB64Url(t)); } catch { throw new Error('参加トークンを読めません'); }
  const o = v as Partial<JoinToken> | null;
  if (!o || typeof o.url !== 'string' || !o.url || typeof o.secret !== 'string' || !o.secret) throw new Error('参加トークンの形式が違います');
  if (!isAllowedJoinUrl(o.url)) throw new Error('参加トークンの宛先が不正です');
  return { url: o.url, secret: o.secret };
}

/** R2 の鍵に入れてよい ID か。スラッシュ、`..`、制御文字、空を通さない。 */
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
export function isSafeKeyId(id: string): boolean {
  return id.length > 0 && id.length <= MAX_ID_CHARS && ID_RE.test(id);
}

/**
 * R2 の鍵に入れてよい相対パスか。
 * 空でなく、`/` で始まらず、どの断片も空でも `.` でも `..` でもなく、制御文字と NUL を含まないこと。
 * Worker の `validKey` と同じ判定を端末の側でも持つための共通の物差しである。
 */
export function isSafeRelPath(rel: string): boolean {
  if (rel.length === 0 || rel.length > MAX_REL_PATH_CHARS) return false;
  if (/[\u0000-\u001f\u007f]/.test(rel)) return false; // NUL と制御文字
  if (rel.startsWith('/')) return false;
  return rel.split('/').every((seg) => seg !== '' && seg !== '.' && seg !== '..');
}

/**
 * R2 の鍵。端末ごとに分けるので、同じセッション ID の本文が端末間で上書きされない。
 * ID は他端末から届いた値が混ざる経路があるので、組み立ての側でも形を検査する。
 * 検査が無いと、スラッシュ入りのセッション ID がサブエージェントの鍵と衝突して上書きし合う。
 */
export function transcriptKey(deviceId: string, sessionUuid: string, agentId: string | null): string {
  if (!isSafeKeyId(deviceId)) throw new Error('端末 ID の形が不正です');
  if (!isSafeKeyId(sessionUuid)) throw new Error('セッション ID の形が不正です');
  if (agentId !== null && !isSafeKeyId(agentId)) throw new Error('サブエージェント ID の形が不正です');
  return agentId === null ? `transcripts/${deviceId}/${sessionUuid}.jsonl.gz` : `transcripts/${deviceId}/${sessionUuid}/subagents/agent-${agentId}.jsonl.gz`;
}

export function configKey(rel: string): string {
  if (!isSafeRelPath(rel)) throw new Error('設定ファイルのパスが不正です');
  return `config/${rel}`;
}
