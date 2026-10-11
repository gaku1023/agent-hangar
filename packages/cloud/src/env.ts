import type { Hono } from 'hono';

/** 参加済みの端末である。`devices` の 1 行に対応する。 */
export type DeviceRow = {
  id: string;
  name: string;
  platform: string;
  token_hash: string;
  joined_at: number;
  last_seen_at: number | null;
  last_pulled_seq: number;
  /** 解除した時刻。null でなければ、この端末トークンは 401 の revoked で断る。版 4 までの D1 には列が無いことがあるので省ける形にする。 */
  revoked_at?: number | null;
  last_ip?: string | null;
  last_city?: string | null;
  last_region?: string | null;
  last_country?: string | null;
};

/**
 * Worker の束縛である。`JOIN_SECRET_HASH`、`USAGE_API_TOKEN`、`CF_ACCOUNT_ID` は wrangler の secret で入れる。
 * USAGE_API_TOKEN は読み取り専用（Billing Read、Account Analytics Read）の API トークンで、無ければ /usage は configured: false を返す。
 */
export type Env = { DB: D1Database; BUCKET: R2Bucket; JOIN_SECRET_HASH?: string; USAGE_API_TOKEN?: string; CF_ACCOUNT_ID?: string };

/** 認証を通した後の文脈である。`c.get('device')` で取る。 */
export type Vars = { device: DeviceRow };

export type AppType = Hono<{ Bindings: Env; Variables: Vars }>;
