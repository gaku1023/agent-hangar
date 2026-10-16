import type { CloudDeviceOut, CloudDevicesDto, MobilePairingDto } from '@agent-hangar/shared';

/**
 * クラウド同期への参加と、PC の一覧と解除と、この PC の参加の解除の状態（0.4.0）。
 * 参加と解除は殻の命令（CLI）が行い、結果は Runtime しか知らない事実なので、Store が持つ（store/update.ts と同じ作り）。
 * Runtime が殻を呼び（runtime/cloudMember.ts）、結果をこの reduceCloudMember に通して Store に置く。
 * 参加トークンはここに置かない。Runtime の中にだけ持ち、参加が済むか段を閉じたら捨てる。
 */

/** 参加の見立て（hangar join --plan --json の plan）。参加用の秘密は含まない。 */
export type JoinPlanView = { url: string; host: string; current: { url: string } | null; change: 'new' | 'same' | 'other-cloud' | 'new-secret' };

/** 殻か CLI が返した失敗。code で画面の言い方を選び、message は CLI か OS の文をそのまま持つ。 */
export type CloudFailure = { code: string; message: string };

/**
 * 参加の段。idle は段を開いていない（貼る欄は画面だけが持つ）、checking は宛先を確かめている、confirm は宛先の確認を待っている、
 * joining は参加している、joined は参加が済んで再起動を待っている、failed は失敗した（宛先を確かめた後なら plan を持つ）。
 */
export type JoinStage =
  | { kind: 'idle' } | { kind: 'checking' }
  | { kind: 'confirm'; plan: JoinPlanView } | { kind: 'joining'; plan: JoinPlanView }
  | { kind: 'joined'; host: string }
  | { kind: 'failed'; plan: JoinPlanView | null; failure: CloudFailure };

/** ほかの PC の解除。1 度に 1 台だけを扱う。done は済んだ印で、次の操作か閉じるまで残す。 */
export type RevokeStage = { id: string; kind: 'busy' } | { id: string; kind: 'failed'; failure: CloudFailure } | { id: string; kind: 'done'; name: string };

/** この PC の参加の解除。left は済んで再起動を待っている（クラウドで解除できなかった理由つき）。 */
export type LeaveStage = { kind: 'idle' } | { kind: 'busy' } | { kind: 'left'; revokeError: string | null } | { kind: 'failed'; failure: CloudFailure };

/**
 * スマホを接続する QR の段。loading は券を取っている、ready は QR を出している（known は出した時点で参加していたスマホの ID。一覧がまだ無ければ null で、最初に届いた一覧を基準にする）、
 * loading の renew は、QR の段を開いたまま新しい券を待っている（段を畳まない）。expired は 5 分を過ぎた、paired は QR を出している間に新しいスマホが参加した、old は Worker の版が足りない、limited は券の取りすぎ、notJoined は同期に参加していない、failed はそれ以外の失敗。
 * QR の中身（pairUrl と pairText、スマホ用の暗号鍵を含む）を持つのは ready の間だけで、閉じる、期限が切れる、参加する、のどれでも捨てる。
 */
export type PhoneStage =
  | { kind: 'idle' } | { kind: 'loading'; renew?: true }
  | { kind: 'ready'; pairUrl: string; pairText: string; expiresAt: number; known: string[] | null }
  | { kind: 'expired' } | { kind: 'paired'; id: string; name: string }
  | { kind: 'old'; compat: number | null } | { kind: 'limited' } | { kind: 'notJoined' } | { kind: 'failed'; message: string };

/** devices は Worker の PC の一覧（GET /api/sync/cloud-devices）で、設定に入ったときに取る。未取得は null。 */
export type CloudMemberState = { devices: CloudDevicesDto | null; join: JoinStage; revoke: RevokeStage | null; leave: LeaveStage; phone: PhoneStage };

export type CloudMemberEvent =
  | { type: 'devices.loaded'; devices: CloudDevicesDto }
  | { type: 'join.checking' } | { type: 'join.planned'; plan: JoinPlanView } | { type: 'join.joining' } | { type: 'join.joined'; host: string }
  | { type: 'join.failed'; failure: CloudFailure } | { type: 'join.reset' }
  | { type: 'revoke.start'; id: string } | { type: 'revoke.done'; device: CloudDeviceOut } | { type: 'revoke.failed'; id: string; failure: CloudFailure } | { type: 'revoke.reset' }
  | { type: 'leave.start' } | { type: 'leave.done'; revokeError: string | null } | { type: 'leave.failed'; failure: CloudFailure } | { type: 'leave.reset' }
  | { type: 'phone.loading' } | { type: 'phone.loaded'; pairing: MobilePairingDto } | { type: 'phone.failed'; message: string } | { type: 'phone.expired' } | { type: 'phone.reset' };

export function initialCloudMember(): CloudMemberState {
  return { devices: null, join: { kind: 'idle' }, revoke: null, leave: { kind: 'idle' }, phone: { kind: 'idle' } };
}

/** 一覧のうち、解除していないスマホ。版 6 までの Worker は kind を返さないので、無ければ PC として読む。 */
const activePhones = (devices: CloudDevicesDto): CloudDeviceOut[] => (devices.state === 'ok' ? devices.devices.filter((d) => d.kind === 'mobile' && d.revokedAt === null) : []);

function phoneOf(pairing: MobilePairingDto, devices: CloudDevicesDto | null): PhoneStage {
  switch (pairing.state) {
    case 'ready': return { kind: 'ready', pairUrl: pairing.pairUrl, pairText: pairing.pairText, expiresAt: pairing.expiresAt, known: devices?.state === 'ok' ? activePhones(devices).map((d) => d.id) : null };
    case 'worker-too-old': return { kind: 'old', compat: pairing.compat };
    case 'rate-limited': return { kind: 'limited' };
    case 'not-joined': return { kind: 'notJoined' };
  }
}

/** QR を出している間に届いた一覧で、新しく参加したスマホを探す。基準がまだ無ければ、この一覧を基準にする。 */
function watchPhones(p: PhoneStage, devices: CloudDevicesDto): PhoneStage {
  if (p.kind !== 'ready' || devices.state !== 'ok') return p;
  const phones = activePhones(devices);
  if (p.known === null) return { ...p, known: phones.map((d) => d.id) };
  const fresh = phones.find((d) => !p.known!.includes(d.id));
  return fresh ? { kind: 'paired', id: fresh.id, name: fresh.name } : p;
}

/** いまの段が持つ宛先。宛先を確かめる前と、済んだ後は null。 */
export function joinPlanOf(j: JoinStage): JoinPlanView | null {
  return j.kind === 'confirm' || j.kind === 'joining' ? j.plan : j.kind === 'failed' ? j.plan : null;
}

export function reduceCloudMember(s: CloudMemberState, e: CloudMemberEvent): CloudMemberState {
  switch (e.type) {
    case 'devices.loaded': return { ...s, devices: e.devices, phone: watchPhones(s.phone, e.devices) };
    case 'join.checking': return { ...s, join: { kind: 'checking' } };
    case 'join.planned': return { ...s, join: { kind: 'confirm', plan: e.plan } };
    case 'join.joining': {
      const plan = joinPlanOf(s.join);
      return plan ? { ...s, join: { kind: 'joining', plan } } : s;
    }
    case 'join.joined': return { ...s, join: { kind: 'joined', host: e.host } };
    case 'join.failed': return { ...s, join: { kind: 'failed', plan: joinPlanOf(s.join), failure: e.failure } };
    case 'join.reset': return { ...s, join: { kind: 'idle' } };
    case 'revoke.start': return { ...s, revoke: { id: e.id, kind: 'busy' } };
    case 'revoke.done': {
      // 取り直しを待たずに、その PC を「解除した PC」へ移す。
      const devices = s.devices ? { ...s.devices, devices: s.devices.devices.map((d) => (d.id === e.device.id ? { ...e.device, self: d.self } : d)) } : s.devices;
      return { ...s, devices, revoke: { id: e.device.id, kind: 'done', name: e.device.name } };
    }
    case 'revoke.failed': return { ...s, revoke: { id: e.id, kind: 'failed', failure: e.failure } };
    case 'revoke.reset': return { ...s, revoke: null };
    case 'leave.start': return { ...s, leave: { kind: 'busy' } };
    case 'leave.done': return { ...s, leave: { kind: 'left', revokeError: e.revokeError } };
    case 'leave.failed': return { ...s, leave: { kind: 'failed', failure: e.failure } };
    case 'leave.reset': return { ...s, leave: { kind: 'idle' } };
    // QR の段を開いたまま新しい QR を頼んだとき（期限切れの「新しい QR を出す」など）は renew を立て、段を畳まずに待つ。
    case 'phone.loading': return { ...s, phone: s.phone.kind === 'ready' || s.phone.kind === 'expired' || s.phone.kind === 'paired' ? { kind: 'loading', renew: true } : { kind: 'loading' } };
    case 'phone.loaded': return { ...s, phone: phoneOf(e.pairing, s.devices) };
    case 'phone.failed': return { ...s, phone: { kind: 'failed', message: e.message } };
    case 'phone.expired': return s.phone.kind === 'ready' ? { ...s, phone: { kind: 'expired' } } : s;
    case 'phone.reset': return { ...s, phone: { kind: 'idle' } };
  }
}
