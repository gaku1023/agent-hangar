import type { Context } from 'hono';
import type { DeviceRow, Env, Vars } from './env.ts';

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
 * 最終確認を書き直す間隔（同期の版 6）。
 * push、pull、本文の PUT のたびに書くと、PC 1 台で 1 日に数万行を書く。
 * 他の PC の生存は「Worker の now − lastSeenAt」で見て、約 3 分（端末の PEER_STALE_MS）で古いとみなすので、1 分の粗さで足りる。
 */
export const TOUCH_EVERY_MS = 60_000;

/**
 * 最後に同期した時刻と、IP と場所を書く文。
 * 持つのは PC ごとに最後の 1 件だけで、履歴は持たない。
 * IP の無い要求（端を通らない試し）では、前の IP と場所を消さずに時刻だけを書く。
 */
export function touchDevice(db: D1Database, deviceId: string, now: number, seen: Seen): D1PreparedStatement {
  if (seen.ip === null) return db.prepare('update devices set last_seen_at = ? where id = ?').bind(now, deviceId);
  return db
    .prepare('update devices set last_seen_at = ?, last_ip = ?, last_city = ?, last_region = ?, last_country = ? where id = ?')
    .bind(now, seen.ip, seen.city, seen.region, seen.country, deviceId);
}

/**
 * 書く必要があるときだけ、最終確認を書く文を返す。要らなければ null である。
 * 認証で読んだ行（`device`）を見るので、判定のために D1 を読み直さない。
 * 前回から TOUCH_EVERY_MS たったときと、IP が変わったときに書く。IP は一覧に出すので、間引きで古いまま残さない。
 */
export function touchIfDue(db: D1Database, device: DeviceRow, now: number, seen: Seen): D1PreparedStatement | null {
  const last = device.last_seen_at;
  const due = last === null || last === undefined || now - last >= TOUCH_EVERY_MS || (seen.ip !== null && seen.ip !== (device.last_ip ?? null));
  return due ? touchDevice(db, device.id, now, seen) : null;
}
