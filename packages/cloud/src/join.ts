import { Hono, type Context } from 'hono';
import {
  JOIN_CODE_RATE,
  JOIN_CODE_TTL_MS,
  JOIN_GUESS_LIMIT,
  RECOVERY_RECIPIENT,
  type BootstrapRequest,
  type JoinApproveIn,
  type JoinCodeCreate,
  type JoinCodeHello,
  type JoinCodeMine,
  type JoinRequestIn,
  type JoinStatusOut,
} from '@agent-hangar/shared';
import { timingSafeEqualHex } from './auth.ts';
import type { Env, Vars } from './env.ts';
import { countInWindow, windowFull } from './limits.ts';
import { blobToSealed, isSealedText, randomToken, sealedToBlob, sha256Hex } from './util.ts';

const MAX_NAME_CHARS = 128;

/** C0 と DEL と C1。改行と NUL を名前に混ぜられると、ログと控えの名前が壊れる。 */
const CONTROL_RE = /[\u0000-\u001f\u007f-\u009f]/;

/** ファイル名に入れると困る文字。控えは `memo.conflict-<端末名>-<時刻>.md` という名前になる。 */
const NAME_BANNED_RE = /[<>:"/\\|?*]/;

/**
 * 端末の名前。
 * ホスト名がそのまま入るので、空白と非 ASCII は通す。
 * 制御文字とパスの区切りだけを断る。
 */
export const isSafeName = (s: string): boolean => s.trim().length > 0 && s.length <= MAX_NAME_CHARS && !CONTROL_RE.test(s) && !NAME_BANNED_RE.test(s);

/**
 * 端末トークンを 1 つ発行する。PC の参加とスマホの参加（mobile.ts）が共有する。
 * 返す平文のトークンは応答にだけ載せ、D1 には SHA-256 のハッシュだけを置く。
 * 何を確かめてから発行するかは呼び手ごとに違うので、ここでは照合しない。
 */
export async function issueDeviceToken(): Promise<{ token: string; tokenHash: string }> {
  const token = randomToken(32);
  return { token, tokenHash: await sha256Hex(token) };
}

/**
 * PC の参加（互換の版 9）。
 * 参加用の秘密で参加する口（POST /join）は消した。
 * 最初の PC は setup が Worker の secret に入れたトークンで `POST /bootstrap` を 1 回だけ通る。
 * 2 台目からは、参加済みの PC が発行した参加コード（5 分、1 回限り）にリクエストを置き、発行した PC の承認を待つ。
 *
 * Worker が見るのはコードの SHA-256 だけで、平文のコードも、リクエストの中身（公開鍵、名前、OS）も持たない。
 * 新しい PC の端末トークンは、承認の時点では作らず、承認の後の最初の問い合わせで作って返す。
 * 発行した PC はトークンを一度も見ない。
 */

/** 1 日を過ぎた参加コードの行は、次の発行のついでに消す。 */
const JOIN_CODE_KEEP_MS = 86_400_000;
/** 封じた参加リクエストの文字数の上限。中身は公開鍵と名前と OS なので、これで十分に余る。 */
const MAX_SEALED_REQUEST_CHARS = 8192;
/** 認証のない口（参加リクエストと bootstrap）の本文の上限（バイト）。申告の長さで先に断り、読みながらも数える。 */
const MAX_REQUEST_BODY_BYTES = 16_384;
const MIN_TOKEN_CHARS = 16;
const MAX_TOKEN_CHARS = 512;

/** 正規化したコードの SHA-256（hex）。 */
const HASH_RE = /^[0-9a-f]{64}$/;
/** 端末の ID。shared の e2e/names.ts と同じ形である。 */
const DEVICE_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

/** 使った最初の端末トークンのハッシュを置く meta の鍵。同じハッシュは 2 度通さない。 */
const META_BOOTSTRAP_USED = 'bootstrap_used';
/** 一致しないコードへのリクエストを数える meta の鍵（Worker 全体の窓）。 */
const META_JOIN_GUESS = 'join_guess';

const deny = 'unauthorized';
const notFound = 'not found';

type Ctx = Context<{ Bindings: Env; Variables: Vars }>;

type CodeRow = {
  code_hash: string;
  created_by: string;
  expires_at: number;
  used_at: number | null;
  status: JoinCodeMine['status'];
  device_id: string | null;
  /** 封じた参加リクエスト。D1 にはバイト列の BLOB で置く。 */
  request: unknown;
};

/**
 * 端末の ID の形か。
 * `recovery` は keybox の受け手の予約の名前（keys.ts）なので、端末の ID には使わせない。
 * 使わせると、その名の PC が自分宛ての keybox を置けても、recovery の決まりで読めなくなる。
 */
const isDeviceId = (v: unknown): v is string => typeof v === 'string' && DEVICE_ID_RE.test(v) && v !== RECOVERY_RECIPIENT;
const isHash = (v: unknown): v is string => typeof v === 'string' && HASH_RE.test(v);

const readJson = async (c: Ctx): Promise<Record<string, unknown> | null> => {
  const v = (await c.req.json().catch(() => null)) as unknown;
  return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
};

/**
 * 認証のない口の本文を、上限まで読んで JSON として解く。
 * 申告の長さ（content-length）で先に断り、申告が無い本文（chunked）は読みながらバイトを数え、上限を超えた時点で読むのをやめる。
 * JSON でないか、オブジェクトでなければ value を null にする。
 */
async function readCappedJson(c: Ctx, max: number): Promise<{ tooLarge: true } | { tooLarge: false; value: Record<string, unknown> | null }> {
  if (Number(c.req.header('content-length') ?? 0) > max) return { tooLarge: true };
  const stream = c.req.raw.body;
  if (!stream) return { tooLarge: false, value: null };
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel().catch(() => undefined);
      return { tooLarge: true };
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let at = 0;
  for (const ch of chunks) {
    bytes.set(ch, at);
    at += ch.byteLength;
  }
  try {
    const v = JSON.parse(new TextDecoder().decode(bytes)) as unknown;
    return { tooLarge: false, value: typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null };
  } catch {
    return { tooLarge: false, value: null };
  }
}

/** 期限を過ぎた開いたコードを expired にし、封じたリクエストを消す。主キーで 1 行だけを見る。 */
const expireCode = (db: D1Database, codeHash: string, now: number) =>
  db.prepare("update join_codes set status = 'expired', request = null where code_hash = ? and status in ('open', 'requested') and expires_at <= ?").bind(codeHash, now);

/**
 * 最初の PC の端末トークンを登録する（認証なし）。
 * `SHA-256(token)` が secret の `BOOTSTRAP_TOKEN_HASH` と一致し、そのハッシュをまだ使っていないときだけ、`kind='pc'` の行を入れる。
 * secret が無いか空の Worker は、どのトークンも 401 で断る。
 * 入れるのと使ったことを残すのを 1 つの batch にし、同じトークンが同時に 2 回来ても 1 行しか入らない。
 * 既にある端末 ID には入れず、そのときは使ったことにもしない。
 * `hangar recover` は secret を別のハッシュに入れ替えて、もう 1 度ここを通る。
 */
export async function bootstrapHandler(c: Ctx) {
  const read = await readCappedJson(c, MAX_REQUEST_BODY_BYTES);
  if (read.tooLarge) return c.json({ error: 'payload too large' }, 413);
  const body = read.value as Partial<BootstrapRequest> | null;
  if (!body || !isDeviceId(body.deviceId) || typeof body.token !== 'string' || body.token.length < MIN_TOKEN_CHARS || body.token.length > MAX_TOKEN_CHARS) {
    return c.json({ error: 'invalid body' }, 400);
  }
  const expected = (c.env.BOOTSTRAP_TOKEN_HASH ?? '').trim().toLowerCase();
  if (!HASH_RE.test(expected)) return c.json({ error: deny }, 401);
  const hash = await sha256Hex(body.token);
  if (!timingSafeEqualHex(hash, expected)) return c.json({ error: deny }, 401);
  const db = c.env.DB;
  const now = Date.now();
  const [ins] = await db.batch([
    db
      .prepare("insert into devices (id, kind, token_hash, joined_at, last_seen_at) select ?, 'pc', ?, ?, ? where not exists (select 1 from meta where key = ? and value = ?) on conflict do nothing")
      .bind(body.deviceId, hash, now, now, META_BOOTSTRAP_USED, hash),
    db
      .prepare('insert into meta (key, value) select ?, ? where exists (select 1 from devices where id = ? and token_hash = ?) on conflict(key) do update set value = excluded.value')
      .bind(META_BOOTSTRAP_USED, hash, body.deviceId, hash),
  ]);
  if (Number(ins?.meta?.changes ?? 0) !== 1) return c.json({ error: deny }, 401);
  return c.json({ deviceId: body.deviceId }, 201);
}

/** 新しい PC が使う、認証のない口（`/join/*`）。 */
export const joinApp = new Hono<{ Bindings: Env; Variables: Vars }>();

/**
 * 接続先の確認。
 * 名前は封じた名簿にあって新しい PC には読めないので、返すのはホスト名と、解除されていない PC の数だけである。
 */
joinApp.get('/hello', async (c) => {
  const r = await c.env.DB.prepare("select count(*) n from devices where kind = 'pc' and revoked_at is null").first<{ n: number }>();
  const res: JoinCodeHello = { hostLabel: new URL(c.req.url).hostname, pcCount: Number(r?.n ?? 0) };
  return c.json(res);
});

/**
 * 参加リクエストを置く。
 * 開いていて、期限内で、まだリクエストの無いコードにだけ書き、解除されていない端末と同じ ID は断る。
 * 解除済みの端末と同じ ID は通す（解除した PC が同じ ID のまま再参加する。承認が要るのは変わらない）。
 * 期限切れ、使用済み、無いコードは区別せずに 404 で、この 404 を Worker 全体の窓で数える（総当たりへの守り）。
 * 窓が上限に達している間は、正しいコードでも 429 で断る（妨害には使えるが、10 分で戻る）。
 * 形の違う本文は D1 に触らずに 400 で返し、窓に数えない。
 */
joinApp.post('/requests', async (c) => {
  const read = await readCappedJson(c, MAX_REQUEST_BODY_BYTES);
  if (read.tooLarge) return c.json({ error: 'payload too large' }, 413);
  const body = read.value as Partial<JoinRequestIn> | null;
  if (
    !body ||
    !isHash(body.codeHash) ||
    !isDeviceId(body.deviceId) ||
    !isSealedText(body.sealed, MAX_SEALED_REQUEST_CHARS)
  ) {
    return c.json({ error: 'invalid body' }, 400);
  }
  const db = c.env.DB;
  const now = Date.now();
  const guess = await db.prepare('select value from meta where key = ?').bind(META_JOIN_GUESS).first<{ value: string }>();
  if (windowFull(guess?.value, now, JOIN_GUESS_LIMIT)) return c.json({ error: 'rate limited' }, 429);
  const res = await db
    .prepare(
      "update join_codes set status = 'requested', device_id = ?, request = ?, request_at = ? where code_hash = ? and status = 'open' and expires_at > ? and request is null and not exists (select 1 from devices where id = ? and revoked_at is null)",
    )
    .bind(body.deviceId, sealedToBlob(body.sealed), now, body.codeHash, now, body.deviceId)
    .run();
  if (Number(res.meta?.changes ?? 0) === 1) return c.json({ ok: true }, 202);
  await countInWindow(db, META_JOIN_GUESS, now, JOIN_GUESS_LIMIT).run();
  return c.json({ error: notFound }, 404);
});

/**
 * 新しい PC の問い合わせ（2 秒ごと）。
 * コードのハッシュと、リクエストを置いた端末の ID の組で引く。組が合わなければ、無いコードと同じく expired を返す。
 * 承認の後の最初の問い合わせでだけ端末トークンを作り、`devices` に入れて平文を返す。D1 にはハッシュだけを置く。
 * トークンを渡したことは `used_at` で残し、2 回目からは返さない。
 * 承認が期限の間際でも受け取れるよう、承認の後は期限からさらに 5 分だけ受け取りを待つ。
 */
joinApp.get('/status', async (c) => {
  const codeHash = c.req.query('code');
  const deviceId = c.req.query('device');
  if (!isHash(codeHash) || !isDeviceId(deviceId)) return c.json({ error: 'invalid query' }, 400);
  const db = c.env.DB;
  const now = Date.now();
  const r = await db.prepare('select status, device_id, expires_at, used_at from join_codes where code_hash = ?').bind(codeHash).first<CodeRow>();
  const out = (res: JoinStatusOut) => c.json(res);
  if (!r || r.device_id !== deviceId) return out({ status: 'expired' });
  if (r.status === 'rejected') return out({ status: 'rejected' });
  if (r.status === 'requested') {
    if (r.expires_at > now) return out({ status: 'waiting' });
    await expireCode(db, codeHash, now).run();
    return out({ status: 'expired' });
  }
  if (r.status !== 'approved') return out({ status: 'expired' });
  if (r.used_at !== null) return out({ status: 'approved' });
  if (now >= r.expires_at + JOIN_CODE_TTL_MS) return out({ status: 'expired' });
  const { token, tokenHash } = await issueDeviceToken();
  // 入れるのと渡したことを残すのを 1 つの batch にし、同時の問い合わせでもトークンは 1 つしか生まれない。
  // used_at は、この問い合わせのトークンで行が入ったときだけ書く。
  // 同じ ID の解除済みの行は、同じ文の中で新しいトークンの行に置き換える（解除した PC の再参加）。
  // 同じ ID の解除されていない端末があって入れられなかったときは、待たせ続けずに rejected で閉じる。その端末の行には触らない。
  const [ins, , closed] = await db.batch([
    db
      .prepare(
        "insert into devices (id, kind, token_hash, joined_at, last_seen_at) select ?, 'pc', ?, ?, ? where exists (select 1 from join_codes where code_hash = ? and device_id = ? and status = 'approved' and used_at is null) on conflict(id) do update set kind = 'pc', token_hash = excluded.token_hash, joined_at = excluded.joined_at, last_seen_at = excluded.last_seen_at, last_pulled_seq = 0, revoked_at = null, expires_at = null where devices.revoked_at is not null",
      )
      .bind(deviceId, tokenHash, now, now, codeHash, deviceId),
    db
      .prepare("update join_codes set used_at = ? where code_hash = ? and device_id = ? and status = 'approved' and used_at is null and exists (select 1 from devices where id = ? and token_hash = ?)")
      .bind(now, codeHash, deviceId, deviceId, tokenHash),
    db
      .prepare(
        "update join_codes set status = 'rejected' where code_hash = ? and device_id = ? and status = 'approved' and used_at is null and not exists (select 1 from devices where id = ? and token_hash = ?)",
      )
      .bind(codeHash, deviceId, deviceId, tokenHash),
  ]);
  if (Number(ins?.meta?.changes ?? 0) === 1) return out({ status: 'approved', deviceToken: token });
  if (Number(closed?.meta?.changes ?? 0) === 1) return out({ status: 'rejected' });
  return out({ status: 'approved' });
});

/** 発行した PC が使う口（`/join-codes/*`）。PC の端末トークンが要る（app.ts で付ける）。 */
export const joinCodesApp = new Hono<{ Bindings: Env; Variables: Vars }>();

/**
 * 参加コードを発行する。
 * 数えるのと入れるのを 1 つの文にして、同時に来た要求で上限を越えさせない（索引 join_codes_by で数える）。
 * 同じ batch で、1 日を過ぎた行を消し、期限を過ぎた開いたコードの封じたリクエストを消す。
 * 入れられたときは、同じ PC の前の開いたコードを expired にする（1 台の PC が待つコードは 1 つだけ）。
 */
joinCodesApp.post('/', async (c) => {
  const body = await readJson(c);
  if (!body || !isHash(body.codeHash)) return c.json({ error: 'invalid body' }, 400);
  const codeHash = body.codeHash;
  const me = c.get('device').id;
  const db = c.env.DB;
  const now = Date.now();
  const expiresAt = now + JOIN_CODE_TTL_MS;
  const results = await db.batch([
    db.prepare('delete from join_codes where created_at < ?').bind(now - JOIN_CODE_KEEP_MS),
    db.prepare("update join_codes set status = 'expired', request = null where status in ('open', 'requested') and expires_at <= ?").bind(now),
    db
      .prepare(
        'insert into join_codes (code_hash, created_by, created_at, expires_at) select ?, ?, ?, ? where (select count(*) from join_codes where created_by = ? and created_at > ?) < ? on conflict do nothing',
      )
      .bind(codeHash, me, now, expiresAt, me, now - JOIN_CODE_RATE.windowMs, JOIN_CODE_RATE.max),
    db
      .prepare(
        "update join_codes set status = 'expired', request = null where created_by = ? and code_hash <> ? and status in ('open', 'requested') and exists (select 1 from join_codes where code_hash = ? and created_by = ? and created_at = ?)",
      )
      .bind(me, codeHash, codeHash, me, now),
  ]);
  if (Number(results[2]?.meta?.changes ?? 0) !== 1) {
    const dup = await db.prepare('select 1 ok from join_codes where code_hash = ?').bind(codeHash).first();
    return dup ? c.json({ error: 'conflict' }, 409) : c.json({ error: 'rate limited' }, 429);
  }
  const res: JoinCodeCreate = { codeHash, expiresAt };
  return c.json(res, 201);
});

/**
 * 発行した PC が、自分のいちばん新しいコードの状態を見る（コードが生きている間 3 秒ごと）。
 * 索引 join_codes_by で 1 行だけを引く。封じたリクエストを返すのは requested のときだけである。
 * 期限を過ぎていれば、ここで expired にして封じたリクエストを消す。
 */
joinCodesApp.get('/mine', async (c) => {
  const db = c.env.DB;
  const now = Date.now();
  const r = await db
    .prepare('select code_hash, status, device_id, request, expires_at from join_codes where created_by = ? order by created_at desc limit 1')
    .bind(c.get('device').id)
    .first<CodeRow>();
  if (!r) return c.json({ error: notFound }, 404);
  let status = r.status;
  if ((status === 'open' || status === 'requested') && r.expires_at <= now) {
    await expireCode(db, r.code_hash, now).run();
    status = 'expired';
  }
  const res: JoinCodeMine = { codeHash: r.code_hash, status, sealed: status === 'requested' && r.request !== null ? blobToSealed(r.request) : null, deviceId: r.device_id };
  return c.json(res);
});

/** 主キーでコードを引き、発行した PC かを確かめる。無ければ 404、ほかの PC のコードなら 403 の応答を返す。 */
async function ownCode(c: Ctx, codeHash: string): Promise<Response | null> {
  if (!isHash(codeHash)) return c.json({ error: notFound }, 404);
  const r = await c.env.DB.prepare('select created_by from join_codes where code_hash = ?').bind(codeHash).first<{ created_by: string }>();
  if (!r) return c.json({ error: notFound }, 404);
  if (r.created_by !== c.get('device').id) return c.json({ error: 'forbidden' }, 403);
  return null;
}

/**
 * 承認する。発行した PC だけができる。
 * 状態を approved にして封じたリクエストを消すだけで、トークンはここでは作らない（発行した PC にトークンを渡さない）。
 * 本文の端末 ID がリクエストを置いた端末と違うとき、リクエストの前、期限切れ、承認か拒否の済んだコードは 409 で断る。
 */
joinCodesApp.post('/:hash/approve', async (c) => {
  const codeHash = c.req.param('hash');
  const denied = await ownCode(c, codeHash);
  if (denied) return denied;
  const body = (await readJson(c)) as Partial<JoinApproveIn> | null;
  if (!body || !isDeviceId(body.deviceId)) return c.json({ error: 'invalid body' }, 400);
  const db = c.env.DB;
  const now = Date.now();
  const res = await db
    .prepare("update join_codes set status = 'approved', request = null where code_hash = ? and created_by = ? and status = 'requested' and device_id = ? and expires_at > ?")
    .bind(codeHash, c.get('device').id, body.deviceId, now)
    .run();
  if (Number(res.meta?.changes ?? 0) !== 1) {
    await expireCode(db, codeHash, now).run();
    return c.json({ error: 'conflict' }, 409);
  }
  return c.json({ ok: true });
});

/** 拒否する。発行した PC だけができる。リクエストの前のコードも拒否で閉じられる。 */
joinCodesApp.post('/:hash/reject', async (c) => {
  const codeHash = c.req.param('hash');
  const denied = await ownCode(c, codeHash);
  if (denied) return denied;
  const db = c.env.DB;
  const now = Date.now();
  const res = await db
    .prepare("update join_codes set status = 'rejected', request = null where code_hash = ? and created_by = ? and status in ('open', 'requested') and expires_at > ?")
    .bind(codeHash, c.get('device').id, now)
    .run();
  if (Number(res.meta?.changes ?? 0) !== 1) {
    await expireCode(db, codeHash, now).run();
    return c.json({ error: 'conflict' }, 409);
  }
  return c.json({ ok: true });
});
