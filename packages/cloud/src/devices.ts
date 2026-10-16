import { Hono } from 'hono';
import { isSafeKeyId, type CloudDeviceOut, type CloudDeviceRevokeResponse, type CloudDevicesResponse } from '@agent-hangar/shared';
import type { DeviceRow, Env, Vars } from './env.ts';

/**
 * 同期に参加している PC の一覧と、PC の解除（互換の版 5）。
 * どちらも端末トークンが要り、参加している PC ならどれからでも呼べる（全員が参加用の秘密を持っていて対等である）。
 * 解除は devices の行を消さずに revoked_at を付ける。いつどの PC を解除したかが一覧に残り、その PC の端末トークンは auth.ts が 401 の revoked で断る。
 * 解除した PC の本文（R2 の transcripts/<端末 ID>/ と config/<端末 ID>/）と、その PC が書いた行（rows、changes）は消さない。
 * 他の PC から読み続けられるようにし、取り返しの付かない削除を解除に混ぜないためである（docs/design.md「PC の一覧と解除」）。
 */
export const devicesApp = new Hono<{ Bindings: Env; Variables: Vars }>();

/** 一覧に出す形。端末トークンのハッシュと読み位置は出さない。 */
const toOut = (r: DeviceRow): CloudDeviceOut => ({
  id: r.id,
  // 名前と OS は devices に置かない（互換の版 9）。封じた名簿から読むまでは ID を名前の代わりに出す。
  name: r.id,
  platform: '',
  joinedAt: r.joined_at,
  lastSeenAt: r.last_seen_at,
  revokedAt: r.revoked_at ?? null,
  // IP と所在地は保存しない（互換の版 9）。
  lastIp: null,
  lastCity: null,
  lastRegion: null,
  lastCountry: null,
  kind: r.kind,
});

/** PC の数は数台なので、1 回で全部を返す。 */
devicesApp.get('/', async (c) => {
  const rows = await c.env.DB.prepare('select * from devices order by joined_at, id').all<DeviceRow>();
  const res: CloudDevicesResponse = { devices: rows.results.map(toOut) };
  return c.json(res);
});

/**
 * PC を解除する。自分自身も解除できる（この PC の参加を解除）。
 * 既に解除した PC はそのまま返し、解除日を動かさない。
 */
devicesApp.post('/:id/revoke', async (c) => {
  const id = c.req.param('id');
  if (!isSafeKeyId(id)) return c.json({ error: 'invalid id' }, 400);
  const now = Date.now();
  await c.env.DB.prepare('update devices set revoked_at = ? where id = ? and revoked_at is null').bind(now, id).run();
  const row = await c.env.DB.prepare('select * from devices where id = ?').bind(id).first<DeviceRow>();
  if (!row) return c.json({ error: 'not found' }, 404);
  const res: CloudDeviceRevokeResponse = { device: toOut(row) };
  return c.json(res);
});
