import type { MiddlewareHandler } from 'hono';
import { REVOKED_ERROR } from '@agent-hangar/shared';
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
 * 解除した PC（revoked_at のある行）のトークンも 401 だが、本文は `{ error: 'revoked' }` にする。
 * 期限（expires_at）を過ぎたトークンも 401 で、本文は `{ error: 'expired' }` にする。
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
    // 解除した PC の端末トークンである。
    // トークンが合った相手にだけ理由を言う。持ち主は「解除された」と知って参加し直せばよく、トークンを持たない相手には一律の返事しか出ない。
    if (row.revoked_at !== null && row.revoked_at !== undefined) return c.json({ error: REVOKED_ERROR }, 401);
    // 期限のあるトークン（互換の版 9）で、期限を過ぎたものである。理由を言うのは、解除と同じくトークンが合った相手にだけである。
    if (row.expires_at !== null && row.expires_at !== undefined && row.expires_at <= Date.now()) return c.json({ error: 'expired' }, 401);
    c.set('device', row);
    await next();
  };
}

/**
 * 認証を通した端末の種類を確かめる（互換の版 7）。authMiddleware の後に置く。
 * スマホのトークンは `/m/` のスマホ用の口だけを通し、PC の口（同期、本文、一覧、使用量）は 403 で断る。
 * 逆に、PC だけの口（券を取る、受信箱の素を書く）とスマホだけの口（受信箱を読む）も分ける。
 * 列を足す前の行（kind が無い）は PC として読む。
 */
export function requireKind(kind: 'pc' | 'mobile'): MiddlewareHandler<{ Bindings: Env; Variables: Vars }> {
  return async (c, next) => {
    if ((c.get('device').kind ?? 'pc') !== kind) return c.json({ error: 'forbidden' }, 403);
    await next();
  };
}
