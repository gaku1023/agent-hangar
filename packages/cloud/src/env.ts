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
  /** PC かスマホか（互換の版 7）。起動のたびの用意で足す列なので、足す前の読みでは省ける形にする。無ければ PC。 */
  kind?: 'pc' | 'mobile';
};

/**
 * Worker の束縛である。`JOIN_SECRET_HASH`、`USAGE_API_TOKEN`、`CF_ACCOUNT_ID` は wrangler の secret で入れる。
 * USAGE_API_TOKEN は読み取り専用（Billing Read、Account Analytics Read）の API トークンで、無ければ /usage は configured: false を返す。
 */
export type Env = {
  DB: D1Database;
  BUCKET: R2Bucket;
  /**
   * 呼び鈴（bell.ts の HangarBell）。
   * rc.1 の設定のまま再配備していない Worker には無いので、省ける形にする。無ければ鳴らさず、問い合わせは 503 で返す。
   */
  BELL?: DurableObjectNamespace;
  JOIN_SECRET_HASH?: string;
  USAGE_API_TOKEN?: string;
  CF_ACCOUNT_ID?: string;
  /** 呼び鈴の答えの待ちを短くする。試験のためだけのもので、実物の配備では置かない（bell.ts の askTimeoutMs）。 */
  BELL_ASK_TIMEOUT_MS?: string;
};

/** 認証を通した後の文脈である。`c.get('device')` で取る。 */
export type Vars = { device: DeviceRow };

export type AppType = Hono<{ Bindings: Env; Variables: Vars }>;
