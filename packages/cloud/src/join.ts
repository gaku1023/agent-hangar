import { isSafeKeyId, type JoinRequest, type JoinResponse } from '@agent-hangar/shared';
import type { Context } from 'hono';
import { timingSafeEqualHex } from './auth.ts';
import type { Env, Vars } from './env.ts';
import { randomToken, sha256Hex } from './util.ts';

const MAX_NAME_CHARS = 128;
const MAX_PLATFORM_CHARS = 32;

/** C0 と DEL と C1。改行と NUL を名前に混ぜられると、ログと控えの名前が壊れる。 */
const CONTROL_RE = /[\u0000-\u001f\u007f-\u009f]/;

/** ファイル名に入れると困る文字。控えは `memo.conflict-<端末名>-<時刻>.md` という名前になる。 */
const NAME_BANNED_RE = /[<>:"/\\|?*]/;

/**
 * 端末の名前。
 * ホスト名がそのまま入るので、空白と非 ASCII は通す。
 * 制御文字とパスの区切りだけを断る。
 */
const isSafeName = (s: string): boolean => s.trim().length > 0 && s.length <= MAX_NAME_CHARS && !CONTROL_RE.test(s) && !NAME_BANNED_RE.test(s);

/** `process.platform` がそのまま入る。短い ASCII だけを通す。 */
const isSafePlatform = (s: string): boolean => s.length <= MAX_PLATFORM_CHARS && isSafeKeyId(s);

/**
 * 参加を申し込んだ端末の形。
 * **ID は共有の `isSafeKeyId` で見る。**
 * ID は `rows.device_id` にも R2 の鍵（`transcripts/<端末 ID>/...`）にも入るので、
 * スラッシュや `..` を通すと、出口の検査を 1 つ抜けただけで他端末の領域に届いてしまう。
 * 入口で断るのが本筋である。
 */
const isDevice = (d: unknown): d is JoinRequest['device'] => {
  const o = d as Partial<JoinRequest['device']> | null;
  return (
    !!o &&
    typeof o.id === 'string' &&
    isSafeKeyId(o.id) &&
    typeof o.name === 'string' &&
    isSafeName(o.name) &&
    typeof o.platform === 'string' &&
    isSafePlatform(o.platform)
  );
};

/**
 * 参加用の秘密を検査し、端末トークンを発行する。
 * 秘密もトークンも D1 には SHA-256 だけを置き、平文は Worker のどこにも残さない。
 * 応答に載せるのは発行したトークンだけで、受け取った秘密は返さずログにも出さない。
 */
export async function joinHandler(c: Context<{ Bindings: Env; Variables: Vars }>): Promise<Response> {
  const body = (await c.req.json().catch(() => null)) as Partial<JoinRequest> | null;
  if (!body || typeof body.secret !== 'string' || !isDevice(body.device)) return c.json({ error: 'invalid body' }, 400);
  const active = await c.env.DB.prepare('select secret_hash from join_secrets where revoked_at is null').all<{ secret_hash: string }>();
  // 有効な秘密が 1 つも無いのは、Worker の secret がまだ入っていないということである。
  if (active.results.length === 0) return c.json({ error: 'not initialized' }, 503);
  const hash = await sha256Hex(body.secret);
  // 一致したところで抜けない。どの行まで見たかを時間差から測れないようにする。
  let ok = false;
  for (const r of active.results) ok = timingSafeEqualHex(r.secret_hash, hash) || ok;
  if (!ok) return c.json({ error: 'forbidden' }, 403);
  const token = randomToken(32);
  const now = Date.now();
  await c.env.DB.prepare(
    'insert into devices (id, name, platform, token_hash, joined_at, last_seen_at, last_pulled_seq) values (?, ?, ?, ?, ?, ?, 0) on conflict(id) do update set name = excluded.name, platform = excluded.platform, token_hash = excluded.token_hash, last_seen_at = excluded.last_seen_at',
  )
    .bind(body.device.id, body.device.name, body.device.platform, await sha256Hex(token), now, now)
    .run();
  const res: JoinResponse = { deviceToken: token, deviceId: body.device.id };
  return c.json(res, 201);
}
