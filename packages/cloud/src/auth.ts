import type { MiddlewareHandler } from 'hono';
import type { DeviceRow, Env, Vars } from './env.ts';
import { sha256Hex } from './util.ts';

/**
 * 16 進の文字列どうしを、長さの違いだけを漏らす形で比べる。
 * 一致した位置で早く抜けないので、先頭から何文字合っていたかを時間差から測れない。
 */
export function timingSafeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** どの検査で断ったかを区別できない、一律の返事である。攻撃者に手掛かりを与えない。 */
const deny = 'unauthorized';

/**
 * Bearer の端末トークンを `devices.token_hash` で引く。
 * 見つからなければ 401 で、理由（見出しが無い、形が違う、トークンが違う）は返事に出さない。
 * D1 に置いてあるのはハッシュだけなので、平文のトークンはどこにも残らない。
 */
export function authMiddleware(): MiddlewareHandler<{ Bindings: Env; Variables: Vars }> {
  return async (c, next) => {
    const auth = c.req.header('authorization') ?? '';
    if (!auth.startsWith('Bearer ')) return c.json({ error: deny }, 401);
    const token = auth.slice('Bearer '.length).trim();
    if (!token) return c.json({ error: deny }, 401);
    const row = await c.env.DB.prepare('select * from devices where token_hash = ?').bind(await sha256Hex(token)).first<DeviceRow>();
    if (!row) return c.json({ error: deny }, 401);
    c.set('device', row);
    await next();
  };
}
