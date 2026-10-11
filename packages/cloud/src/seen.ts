import type { Context } from 'hono';
import type { Env, Vars } from './env.ts';

/** 1 つの値の上限。IPv6 でも 45 字なので、ふつうはこれに届かない。 */
const MAX_SEEN_CHARS = 64;

/** C0 と DEL と C1。端の見出しも request.cf も外から来た値なので、そのまま一覧へ流さない。 */
const CONTROL_RE = /[\u0000-\u001f\u007f-\u009f]/g;

const clean = (v: unknown): string | null => {
  if (typeof v !== 'string') return null;
  const s = v.replace(CONTROL_RE, '').trim().slice(0, MAX_SEEN_CHARS);
  return s === '' ? null : s;
};

/** 要求がどこから来たか。ip が null なら、Cloudflare の端を通っていない（手元の試しなど）。 */
export type Seen = { ip: string | null; city: string | null; region: string | null; country: string | null };

/**
 * 要求の送り手の IP と、おおよその場所を読む。
 * IP は Cloudflare の端が付ける CF-Connecting-IP、場所は request.cf の city、region、country で、どれも Cloudflare の推定である。
 * 表記は Cloudflare の英語のまま写し、訳さない。
 */
export function seenOf(c: Context<{ Bindings: Env; Variables: Vars }>): Seen {
  const cf = (c.req.raw as Request & { cf?: Record<string, unknown> }).cf ?? {};
  return { ip: clean(c.req.header('cf-connecting-ip')), city: clean(cf.city), region: clean(cf.region), country: clean(cf.country) };
}

/**
 * 最後に同期した時刻と、IP と場所を書く文。
 * 持つのは PC ごとに最後の 1 件だけで、履歴は持たない。
 * IP の無い要求（端を通らない試し）では、前の IP と場所を消さずに時刻だけを書く。
 * 同じ行を書き換えるだけなので、D1 の書き込みの行数は今までと変わらない。
 */
export function touchDevice(db: D1Database, deviceId: string, now: number, seen: Seen, pulledSeq?: number): D1PreparedStatement {
  const pulled = pulledSeq === undefined ? '' : ', last_pulled_seq = max(last_pulled_seq, ?)';
  const pulledArg = pulledSeq === undefined ? [] : [pulledSeq];
  if (seen.ip === null) return db.prepare(`update devices set last_seen_at = ?${pulled} where id = ?`).bind(now, ...pulledArg, deviceId);
  return db
    .prepare(`update devices set last_seen_at = ?${pulled}, last_ip = ?, last_city = ?, last_region = ?, last_country = ? where id = ?`)
    .bind(now, ...pulledArg, seen.ip, seen.city, seen.region, seen.country, deviceId);
}
