import { PHONE_IDLE_MS, recoverySecretTail, type CloudDeviceDto, type Translate } from '@agent-hangar/shared';
import { joinCheckOf, type AddPcStage, type CloudFailure, type JoinFailReason, type JoinStage, type PhoneStage, type RecoveryError, type RecoveryStage } from '../store/cloudMember.ts';
import type { Store } from '../store/store.ts';
import { relativeTime } from './format.ts';
import { translatorOf } from './i18n.ts';

/**
 * 設定のクラウド同期の節の、参加と、PC の一覧と解除と、この PC の参加の解除（0.4.0。試作 settings-040-proto の推す組み合わせ）。
 * 参加は節の中の段（貼る → 宛先の確認 → 参加）、PC は表と行の中の確認、この PC の参加の解除は節の末尾に離した帯で出す。
 * 参加と解除は殻の中でだけ行い、ブラウザではターミナルのコマンドを案内する（desktop が偽）。
 */

/**
 * PC の 1 行（試作 cloud-e2e の E2）。joined は Worker の一覧があるときだけで、同期の表に戻したときは null。
 * IP と所在地は持たない（互換の版 9 で Worker が保存をやめた）。
 */
export type CloudPcRow = { id: string; name: string; self: boolean; os: string; joined: string | null; lastSeen: string; removedOn: string | null };

/**
 * スマホの 1 行（試作 cloud-e2e の E2）。PC の表とは別に、「スマホ」の小見出しの下に並べる。
 * left は、切れるまでの残りの日数と、再接続が必要になる日付（phoneLeft）。期限を返さない行は null。
 */
export type CloudPhoneRow = { id: string; name: string; joined: string; lastSeen: string; left: { days: number; reconnectOn: string } | null };

/** スマホの残りの日数の棒の満たん（使わずに切れるまでの 30 日）。 */
export const PHONE_LEFT_FULL_DAYS = PHONE_IDLE_MS / 86_400_000;

/**
 * スマホの残りの日数と再接続の日付。どちらも Worker の値（GET /devices）から求める。
 * 残りの日数は min(expiresAt, lastSeenAt + PHONE_IDLE_MS) − now を日に切り上げたもの（0 より小さくしない）。
 * 使うと 30 日延びるが、接続から 90 日の期限（expiresAt）は越えない。再接続の日付は expiresAt である。
 * expiresAt が無い（期限を持たない Worker）行は null。lastSeenAt が無ければ参加日から数える。
 */
function phoneLeft(d: CloudDeviceDto, now: number): CloudPhoneRow['left'] {
  if (d.expiresAt === null) return null;
  const end = Math.min(d.expiresAt, (d.lastSeenAt ?? d.joinedAt) + PHONE_IDLE_MS);
  return { days: Math.max(0, Math.ceil((end - now) / 86_400_000)), reconnectOn: ymd(d.expiresAt) };
}

/**
 * スマホを接続する QR の段（store/cloudMember.ts の PhoneStage から券の印を除いたもの）。
 * QR の中身（pairUrl、pairText）は ready の間だけ持つ。期限切れと参加の後は、薄くした QR を中身の無い図で描く。
 */
export type CloudPhoneProps =
  | { kind: 'idle' } | { kind: 'loading'; renew?: true } | { kind: 'expired' } | { kind: 'limited' } | { kind: 'notJoined' }
  | { kind: 'ready'; pairUrl: string; pairText: string; expiresAt: number }
  | { kind: 'paired'; id: string; name: string }
  | { kind: 'old'; compat: number | null }
  | { kind: 'failed'; message: string };

/** 券の有効期間（Worker の PAIRING_TTL_MS と同じ 5 分）。残り時間の棒の長さの基準にする。 */
export const PAIR_TTL_MS = 5 * 60_000;

function presentPhone(p: PhoneStage): CloudPhoneProps {
  if (p.kind === 'ready') return { kind: 'ready', pairUrl: p.pairUrl, pairText: p.pairText, expiresAt: p.expiresAt };
  return p;
}

/**
 * PC の一覧。state の ok は Worker の一覧、fallback は Worker が古いか繋がらないので同期の表（共有テーブルの devices）に戻したもの、
 * loading はまだ Worker の一覧が届いていないもの（同期の表を出しておく）。fallback と loading では解除を出さない。
 */
export type CloudPcsProps = { state: 'ok' | 'fallback' | 'loading'; rows: CloudPcRow[]; removed: CloudPcRow[]; note: string | null };

/**
 * 参加の段（新しい PC の側、試作 B2）。
 * urlError は接続先の URL の段の理由、host と pcCount は接続先の確認の結果（参加済みの PC の名前は承認の前に復号できないので出さない）。
 * rejoin は別のクラウドに参加済みのときの警告、sas は区切りつきの確認コード（123 456）、failure は終わった理由の見出しと本文。
 * reenter は失敗の後に参加コードを入力し直せるか（接続先の確認の結果を持っているか）。
 */
export type CloudJoinProps = {
  kind: JoinStage['kind'];
  urlError: string | null;
  url: string | null;
  host: string | null;
  pcCount: number | null;
  rejoin: { current: string; next: string } | null;
  sas: string | null;
  expiresAt: number | null;
  failure: { reason: JoinFailReason; title: string; body: string } | null;
  reenter: boolean;
};

/**
 * 「PC を追加」の段（参加済みの PC の側、試作 A1）。url は接続先の URL（この PC の同期の設定のもの）。
 * code は発行した参加コード（この PC の画面にだけ出す）、request は受信した参加リクエスト（OS は表示名、sas は区切りつき）。
 * message は失敗の文、name は完了と拒否の相手の名前。
 */
export type CloudAddProps = {
  kind: AddPcStage['kind'];
  url: string | null;
  code: string | null;
  expiresAt: number | null;
  request: { name: string; os: string; sas: string } | null;
  message: string | null;
  name: string | null;
};

/**
 * 「リカバリーキーを再発行」の段（試作 D2）。text は保存とコピーに使う 4 行の文字列、heading と fields と secret はその見せ方（見出し、作成日と URL、暗号鍵）。
 * tail は暗号鍵の末尾 4 文字（入力と比べる）、hideAt は暗号鍵を伏せる時刻、entering は末尾 4 文字の入力の段。
 * error は確認の失敗（retry なら同じ下書きで送り直せる）、message は作成の失敗か下書きが無い旨。
 */
export type CloudRecoveryProps = {
  kind: RecoveryStage['kind'];
  text: string | null;
  heading: string | null;
  fields: { label: string; value: string }[];
  secretLabel: string | null;
  secret: string | null;
  tail: string | null;
  hideAt: number | null;
  entering: boolean;
  busy: boolean;
  error: RecoveryError | null;
  message: string | null;
};

/**
 * 末尾 4 文字の入力をそろえる（サーバーの照合と同じ）。全角を半角に（NFKC）、空白とハイフンを捨て、大文字にする。
 * 小文字、全角、区切りの混じった入力も、同じ 4 文字として比べる。
 */
export const normalizeRecoveryTail = (s: string): string => s.normalize('NFKC').replace(/[\s\-‐-―−]/g, '').toUpperCase();

/**
 * 4 行の文字列を、見出し、項目、暗号鍵に分ける。形は shared の formatRecoveryKey で、見出しの後に作成日、URL、暗号鍵の順に「名前: 値」が並ぶ。
 * 最後の項目を暗号鍵として扱う（伏せる対象）。
 */
function presentRecovery(r: RecoveryStage): CloudRecoveryProps {
  const none = { text: null, heading: null, fields: [], secretLabel: null, secret: null, tail: null, hideAt: null, entering: false, busy: false, error: null };
  if (r.kind === 'failed') return { kind: r.kind, ...none, message: r.message };
  if (r.kind !== 'shown') return { kind: r.kind, ...none, message: null };
  const [heading = '', ...rest] = r.text.split(/\r?\n/);
  const all = rest.flatMap((line) => {
    const m = /^(.+?)\s*[:：]\s*(.*)$/.exec(line);
    return m ? [{ label: m[1]!, value: m[2] ?? '' }] : [];
  });
  const last = all.at(-1) ?? null;
  const fields = all.slice(0, -1);
  const secretLabel = last?.label ?? null;
  const secret = last?.value ?? null;
  let tail: string | null;
  try { tail = recoverySecretTail(r.text); } catch { tail = secret ? normalizeRecoveryTail(secret).slice(-4) : null; }
  return { kind: r.kind, text: r.text, heading, fields, secretLabel, secret, tail, hideAt: r.hideAt, entering: r.entering, busy: r.busy, error: r.error, message: null };
}

export type CloudMemberProps = {
  desktop: boolean;
  /** この PC が同期から解除されている。 */
  revoked: boolean;
  thisPcName: string;
  pending: number;
  creator: boolean;
  pcs: CloudPcsProps;
  join: CloudJoinProps;
  /** 「PC を追加」の段。 */
  add: CloudAddProps;
  /** 他の PC の解除の段。message は失敗の文。 */
  revoke: { id: string; kind: 'busy' | 'failed' | 'done'; name: string; message: string | null } | null;
  leave: { kind: 'idle' | 'busy' | 'left' | 'failed'; revokeError: string | null; message: string | null };
  /** ブラウザで案内するコマンド。hangar の呼び方は、準備の確かめの参加のコマンドからそろえる。 */
  commands: { leave: string; revoke: string; devices: string };
  /** スマホを接続する QR の段。 */
  phone: CloudPhoneProps;
  /** 接続しているスマホ（解除していないもの）。Worker の一覧が無いときは空。 */
  phones: CloudPhoneRow[];
  /** 「リカバリーキーを再発行」の段。 */
  recovery: CloudRecoveryProps;
};

const OS: Record<string, string> = { darwin: 'macOS', win32: 'Windows', linux: 'Linux' };

const pad = (n: number): string => String(n).padStart(2, '0');
const ymd = (ms: number): string => { const d = new Date(ms); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
const md = (ms: number): string => { const d = new Date(ms); return `${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };

/** 殻と CLI の失敗の符号を、画面の文にする（参加の段のほかで使う短い文）。 */
export function failureMessage(t: Translate, f: CloudFailure): string {
  switch (f.code) {
    case 'busy': return t('cloudMember.fail.busy');
    case 'timeout': return t('cloudMember.fail.timeout');
    case 'unreachable': case 'network': return t('cloudMember.fail.unreachable');
    case 'outdated': return t('sync.devices.workerOutdated');
    case 'revoked': return t('sync.revoked.thisPc');
    case 'cannot-start': case 'cannot-read': case 'unreadable': case 'shell': return t('cloudMember.fail.shell', { message: f.message || f.code });
    default: return f.message || f.code;
  }
}

/** 確認コードの表示の形（123 456）。 */
export const sasText = (sas: string): string => (sas.length === 6 ? `${sas.slice(0, 3)} ${sas.slice(3)}` : sas);

/** OS の表示名。サーバーと Worker は process.platform の値で持つ。 */
export const osLabel = (platform: string): string => OS[platform] ?? platform;

/** 接続先の確認の失敗を、URL の欄の下の 1 文にする。 */
function urlError(t: Translate, f: CloudFailure): string {
  switch (f.code) {
    case 'invalid-url': return t('cloudMember.join.badUrl');
    case 'outdated': return t('cloudMember.join.outdated');
    case 'compat': return t('cloudMember.fail.compat.body');
    case 'broken-config': return t('cloudMember.fail.brokenConfig.body');
    default: return failureMessage(t, f);
  }
}

/** 参加が終わった理由の見出しと本文。本文は次の手順まで言う。 */
function joinFailure(t: Translate, reason: JoinFailReason, message: string, host: string | null): { reason: JoinFailReason; title: string; body: string } {
  switch (reason) {
    case 'expired': return { reason, title: t('cloudMember.fail.expired.title'), body: t('cloudMember.fail.expired.body') };
    case 'rejected': return { reason, title: t('cloudMember.fail.rejected.title'), body: t('cloudMember.fail.rejected.body') };
    case 'no-answer': return { reason, title: t('cloudMember.fail.noAnswer.title'), body: t('cloudMember.fail.noAnswer.body') };
    case 'bad-code': return { reason, title: t('cloudMember.fail.badCode.title'), body: t('cloudMember.fail.badCode.body') };
    case 'rate-limited': return { reason, title: t('cloudMember.fail.rateLimited.title'), body: t('cloudMember.fail.rateLimited.body') };
    case 'pending': return { reason, title: t('cloudMember.fail.pending.title'), body: t('cloudMember.fail.pending.body') };
    case 'network': return { reason, title: t('cloudMember.fail.network.title'), body: t('cloudMember.fail.network.body', { host: host ?? '' }) };
    case 'compat': return { reason, title: t('cloudMember.fail.compat.title'), body: t('cloudMember.fail.compat.body') };
    case 'other': return { reason, title: t('cloudMember.fail.other.title'), body: message || t('cloudMember.fail.timeout') };
  }
}

function presentJoin(t: Translate, j: JoinStage): CloudJoinProps {
  const check = joinCheckOf(j);
  return {
    kind: j.kind,
    urlError: j.kind === 'url' && j.failure ? urlError(t, j.failure) : null,
    url: check?.url ?? (j.kind === 'checking' ? j.url : null),
    host: j.kind === 'done' ? j.host : check?.host ?? null,
    pcCount: check?.pcCount ?? null,
    rejoin: check?.current && check.current.url !== check.url ? { current: check.current.url, next: check.url } : null,
    sas: j.kind === 'waiting' ? sasText(j.sas) : null,
    expiresAt: j.kind === 'waiting' ? j.expiresAt : null,
    failure: j.kind === 'failed' ? joinFailure(t, j.reason, j.message, check?.host ?? null) : null,
    reenter: j.kind === 'failed' && check !== null && j.reason !== 'pending',
  };
}

function presentAdd(store: Store): CloudAddProps {
  const a = store.cloudMember.add;
  return {
    kind: a.kind,
    url: store.sync?.url ?? null,
    code: a.kind === 'open' || a.kind === 'requested' ? a.code : null,
    expiresAt: a.kind === 'open' || a.kind === 'requested' ? a.expiresAt : null,
    request: a.kind === 'requested' ? { name: a.request.name, os: osLabel(a.request.os), sas: sasText(a.request.sas) } : null,
    message: a.kind === 'failed' ? a.message : null,
    name: a.kind === 'done' || a.kind === 'rejected' ? a.name : null,
  };
}

/** hangar の呼び方（同梱の hangar の絶対パスなど）。準備の確かめの参加のコマンドの頭を使う。 */
function hangarBase(store: Store): string {
  const join = store.readiness?.commands.join ?? 'hangar join <token>';
  const tail = / (?:cloud join <URL>|join <token>)$/;
  return tail.test(join) ? join.replace(tail, '') : 'hangar';
}

/** ブラウザで案内する参加のコマンド（参加コードは実行した後に入力する）。 */
export function cloudJoinCommand(store: Store): string {
  return `${hangarBase(store)} cloud join <URL>`;
}

export function presentCloudMember(store: Store, now: number = Date.now()): CloudMemberProps {
  const t = translatorOf(store);
  const m = store.cloudMember;
  const cloud = m.devices;
  const row = (d: CloudDeviceDto): CloudPcRow => ({
    // 名簿に無い端末（名前と OS が null）は ID で出し、OS の列は空ける。
    id: d.id, name: d.name ?? d.id, self: d.self, os: d.platform === null ? '—' : OS[d.platform] ?? d.platform,
    joined: ymd(d.joinedAt), lastSeen: relativeTime(t, d.lastSeenAt, now),
    removedOn: d.revokedAt === null ? null : t('cloudMember.pcs.removedOn', { date: md(d.revokedAt) }),
  });
  const phoneRow = (d: CloudDeviceDto): CloudPhoneRow => ({ id: d.id, name: d.name ?? d.id, joined: ymd(d.joinedAt), lastSeen: relativeTime(t, d.lastSeenAt, now), left: phoneLeft(d, now) });
  // Worker の一覧が無いときは、同期の表の一覧を出しておく（参加日は無い）。
  const shared = (): CloudPcRow[] => store.devices.map((d) => ({ id: d.id, name: d.name, self: d.self, os: OS[d.platform] ?? d.platform, joined: null, lastSeen: relativeTime(t, d.lastSeenAt, now), removedOn: null }));
  const listed = cloud?.state === 'ok' ? cloud.devices : [];
  const pcList = listed.filter((d) => d.kind !== 'mobile');
  const pcs: CloudPcsProps = cloud?.state === 'ok'
    ? { state: 'ok', rows: pcList.filter((d) => d.revokedAt === null).map(row), removed: pcList.filter((d) => d.revokedAt !== null).map(row), note: null }
    : cloud && cloud.state !== 'off'
      ? { state: 'fallback', rows: shared(), removed: [], note: cloud.message }
      : { state: 'loading', rows: shared(), removed: [], note: null };
  // 解除したスマホは出さない。再接続は新しい QR で別の行になるので、解除した PC のように並べておく意味が無い。
  // 「元に戻す」を待っているスマホと、解除を送っているスマホと、送る順を待っているスマホも出さない（1 クリックで行を畳む。試作 E2）。失敗したら行を戻す。
  const hidden = new Set([m.phoneUndo?.id, m.revoke?.kind === 'busy' ? m.revoke.id : undefined, ...m.phoneQueued].filter((x): x is string => x !== undefined));
  const phones = listed.filter((d) => d.kind === 'mobile' && d.revokedAt === null && !hidden.has(d.id)).map(phoneRow);
  const names = new Map((cloud?.devices ?? []).map((d) => [d.id, d.name]));
  const rv = m.revoke;
  const revoke = rv === null ? null : {
    id: rv.id, kind: rv.kind, name: rv.kind === 'done' ? rv.name : names.get(rv.id) ?? rv.id,
    message: rv.kind === 'failed' ? failureMessage(t, rv.failure) : null,
  };
  const lv = m.leave;
  const base = hangarBase(store);
  return {
    desktop: store.desktop,
    revoked: store.sync?.revoked === true,
    thisPcName: store.device?.name ?? '',
    pending: store.sync?.pending ?? 0,
    creator: cloud?.creator === true,
    pcs,
    join: presentJoin(t, m.join),
    add: presentAdd(store),
    revoke,
    leave: { kind: lv.kind, revokeError: lv.kind === 'left' ? lv.revokeError : null, message: lv.kind === 'failed' ? failureMessage(t, lv.failure) : null },
    commands: { leave: `${base} cloud leave`, revoke: `${base} cloud revoke <ID>`, devices: `${base} cloud devices` },
    phone: presentPhone(m.phone),
    phones,
    recovery: presentRecovery(m.recovery),
  };
}
