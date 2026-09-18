import type { JoinRequest, JoinResponse } from '@agent-hangar/shared';
import type { Context } from 'hono';
import { timingSafeEqualHex } from './auth.ts';
import type { Env, Vars } from './env.ts';
import { randomToken, sha256Hex } from './util.ts';

const isDevice = (d: unknown): d is JoinRequest['device'] => {
  const o = d as Partial<JoinRequest['device']> | null;
  return (
    !!o &&
    typeof o.id === 'string' &&
    o.id.length > 0 &&
    o.id.length <= 64 &&
    typeof o.name === 'string' &&
    o.name.length > 0 &&
    o.name.length <= 128 &&
    typeof o.platform === 'string' &&
    o.platform.length <= 32
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
