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
/**
 * push の応答である。
 *
 * `d1RowsToday` は、その日（UTC で区切る）にこの箱の Worker が D1 へ書いた行数である。
 * 端末が自分の push から見積もると、圧縮と参加とスキーマの用意の書き込みを数え落とす。
 * Worker は `meta.rows_written` をそのまま積んでいるので、どの端末のどの経路の書き込みも入っている。
 * 古い Worker は返さないので任意である。受け取れないときは端末側の見積もりに落ちる。
 */
export type PushChangesResponse = { seq: number; accepted: number; skipped: number; d1RowsToday?: number };
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
 * 見出しに載せてよい値か。
 * HTTP の見出しの値は ByteString（0x00 から 0xff）しか運べず、
 * さらに制御文字を入れると要求そのものが壊れるので、印字できる ASCII だけに限る。
 */
export function isHeaderSafe(s: string): boolean {
  return !/[^ -~]/.test(s);
}

/**
 * 見出しに載せる文字列の符号化。
 *
 * 非 ASCII をそのまま見出しに渡すと、Node の fetch（undici）は送る前に
 * `TypeError: Cannot convert argument to a ByteString ...` を投げる。
 * 要求が届かないので Worker 側では直せない。端末が符号化して送り、Worker が復号する。
 *
 * `/` は読みやすさのために残す（`%` は必ず `%25` になるので往復できる）。
 * 単独のサロゲートなど符号化できない文字列は null を返す。
 */
export function encodeHeaderText(s: string): string | null {
  try {
    return encodeURIComponent(s).replace(/%2F/g, '/');
  } catch {
    return null;
  }
}

/** encodeHeaderText の逆。百分率の形が壊れていれば null を返す（例外を投げない）。 */
export function decodeHeaderText(s: string): string | null {
  try {
    return decodeURIComponent(s);
  } catch {
    return null;
  }
}

/** R2 の鍵の長さの上限。超えると R2 が投げるので、その手前で 400 にして 500 を出さない。 */
export const MAX_KEY_BYTES = 1024;

/** 鍵の 1 段目に許す接頭辞。 */
export type KeyPrefix = 'transcripts' | 'config';

/**
 * R2 の鍵を接頭辞と、その先の相対パスに割る。形が違えば null。
 * Worker（`packages/cloud/src/files.ts`）と端末（`packages/server/src/sync/client.ts`）が
 * この 1 つの物差しを共有する。片方だけ厳しいと、端末で組み立てられる鍵が Worker で 400 になる。
 */
export function splitFileKey(key: string): { prefix: KeyPrefix; rel: string } | null {
  const i = key.indexOf('/');
  if (i < 0) return null;
  const prefix = key.slice(0, i);
  if (prefix !== 'transcripts' && prefix !== 'config') return null;
  const rel = key.slice(i + 1);
  if (!isSafeRelPath(rel)) return null;
  if (new TextEncoder().encode(key).length > MAX_KEY_BYTES) return null;
  return { prefix, rel };
}

/** 権限を抜きにした、鍵の形だけの検査。日本語と空白は通る（`~/.claude` の名前は選べない）。 */
export function isValidFileKey(key: string): boolean {
  return splitFileKey(key) !== null;
}

/** 鍵を URL のパスに載せる形。断片ごとに符号化するので、`/` は潰れない。 */
export function encodeFileKeyPath(key: string): string {
  return key.split('/').map(encodeURIComponent).join('/');
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

/**
 * 設定の R2 の鍵。本文と同じく端末ごとに分ける。
 *
 * 分けないと、2 台が同じ相対パスを上げたときに同じオブジェクトを奪い合う。
 * 負けた側の索引（`file_sync`）には自分が上げた指紋が残るのに中身は相手のものなので、
 * 取り込みは「SHA-256 が一致しません」で永久に止まる。
 * 端末ごとに分ければ、受け取る側が相対パスごとに新しい方を選べる。
 */
export function configKey(deviceId: string, rel: string): string {
  if (!isSafeKeyId(deviceId)) throw new Error('端末 ID の形が不正です');
  if (!isSafeRelPath(rel)) throw new Error('設定ファイルのパスが不正です');
  return `config/${deviceId}/${rel}`;
}
