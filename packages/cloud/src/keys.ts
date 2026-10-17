import { Hono, type Context } from 'hono';
import {
  JOIN_CODE_TTL_MS,
  MAX_KEYBOXES_PER_PUT,
  RECOVERY_RECIPIENT,
  ROSTER_MARKER_K,
  type KeyboxesOut,
  type KeyboxesPut,
  type KeyboxesPutOut,
  type KeyboxIn,
  type RosterOut,
  type RosterPut,
  type RosterPutOut,
} from '@agent-hangar/shared';
import type { Env, Vars } from './env.ts';
import { blobToSealed, isEpoch, isSealedText, sealedToBlob } from './util.ts';

/**
 * 封じた名簿と keybox の口（互換の版 9）。どれも PC の端末トークンが要る（app.ts で付ける）。
 * Worker は名簿も keybox も開けず、平文で持つのは版、世代、受け手の ID、時刻だけである。
 *
 * 名簿は 1 行（`roster.id = 1`）で、版の番号を条件にした 1 つの文で書き換える。
 * 2 台が同じ版から同時に書いても、通るのは片方だけで、もう片方は 409 と今の版を受け取って読み直す。
 *
 * 名簿か keybox を書き換えた要求は、同じ batch の中で `rows` の印の行（`k = '~roster'`）を消して入れ直し、連番を進める。
 * ほかの PC は pull でこの 1 行を見たときだけ `GET /roster` と `GET /keyboxes` を読む。
 * `GET /changes` の度に名簿を読まないので、pull の読み取りの行数は増えない。
 * 印の行の `sealed` は空の BLOB で、`epoch` は書いた PC が言う今の世代である。
 */
export const keysApp = new Hono<{ Bindings: Env; Variables: Vars }>();

type Ctx = Context<{ Bindings: Env; Variables: Vars }>;

/** 名簿の封じた文書の文字数の上限。PC とスマホの数台分の公開鍵と名前とスマホ用の鍵が入って十分に余る。 */
const MAX_ROSTER_CHARS = 65_536;
/** keybox 1 つの文字数の上限。中身は世代 1 から n までの鍵の一覧なので、世代が増えても小さい。 */
const MAX_KEYBOX_CHARS = 16_384;
/** 本文の上限（バイト）。申告の長さで先に断る。 */
const MAX_BODY_BYTES = 512_000;

/** 端末の ID。join.ts と同じ形である。 */
const DEVICE_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

/** bootstrap で使った端末トークンのハッシュを置く meta の鍵（join.ts が書く）。 */
const META_BOOTSTRAP_USED = 'bootstrap_used';
/** recovery 宛ての keybox を読む道を閉じた端末トークンのハッシュを置く meta の鍵。 */
const META_RECOVERY_DONE = 'recovery_done';

/** 封じた値は base64url で受け、D1 にはバイト列の BLOB で置く（changes.ts の行と同じ）。 */
const isSealed = isSealedText;

const readJson = async (c: Ctx): Promise<Record<string, unknown> | null> => {
  const v = (await c.req.json().catch(() => null)) as unknown;
  return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
};

const tooLarge = (c: Ctx) => Number(c.req.header('content-length') ?? 0) > MAX_BODY_BYTES;

/**
 * 印の行を消して入れ直し、表の末尾の連番を受け取らせる。
 * `cond` を渡せば、その条件が真のときだけ動く（名簿の書き換えが通ったときだけ進める）。
 */
function bumpMarker(db: D1Database, deviceId: string, epoch: number, now: number, cond?: { sql: string; binds: unknown[] }): D1PreparedStatement[] {
  const where = cond ? ` and ${cond.sql}` : '';
  const binds = cond?.binds ?? [];
  return [
    db.prepare(`delete from rows where k = ?${where}`).bind(ROSTER_MARKER_K, ...binds),
    db.prepare(`insert into rows (k, op, updated_at, device_id, epoch, sealed) select ?, 'upsert', ?, ?, ?, x'' where 1${where}`).bind(ROSTER_MARKER_K, now, deviceId, epoch, ...binds),
  ];
}

/**
 * recovery 宛ての keybox を読む道を閉じる。
 * 呼び手が bootstrap で入った端末のときだけ、そのトークンのハッシュを残す。ほかの端末の書き込みでは何もしない。
 */
function closeRecovery(db: D1Database, tokenHash: string, cond?: { sql: string; binds: unknown[] }): D1PreparedStatement {
  const where = cond ? ` and ${cond.sql}` : '';
  return db
    .prepare(`insert into meta (key, value) select ?, ? where exists (select 1 from meta where key = ? and value = ?)${where} on conflict(key) do update set value = excluded.value`)
    .bind(META_RECOVERY_DONE, tokenHash, META_BOOTSTRAP_USED, tokenHash, ...(cond?.binds ?? []));
}

/** 名簿を返す。主キーで 1 行だけを読む。 */
keysApp.get('/roster', async (c) => {
  const r = await c.env.DB.prepare('select version, sealed from roster where id = 1').first<{ version: number; sealed: unknown }>();
  if (!r) return c.json({ error: 'not found' }, 404);
  const res: RosterOut = { version: Number(r.version), sealed: blobToSealed(r.sealed) };
  return c.json(res);
});

/**
 * 名簿を書き換える。
 * `ifVersion: 0` は名簿が無いときだけ入れ、それ以外は `version = ifVersion` の行だけを書き換える。どちらも 1 つの文である。
 * 同じ batch の後ろの文は、書き換えが通ったときだけ動く。通ったかは、版と時刻と中身がこの要求の値になっていることで見る。
 * 同じ版から同じ時刻に同じ中身を書く 2 つの要求は区別できないが、そのときは印の行が 2 回進むだけで、名簿は 1 つに定まる。
 * 最後の文で今の版を読み、断ったときの 409 に載せる。
 */
keysApp.put('/roster', async (c) => {
  if (tooLarge(c)) return c.json({ error: 'payload too large' }, 413);
  const body = (await readJson(c)) as Partial<RosterPut> | null;
  if (!body || typeof body.ifVersion !== 'number' || !Number.isSafeInteger(body.ifVersion) || body.ifVersion < 0 || !isEpoch(body.epoch) || !isSealed(body.sealed, MAX_ROSTER_CHARS)) {
    return c.json({ error: 'invalid body' }, 400);
  }
  const { ifVersion, epoch } = body;
  const sealed = sealedToBlob(body.sealed);
  const device = c.get('device');
  const db = c.env.DB;
  const now = Date.now();
  const write =
    ifVersion === 0
      ? db.prepare('insert into roster (id, version, updated_at, sealed) values (1, 1, ?, ?) on conflict(id) do nothing').bind(now, sealed)
      : db.prepare('update roster set version = version + 1, updated_at = ?, sealed = ? where id = 1 and version = ?').bind(now, sealed, ifVersion);
  const done = { sql: 'exists (select 1 from roster where id = 1 and version = ? and updated_at = ? and sealed = ?)', binds: [ifVersion + 1, now, sealed] };
  const results = await db.batch([
    write,
    ...bumpMarker(db, device.id, epoch, now, done),
    closeRecovery(db, device.token_hash, done),
    db.prepare('select version from roster where id = 1'),
  ]);
  const current = Number((results.at(-1)?.results?.[0] as { version?: number } | undefined)?.version ?? 0);
  const res: RosterPutOut = { version: current };
  if (Number(results[0]?.meta?.changes ?? 0) !== 1) return c.json(res, 409);
  return c.json(res);
});

/**
 * keybox を読む。受け手の索引（keyboxes_recipient）で、その受け手のいちばん新しい世代の 1 つだけを読む。
 * keybox の中身は世代 1 から n までの鍵の一覧なので、古い世代の箱は要らない。
 * 全部を返すと、世代を回すたびに 1 回の読み取りの行が 1 つずつ増える。
 * `recipient` を省けば自分宛てで、ほかの PC 宛ては 403。
 *
 * `recovery` 宛ては `hangar recover` の道のためにある。
 * 読めるのは、端末トークンのハッシュが meta の `bootstrap_used`（`POST /bootstrap` で最後に通ったハッシュ）と同じ端末で、
 * まだ名簿か keybox を書いていない（meta の `recovery_done` が同じハッシュでない）ときだけである。
 * recover の道は、bootstrap、recovery 宛ての keybox を読む、名簿を読んで自分を足す、keybox を置く、の順なので、書いた時点で閉じても困らない。
 * 名簿の書き換えが 409 で断られたときは閉じない（読み直して当て直す間に、もう 1 度読めるように）。
 * 再び開くのは、secret を別のハッシュに入れ替えて bootstrap をもう 1 度通ったときだけである。
 * 受け手の ID が `recovery` という端末があっても、この道でしか読めない。
 */
keysApp.get('/keyboxes', async (c) => {
  const device = c.get('device');
  const recipient = c.req.query('recipient') ?? device.id;
  const db = c.env.DB;
  const boxes = (rows: unknown[]): KeyboxesOut => ({ boxes: (rows as { epoch: number; sealed: unknown }[]).map((r) => ({ epoch: Number(r.epoch), sealed: blobToSealed(r.sealed) })) });
  if (recipient === RECOVERY_RECIPIENT) {
    const allowed = 'exists (select 1 from meta where key = ? and value = ?) and not exists (select 1 from meta where key = ? and value = ?)';
    const binds = [META_BOOTSTRAP_USED, device.token_hash, META_RECOVERY_DONE, device.token_hash];
    const [ok, list] = await db.batch([
      db.prepare(`select ${allowed} ok`).bind(...binds),
      db.prepare(`select epoch, sealed from keyboxes where recipient = ? and ${allowed} order by epoch desc limit 1`).bind(RECOVERY_RECIPIENT, ...binds),
    ]);
    if (!Number((ok?.results?.[0] as { ok?: number } | undefined)?.ok ?? 0)) return c.json({ error: 'forbidden' }, 403);
    return c.json(boxes(list?.results ?? []));
  }
  if (recipient !== device.id) return c.json({ error: 'forbidden' }, 403);
  const list = await db.prepare('select epoch, sealed from keyboxes where recipient = ? order by epoch desc limit 1').bind(recipient).all();
  return c.json(boxes(list.results));
});

/**
 * keybox を置く。1 回に 20 件まで。
 * 受け手は解除されていない PC の ID か `recovery` で、ほかが 1 つでも混ざれば何も書かずに 400 で断る。スマホの分は `PUT /phone-keyboxes` で phone_keyboxes に置く。
 * 書き手が発行した参加コードにリクエストを置いた PC の ID も受け手にできる（承認の前に keybox を置くため。devices に入るのは承認の後の最初の問い合わせである）。
 * 通すのは、リクエストが期限内のときと、承認の後で端末トークンをまだ渡していないとき（期限からさらに 5 分）だけである。
 * 解除した PC が同じ ID で再参加するときも、この道で通る。
 * 世代と受け手の組で上書きする。同じ batch で印の行を進め、`epoch` には本文のいちばん新しい世代を載せる。
 */
keysApp.put('/keyboxes', async (c) => {
  if (tooLarge(c)) return c.json({ error: 'payload too large' }, 413);
  const list = readBoxes((await readJson(c)) as Partial<KeyboxesPut> | null);
  if (!list) return c.json({ error: 'invalid body' }, 400);
  const db = c.env.DB;
  const device = c.get('device');
  const now = Date.now();
  const ids = [...new Set(list.map((b) => b.recipient).filter((r) => r !== RECOVERY_RECIPIENT))];
  if (ids.length > 0) {
    const marks = ids.map(() => '?').join(', ');
    // union で重なりを畳み、受け手ごとに 1 つと数える。参加コードは索引 join_codes_by（created_by）で引く。
    const found = await db
      .prepare(
        `select count(*) n from (select id from devices where id in (${marks}) and kind = 'pc' and revoked_at is null union select device_id from join_codes where created_by = ? and device_id in (${marks}) and ((status = 'requested' and expires_at > ?) or (status = 'approved' and used_at is null and expires_at > ?)))`,
      )
      .bind(...ids, device.id, ...ids, now, now - JOIN_CODE_TTL_MS)
      .first<{ n: number }>();
    if (Number(found?.n ?? 0) !== ids.length) return c.json({ error: 'unknown recipient' }, 400);
  }
  const epoch = Math.max(...list.map((b) => b.epoch));
  await db.batch([
    ...list.map((b) =>
      db
        .prepare('insert into keyboxes (epoch, recipient, created_at, sealed) values (?, ?, ?, ?) on conflict(epoch, recipient) do update set created_at = excluded.created_at, sealed = excluded.sealed')
        .bind(b.epoch, b.recipient, now, sealedToBlob(b.sealed)),
    ),
    ...bumpMarker(db, device.id, epoch, now),
    closeRecovery(db, device.token_hash),
  ]);
  const res: KeyboxesPutOut = { written: list.length };
  return c.json(res);
});

/** 本文の keybox の一覧を読み、形が違えば null を返す。`PUT /keyboxes` と `PUT /phone-keyboxes` が使う。 */
const readBoxes = (body: Partial<KeyboxesPut> | null): KeyboxIn[] | null => {
  const list = body?.boxes;
  if (!Array.isArray(list) || list.length === 0 || list.length > MAX_KEYBOXES_PER_PUT) return null;
  const valid = (b: unknown): b is KeyboxIn => {
    const x = b as Partial<KeyboxIn> | null;
    return typeof x === 'object' && x !== null && isEpoch(x.epoch) && typeof x.recipient === 'string' && DEVICE_ID_RE.test(x.recipient) && isSealed(x.sealed, MAX_KEYBOX_CHARS);
  };
  return list.every(valid) ? list : null;
};

/**
 * スマホ用の鍵 `M[m]` の keybox を置く（互換の版 9）。1 回に 20 件まで。
 * 受け手は解除されていないスマホの ID だけで、ほかが 1 つでも混ざれば何も書かずに 400 で断る。
 * スマホは接続（`POST /m/join`）の時点で devices に入るので、承認の前の道は要らない。
 * `epoch` はスマホ用の鍵の世代で、世代と受け手の組で上書きする。
 *
 * 名簿の印の行は進めない。PC はスマホ用の鍵を名簿の `phoneKey` から読み、スマホの keybox は読まないためである。
 * 世代を回したことは、受信箱の素の `epoch` でスマホに伝わる。
 * 同じ batch で、受け手のスマホの参加リクエスト（mobile_pairings.request）を消す。keybox を置き終えた券は、もう開く必要が無い。
 */
keysApp.put('/phone-keyboxes', async (c) => {
  if (tooLarge(c)) return c.json({ error: 'payload too large' }, 413);
  const list = readBoxes((await readJson(c)) as Partial<KeyboxesPut> | null);
  if (!list) return c.json({ error: 'invalid body' }, 400);
  const db = c.env.DB;
  const now = Date.now();
  const ids = [...new Set(list.map((b) => b.recipient))];
  const marks = ids.map(() => '?').join(', ');
  const found = await db.prepare(`select count(*) n from devices where id in (${marks}) and kind = 'mobile' and revoked_at is null`).bind(...ids).first<{ n: number }>();
  if (Number(found?.n ?? 0) !== ids.length) return c.json({ error: 'unknown recipient' }, 400);
  await db.batch([
    ...list.map((b) =>
      db
        .prepare('insert into phone_keyboxes (epoch, recipient, created_at, sealed) values (?, ?, ?, ?) on conflict(epoch, recipient) do update set created_at = excluded.created_at, sealed = excluded.sealed')
        .bind(b.epoch, b.recipient, now, sealedToBlob(b.sealed)),
    ),
    db.prepare(`update mobile_pairings set request = null where device_id in (${marks}) and request is not null`).bind(...ids),
  ]);
  const res: KeyboxesPutOut = { written: list.length };
  return c.json(res);
});
