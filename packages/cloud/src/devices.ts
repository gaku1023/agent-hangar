import { Hono } from 'hono';
import { isSafeKeyId, type DeviceOut, type DeviceRevokeOut, type DevicesOut } from '@agent-hangar/shared';
import type { Env, Vars } from './env.ts';

/**
 * 同期に参加している端末の一覧と、端末の解除（互換の版 9）。
 * どちらも PC の端末トークンが要り、参加している PC ならどれからでも呼べる。
 * 一覧が返すのは ID、種類、参加日、最後に同期した時刻、解除日、トークンの期限だけである。
 * 名前と OS は封じた名簿（keys.ts の `/roster`）にあり、IP と所在地は保存しない。
 * 解除は devices の行を消さずに revoked_at を付ける。スマホなら、プッシュ通知の購読（push_subscriptions）の行は消す。いつどの端末を解除したかが一覧に残り、その端末トークンは auth.ts が 401 の revoked で断る。
 * 解除した PC の本文（R2 の `b/<端末 ID>/`）と、その PC が書いた行（rows）は消さない。
 * 他の PC から読み続けられるようにし、取り返しの付かない削除を解除に混ぜないためである（docs/design.md「PC の一覧と解除」）。
 */
export const devicesApp = new Hono<{ Bindings: Env; Variables: Vars }>();

type DeviceListRow = { id: string; kind: 'pc' | 'mobile'; joined_at: number; last_seen_at: number | null; revoked_at: number | null; expires_at: number | null };

/** 一覧で読む列。端末トークンのハッシュと読み位置は読まない。 */
const DEVICE_COLS = 'id, kind, joined_at, last_seen_at, revoked_at, expires_at';

const toOut = (r: DeviceListRow): DeviceOut => ({
  id: r.id,
  kind: r.kind,
  joinedAt: r.joined_at,
  lastSeenAt: r.last_seen_at ?? null,
  revokedAt: r.revoked_at ?? null,
  expiresAt: r.expires_at ?? null,
});

/**
 * 端末を解除する書き込み。PC からの解除と、スマホが自分で外す `POST /m/leave`（mobile.ts）が同じものを使う。
 * 既に解除した端末の解除日は動かさない。
 * スマホのプッシュ通知の購読（0.9.1）も消す。解除したスマホには送らないが、endpoint を残す理由も無い。PC の ID なら行が無く、何も消えない。
 * スマホ宛ての keybox（phone_keyboxes）と、そのスマホが出した起動の依頼は消さない。keybox はトークンが通らなくなるので読まれず、依頼は残す期間（mobile.ts の LAUNCH_KEEP_MS）を過ぎると掃除されるためである。
 */
export async function revokeDevice(db: D1Database, id: string, now: number): Promise<void> {
  await db.batch([db.prepare('update devices set revoked_at = ? where id = ? and revoked_at is null').bind(now, id), db.prepare('delete from push_subscriptions where device_id = ?').bind(id)]);
}

/** 端末の数は数台なので、1 回で全部を返す。 */
devicesApp.get('/', async (c) => {
  const rows = await c.env.DB.prepare(`select ${DEVICE_COLS} from devices order by joined_at, id`).all<DeviceListRow>();
  const res: DevicesOut = { devices: rows.results.map(toOut) };
  return c.json(res);
});

/**
 * 端末を解除する。自分自身も解除できる（この PC の参加を解除）。
 * 既に解除した端末はそのまま返し、解除日を動かさない。
 */
devicesApp.post('/:id/revoke', async (c) => {
  const id = c.req.param('id');
  if (!isSafeKeyId(id)) return c.json({ error: 'invalid id' }, 400);
  await revokeDevice(c.env.DB, id, Date.now());
  const row = await c.env.DB.prepare(`select ${DEVICE_COLS} from devices where id = ?`).bind(id).first<DeviceListRow>();
  if (!row) return c.json({ error: 'not found' }, 404);
  const res: DeviceRevokeOut = { device: toOut(row) };
  return c.json(res);
});
