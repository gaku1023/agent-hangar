import fs from 'node:fs';
import { CloudError, cloudConfigPath, HttpCloudClient, readCloudConfig, RevokedError } from '@agent-hangar/server/src/cliEntry.ts';
import { DEVICE_ADMIN_MIN_WORKER_COMPAT, decodeJoinToken, type CloudDeviceOut } from '@agent-hangar/shared';
import { brokenConfigMessage, JoinError, runJoin, type DeviceLike } from './cloud.ts';

/**
 * クラウド同期への参加と、PC の一覧と解除（0.4.0）。
 * 殻（apps/desktop の cloud_* の命令）は、この関数を呼ぶ CLI を `--json` で走らせ、最後の 1 行の JSON を読む。
 * 端末から打つときも同じ関数を通る（hangar join、hangar cloud devices、hangar cloud revoke、hangar cloud leave）。
 * 参加トークンと参加用の秘密と端末トークンは、返事にも例外の文にも載せない。
 */

/**
 * 失敗の種類。殻と画面は、この符号で言い方を選ぶ。
 * invalid-token は参加トークンを読めない、broken-config は cloud.json が壊れている、overwrite-required は別のクラウドに参加済みで上書きの承諾が無い、
 * not-joined は同期していない、outdated は Worker が一覧と解除の口を持たない、self は自分を revoke で解除しようとした、
 * revoked はこの PC が解除されている、unreachable は Worker に繋がらない。参加の失敗は JoinError の符号をそのまま使う。
 */
export type MembershipErrorCode = 'invalid-token' | 'broken-config' | 'overwrite-required' | 'not-joined' | 'outdated' | 'self' | 'revoked' | 'unreachable' | JoinError['code'];

export class MembershipError extends Error {
  constructor(readonly code: MembershipErrorCode, message: string) {
    super(message);
    this.name = 'MembershipError';
  }
}

/** いまの参加と比べた、参加し直しの種類。new は未参加、same は同じ宛先と同じ秘密、other-cloud は別の宛先、new-secret は同じ宛先で秘密が違う。 */
export type JoinChange = 'new' | 'same' | 'other-cloud' | 'new-secret';
export type JoinPlan = { url: string; host: string; current: { url: string } | null; change: JoinChange };

/** 参加トークンを読む。読めない理由は 3 種類の固定の文で、トークンの断片を載せない（shared の decodeJoinToken）。 */
function decode(token: string): { url: string; secret: string } {
  try {
    const t = decodeJoinToken(token);
    return { url: t.url.replace(/\/+$/, ''), secret: t.secret };
  } catch (e) {
    throw new MembershipError('invalid-token', e instanceof Error ? e.message : '参加トークンを読み取れません');
  }
}

/**
 * 参加の前の見立て。宛先の URL とホスト、いま参加している宛先、参加し直しの種類を返す。
 * 外へは出ず、cloud.json を読むだけである。画面はこれを見せて、宛先の確認と、別のクラウドなら上書きの警告を出す。
 */
export function joinPlan(o: { home: string; token: string }): JoinPlan {
  const read = readCloudConfig(o.home);
  if (read.state === 'broken') throw new MembershipError('broken-config', brokenConfigMessage(o.home));
  const t = decode(o.token);
  const prev = read.config;
  const change: JoinChange = !prev ? 'new' : prev.url !== t.url ? 'other-cloud' : prev.joinSecret !== t.secret ? 'new-secret' : 'same';
  return { url: t.url, host: new URL(t.url).host, current: prev ? { url: prev.url } : null, change };
}

/**
 * 確認を画面で済ませた後の参加。宛先の確認は画面（殻の頁）が行い、ここでは聞かない。
 * 別のクラウドか秘密の違う参加し直しは、overwrite が無ければ断る（端末の hangar join の合言葉 overwrite に当たる）。
 * 同じ宛先と同じ秘密での参加し直し（解除された PC が戻るとき）は、上書きの承諾なしで通す。
 */
export async function runJoinQuiet(o: { home: string; token: string; device: DeviceLike; overwrite: boolean; fetch?: typeof fetch; sleep?: (ms: number) => Promise<void> }): Promise<{ url: string; host: string }> {
  const plan = joinPlan(o);
  if ((plan.change === 'other-cloud' || plan.change === 'new-secret') && !o.overwrite) {
    throw new MembershipError('overwrite-required', 'この PC はすでに別のクラウドに参加しています。上書きして参加するには --overwrite を指定してください');
  }
  try {
    await runJoin({ home: o.home, token: o.token, device: o.device, fetch: o.fetch, sleep: o.sleep, force: true, log: () => {} });
  } catch (e) {
    if (e instanceof JoinError) throw new MembershipError(e.code, e.message);
    throw e;
  }
  return { url: plan.url, host: plan.host };
}

/** 参加中の cloud.json から、Worker へ話す口を作る。 */
function clientOf(home: string, f?: typeof fetch): { client: HttpCloudClient; creator: boolean } {
  const read = readCloudConfig(home);
  if (read.state === 'broken') throw new MembershipError('broken-config', brokenConfigMessage(home));
  if (!read.config) throw new MembershipError('not-joined', 'この PC はクラウド同期に参加していません');
  return { client: new HttpCloudClient({ url: read.config.url, token: read.config.deviceToken, ...(f ? { fetch: f } : {}) }), creator: read.config.workerName !== null };
}

/** Worker の失敗を、符号のある失敗に直す。 */
function membershipErrorOf(e: unknown): MembershipError {
  if (e instanceof MembershipError) return e;
  if (e instanceof RevokedError) return new MembershipError('revoked', 'この PC は同期から解除されています。参加トークンでもう一度参加してください');
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

export async function listCloudDevices(o: { home: string; fetch?: typeof fetch }): Promise<CloudDeviceOut[]> {
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
const place = (d: CloudDeviceOut): string => [d.lastCity, d.lastRegion, d.lastCountry].filter((v): v is string => v !== null).join(', ') || '-';

/** hangar cloud devices の表。場所は Cloudflare の推定で、英語の表記のまま出す。 */
export async function cloudDevicesText(o: { home: string; deviceId: string; fetch?: typeof fetch }): Promise<string> {
  const rows = await listCloudDevices(o);
  const lines = rows.map((d) => {
    const mark = d.id === o.deviceId ? '（この PC）' : '';
    const state = d.revokedAt !== null ? `${day(d.revokedAt)} に解除` : `最終同期 ${day(d.lastSeenAt)}`;
    return `${d.name}${mark}  ${d.platform}  ID ${d.id}  参加 ${day(d.joinedAt)}  ${state}  IP ${d.lastIp ?? '-'}  所在地 ${place(d)}`;
  });
  lines.push('所在地は Cloudflare が IP アドレスから推定したもので、市区町村は正確でないことがよくあります。');
  return lines.join('\n');
}

/**
 * ほかの PC を同期から解除する。その PC の端末トークンは使えなくなり、次に同期したときに「解除されました」と出る。
 * 自分自身は断り、hangar cloud leave へ案内する（cloud.json が残ったまま自分の鍵だけを無効にすると、同期が止まったままになる）。
 */
export async function revokeCloudDevice(o: { home: string; deviceId: string; id: string; fetch?: typeof fetch }): Promise<CloudDeviceOut> {
  const { client } = clientOf(o.home, o.fetch);
  if (o.id === o.deviceId) throw new MembershipError('self', 'この PC の参加を解除するには hangar cloud leave を使ってください');
  try {
    requireAdmin(client);
    return await client.revokeDevice(o.id);
  } catch (e) {
    throw membershipErrorOf(e);
  }
}

export type LeaveResult = {
  /** クラウドでもこの PC を解除できたか。revoke を外したときは偽。 */
  revoked: boolean;
  /** クラウドで解除しようとして失敗した理由。cloud.json は消してある。 */
  revokeError: string | null;
  /** この PC がクラウドを作った PC だったか。真なら、もう hangar cloud teardown はできない。 */
  creator: boolean;
};

/**
 * この PC の参加を解除する。
 * revoke が真なら、先にクラウドでもこの PC を解除する（端末トークンを無効にする）。繋がらなくても cloud.json は消し、解除できなかったことを返す。
 * 消すのは cloud.json だけで、受信済みのトランスクリプト（~/.agent-hangar/remote）と、クラウドのトランスクリプトと、ほかの PC の同期は残る。
 * 壊れた cloud.json は消さない（読めない理由を確かめる前に、参加用の秘密の写しを失わせない）。
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
      // 既に解除されていれば、目的は果たしている。
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

/**
 * hangar join の機械向けの入口（--plan、--yes、--json）。
 * --plan は見立てだけを出す。--yes は宛先の確認を省いて参加する（確認は画面で済ませてある）。
 * 別のクラウドへの上書きは、--overwrite が無ければ断る。
 */
export async function joinCommand(o: Out & { home: string; token: string; device: DeviceLike; plan: boolean; yes: boolean; overwrite: boolean; fetch?: typeof fetch; sleep?: (ms: number) => Promise<void> }): Promise<number> {
  const log = logOf(o);
  try {
    if (o.plan) {
      const plan = joinPlan(o);
      if (o.json) log(JSON.stringify({ ok: true, plan }));
      else {
        log(`接続先: ${plan.url}（ホスト ${plan.host}）`);
        if (plan.current) log(`現在の接続先: ${plan.current.url}（${plan.change === 'same' ? '同じクラウド' : '別のクラウド、または参加トークンが違う'}）`);
      }
      return 0;
    }
    if (!o.yes) return confirmRequired(o, '参加していません');
    const result = await runJoinQuiet(o);
    log(o.json ? JSON.stringify({ ok: true, result }) : `参加しました: ${result.url}`);
    return 0;
  } catch (e) {
    return fail(o, e);
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

/** hangar cloud revoke <id>。端末では、解除する PC の名前を見せて y で確かめる。 */
export async function revokeCommand(o: Out & { home: string; deviceId: string; id: string; yes: boolean; confirm?: (question: string, word: string) => Promise<boolean>; fetch?: typeof fetch }): Promise<number> {
  const log = logOf(o);
  try {
    if (!o.yes) {
      if (o.json || !o.confirm) return confirmRequired(o, '解除していません');
      const target = (await listCloudDevices(o)).find((d) => d.id === o.id);
      if (!target) throw new MembershipError('unreachable', `PC ${o.id} はこのクラウドに参加していません`);
      log(`${target.name}（${o.id}）を同期から解除します。その PC はこのクラウドと送受信できなくなります。クラウドにあるその PC のトランスクリプトは残ります。`);
      log('解除しても、その PC が参加トークンを持っていれば参加し直せます。再参加を防ぐには、解除したうえで、クラウドを作成した PC で hangar setup cloud --rotate-secret を実行して参加トークンを再生成してください。');
      if (!(await o.confirm('解除しますか。', 'y'))) { log('解除しませんでした'); return 1; }
    }
    const result = await revokeCloudDevice(o);
    log(o.json ? JSON.stringify({ ok: true, result }) : `${result.name} を同期から解除しました`);
    return 0;
  } catch (e) {
    return fail(o, e);
  }
}

/** hangar cloud leave。端末では、消すものと残るものを見せて y で確かめる。 */
export async function leaveCommand(o: Out & { home: string; deviceId: string; revoke: boolean; yes: boolean; confirm?: (question: string, word: string) => Promise<boolean>; fetch?: typeof fetch }): Promise<number> {
  const log = logOf(o);
  try {
    if (!o.yes) {
      if (o.json || !o.confirm) return confirmRequired(o, '参加を解除していません');
      const read = readCloudConfig(o.home);
      if (read.config?.workerName) log('この PC はクラウドを作成した PC です。参加を解除すると、hangar cloud teardown でクラウドを削除できなくなります。クラウドごと削除する場合は、先に teardown を実行してください。');
      log(`この PC の同期の設定（${cloudConfigPath(o.home)}）を削除します${o.revoke ? '。クラウドの一覧でも、この PC を解除します' : ''}。`);
      log('クラウドのトランスクリプト、他の PC の同期、この PC に受信済みのトランスクリプトは残ります。元に戻すには、参加トークンでもう一度参加します。');
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
