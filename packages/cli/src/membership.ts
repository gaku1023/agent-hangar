import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { CloudError, cloudConfigPath, type CloudConfig, HttpCloudClient, MIN_WORKER_COMPAT, readCloudConfig, readLegacyCloudConfig, readOrCreateToken, RevokedError, saveCloudConfig } from '@agent-hangar/server/src/cliEntry.ts';
import {
  decodeEpochList,
  deriveEpochKeys,
  deriveSas,
  DEVICE_ADMIN_MIN_WORKER_COMPAT,
  E2eOpenError,
  fromBase64Url,
  generateKeyPair,
  importPrivate,
  isAllowedJoinUrl,
  JOIN_CODE_TTL_MS,
  joinCodeHash,
  normalizeJoinCode,
  openKeybox,
  openRoster,
  sealJoinRequest,
  type DeviceOut,
  type JoinCodeHello,
  type JoinStatusOut,
  type KeyPairRaw,
  type Roster,
} from '@agent-hangar/shared';
import { brokenConfigMessage, JoinError, legacyConfigMessage, openFloorFirst, workerFetch, type DeviceLike } from './cloud.ts';

/**
 * クラウド同期への参加（参加コード）と、PC の一覧と解除。
 * 殻（apps/desktop の cloud_* の命令）は、この関数を呼ぶ CLI を `--json` で走らせ、最後の 1 行の JSON を読む。
 * 端末から実行するときも同じ関数を通る（hangar cloud join、hangar cloud devices、hangar cloud revoke、hangar cloud leave）。
 * 参加コード、秘密鍵、世代鍵、端末トークンは、応答にも例外の文にも載せない。
 */

/**
 * 失敗の種類。殻と画面は、この符号で言い方を選ぶ。
 * invalid-url は接続先の URL の形式が違う、invalid-code は参加コードの形式が違う、code-not-found は参加コードが期限切れか使用済みか無い、
 * rate-limited は参加リクエストが多すぎる、rejected は参加リクエストが拒否された、expired は承認されないまま期限が切れた、
 * join-pending は承認済みで端末トークンを受信した下書きがあり、join-poll で完了するまで新しい参加リクエストを送れない、
 * broken-config は cloud.json が壊れている、legacy-config は cloud.json が古い形式、overwrite-required は別のクラウドに参加済みで上書きの承認が無い、
 * not-joined は同期していない、outdated は Worker が古い、self は自分を revoke で解除しようとした、
 * revoked はこの PC が解除されている、unreachable は Worker に接続できない、
 * not-found は解除しようとした端末がクラウドに参加していない、server-down は PC の解除に要るサーバーが動いていない、ほかに Worker との話の失敗（JoinError の符号）を使う。
 */
export type MembershipErrorCode =
  | 'invalid-url'
  | 'invalid-code'
  | 'code-not-found'
  | 'rate-limited'
  | 'rejected'
  | 'expired'
  | 'join-pending'
  | 'broken-config'
  | 'legacy-config'
  | 'overwrite-required'
  | 'not-joined'
  | 'outdated'
  | 'self'
  | 'revoked'
  | 'unreachable'
  | 'not-found'
  | 'server-down'
  | JoinError['code'];

export class MembershipError extends Error {
  constructor(readonly code: MembershipErrorCode, message: string) {
    super(message);
    this.name = 'MembershipError';
  }
}

const realFetch: typeof fetch = (...a) => fetch(...a);

// ---- 参加コードでの参加（新しい PC の側） ----

/** 参加の前の確認（hangar cloud join-check）の結果。current は今参加しているクラウド（別のクラウドへの上書きの警告に使う）。 */
export type JoinCheck = { url: string; host: string; pcCount: number; current: { url: string } | null };

/** 参加リクエスト（hangar cloud join-request）の結果。sas は確認コード（6 桁、区切りなし）、expiresAt は問い合わせを打ち切る目安の時刻。 */
export type JoinRequestResult = { sas: string; expiresAt: number };

/** 問い合わせ（hangar cloud join-poll）の結果。none は参加リクエストの下書きが無い。 */
export type JoinPollStatus = 'waiting' | 'approved' | 'rejected' | 'expired' | 'none';
export type JoinPollResult = { status: JoinPollStatus };

/**
 * 参加リクエストの下書き（~/.agent-hangar/cloud-pending.json、0600）。
 * この PC の鍵ペアと、問い合わせに使う参加コードのハッシュを持つ。参加コードの平文は置かない。
 * 承認の後に受け取った端末トークンは、cloud.json を書き終えるまでここに置く（端末トークンは 1 回しか受け取れない）。
 */
type PendingJoin = {
  v: 1;
  url: string;
  codeHash: string;
  deviceId: string;
  keyPair: KeyPairRaw;
  expiresAt: number;
  createdAt: number;
  deviceToken: string | null;
};

export function pendingJoinPath(home: string): string {
  return path.join(home, 'cloud-pending.json');
}

/** 下書きを 0600 で書く。同じ入れ物の中に一時ファイルを作ってから rename で被せる。 */
function writePending(home: string, p: PendingJoin): void {
  fs.mkdirSync(home, { recursive: true, mode: 0o700 });
  const file = pendingJoinPath(home);
  const tmp = `${file}.tmp-${process.pid}-${randomBytes(6).toString('hex')}`;
  let fd: number | null = null;
  try {
    fd = fs.openSync(tmp, 'wx', 0o600);
    fs.writeFileSync(fd, JSON.stringify(p, null, 2) + '\n');
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = null;
    fs.renameSync(tmp, file);
  } catch (e) {
    if (fd !== null) { try { fs.closeSync(fd); } catch { /* 閉じられなくても続ける */ } }
    try { fs.rmSync(tmp, { force: true }); } catch { /* 元のファイルは無事である */ }
    throw e;
  }
}

/** 下書きを読む。無いか読めなければ null（読めない下書きからは参加を続けられない）。 */
function readPending(home: string): PendingJoin | null {
  try {
    const v = JSON.parse(fs.readFileSync(pendingJoinPath(home), 'utf8')) as Partial<PendingJoin>;
    const kp = v.keyPair as Partial<KeyPairRaw> | undefined;
    if (v.v !== 1 || typeof v.url !== 'string' || typeof v.codeHash !== 'string' || typeof v.deviceId !== 'string' || typeof kp?.pub !== 'string' || typeof kp.priv !== 'string') return null;
    return {
      v: 1,
      url: v.url,
      codeHash: v.codeHash,
      deviceId: v.deviceId,
      keyPair: { pub: kp.pub, priv: kp.priv },
      expiresAt: typeof v.expiresAt === 'number' ? v.expiresAt : 0,
      createdAt: typeof v.createdAt === 'number' ? v.createdAt : 0,
      deviceToken: typeof v.deviceToken === 'string' ? v.deviceToken : null,
    };
  } catch {
    return null;
  }
}

function removePending(home: string): void {
  fs.rmSync(pendingJoinPath(home), { force: true });
}

/** 入力された接続先の URL を origin の形にそろえる。https の origin（手元の試験では loopback の http）だけを通す。 */
function normalizeUrl(input: string): string {
  const s = String(input ?? '').trim().replace(/\/+$/, '');
  if (!isAllowedJoinUrl(s)) {
    throw new MembershipError('invalid-url', '接続先の URL の形式が違います。https:// で始まる Worker の URL（例: https://hangar.example.workers.dev）を入力してください');
  }
  return new URL(s).origin;
}

/** 今参加しているクラウドの接続先。壊れた cloud.json は上書きさせないので broken-config で止める。 */
function currentCloud(home: string): { url: string } | null {
  const read = readCloudConfig(home);
  if (read.state === 'broken') throw new MembershipError('broken-config', brokenConfigMessage(home));
  if (read.state === 'legacy') {
    const legacy = readLegacyCloudConfig(home).config;
    return legacy ? { url: legacy.url } : { url: '' };
  }
  return read.config ? { url: read.config.url } : null;
}

const outdatedJoin = (): MembershipError =>
  new MembershipError('outdated', 'クラウドの Worker が古いため、参加コードで参加できません。クラウドを作成した PC で hangar setup cloud をもう一度実行して、Worker を更新してください');

/** Worker の応答を JSON で読む。読めなければ null。 */
async function jsonOf<T>(r: Response): Promise<T | null> {
  try {
    return (await r.json()) as T;
  } catch {
    return null;
  }
}

/**
 * 接続先の確認（B2）。
 * GET /health で Worker の互換の版を確かめ、GET /join/hello で参加済みの PC の数を読む。
 * PC の名前は封じた名簿にあって、参加の前のこの PC には読めないので、返すのは数とホスト名だけである。
 */
export async function joinCheck(o: { home: string; url: string; fetch?: typeof fetch }): Promise<JoinCheck> {
  const url = normalizeUrl(o.url);
  const current = currentCloud(o.home);
  const f = o.fetch ?? realFetch;
  const h = await workerFetch(url, '/health', { fetch: f });
  const health = h.ok ? await jsonOf<{ ok?: unknown; compat?: unknown }>(h) : null;
  if (health?.ok !== true) throw new MembershipError('unreachable', `${url} からクラウドの応答がありません（HTTP ${h.status}）。接続先の URL を確認してください`);
  if (typeof health.compat !== 'number' || health.compat < MIN_WORKER_COMPAT) throw outdatedJoin();
  const r = await workerFetch(url, '/join/hello', { fetch: f });
  const hello = r.ok ? await jsonOf<JoinCodeHello>(r) : null;
  if (r.status === 404) throw outdatedJoin();
  if (!hello || typeof hello.pcCount !== 'number') throw new MembershipError('failed', `接続先を確認できませんでした（HTTP ${r.status}）`);
  return { url, host: new URL(url).host, pcCount: hello.pcCount, current };
}

/**
 * 参加リクエストを置く（新しい PC の手順 3）。
 * 参加コードの形を手元で確かめてから、鍵ペアを作り、公開鍵と名前と OS を参加コードで封じて Worker に置く。
 * 形の違うコードは Worker に送らない（一致しないコードへのリクエストは Worker 全体の上限に数えられる）。
 * 鍵ペアは、送る前に下書き（0600）に書く。送った後に止まっても、秘密鍵を失わない。
 * 確認コードは、参加コードとこの PC の公開鍵から導く。発行した PC にも同じ確認コードが表示される。
 */
export async function joinRequest(o: { home: string; url: string; code: string; device: DeviceLike; overwrite?: boolean; fetch?: typeof fetch; now?: () => number }): Promise<JoinRequestResult> {
  const code = normalizeJoinCode(String(o.code ?? ''));
  if (code === null) throw new MembershipError('invalid-code', '参加コードの形式が違います。参加済みの PC に表示された 8 文字（例: K7QM-2XFD）を入力してください');
  const url = normalizeUrl(o.url);
  // 承認済みで端末トークンを受信した下書きは上書きしない。
  // 端末トークンは 1 回しか受信できないので、上書きすると承認された参加を完了できなくなる。
  if (readPending(o.home)?.deviceToken) {
    throw new MembershipError('join-pending', '承認済みの参加リクエストが完了していません。hangar cloud join-poll を実行して参加を完了してください');
  }
  const current = currentCloud(o.home);
  if (current && !o.overwrite) {
    throw new MembershipError('overwrite-required', 'この PC はすでに別のクラウドに参加しています。上書きして参加するには --overwrite を指定してください');
  }
  // DB を先に開く（控えが取れなければ、参加リクエストを送る前に止まる）。床を刻むのは承認の後（joinPoll）である。
  openFloorFirst(o.home, '参加リクエストはまだ送信していません', 'hangar cloud join').close();

  const now = (o.now ?? Date.now)();
  const keyPair = await generateKeyPair();
  const codeHash = await joinCodeHash(code);
  const sealed = await sealJoinRequest(code, codeHash, { pub: keyPair.pub, name: o.device.name, os: o.device.platform });
  const sas = await deriveSas(code, keyPair.pub);
  const expiresAt = now + JOIN_CODE_TTL_MS;
  writePending(o.home, { v: 1, url, codeHash, deviceId: o.device.id, keyPair, expiresAt, createdAt: now, deviceToken: null });

  let r: Response;
  try {
    r = await workerFetch(url, '/join/requests', { fetch: o.fetch ?? realFetch, method: 'POST', body: { codeHash, deviceId: o.device.id, sealed } });
  } catch (e) {
    removePending(o.home);
    throw e;
  }
  if (r.status === 202) return { sas, expiresAt };
  removePending(o.home);
  if (r.status === 404) throw new MembershipError('code-not-found', '参加コードが見つかりません。期限切れか、すでに使われています。参加済みの PC で新しい参加コードを発行して、もう一度実行してください');
  if (r.status === 429) throw new MembershipError('rate-limited', '参加リクエストが多すぎるため、一時的に受け付けていません。10 分ほど待ってから、もう一度実行してください');
  throw new MembershipError('failed', `参加リクエストを送信できませんでした（HTTP ${r.status}）`);
}

/**
 * 承認の結果を 1 回だけ問い合わせる（新しい PC の手順 7。画面が 2 秒ごとに呼ぶ）。
 * waiting なら何も書かない。rejected と expired は下書きを消す。
 * approved なら端末トークンを受け取って下書きに書き、keybox と名簿を読んで cloud.json（版 2）を書き、下書きを消す。
 * 承認の直後で keybox がまだ無ければ、端末トークンを下書きに持ったまま waiting を返し、次の問い合わせで続きから完了する。
 */
export async function joinPoll(o: { home: string; fetch?: typeof fetch }): Promise<JoinPollResult> {
  const d = readPending(o.home);
  if (!d) return { status: 'none' };
  const f = o.fetch ?? realFetch;
  if (d.deviceToken === null) {
    const r = await workerFetch(d.url, `/join/status?code=${encodeURIComponent(d.codeHash)}&device=${encodeURIComponent(d.deviceId)}`, { fetch: f });
    const s = r.ok ? await jsonOf<JoinStatusOut>(r) : null;
    if (!s) throw new MembershipError('failed', `承認の状態を確認できませんでした（HTTP ${r.status}）`);
    if (s.status === 'waiting') return { status: 'waiting' };
    if (s.status === 'rejected' || s.status === 'expired') {
      removePending(o.home);
      return { status: s.status };
    }
    if (s.status !== 'approved' || typeof s.deviceToken !== 'string') {
      // 承認済みなのに端末トークンが無いのは、端末トークンをすでに受け取った後である（この PC では使えない）。
      removePending(o.home);
      throw new MembershipError('failed', '承認されましたが、この PC 用の端末トークンを受信できませんでした。参加済みの PC でこの PC を同期から解除してから、もう一度参加してください');
    }
    d.deviceToken = s.deviceToken;
    // 端末トークンは 1 回しか受け取れない。cloud.json を書き終える前に止まっても失わないよう、先に下書きに書く。
    writePending(o.home, d);
  }
  return finishJoin(o.home, d, d.deviceToken, f);
}

/** 承認の後の仕上げ。keybox を開いて世代鍵を読み、名簿の版とスマホ用の鍵を読み、cloud.json を書く。 */
async function finishJoin(home: string, d: PendingJoin, deviceToken: string, f: typeof fetch): Promise<JoinPollResult> {
  const client = new HttpCloudClient({ url: d.url, token: deviceToken, fetch: f });
  let boxes;
  try {
    boxes = (await client.getKeyboxes()).boxes;
  } catch (e) {
    throw membershipErrorOf(e);
  }
  const box = boxes.reduce<(typeof boxes)[number] | null>((a, b) => (a === null || b.epoch > a.epoch ? b : a), null);
  // 発行した PC が keybox を置く前に問い合わせた。端末トークンは下書きにあるので、次の問い合わせで続ける。
  if (!box) return { status: 'waiting' };
  let epochs: Record<string, string>;
  try {
    const sealed = fromBase64Url(box.sealed);
    if (!sealed) throw new E2eOpenError();
    epochs = decodeEpochList(await openKeybox(await importPrivate(d.keyPair.priv), d.keyPair.pub, { epoch: box.epoch, recipient: d.deviceId }, sealed)).epochs;
  } catch {
    throw new MembershipError('failed', 'クラウドの暗号鍵を復号できませんでした。参加済みの PC でこの PC を同期から解除してから、もう一度参加してください');
  }
  const numbers = Object.keys(epochs).map(Number).sort((a, b) => b - a);
  const currentEpoch = numbers[0];
  if (currentEpoch === undefined) throw new MembershipError('failed', 'クラウドの暗号鍵が空です');

  const h = await workerFetch(d.url, '/health', { fetch: f });
  const health = h.ok ? await jsonOf<{ cloudId?: unknown }>(h) : null;
  const cloudId = typeof health?.cloudId === 'string' ? health.cloudId : '';
  if (cloudId === '') throw new MembershipError('outdated', `${d.url}/health が cloudId を返しません。${outdatedJoin().message}`);

  // 名簿は読めれば版とスマホ用の鍵を写す。読めなくても、同期を始めたサーバが読み直す。
  let rosterVersion = 0;
  let phoneKey: Roster['phoneKey'] = null;
  try {
    const got = await client.getRoster();
    const sealed = got ? fromBase64Url(got.sealed) : null;
    if (got && sealed) {
      for (const n of numbers) {
        try {
          const roster = await openRoster((await deriveEpochKeys(n, epochs[String(n)]!)).roster, got.version, sealed);
          rosterVersion = got.version;
          phoneKey = roster.phoneKey;
          break;
        } catch (e) {
          if (!(e instanceof E2eOpenError)) throw e;
        }
      }
    }
  } catch (e) {
    if (e instanceof RevokedError) throw membershipErrorOf(e);
    // 名簿は後から読み直せるので、ここでは参加を止めない。
  }

  // 床を刻むための DB を開く。開けなければ、端末トークンを下書きに持ったまま止まり、もう一度の問い合わせで続ける。
  const floor = openFloorFirst(home, 'cloud.json はまだ書いていません（受信した端末トークンは下書きに保存しています）', 'hangar cloud join-poll');
  try {
    const conf: CloudConfig = {
      v: 2,
      url: d.url,
      cloudId,
      deviceToken,
      keyPair: d.keyPair,
      epochs,
      currentEpoch,
      phoneKey,
      rosterVersion,
      workerName: null,
      accountId: null,
      dbName: null,
      bucketName: null,
      joinedAt: Date.now(),
    };
    saveCloudConfig(home, conf);
    // 本文をどこから上げるかの床を、cloud.json を書くのと同じ時点で刻む（setup cloud と同じ理由である）。
    floor.stamp(conf.joinedAt);
  } finally {
    floor.close();
  }
  removePending(home);
  return { status: 'approved' };
}

// ---- PC の一覧と解除 ----

/** 参加中の cloud.json から、Worker と話す口を作る。 */
function clientOf(home: string, f?: typeof fetch): { client: HttpCloudClient; creator: boolean } {
  const read = readCloudConfig(home);
  if (read.state === 'broken') throw new MembershipError('broken-config', brokenConfigMessage(home));
  if (read.state === 'legacy') throw new MembershipError('legacy-config', legacyConfigMessage(home));
  if (!read.config) throw new MembershipError('not-joined', 'この PC はクラウド同期に参加していません');
  return { client: new HttpCloudClient({ url: read.config.url, token: read.config.deviceToken, ...(f ? { fetch: f } : {}) }), creator: read.config.workerName !== null };
}

/** Worker の失敗を、符号のある失敗に直す。 */
function membershipErrorOf(e: unknown): MembershipError {
  if (e instanceof MembershipError) return e;
  if (e instanceof JoinError) return new MembershipError(e.code, e.message);
  if (e instanceof RevokedError) return new MembershipError('revoked', 'この PC は同期から解除されています');
  if (e instanceof CloudError && e.status === 404) return outdatedError();
  return new MembershipError('unreachable', `クラウドに接続できません（${e instanceof Error ? e.message : String(e)}）`);
}

const outdatedError = (): MembershipError =>
  new MembershipError('outdated', 'クラウドの Worker が古いため、PC の一覧と解除を使えません。クラウドを作成した PC で hangar setup cloud をもう一度実行して、Worker を更新してください');

/** Worker が版を名乗っていて、一覧と解除の口に届かなければ断る。 */
function requireAdmin(client: HttpCloudClient): void {
  const seen = client.lastWorkerCompat();
  if (seen !== null && seen < DEVICE_ADMIN_MIN_WORKER_COMPAT) throw outdatedError();
}

export async function listCloudDevices(o: { home: string; fetch?: typeof fetch }): Promise<DeviceOut[]> {
  const { client } = clientOf(o.home, o.fetch);
  try {
    const rows = await client.listDevices();
    requireAdmin(client);
    return rows;
  } catch (e) {
    throw membershipErrorOf(e);
  }
}

const pad2 = (n: number): string => String(n).padStart(2, '0');
/** 手元の時刻の日付（YYYY-MM-DD）。画面の参加日と同じく、UTC ではなくこの PC の時間帯で数える。 */
const day = (ms: number | null): string => {
  if (ms === null) return '-';
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
};
/**
 * hangar cloud devices の表。
 * 互換の版 9 の Worker は名前と OS を持たない（名前と OS は封じた名簿にある）ので、種類と ID で出す。
 * 名簿を開いて名前を出すのは、PC の一覧を作り直すとき（Task 20）にする。
 */
export async function cloudDevicesText(o: { home: string; deviceId: string; fetch?: typeof fetch }): Promise<string> {
  const rows = await listCloudDevices(o);
  return rows.map((d) => {
    const mark = d.id === o.deviceId ? '（この PC）' : '';
    const state = d.revokedAt !== null ? `${day(d.revokedAt)} に解除` : `最終同期 ${day(d.lastSeenAt)}`;
    return `${d.kind === 'mobile' ? 'スマホ' : 'PC'}${mark}  ID ${d.id}  参加 ${day(d.joinedAt)}  ${state}`;
  }).join('\n');
}

/** 動いているサーバーの既定のポート。 */
export const DEFAULT_SERVER_PORT = 4177;
/**
 * 解除をサーバーに頼んだときに待つ上限。世代の回しは Worker へ 8 回ほど要求するので、ほかの口より長くとる。
 * 殻の締め切り（apps/desktop の CLI_TIMEOUT、90 秒）より短くする。
 */
const REVOKE_TIMEOUT_MS = 80_000;
const SERVER_CODES = new Set<MembershipErrorCode>(['self', 'revoked', 'not-found', 'not-joined']);

/**
 * 他の端末を同期から解除する。その端末の端末トークンは使えなくなり、次に同期したときに「解除されました」と表示される。
 * 自分自身は断り、hangar cloud leave へ案内する（cloud.json が残ったまま自分の端末トークンだけを無効にすると、同期が止まったままになる）。
 *
 * 動いているサーバーの経路（POST /api/sync/cloud-devices/:id/revoke）に頼む。
 * PC の解除は世代鍵を作り直して残りの PC に配る（sync/rotate.ts）。世代鍵と回しの途中の記録は動いているサーバーの手元にあり、CLI が別に回すと食い違うからである。
 * サーバーが止まっていれば、スマホだけは Worker で直に解除し、PC は起動を求めて断る（server-down）。
 */
export async function revokeCloudDevice(o: { home: string; deviceId: string; id: string; port?: number; fetch?: typeof fetch }): Promise<DeviceOut> {
  const { client } = clientOf(o.home, o.fetch);
  if (o.id === o.deviceId) throw new MembershipError('self', 'この PC の参加を解除するには hangar cloud leave を使ってください');
  const f = o.fetch ?? realFetch;
  let res: Response;
  try {
    res = await f(`http://127.0.0.1:${o.port ?? DEFAULT_SERVER_PORT}/api/sync/cloud-devices/${encodeURIComponent(o.id)}/revoke`, {
      method: 'POST',
      headers: { authorization: `Bearer ${readOrCreateToken(o.home)}` },
      signal: AbortSignal.timeout(REVOKE_TIMEOUT_MS),
    });
  } catch (e) {
    if (e instanceof Error && e.name === 'TimeoutError') throw new MembershipError('unreachable', `サーバーが ${REVOKE_TIMEOUT_MS / 1000} 秒以内に応答しませんでした。設定のクラウド同期の PC の一覧で、解除できたかを確かめてください`);
    return revokeWithoutServer(client, o.id);
  }
  const body = (await res.json().catch(() => null)) as { device?: DeviceOut; error?: unknown; code?: unknown } | null;
  if (res.ok && body?.device) return body.device;
  if (res.status === 401 || res.status === 403) throw new MembershipError('unreachable', 'サーバーの鍵が一致しません。サーバーと同じ HANGAR_HOME で実行しているか確認してください');
  const message = typeof body?.error === 'string' ? body.error : `HTTP ${res.status}`;
  const code = typeof body?.code === 'string' && SERVER_CODES.has(body.code as MembershipErrorCode) ? (body.code as MembershipErrorCode) : 'unreachable';
  throw new MembershipError(code, message);
}

/** サーバーが止まっているときの解除。スマホだけを Worker で直に解除する。 */
async function revokeWithoutServer(client: HttpCloudClient, id: string): Promise<DeviceOut> {
  try {
    requireAdmin(client);
    const target = (await client.listDevices()).find((d) => d.id === id);
    if (!target) throw new MembershipError('not-found', `${id} はこのクラウドに参加していません`);
    if (target.kind !== 'mobile') throw new MembershipError('server-down', 'PC の解除では暗号鍵を再生成するため、hangar の起動中に行います。hangar start で起動してから、もう一度実行してください');
    return await client.revokeDevice(id);
  } catch (e) {
    throw membershipErrorOf(e);
  }
}

export type LeaveResult = {
  /** クラウドでもこの PC を解除できたか。revoke を外したときは偽。 */
  revoked: boolean;
  /** クラウドで解除しようとして失敗した理由。cloud.json は削除してある。 */
  revokeError: string | null;
  /** この PC がクラウドを作った PC だったか。真なら、もう hangar cloud teardown はできない。 */
  creator: boolean;
};

/**
 * この PC の参加を解除する。
 * revoke が真なら、先にクラウドでもこの PC を解除する（端末トークンを無効にする）。接続できなくても cloud.json は削除し、解除できなかったことを返す。
 * 削除するのは cloud.json だけで、受信済みのトランスクリプト（~/.agent-hangar/remote）と、クラウドのトランスクリプトと、他の PC の同期は削除しない。
 * 壊れた cloud.json は削除しない（読めない理由を確かめる前に、暗号鍵の写しを失わせない）。
 */
export async function leaveCloud(o: { home: string; deviceId: string; revoke: boolean; fetch?: typeof fetch }): Promise<LeaveResult> {
  const { client, creator } = clientOf(o.home, o.fetch);
  let revoked = false;
  let revokeError: string | null = null;
  if (o.revoke) {
    try {
      requireAdmin(client);
      await client.revokeDevice(o.deviceId);
      revoked = true;
    } catch (e) {
      // すでに解除されていれば、目的は果たしている。
      if (e instanceof RevokedError) revoked = true;
      else revokeError = membershipErrorOf(e).message;
    }
  }
  fs.rmSync(cloudConfigPath(o.home), { force: true });
  return { revoked, revokeError, creator };
}

// ---- 端末と殻の入口（--json は殻の命令が読む 1 行） ----

type Out = { log?: (line: string) => void; json: boolean };

const logOf = (o: Out): ((l: string) => void) => o.log ?? ((l: string) => console.log(l));

/** 失敗を出して終了コードを返す。--json なら 1 行の JSON で、符号と文を載せる。 */
function fail(o: Out, e: unknown): number {
  const log = logOf(o);
  const m = e instanceof MembershipError ? e : e instanceof JoinError ? new MembershipError(e.code, e.message) : null;
  if (!m) throw e;
  log(o.json ? JSON.stringify({ ok: false, code: m.code, message: m.message }) : m.message);
  return 1;
}

const confirmRequired = (o: Out, what: string): number => {
  logOf(o)(o.json ? JSON.stringify({ ok: false, code: 'confirm-required', message: `確認できないため、${what}。--yes を指定してください` }) : `標準入力が対話型ではないため、確認できません。ターミナルから実行するか、--yes を指定してください`);
  return 1;
};

/** 確認コードの表示の形（`123 456`）。 */
export const formatSas = (sas: string): string => `${sas.slice(0, 3)} ${sas.slice(3)}`;

/** 古い hangar join の案内。参加トークンは廃止した。 */
export const JOIN_TOKEN_RETIRED = [
  '参加トークンは廃止されました。',
  'PC を追加するには、参加済みの PC の 設定 › クラウド同期 で「PC を追加」をクリックして参加コードを発行し、',
  'この PC で hangar cloud join <接続先の URL> を実行して参加コードを入力してください。',
].join('\n');

/** hangar cloud join-check <url>。 */
export async function joinCheckCommand(o: Out & { home: string; url: string; fetch?: typeof fetch }): Promise<number> {
  const log = logOf(o);
  try {
    const check = await joinCheck(o);
    if (o.json) log(JSON.stringify({ ok: true, check }));
    else {
      log(`接続先: ${check.url}（ホスト ${check.host}）`);
      log(`参加済みの PC: ${check.pcCount} 台`);
      if (check.current) log(`現在の接続先: ${check.current.url}（参加すると cloud.json を上書きします）`);
    }
    return 0;
  } catch (e) {
    return fail(o, e);
  }
}

/** hangar cloud join-request <url>（参加コードは標準入力）。 */
export async function joinRequestCommand(o: Out & { home: string; url: string; code: string; device: DeviceLike; overwrite: boolean; fetch?: typeof fetch }): Promise<number> {
  const log = logOf(o);
  try {
    const request = await joinRequest(o);
    if (o.json) log(JSON.stringify({ ok: true, request }));
    else {
      log(`確認コード: ${formatSas(request.sas)}`);
      log('参加コードを発行した PC に同じ確認コードが表示されていることを確認してから、その PC で承認してください。');
    }
    return 0;
  } catch (e) {
    return fail(o, e);
  }
}

/** hangar cloud join-poll。 */
export async function joinPollCommand(o: Out & { home: string; fetch?: typeof fetch }): Promise<number> {
  const log = logOf(o);
  try {
    const poll = await joinPoll(o);
    log(o.json ? JSON.stringify({ ok: true, poll }) : POLL_TEXT[poll.status]);
    return 0;
  } catch (e) {
    return fail(o, e);
  }
}

const POLL_TEXT: Record<JoinPollStatus, string> = {
  waiting: '承認を待っています。参加コードを発行した PC で承認してください。',
  approved: '参加しました。hangar を再起動すると同期が始まります。',
  rejected: '参加リクエストが拒否されました。',
  expired: '参加コードの期限が切れました。参加済みの PC で新しい参加コードを発行して、もう一度参加してください。',
  none: '承認待ちの参加リクエストはありません。',
};

/** 問い合わせの間隔（設計書の 2 秒）。 */
export const JOIN_POLL_INTERVAL_MS = 2000;

/**
 * hangar cloud join <url>（ターミナルで対話する）。
 * 接続先を表示し、別のクラウドに参加済みなら合言葉で確認し、参加コードを尋ね、確認コードを表示して、2 秒ごとに承認を問い合わせる。
 * 参加コードの期限（5 分）と、承認の後に端末トークンを受信できる 5 分を過ぎたら、問い合わせをやめる。
 */
export async function joinInteractive(o: {
  home: string;
  url: string;
  device: DeviceLike;
  ask: (question: string) => Promise<string>;
  confirm: (question: string, word: string) => Promise<boolean>;
  overwriteWord: string;
  log?: (line: string) => void;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}): Promise<number> {
  const log = o.log ?? ((l: string) => console.log(l));
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = o.now ?? Date.now;
  const out: Out = { log, json: false };
  try {
    const check = await joinCheck(o);
    log('');
    log('参加しようとしている接続先:');
    log(`  ${check.url}`);
    log(`  ホスト: ${check.host}（参加済みの PC: ${check.pcCount} 台）`);
    log('自分のクラウドの接続先か、上のホストを確認してください。心当たりのないホストの場合、この PC の会話のトランスクリプトがそのホストへアップロードされます。');
    let overwrite = false;
    if (check.current) {
      log('');
      log('警告: この PC はすでに別のクラウドに参加しています。');
      log(`  現在の接続先: ${check.current.url}`);
      log('参加すると cloud.json を上書きし、この PC の暗号鍵を新しく作成します。現在のクラウドのデータは、この PC から読み取れなくなります（すでにダウンロードしたトランスクリプトはそのまま読み取れます）。');
      if (!(await o.confirm('cloud.json を上書きして参加しますか？', o.overwriteWord))) {
        log('参加をキャンセルしました');
        return 1;
      }
      overwrite = true;
    }
    log('');
    const code = await o.ask('参加コードを入力してください（例: K7QM-2XFD）: ');
    const req = await joinRequest({ home: o.home, url: check.url, code, device: o.device, overwrite, fetch: o.fetch, now });
    log('');
    log(`確認コード: ${formatSas(req.sas)}`);
    log('参加コードを発行した PC に同じ確認コードが表示されていることを確認してから、その PC で承認してください。');
    log('承認を待っています…');
    // 承認が期限の間際でも受信できるよう、Worker は承認の後さらに 5 分だけ端末トークンを渡す。その分まで待つ。
    const deadline = req.expiresAt + JOIN_CODE_TTL_MS;
    for (;;) {
      const { status } = await joinPoll(o);
      if (status === 'approved') {
        log('');
        log(`参加しました: ${check.url}`);
        log('hangar を再起動すると同期が始まり、他の PC のトランスクリプトが ~/.agent-hangar/remote にダウンロードされます。');
        return 0;
      }
      if (status === 'rejected' || status === 'expired' || status === 'none') {
        log(POLL_TEXT[status]);
        return 1;
      }
      if (now() >= deadline) {
        log('承認されないまま時間切れになりました。参加コードを発行した PC がスリープしていないか確認し、新しい参加コードで、もう一度実行してください。');
        return 1;
      }
      await sleep(JOIN_POLL_INTERVAL_MS);
    }
  } catch (e) {
    return fail(out, e);
  }
}

/** hangar cloud devices。 */
export async function devicesCommand(o: Out & { home: string; deviceId: string; fetch?: typeof fetch }): Promise<number> {
  const log = logOf(o);
  try {
    if (o.json) log(JSON.stringify({ ok: true, devices: await listCloudDevices(o) }));
    else log(await cloudDevicesText(o));
    return 0;
  } catch (e) {
    return fail(o, e);
  }
}

/** hangar cloud revoke <id>。端末では、解除する PC の ID を見せて y で確認する。 */
export async function revokeCommand(o: Out & { home: string; deviceId: string; id: string; yes: boolean; port?: number; confirm?: (question: string, word: string) => Promise<boolean>; fetch?: typeof fetch }): Promise<number> {
  const log = logOf(o);
  try {
    if (!o.yes) {
      if (o.json || !o.confirm) return confirmRequired(o, '解除していません');
      const target = (await listCloudDevices(o)).find((d) => d.id === o.id);
      if (!target) throw new MembershipError('not-found', `${o.id} はこのクラウドに参加していません`);
      if (target.kind === 'mobile') log(`スマホ ${o.id} を同期から解除します。そのスマホはこのクラウドと送受信できなくなります。`);
      else log(`PC ${o.id} を同期から解除します。解除すると、暗号鍵を再生成して残りの PC に配布します。解除した PC は、これ以降の同期データを復号できなくなります。クラウドにあるその PC のトランスクリプトは削除されません。`);
      if (!(await o.confirm('解除しますか。', 'y'))) { log('解除しませんでした'); return 1; }
    }
    const result = await revokeCloudDevice(o);
    log(o.json ? JSON.stringify({ ok: true, result }) : `${result.id} を同期から解除しました`);
    return 0;
  } catch (e) {
    return fail(o, e);
  }
}

/** hangar cloud leave。端末では、削除するものと削除しないものを見せて y で確認する。 */
export async function leaveCommand(o: Out & { home: string; deviceId: string; revoke: boolean; yes: boolean; confirm?: (question: string, word: string) => Promise<boolean>; fetch?: typeof fetch }): Promise<number> {
  const log = logOf(o);
  try {
    if (!o.yes) {
      if (o.json || !o.confirm) return confirmRequired(o, '参加を解除していません');
      const read = readCloudConfig(o.home);
      if (read.config?.workerName) log('この PC はクラウドを作成した PC です。参加を解除すると、hangar cloud teardown でクラウドを削除できなくなります。クラウドごと削除する場合は、先に teardown を実行してください。');
      log(`この PC の同期の設定（${cloudConfigPath(o.home)}）を削除します${o.revoke ? '。クラウドの一覧でも、この PC を解除します' : ''}。`);
      log('クラウドのトランスクリプト、他の PC の同期、この PC に受信済みのトランスクリプトは削除されません。');
      if (!(await o.confirm('この PC の参加を解除しますか。', 'y'))) { log('参加を解除しませんでした'); return 1; }
    }
    const result = await leaveCloud(o);
    if (o.json) log(JSON.stringify({ ok: true, result }));
    else {
      log('この PC の参加を解除しました。hangar を再起動すると同期が停止します。');
      if (result.revokeError) log(`クラウドでの解除に失敗しました（${result.revokeError}）。他の PC の設定のクラウド同期から、この PC を解除してください。`);
    }
    return 0;
  } catch (e) {
    return fail(o, e);
  }
}
