/** 端末とクラウド Worker の間の契約。サーバ、CLI、Worker が共有する。 */
import type { MobileLaunchOut } from './mobile.ts';

export type SharedTable = 'devices' | 'projects' | 'project_roots' | 'sessions' | 'runs' | 'run_tabs' | 'session_summaries' | 'session_states' | 'session_notes' | 'todos' | 'project_memos' | 'artifacts' | 'artifact_versions' | 'config_snapshots' | 'takeovers' | 'takeover_answers';

/**
 * 親から子の順。pull の適用はこの順に並べ替えて外部キーの順序違反を避ける。
 * Worker（packages/cloud/src/changes.ts）はこの一覧に無い表の変更を含む push を断るので、表を足したら Worker も配備し直す。
 * session_notes（セッションの名前とメモ）は互換の版 2 で足した。版 1 の Worker はこの表の行を断るので、端末は Worker に版 2 を求める。
 * takeovers と takeover_answers（ほかの PC で動く会話を止めて引き継ぐ頼みと応答）は互換の版 6 で足した。版 5 までの Worker はこの 2 表の行を含む push を 400 で丸ごと断るので、端末は Worker の版が TAKEOVER_MIN_WORKER_COMPAT に届くまで書かない。
 * takeover_requests は v1 のマイグレーションに表が残るが、誰も書かないので一覧に入れない。
 */
export const SHARED_TABLES: readonly SharedTable[] = ['devices', 'projects', 'project_roots', 'sessions', 'runs', 'run_tabs', 'session_summaries', 'session_states', 'session_notes', 'todos', 'project_memos', 'artifacts', 'artifact_versions', 'config_snapshots', 'takeovers', 'takeover_answers'];

export const TABLE_PK: Record<SharedTable, string> = {
  devices: 'id', projects: 'id', project_roots: 'id', sessions: 'id', runs: 'id', run_tabs: 'id',
  session_summaries: 'session_id', session_states: 'session_id', session_notes: 'session_id', todos: 'id', project_memos: 'project_id', artifacts: 'id', artifact_versions: 'id', config_snapshots: 'device_id', takeovers: 'id', takeover_answers: 'ask_id',
};

export type ChangeOp = 'upsert' | 'delete';
/**
 * 開いた行の形。PC の中だけで使い、線の上には載せない（線の上は SealedChangeIn と SealedChangeOut）。
 * 封じて送るのと、受けて開くのは、サーバの SealedCloudClient（packages/server/src/sync/sealedClient.ts）である。
 */
export type ChangeIn = { tableName: SharedTable; rowId: string; op: ChangeOp; payload: Record<string, unknown>; updatedAt: number };
export type ChangeOut = ChangeIn & { seq: number; deviceId: string };
/** push の応答である。seq はサーバの連番の高水位、accepted は採った行、skipped は新しくなかったので捨てた行の数である。 */
export type PushChangesResponse = { seq: number; accepted: number; skipped: number };
/**
 * 解除していない PC の 1 台と、Worker がその PC を最後に見た時刻（互換の版 6）。
 * lastSeenAt は Worker の時計で、1 分おきにしか書かないので最大 1 分遅れる。参加の前の行など、まだ見ていなければ null である。
 */
export type CloudPeer = { id: string; lastSeenAt: number | null };

/**
 * 封じた行（互換の版 9）。
 * `k` は PC が表名と行 ID から求めた HMAC の base64url（43 字）で、Worker は表名も行 ID も知らない。
 * `sealed` は `/row` の鍵で封じた中身（base64url）で、Worker は開けない。`epoch` は封じた鍵の世代である。
 * 名簿の印の行（`ROSTER_MARKER_K`）だけは `sealed` が空で、Worker が書く。
 */
export type SealedChangeIn = { k: string; op: ChangeOp; updatedAt: number; epoch: number; sealed: string };
export type SealedChangeOut = SealedChangeIn & { seq: number; deviceId: string };
/**
 * 封じた行の pull（`GET /changes`）。
 * changes は自端末以外の行を連番の昇順で、nextSeq は次に渡す since である。
 * peers と now は互換の版 6 で足した生存の知らせで、端末は「now − lastSeenAt」を PC の年齢として読む。
 * 2 つの時刻はどちらも Worker の時計なので、端末の時計のずれが入らない。
 */
export type SealedPullChangesResponse = {
  changes: SealedChangeOut[];
  nextSeq: number;
  more: boolean;
  peers: CloudPeer[];
  now: number;
  /** この PC 宛ての、まだ受け取っていない起動の依頼（互換の版 7）。中身はスマホが封をしたまま。 */
  launches?: MobileLaunchOut[];
};
/** 封じた行の取り直し（`GET /rows`）。`k` の順に並び、`nextAfter` は次に渡す `after` である。 */
export type SealedSnapshotResponse = { changes: SealedChangeOut[]; nextAfter: string | null; seq: number };
/** 封じた行の `k` の形（HMAC-SHA256 の base64url、詰め物なし）。 */
export const SEALED_ROW_K_RE = /^[A-Za-z0-9_-]{43}$/;

export type FileKind = 'transcript' | 'config';
/** 平文のメタを持つファイルの形。Task 9/10 で SealedFileIn に置き換わって消える。 */
export type FileMetaIn = { key: string; path: string; kind: FileKind; sha256: string; size: number; mtime: number; encrypted: boolean };
export type FileEntry = FileMetaIn & { seq: number; deviceId: string; uploadedAt: number; storedSize: number };
export type ListFilesResponse = { files: FileEntry[]; nextSeq: number; more: boolean };

/**
 * 封じたメタを持つファイル（互換の版 9）。
 * `key` は `b/<端末 ID>/<HMAC の base64url>`（e2e/names.ts）で、パスは平文で残らない。
 * `sealedMeta` はパス、平文の SHA-256、mtime、元の PC を封じたもの（base64url）である。
 */
export type SealedFileIn = { key: string; kind: FileKind; size: number; epoch: number; sealedMeta: string };
export type SealedFileEntry = SealedFileIn & { seq: number; deviceId: string; uploadedAt: number; storedSize: number };
export type SealedListFilesResponse = { files: SealedFileEntry[]; nextSeq: number; more: boolean };
/** `x-hangar-meta` の見出しの長さの上限（字）。 */
export const MAX_SEALED_META_CHARS = 8192;

/**
 * PC が決めた本文の削除（`DELETE /blobs`、互換の版 9）。
 * 自分の端末 ID の下（`b/<自分>/`）の鍵だけを消せる。置いてから 1 時間たっていないものは消さない。
 * 断ったものは `refused` に入れて返す。索引に無い鍵は消えたものとして `deleted` に入れる。
 */
export type BlobsDeleteIn = { keys: string[] };
export type BlobsDeleteOut = { deleted: string[]; refused: string[] };
/** 1 回の `DELETE /blobs` の鍵の数の上限。 */
export const MAX_BLOB_DELETE_KEYS = 50;
/** 1 台の端末が 1 日（UTC）に消せる本文の数。超えると 429。 */
export const BLOB_DELETE_DAILY = 500;
/** 置いてからこれだけたっていない本文は消さない。 */
export const BLOB_DELETE_GRACE_MS = 3_600_000;

export type JoinRequest = { secret: string; device: { id: string; name: string; platform: string } };
export type JoinResponse = { deviceToken: string; deviceId: string };
export type JoinToken = { url: string; secret: string };

/**
 * 最初の PC の端末トークンを登録する（`POST /bootstrap`、互換の版 9）。
 * setup が Worker の secret `BOOTSTRAP_TOKEN_HASH` に `SHA-256(token)` を入れ、同じハッシュは 1 回だけ通る。
 * 応答は 201 `{ deviceId }`。
 */
export type BootstrapRequest = { deviceId: string; token: string };

/** 参加コードの期限（5 分）。判定は Worker の時計で行う。 */
export const JOIN_CODE_TTL_MS = 5 * 60_000;
/** 参加コードの発行は 1 台の PC につき 10 分に 5 回まで。 */
export const JOIN_CODE_RATE = { max: 5, windowMs: 10 * 60_000 } as const;
/** 一致しないコードへの参加リクエストは、Worker 全体で 10 分に 30 回まで。超えたら 429。 */
export const JOIN_GUESS_LIMIT = { max: 30, windowMs: 10 * 60_000 } as const;

/**
 * 参加コードの発行（`POST /join-codes`、発行する PC の端末トークンが要る）。
 * 送るのは正規化したコードの SHA-256（hex）だけで、平文は送らない。
 * 本文の `expiresAt` は省けて、Worker は読まない。期限は Worker の時計で決め、201 の応答の `expiresAt` で返す。
 */
export type JoinCodeCreate = { codeHash: string; expiresAt: number };

/** 接続先の確認（`GET /join/hello`、認証なし）。`pcCount` は解除されていない PC の数。 */
export type JoinCodeHello = { hostLabel: string; pcCount: number };

/**
 * 新しい PC の参加リクエスト（`POST /join/requests`、認証なし）。`sealed` は参加コードで封じた中身（base64url）。
 * 開いていて期限内で、まだリクエストの無いコードにだけ置け、202 を返す。ほかは区別せずに 404。
 */
export type JoinRequestIn = { codeHash: string; deviceId: string; sealed: string };

/** 発行した PC が見る、自分のいちばん新しいコード（`GET /join-codes/mine`）。無ければ 404。 */
export type JoinCodeMine = { codeHash: string; status: 'open' | 'requested' | 'approved' | 'rejected' | 'expired'; sealed: string | null; deviceId: string | null };

/** 承認（`POST /join-codes/:hash/approve`、発行した PC だけ）の本文。トークンは発行した PC に渡さない。 */
export type JoinApproveIn = { deviceId: string };

/**
 * 新しい PC の問い合わせ（`GET /join/status?code=<hash>&device=<id>`、認証なし）。
 * `deviceToken` は承認の後の最初の問い合わせにだけ載る。
 */
export type JoinStatusOut = { status: 'waiting' | 'approved' | 'rejected' | 'expired'; deviceToken?: string };

/**
 * 封じた名簿（`GET /roster`、PC の端末トークンが要る、互換の版 9）。
 * 名簿がまだ無ければ 404。`sealed` は `/roster` の鍵で封じた文書（base64url）で、Worker は開けない。
 */
export type RosterOut = { version: number; sealed: string };

/**
 * 名簿の書き換え（`PUT /roster`）。`ifVersion` は手元で読んだ版で、最初は 0。
 * 版が合えば 200 の `RosterPutOut`（1 進んだ版）、合わなければ 409 の `RosterPutOut`（今の版）。
 * 通った書き換えは、同じ要求の中で `rows` の印の行（`ROSTER_MARKER_K`）の連番を進める。`epoch` はその行に載せる今の世代である。
 */
export type RosterPut = { ifVersion: number; epoch: number; sealed: string };
export type RosterPutOut = { version: number };

/**
 * 名簿か keybox が変わったことを pull で伝える印の行の鍵（`rows.k`）。
 * ふつうの行の `k` は HMAC の base64url なので、`~` で始まる値とは重ならない。
 */
export const ROSTER_MARKER_K = '~roster';

/** リカバリーキー宛ての keybox の受け手。 */
export const RECOVERY_RECIPIENT = 'recovery';
/** `PUT /keyboxes` の 1 回の件数の上限。 */
export const MAX_KEYBOXES_PER_PUT = 20;

/**
 * 自分宛ての keybox（`GET /keyboxes?recipient=<id>`）。いちばん新しい世代の 1 つだけで、無ければ空の配列である。
 * keybox の中身は世代 1 から n までの鍵の一覧なので、古い世代の箱は返さない（読み取りの行を世代の数に比例させない）。
 * `recipient` を省けば自分宛てで、ほかの PC 宛ては 403。
 * `recovery` 宛ては、`POST /bootstrap` で入った端末が名簿か keybox を書くまでの間だけ読める（`hangar recover` の道）。
 */
export type KeyboxOut = { epoch: number; sealed: string };
export type KeyboxesOut = { boxes: KeyboxOut[] };

/**
 * keybox を置く（`PUT /keyboxes`）。受け手は解除されていない PC の ID か `recovery` で、世代と受け手の組で上書きする。
 * 通った書き換えは、名簿と同じく印の行の連番を進める。応答は 200 の `KeyboxesPutOut`。
 */
export type KeyboxIn = { epoch: number; recipient: string; sealed: string };
export type KeyboxesPut = { boxes: KeyboxIn[] };
export type KeyboxesPutOut = { written: number };

/**
 * Worker の `GET /devices` が返す PC の 1 行（互換の版 5 から）。
 * 時刻は epoch のミリ秒で、revokedAt が null でなければ解除した PC である。
 * 最後に同期した IP と場所は、Worker が同期の要求を受けたときの CF-Connecting-IP と request.cf の city、region、country をそのまま写したもので、PC ごとに最後の 1 件だけを持つ。
 * 場所は Cloudflare の推定で、英語の表記のままである。
 */
export type CloudDeviceOut = {
  id: string;
  name: string;
  platform: string;
  joinedAt: number;
  lastSeenAt: number | null;
  revokedAt: number | null;
  lastIp: string | null;
  lastCity: string | null;
  lastRegion: string | null;
  lastCountry: string | null;
  /**
   * PC かスマホか（互換の版 7）。
   * スマホは `POST /m/join` で参加した行で、platform は `mobile` である。
   * 版 6 までの Worker は返さないので、無ければ PC として読む。
   */
  kind?: 'pc' | 'mobile';
};
export type CloudDevicesResponse = { devices: CloudDeviceOut[] };
export type CloudDeviceRevokeResponse = { device: CloudDeviceOut };

/**
 * Worker の `GET /devices` が返す端末の 1 行（互換の版 9）。
 * 名前と OS は封じた名簿にあり、IP と所在地は保存しないので、ここには無い。
 * `expiresAt` はトークンの期限で、null なら期限なし。
 * CloudDeviceOut は Task 9/10 でこの形に置き換わって消える。
 */
export type DeviceOut = { id: string; kind: 'pc' | 'mobile'; joinedAt: number; lastSeenAt: number | null; revokedAt: number | null; expiresAt: number | null };
export type DevicesOut = { devices: DeviceOut[] };
export type DeviceRevokeOut = { device: DeviceOut };
/** 解除した PC の端末トークンで来た要求に、Worker が 401 で返す本文の error。トークンが合ったときにだけ返す（違うトークンには一律の unauthorized）。 */
export const REVOKED_ERROR = 'revoked';

/**
 * `PUT /files/:key` の見出し。
 * 互換の版 9 の Worker が読むのは kind、size、epoch、meta（封じたメタの base64url）だけである。
 * path、sha256、mtime、encrypted は版 8 までの端末の写しで、Task 9/10 で消える。
 */
export const CLOUD_HEADERS = { path: 'x-hangar-path', kind: 'x-hangar-kind', sha256: 'x-hangar-sha256', size: 'x-hangar-size', mtime: 'x-hangar-mtime', encrypted: 'x-hangar-encrypted', epoch: 'x-hangar-epoch', meta: 'x-hangar-meta' } as const;

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
 * 平文の鍵名なので、Task 9/10 で e2e/names.ts の transcriptBlobKey に置き換わって消える。
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
 * 平文の鍵名なので、Task 9/10 で e2e/names.ts の configBlobKey に置き換わって消える。
 */
export function configKey(deviceId: string, rel: string): string {
  if (!isSafeKeyId(deviceId)) throw new Error('端末 ID の形が不正です');
  if (!isSafeRelPath(rel)) throw new Error('設定ファイルのパスが不正です');
  return `config/${deviceId}/${rel}`;
}

/**
 * Cloudflare の無料プランの日の枠。正本は料金の頁（D1 と Workers）で、API からは取れない
 * （entitlements に入っていないことを 2026-10-02 に実物で確かめた）。
 * 設定の「使用量と費用」の表示（packages/server/src/sync/usage.ts）がこの値を使う。
 */
export const CLOUD_FREE_LIMITS = { d1RowsPerDay: 100_000, workersRequestsPerDay: 100_000 } as const;

/** R2 の月の込み量。billable-usage の ServiceName の頭で引く。単位は ServiceName ごとの PricingUnit（GB-months か Count）。 */
const R2_INCLUDED: [prefix: string, included: number][] = [
  ['R2 Data Storage', 10],
  ['R2 Storage Class A Operations', 1_000_000],
  ['R2 Storage Class B Operations', 10_000_000],
];

export function r2Included(serviceName: string): number | null {
  const hit = R2_INCLUDED.find(([p]) => serviceName.startsWith(p));
  return hit ? hit[1] : null;
}

export type CloudUsagePart = 'today' | 'plan' | 'month';

/** Worker の `GET /usage` の応答。トークンが無い Worker は configured: false だけを返す。 */
export type CloudUsageBody =
  | { configured: false }
  | {
      configured: true;
      fetchedAt: number;
      today: { day: string; d1RowsWritten: number; workersRequests: number } | null;
      plan: { workersPaid: boolean; items: { id: string; name: string; priceUsd: number; frequency: string | null }[]; periodStart: string | null; periodEnd: string | null } | null;
      month: { periodStart: string; throughDay: string | null; billedUsd: number; currency: string; services: { family: string; name: string; consumed: number; unit: string; billedUsd: number }[] } | null;
      errors: { part: CloudUsagePart; message: string }[];
    };
