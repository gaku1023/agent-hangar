import { type Context, Hono } from 'hono';
import { LAUNCH_TTL_MS, MOBILE_ASK_MAX_BYTES, type MobileAskIn, type MobileInboxResponse, type MobileJoinRequest, type MobileJoinResponse, type MobileLaunchIn, type MobileLaunchStatus, type MobilePairingResponse } from '@agent-hangar/shared';
import { authMiddleware, requireKind } from './auth.ts';
import { BELL_DEVICE_HEADER, BELL_NAME } from './bellWire.ts';
import type { Env, Vars } from './env.ts';
import { isSafeName, issueDeviceToken } from './join.ts';
import { seenOf, touchIfDue } from './seen.ts';
import { randomToken, sha256Hex } from './util.ts';

/**
 * スマホの口（互換の版 7）。app.ts が `/m` に載せる。
 *
 * スマホは参加の秘密を持たない。
 * PC が `POST /m/pairings` で取った使い捨ての券（5 分で失効、1 回で使い切り）を QR で渡し、スマホは `POST /m/join` で券をスマホ用のトークンに替える。
 * スマホの行は devices に `kind = 'mobile'` で入り、そのトークンが通るのはこのファイルのスマホ用の口だけである（auth.ts の requireKind）。
 * 受信箱の素は PC が暗号化して置き、Worker は PC の ID と更新時刻のほかは読めない。
 * 起動の依頼もスマホが封をして置き、宛先の PC が pull（changes.ts の launches）で受け取って、claim と answer で状態を進める。
 *
 * 表は `rows` に足さず、専用の表（mobile_feeds、mobile_pairings、launch_requests）に置く。
 * 版 6 の PC は知らない表を pull せず、push も断られないので、同期から締め出されない。
 *
 * 呼び鈴（互換の版 8）は bell.ts の Durable Object にある。PC は `GET /m/bell` で WebSocket をつなぎ、スマホは `POST /m/ask` で問い合わせ、起動の依頼は宛先の PC を鳴らす。
 *
 * 経路を足すときは、参加の口のほかは必ず authMiddleware と requireKind を付ける。
 */

/** 券の有効期間。QR の写真や履歴が残っても、この時間を過ぎれば使えない。 */
export const PAIRING_TTL_MS = 5 * 60_000;
/** 1 台の PC が券を取れる回数。盗まれた PC のトークンで D1 の書き込みの枠を食い潰させない。 */
export const PAIRING_RATE = { max: 5, windowMs: 10 * 60_000 } as const;
/** 使った券も使わなかった券も、この時間を過ぎた行は券を取るついでに消す。 */
export const PAIRING_KEEP_MS = 24 * 60 * 60_000;
/** 券の文字数の上限。実物は 22 字（randomToken(16)）なので、長い入力は貼り間違いか攻撃である。 */
const MAX_CODE_CHARS = 64;
/**
 * PUT /m/feed の本文の上限。
 * 受信箱の素は暗号化の前で 48 KiB（MOBILE_FEED_MAX_BYTES）までで、封をして base64url にすると 4/3 倍に膨らみ、上限いっぱいの素は本文が約 65,600 バイトになる。
 * 64 KiB では上限いっぱいの素を断ってしまうので、膨らみに余裕を見て 96 KiB にする。
 */
export const MAX_FEED_BODY_BYTES = 96 * 1024;
/**
 * 解除されていないスマホの台数の上限（Worker 全体で）。
 * 券を取れる PC のトークンが盗まれても、スマホの行を際限なく増やさせない。
 * これは緩い上限である。数える文と行を足す文は別の文なので、同時に来た参加は両方とも数えた時点の台数で通り、上限を少し越えうる。
 * 越える分は、同時に使える券の数で抑えられる（券は 1 回で使い切り、1 台の PC から 10 分に 5 枚まで）。
 */
export const MAX_ACTIVE_PHONES = 10;
/** 1 台のスマホが起動の依頼を出せる回数。盗まれたスマホのトークンで D1 の書き込みの枠を食い潰させない。 */
export const LAUNCH_RATE = { max: 10, windowMs: 10 * 60_000 } as const;
/** 起動の依頼の行を残す期間。過ぎた行は、依頼を出すついでに消す。 */
export const LAUNCH_KEEP_MS = 7 * 24 * 60 * 60_000;
/**
 * 起動の依頼の本文の上限。
 * 最初の指示は MOBILE_PROMPT_MAX（8,000 字）までで、日本語なら UTF-8 で約 24 KB になる。
 * 封をして base64url にすると 4/3 倍に膨らみ約 33 KB になるので、JSON の枠と残りの欄に余裕を見て 48 KiB にする。
 */
export const MAX_LAUNCH_BODY_BYTES = 48 * 1024;
/** 応答の本文の上限。中身は会話の ID と題か、断った理由と 300 字までの説明なので、封をしても収まる。 */
export const MAX_ANSWER_BODY_BYTES = 16 * 1024;
/** 依頼の ID の文字数の上限。スマホは UUID（36 字）を振る。 */
const MAX_LAUNCH_ID_CHARS = 64;
/** 宛先の端末の ID の文字数の上限。 */
const MAX_TARGET_CHARS = 128;

const ENC = new TextEncoder();
const deny = 'unauthorized';

export const mobileApp = new Hono<{ Bindings: Env; Variables: Vars }>();

type Ctx = Context<{ Bindings: Env; Variables: Vars }>;

/**
 * 本文を上限まで読み、JSON として解く。
 * 上限を超えたら `tooLarge`、JSON でなければ value を null にする。
 * 申告の長さ（content-length）で先に断り、申告が無いか偽りのときは読んだ後のバイト数で断る。
 */
async function readLimitedJson(c: Ctx, max: number): Promise<{ tooLarge: true } | { tooLarge: false; value: unknown }> {
  const declared = Number(c.req.header('content-length') ?? 0);
  if (declared > max) return { tooLarge: true };
  const text = await c.req.text();
  if (ENC.encode(text).byteLength > max) return { tooLarge: true };
  try {
    return { tooLarge: false, value: JSON.parse(text) as unknown };
  } catch {
    return { tooLarge: false, value: null };
  }
}

/**
 * PC がペアリングの券を取る。
 * 返すのは平文の券で、D1 には SHA-256 だけを置く。
 * 数えるのと入れるのを 1 つの文にして、同時に来た要求で上限を越えさせない（索引 mobile_pairings_by で数える）。
 */
mobileApp.post('/pairings', authMiddleware(), requireKind('pc'), async (c) => {
  const device = c.get('device');
  const db = c.env.DB;
  const now = Date.now();
  const code = randomToken(16);
  const results = await db.batch([
    db.prepare('delete from mobile_pairings where created_at < ?').bind(now - PAIRING_KEEP_MS),
    db
      .prepare('insert into mobile_pairings (code_hash, created_by, created_at, used_at) select ?, ?, ?, null where (select count(*) from mobile_pairings where created_by = ? and created_at > ?) < ?')
      .bind(await sha256Hex(code), device.id, now, device.id, now - PAIRING_RATE.windowMs, PAIRING_RATE.max),
  ]);
  if (Number(results[1]?.meta?.changes ?? 0) !== 1) return c.json({ error: 'rate limited' }, 429);
  const res: MobilePairingResponse = { code, expiresAt: now + PAIRING_TTL_MS };
  return c.json(res, 201);
});

const isJoinBody = (v: unknown): v is MobileJoinRequest => {
  const o = v as Partial<MobileJoinRequest> | null;
  return (
    !!o &&
    typeof o.code === 'string' &&
    o.code.length > 0 &&
    o.code.length <= MAX_CODE_CHARS &&
    !!o.device &&
    typeof o.device === 'object' &&
    typeof o.device.name === 'string' &&
    isSafeName(o.device.name)
  );
};

/**
 * スマホが券をスマホ用のトークンに替える。トークンは要らない。
 *
 * 券を使い切りにする書き換え（まだ使っておらず、期限内のものだけ）が 1 行を変えたときだけ参加させる。
 * それ以外は、無い券も、使った券も、期限切れの券も、参加の秘密を渡されたときも、同じ 401 で断る。
 * 参加の秘密はここでは照合しない。スマホは PC として参加できない。
 *
 * 解除されていないスマホが MAX_ACTIVE_PHONES 台あるときは 409 で断る。
 * 断るのは券を照合した後、使い切りにする前なので、券は残り、1 台外せば同じ券で参加できる。
 * 使い切りにする文にも台数の条件を入れる（そこで落ちたときは 401 で、券は残る）。
 * ただし台数を数える文と行を足す文は分かれているので、同時に来た参加は上限を少し越えうる（緩い上限）。越える分は券の取りすぎの制限（1 台の PC から 10 分に 5 枚）で抑えられる。
 *
 * スマホの行の ID は Worker が新しく振る。
 * スマホが名乗る ID（`device.id`）は使わないので、既にある行（PC の行や、外したスマホの行）を指して上書きすることはできない。
 * 外したスマホの行は残り、新しい券で参加し直すと別の行になる。
 */
mobileApp.post('/join', async (c) => {
  const body = (await c.req.json().catch(() => null)) as unknown;
  if (!isJoinBody(body)) return c.json({ error: 'invalid body' }, 400);
  const db = c.env.DB;
  const now = Date.now();
  const codeHash = await sha256Hex(body.code);
  const [valid, phones] = await db.batch([
    db.prepare('select 1 ok from mobile_pairings where code_hash = ? and used_at is null and created_at > ?').bind(codeHash, now - PAIRING_TTL_MS),
    db.prepare("select count(*) n from devices where kind = 'mobile' and revoked_at is null"),
  ]);
  if (!valid?.results?.length) return c.json({ error: deny }, 401);
  if (Number((phones?.results?.[0] as { n?: number } | undefined)?.n ?? 0) >= MAX_ACTIVE_PHONES) return c.json({ error: 'too-many-phones' }, 409);
  const used = await db
    .prepare("update mobile_pairings set used_at = ? where code_hash = ? and used_at is null and created_at > ? and (select count(*) from devices where kind = 'mobile' and revoked_at is null) < ?")
    .bind(now, codeHash, now - PAIRING_TTL_MS, MAX_ACTIVE_PHONES)
    .run();
  if (Number(used.meta?.changes ?? 0) !== 1) return c.json({ error: deny }, 401);
  const id = crypto.randomUUID();
  const { token, tokenHash } = await issueDeviceToken();
  const seen = seenOf(c);
  await db
    .prepare(
      "insert into devices (id, name, platform, token_hash, joined_at, last_seen_at, last_pulled_seq, revoked_at, last_ip, last_city, last_region, last_country, kind) values (?, ?, 'mobile', ?, ?, ?, 0, null, ?, ?, ?, ?, 'mobile')",
    )
    .bind(id, body.device.name, tokenHash, now, now, seen.ip, seen.city, seen.region, seen.country)
    .run();
  const res: MobileJoinResponse = { token, deviceId: id };
  return c.json(res, 201);
});

/**
 * PC が受信箱の素（暗号化した JSON）を置く。PC ごとに 1 行で、2 回目からは上書きする。
 * 中身は読まず、文字列であることと大きさだけを見る。
 */
mobileApp.put('/feed', authMiddleware(), requireKind('pc'), async (c) => {
  const read = await readLimitedJson(c, MAX_FEED_BODY_BYTES);
  if (read.tooLarge) return c.json({ error: 'payload too large', limit: MAX_FEED_BODY_BYTES }, 413);
  const body = read.value as { sealed?: unknown } | null;
  if (!body || typeof body.sealed !== 'string' || body.sealed.length === 0) return c.json({ error: 'invalid body' }, 400);
  const device = c.get('device');
  const db = c.env.DB;
  const now = Date.now();
  const stmts = [
    db
      .prepare('insert into mobile_feeds (device_id, sealed, updated_at) values (?, ?, ?) on conflict(device_id) do update set sealed = excluded.sealed, updated_at = excluded.updated_at')
      .bind(device.id, body.sealed, now),
  ];
  const touch = touchIfDue(db, device, now, seenOf(c));
  if (touch) stmts.push(touch);
  await db.batch(stmts);
  return c.json({ ok: true, updatedAt: now });
});

type InboxDeviceRow = { id: string; name: string; platform: string; last_seen_at: number | null };
type InboxFeedRow = { device_id: string; updated_at: number; sealed: string };

/**
 * スマホが受信箱を読む。
 * 読むのは devices と mobile_feeds だけで、どちらも PC の数の行である。rows は読まない。
 * 解除した PC と、スマホの行は出さない。解除した PC が前に置いた素も出さない。
 * スマホの最終確認も書く（間引きは PC と同じ touchIfDue）。PC の一覧でスマホを最後に見た時刻が動く。
 */
mobileApp.get('/inbox', authMiddleware(), requireKind('mobile'), async (c) => {
  const db = c.env.DB;
  const now = Date.now();
  const touch = touchIfDue(db, c.get('device'), now, seenOf(c));
  const results = await db.batch([
    ...(touch ? [touch] : []),
    db.prepare("select id, name, platform, last_seen_at from devices where kind = 'pc' and revoked_at is null order by joined_at, id"),
    db.prepare("select f.device_id, f.updated_at, f.sealed from mobile_feeds f join devices d on d.id = f.device_id where d.kind = 'pc' and d.revoked_at is null order by f.device_id"),
  ]);
  const off = touch ? 1 : 0;
  const devices = results[off];
  const feeds = results[off + 1];
  const res: MobileInboxResponse = {
    now,
    devices: ((devices?.results ?? []) as InboxDeviceRow[]).map((d) => ({ id: d.id, name: d.name, platform: d.platform, lastSeenAt: d.last_seen_at ?? null })),
    feeds: ((feeds?.results ?? []) as InboxFeedRow[]).map((f) => ({ deviceId: f.device_id, updatedAt: f.updated_at, sealed: f.sealed })),
  };
  return c.json(res);
});

type LaunchRow = { id: string; from_device: string; status: MobileLaunchStatus['status']; created_at: number; sealed_answer: string | null };

const LAUNCH_SELECT = 'select id, from_device, status, created_at, sealed_answer from launch_requests where id = ?';

/** 受け取られないまま TTL を過ぎた依頼。PC の claim の条件（created_at > now - TTL）のちょうど裏である。 */
const isExpired = (r: LaunchRow, now: number): boolean => r.status === 'pending' && r.created_at <= now - LAUNCH_TTL_MS;

const statusOf = (r: LaunchRow, now: number): MobileLaunchStatus => ({ id: r.id, status: isExpired(r, now) ? 'expired' : r.status, sealedAnswer: r.sealed_answer ?? null });

const isLaunchBody = (v: unknown): v is MobileLaunchIn => {
  const o = v as Partial<MobileLaunchIn> | null;
  return (
    !!o &&
    typeof o.id === 'string' &&
    o.id.length > 0 &&
    o.id.length <= MAX_LAUNCH_ID_CHARS &&
    typeof o.targetDevice === 'string' &&
    o.targetDevice.length > 0 &&
    o.targetDevice.length <= MAX_TARGET_CHARS &&
    typeof o.sealed === 'string' &&
    o.sealed.length > 0
  );
};

/**
 * スマホが起動の依頼を出す。中身（sealed）は封をしたまま置き、読まない。
 *
 * 宛先は解除されていない PC だけで、それ以外（解除した PC、スマホ、無い ID）は 404 で断る。
 * 同じ ID の再送は行を増やさず、既にある行の状態を返す（回数にも数えない）。ほかのスマホの ID と重なったら 409 で、その行の中身は返さない。
 * 回数の上限（LAUNCH_RATE）は、数えるのと入れるのを 1 つの文にして、同時に来た要求で越えさせない（索引 launch_requests_from で数える）。
 * 7 日より古い行は、ここでついでに消す（索引 launch_requests_at で引く）。
 */
mobileApp.post('/launches', authMiddleware(), requireKind('mobile'), async (c) => {
  const read = await readLimitedJson(c, MAX_LAUNCH_BODY_BYTES);
  if (read.tooLarge) return c.json({ error: 'payload too large', limit: MAX_LAUNCH_BODY_BYTES }, 413);
  if (!isLaunchBody(read.value)) return c.json({ error: 'invalid body' }, 400);
  const body = read.value;
  const device = c.get('device');
  const db = c.env.DB;
  const now = Date.now();
  const [, existing, target] = await db.batch([
    db.prepare('delete from launch_requests where created_at < ?').bind(now - LAUNCH_KEEP_MS),
    db.prepare(LAUNCH_SELECT).bind(body.id),
    db.prepare("select id from devices where id = ? and kind = 'pc' and revoked_at is null").bind(body.targetDevice),
  ]);
  const answerExisting = (row: LaunchRow) => (row.from_device === device.id ? c.json(statusOf(row, now), 201) : c.json({ error: 'conflict' }, 409));
  const prev = existing?.results?.[0] as LaunchRow | undefined;
  if (prev) return answerExisting(prev);
  if (!target?.results?.length) return c.json({ error: 'not found' }, 404);
  const ins = await db
    .prepare("insert or ignore into launch_requests (id, target_device, from_device, sealed, status, created_at, claimed_at, answered_at, sealed_answer) select ?, ?, ?, ?, 'pending', ?, null, null, null where (select count(*) from launch_requests where from_device = ? and created_at > ?) < ?")
    .bind(body.id, body.targetDevice, device.id, body.sealed, now, device.id, now - LAUNCH_RATE.windowMs, LAUNCH_RATE.max)
    .run();
  if (Number(ins.meta?.changes ?? 0) === 1) {
    // 宛先の PC を鳴らす。応答は待たず、失敗しても依頼は成功として返す（PC は 30 秒の pull で拾う）。
    const rang = ringBell(c.env, body.targetDevice);
    try {
      c.executionCtx.waitUntil(rang);
    } catch {
      // 実行の文脈が無い（Worker の外で app を叩いた）。鳴らすのは捨ててよい。
    }
    const res: MobileLaunchStatus = { id: body.id, status: 'pending', sealedAnswer: null };
    return c.json(res, 201);
  }
  // 入らなかった。同時に来た同じ ID の再送か、回数の上限である。
  const again = await db.prepare(LAUNCH_SELECT).bind(body.id).first<LaunchRow>();
  if (again) return answerExisting(again);
  return c.json({ error: 'rate limited' }, 429);
});

/**
 * スマホが自分の依頼の状態を読む。読めるのは依頼を出したスマホだけで、ほかは 404 である。
 * 受け取られないまま TTL を過ぎた依頼は expired と返し、行も expired に書き換える（書き換えるのはここだけ）。
 */
mobileApp.get('/launches/:id', authMiddleware(), requireKind('mobile'), async (c) => {
  const id = c.req.param('id');
  const device = c.get('device');
  const db = c.env.DB;
  const now = Date.now();
  const mine = () => db.prepare(`${LAUNCH_SELECT} and from_device = ?`).bind(id, device.id).first<LaunchRow>();
  const row = await mine();
  if (!row) return c.json({ error: 'not found' }, 404);
  if (!isExpired(row, now)) return c.json(statusOf(row, now));
  const w = await db.prepare("update launch_requests set status = 'expired' where id = ? and status = 'pending' and created_at <= ?").bind(id, now - LAUNCH_TTL_MS).run();
  if (Number(w.meta?.changes ?? 0) === 1) return c.json(statusOf(row, now));
  // 読んでから書くまでの間に状態が進んだ。読み直して、今の状態を返す。
  const fresh = await mine();
  return fresh ? c.json(statusOf(fresh, now)) : c.json({ error: 'not found' }, 404);
});

/**
 * 宛先の PC が依頼を受け取る。
 * 1 つの条件つきの書き換えで、自分宛てで、まだ誰も受け取っておらず、TTL の内の行だけを claimed にする。
 * 1 行を変えたときだけ 200 で、それ以外（2 回目、宛先でない PC、時間切れ、無い ID）は 409 である。PC は 200 のときだけ起動する。
 */
mobileApp.post('/launches/:id/claim', authMiddleware(), requireKind('pc'), async (c) => {
  const device = c.get('device');
  const now = Date.now();
  const r = await c.env.DB.prepare("update launch_requests set status = 'claimed', claimed_at = ? where id = ? and target_device = ? and status = 'pending' and created_at > ?")
    .bind(now, c.req.param('id'), device.id, now - LAUNCH_TTL_MS)
    .run();
  if (Number(r.meta?.changes ?? 0) === 1) return c.json({ ok: true });
  return c.json({ error: 'conflict' }, 409);
});

const isAnswerBody = (v: unknown): v is { ok: boolean; sealedAnswer: string } => {
  const o = v as { ok?: unknown; sealedAnswer?: unknown } | null;
  return !!o && typeof o.ok === 'boolean' && typeof o.sealedAnswer === 'string' && o.sealedAnswer.length > 0;
};

/**
 * 受け取った PC が結果を返す。応答の中身（sealedAnswer）は封をしたまま置く。
 * 自分が受け取った（claimed の）自分宛ての行だけを started か failed にする。それ以外は 409 である。
 */
mobileApp.post('/launches/:id/answer', authMiddleware(), requireKind('pc'), async (c) => {
  const read = await readLimitedJson(c, MAX_ANSWER_BODY_BYTES);
  if (read.tooLarge) return c.json({ error: 'payload too large', limit: MAX_ANSWER_BODY_BYTES }, 413);
  if (!isAnswerBody(read.value)) return c.json({ error: 'invalid body' }, 400);
  const body = read.value;
  const device = c.get('device');
  const r = await c.env.DB.prepare("update launch_requests set status = ?, answered_at = ?, sealed_answer = ? where id = ? and target_device = ? and status = 'claimed'")
    .bind(body.ok ? 'started' : 'failed', Date.now(), body.sealedAnswer, c.req.param('id'), device.id)
    .run();
  if (Number(r.meta?.changes ?? 0) === 1) return c.json({ ok: true });
  return c.json({ error: 'conflict' }, 409);
});

/** 呼び鈴の実体。束縛が無い（rc.1 の設定のまま再配備していない）Worker では null。 */
function bellOf(env: Env): DurableObjectStub | null {
  const ns = env.BELL;
  return ns ? ns.get(ns.idFromName(BELL_NAME)) : null;
}

/** 宛先の PC を鳴らす。束縛が無いときと失敗したときは何もしない。 */
async function ringBell(env: Env, target: string): Promise<void> {
  try {
    const bell = bellOf(env);
    if (!bell) return;
    const r = await bell.fetch('https://bell/ring', { method: 'POST', headers: { [BELL_DEVICE_HEADER]: target } });
    await r.body?.cancel();
  } catch (e) {
    console.error('bell ring failed', e instanceof Error ? e.name : typeof e);
  }
}

/**
 * PC が呼び鈴につなぐ（互換の版 8）。
 * 認証と種類の検査（PC だけ）をここで済ませ、端末の ID を見出しに載せて Durable Object へ渡す。
 * スマホのトークン（403）と解除した PC（401）は Durable Object まで届かない。
 * 呼び鈴の束縛が無い Worker では 503 で、PC は張らずに 30 秒の pull で動く。
 */
mobileApp.get('/bell', authMiddleware(), requireKind('pc'), async (c) => {
  if (c.req.header('upgrade')?.toLowerCase() !== 'websocket') return c.json({ error: 'websocket required' }, 426);
  const bell = bellOf(c.env);
  if (!bell) return c.json({ error: 'bell unavailable' }, 503);
  return bell.fetch('https://bell/connect', { headers: { upgrade: 'websocket', [BELL_DEVICE_HEADER]: c.get('device').id } });
});

/**
 * スマホが宛先の PC に問い合わせる（互換の版 8）。
 * 本文は `{ id, targetDevice, sealed }` で、sealed はスマホの鍵で封をしてあり、Worker も Durable Object も読まない。D1 にも書かない。
 * 本文が 4 KiB を超えたら 413、宛先が解除されていない PC でなければ 404 で断る。
 * Durable Object が宛先の WebSocket に渡し、答え（`{ sealed }`）か、503 pc-offline、504 pc-timeout、429 をそのまま返す。
 */
mobileApp.post('/ask', authMiddleware(), requireKind('mobile'), async (c) => {
  const read = await readLimitedJson(c, MOBILE_ASK_MAX_BYTES);
  if (read.tooLarge) return c.json({ error: 'payload too large', limit: MOBILE_ASK_MAX_BYTES }, 413);
  if (!isLaunchBody(read.value)) return c.json({ error: 'invalid body' }, 400);
  const body: MobileAskIn = { id: read.value.id, targetDevice: read.value.targetDevice, sealed: read.value.sealed };
  const target = await c.env.DB.prepare("select id from devices where id = ? and kind = 'pc' and revoked_at is null").bind(body.targetDevice).first();
  if (!target) return c.json({ error: 'not found' }, 404);
  const bell = bellOf(c.env);
  if (!bell) return c.json({ error: 'pc-offline' }, 503);
  return bell.fetch('https://bell/ask', { method: 'POST', headers: { 'content-type': 'application/json', [BELL_DEVICE_HEADER]: c.get('device').id }, body: JSON.stringify(body) });
});
