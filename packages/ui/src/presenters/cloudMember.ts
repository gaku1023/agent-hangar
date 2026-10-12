import type { CloudDeviceDto, Translate } from '@agent-hangar/shared';
import type { CloudFailure, JoinStage } from '../store/cloudMember.ts';
import type { Store } from '../store/store.ts';
import { relativeTime } from './format.ts';
import { translatorOf } from './i18n.ts';

/**
 * 設定のクラウド同期の節の、参加と、PC の一覧と解除と、この PC の参加の解除（0.4.0。試作 settings-040-proto の推す組み合わせ）。
 * 参加は節の中の段（貼る → 宛先の確認 → 参加）、PC は表と行の中の確認、この PC の参加の解除は節の末尾に離した帯で出す。
 * 参加と解除は殻の中でだけ行い、ブラウザではターミナルのコマンドを案内する（desktop が偽）。
 */

/**
 * PC の 1 行。joined と ip と place は Worker の一覧があるときだけで、同期の表に戻したときは null。
 * ip（最後の IP）と place（場所）を分けて持つ。IPv6 の IP は長く、1 本の文字列にすると後ろの場所が切られて見えなくなるからである。
 */
export type CloudPcRow = { id: string; name: string; self: boolean; os: string; joined: string | null; lastSeen: string; ip: string | null; place: string | null; removedOn: string | null };

/**
 * PC の一覧。state の ok は Worker の一覧、fallback は Worker が古いか繋がらないので同期の表（共有テーブルの devices）に戻したもの、
 * loading はまだ Worker の一覧が届いていないもの（同期の表を出しておく）。fallback と loading では解除を出さない。
 */
export type CloudPcsProps = { state: 'ok' | 'fallback' | 'loading'; rows: CloudPcRow[]; removed: CloudPcRow[]; note: string | null };

/** 失敗の見出しと本文。again は、もう一度同じトークンで試すか（retry）、貼り直してもらうか（repaste）。 */
export type CloudFailureText = { title: string; body: string; again: 'retry' | 'repaste' };

export type CloudJoinProps = {
  kind: JoinStage['kind'];
  host: string | null;
  url: string | null;
  /** 別のクラウドか秘密の違う参加し直しの警告。無ければ null。 */
  rejoin: { title: string; current: string; next: string } | null;
  failure: CloudFailureText | null;
};

export type CloudMemberProps = {
  desktop: boolean;
  /** この PC が同期から解除されている。 */
  revoked: boolean;
  thisPcName: string;
  pending: number;
  creator: boolean;
  pcs: CloudPcsProps;
  join: CloudJoinProps;
  /** ほかの PC の解除の段。message は失敗の文。 */
  revoke: { id: string; kind: 'busy' | 'failed' | 'done'; name: string; message: string | null } | null;
  leave: { kind: 'idle' | 'busy' | 'left' | 'failed'; revokeError: string | null; message: string | null };
  /** ブラウザで案内するコマンド。hangar の呼び方は、準備の確かめの参加のコマンドからそろえる。 */
  commands: { leave: string; revoke: string; devices: string };
};

const OS: Record<string, string> = { darwin: 'macOS', win32: 'Windows', linux: 'Linux' };

const pad = (n: number): string => String(n).padStart(2, '0');
const ymd = (ms: number): string => { const d = new Date(ms); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
const md = (ms: number): string => { const d = new Date(ms); return `${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };

/** 場所。Cloudflare の英語のまま、市区、地域、国の順に並べる。最後の IP が無ければ出さない。 */
function placeOf(d: CloudDeviceDto): string | null {
  if (d.lastIp === null) return null;
  return [d.lastCity, d.lastRegion, d.lastCountry].filter((v): v is string => v !== null && v !== '').join(', ') || null;
}

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

/** 参加の段の失敗の見出しと本文。 */
function joinFailure(t: Translate, f: CloudFailure, host: string | null): CloudFailureText {
  switch (f.code) {
    case 'invalid-token': return { title: t('cloudMember.fail.invalidToken.title'), body: t('cloudMember.fail.invalidToken.body'), again: 'repaste' };
    case 'forbidden': return { title: t('cloudMember.fail.forbidden.title'), body: t('cloudMember.fail.forbidden.body'), again: 'repaste' };
    case 'network': case 'timeout': return { title: t('cloudMember.fail.network.title'), body: t('cloudMember.fail.network.body', { host: host ?? '' }), again: 'retry' };
    case 'compat': return { title: t('cloudMember.fail.compat.title'), body: t('cloudMember.fail.compat.body'), again: 'retry' };
    case 'broken-config': return { title: t('cloudMember.fail.brokenConfig.title'), body: t('cloudMember.fail.brokenConfig.body'), again: 'repaste' };
    default: return { title: t('cloudMember.fail.other.title'), body: failureMessage(t, f), again: 'retry' };
  }
}

function presentJoin(t: Translate, j: JoinStage): CloudJoinProps {
  const plan = j.kind === 'confirm' || j.kind === 'joining' || j.kind === 'failed' ? j.plan : null;
  const rejoin = plan && plan.current && (plan.change === 'other-cloud' || plan.change === 'new-secret')
    ? { title: t(plan.change === 'other-cloud' ? 'cloudMember.rejoin.otherCloud' : 'cloudMember.rejoin.newSecret'), current: plan.current.url, next: plan.url }
    : null;
  return {
    kind: j.kind,
    host: j.kind === 'joined' ? j.host : plan?.host ?? null,
    url: plan?.url ?? null,
    rejoin,
    failure: j.kind === 'failed' ? joinFailure(t, j.failure, plan?.host ?? null) : null,
  };
}

/** hangar の呼び方（同梱の hangar の絶対パスなど）。準備の確かめの参加のコマンドの頭を使う。 */
function hangarBase(store: Store): string {
  const join = store.readiness?.commands.join ?? 'hangar join <token>';
  return / join <token>$/.test(join) ? join.replace(/ join <token>$/, '') : 'hangar';
}

export function presentCloudMember(store: Store, now: number = Date.now()): CloudMemberProps {
  const t = translatorOf(store);
  const m = store.cloudMember;
  const cloud = m.devices;
  const row = (d: CloudDeviceDto): CloudPcRow => ({
    id: d.id, name: d.name, self: d.self, os: OS[d.platform] ?? d.platform,
    joined: ymd(d.joinedAt), lastSeen: relativeTime(t, d.lastSeenAt, now), ip: d.lastIp, place: placeOf(d),
    removedOn: d.revokedAt === null ? null : t('cloudMember.pcs.removedOn', { date: md(d.revokedAt) }),
  });
  // Worker の一覧が無いときは、同期の表の一覧を出しておく（参加日と場所は無い）。
  const shared = (): CloudPcRow[] => store.devices.map((d) => ({ id: d.id, name: d.name, self: d.self, os: OS[d.platform] ?? d.platform, joined: null, lastSeen: relativeTime(t, d.lastSeenAt, now), ip: null, place: null, removedOn: null }));
  const pcs: CloudPcsProps = cloud?.state === 'ok'
    ? { state: 'ok', rows: cloud.devices.filter((d) => d.revokedAt === null).map(row), removed: cloud.devices.filter((d) => d.revokedAt !== null).map(row), note: null }
    : cloud && cloud.state !== 'off'
      ? { state: 'fallback', rows: shared(), removed: [], note: cloud.message }
      : { state: 'loading', rows: shared(), removed: [], note: null };
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
    revoke,
    leave: { kind: lv.kind, revokeError: lv.kind === 'left' ? lv.revokeError : null, message: lv.kind === 'failed' ? failureMessage(t, lv.failure) : null },
    commands: { leave: `${base} cloud leave`, revoke: `${base} cloud revoke <ID>`, devices: `${base} cloud devices` },
  };
}
