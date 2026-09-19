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
};

/** Worker の束縛である。`JOIN_SECRET_HASH` は wrangler の secret で入れる。 */
export type Env = { DB: D1Database; BUCKET: R2Bucket; JOIN_SECRET_HASH?: string };

/** 認証を通した後の文脈である。`c.get('device')` で取る。 */
export type Vars = { device: DeviceRow };

export type AppType = Hono<{ Bindings: Env; Variables: Vars }>;
