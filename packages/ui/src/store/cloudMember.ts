import type { CloudDeviceOut, CloudDevicesDto } from '@agent-hangar/shared';

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

/** devices は Worker の PC の一覧（GET /api/sync/cloud-devices）で、設定に入ったときに取る。未取得は null。 */
export type CloudMemberState = { devices: CloudDevicesDto | null; join: JoinStage; revoke: RevokeStage | null; leave: LeaveStage };

export type CloudMemberEvent =
  | { type: 'devices.loaded'; devices: CloudDevicesDto }
  | { type: 'join.checking' } | { type: 'join.planned'; plan: JoinPlanView } | { type: 'join.joining' } | { type: 'join.joined'; host: string }
  | { type: 'join.failed'; failure: CloudFailure } | { type: 'join.reset' }
  | { type: 'revoke.start'; id: string } | { type: 'revoke.done'; device: CloudDeviceOut } | { type: 'revoke.failed'; id: string; failure: CloudFailure } | { type: 'revoke.reset' }
  | { type: 'leave.start' } | { type: 'leave.done'; revokeError: string | null } | { type: 'leave.failed'; failure: CloudFailure } | { type: 'leave.reset' };

export function initialCloudMember(): CloudMemberState {
  return { devices: null, join: { kind: 'idle' }, revoke: null, leave: { kind: 'idle' } };
}

/** いまの段が持つ宛先。宛先を確かめる前と、済んだ後は null。 */
export function joinPlanOf(j: JoinStage): JoinPlanView | null {
  return j.kind === 'confirm' || j.kind === 'joining' ? j.plan : j.kind === 'failed' ? j.plan : null;
}

export function reduceCloudMember(s: CloudMemberState, e: CloudMemberEvent): CloudMemberState {
  switch (e.type) {
    case 'devices.loaded': return { ...s, devices: e.devices };
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
  }
}
