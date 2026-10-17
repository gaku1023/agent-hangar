import type { CloudDevicesDto, DeviceOut, JoinApproverState, MobilePairingDto } from '@agent-hangar/shared';

/**
 * クラウド同期への参加と、PC の一覧と解除と、この PC の参加の解除の状態。
 * 参加と解除は殻の命令（CLI）が行い、結果は Runtime しか知らない事実なので、Store が持つ（store/update.ts と同じ作り）。
 * Runtime が殻を呼び（runtime/cloudMember.ts）、結果をこの reduceCloudMember に通して Store に置く。
 * 新しい PC が入力した参加コードはここに置かない。Runtime が殻へ渡すだけである。
 * 発行した PC の参加コードは、サーバーの承認の状態（JoinApproverState）の写しとして add に置く。この PC の画面にだけ出すものである。
 */

/** 接続先の確認の答え（hangar cloud join-check）。url は origin の形にそろえたもの、current は今参加しているクラウドか null。 */
/** current.legacy は、今の設定が古い形式（版 1）であること（CLI の JoinCheck と同じ）。 */
export type JoinCheckView = { url: string; host: string; pcCount: number; current: { url: string; legacy?: true } | null };

/** 殻か CLI が返した失敗。code で画面の言い方を選び、message は CLI か OS の文をそのまま持つ。 */
export type CloudFailure = { code: string; message: string };

/**
 * 参加が終わった理由。expired は参加コードの期限切れか使用済み、rejected は発行した PC が拒否した、no-answer は 5 分たっても承認されなかった、
 * bad-code は参加コードの形が違う、network は接続先に接続できない、compat はこの PC の hangar が古い、rate-limited はリクエストが多すぎる、
 * pending は承認済みの前回の参加が完了していない、other はそれ以外（message に CLI の文）。
 */
export type JoinFailReason = 'expired' | 'rejected' | 'no-answer' | 'bad-code' | 'network' | 'compat' | 'rate-limited' | 'pending' | 'other';

/**
 * 参加の段（新しい PC の側、試作 B2）。url は接続先の URL の入力（確認に失敗したら failure を持つ）、checking は接続先を確認している、
 * code は参加コードの入力、requesting は参加リクエストを送っている、waiting は承認を待っている（sas は区切りの無い 6 桁の確認コード）、
 * done は承認されて再起動を待っている、failed は終わった理由を持つ（参加コードを入力し直すために check を保持する）。
 */
export type JoinStage =
  | { kind: 'url'; failure: CloudFailure | null } | { kind: 'checking'; url: string }
  | { kind: 'code'; check: JoinCheckView } | { kind: 'requesting'; check: JoinCheckView }
  | { kind: 'waiting'; check: JoinCheckView; sas: string; expiresAt: number }
  | { kind: 'done'; host: string }
  | { kind: 'failed'; reason: JoinFailReason; message: string; check: JoinCheckView | null };

/**
 * 「PC を追加」の段（参加済みの PC の側、試作 A1）。サーバーの承認の状態の写しに、画面だけの 2 つを加える。
 * issuing は参加コードの発行を頼んでいる、rejected は拒否した後の知らせ（サーバーは idle に戻るが、閉じるまで拒否した旨を保持する）。
 */
export type AddPcStage = JoinApproverState | { kind: 'issuing' } | { kind: 'rejected'; name: string };

/** ほかの PC の解除。1 度に 1 台だけを扱う。done は済んだ印で、次の操作か閉じるまで残す。 */
export type RevokeStage = { id: string; kind: 'busy' } | { id: string; kind: 'failed'; failure: CloudFailure } | { id: string; kind: 'done'; name: string };

/** この PC の参加の解除。left は済んで再起動を待っている（クラウドで解除できなかった理由つき）。 */
export type LeaveStage = { kind: 'idle' } | { kind: 'busy' } | { kind: 'left'; revokeError: string | null } | { kind: 'failed'; failure: CloudFailure };

/**
 * スマホを接続する QR の段。loading は券を取っている、ready は QR を出している（pairId は券の印で、サーバーの軽い口に渡して接続の済んだスマホを見る）、
 * loading の renew は、QR の段を開いたまま新しい券を待っている（段を畳まない）。expired は 5 分を過ぎた、paired は QR を出している間にスマホが接続し、PC が keybox を置き終えた、old は Worker の版が足りない、limited は券の取りすぎ、notJoined は同期に参加していない、failed はそれ以外の失敗。
 * QR の中身（pairUrl と pairText、使い捨ての券を含む）を持つのは ready の間だけで、閉じる、期限が切れる、参加する、のどれでも捨てる。
 */
export type PhoneStage =
  | { kind: 'idle' } | { kind: 'loading'; renew?: true }
  | { kind: 'ready'; pairUrl: string; pairText: string; expiresAt: number; pairId: string }
  | { kind: 'expired' } | { kind: 'paired'; id: string; name: string }
  | { kind: 'old'; compat: number | null } | { kind: 'limited' } | { kind: 'notJoined' } | { kind: 'failed'; message: string };

/** 再発行したリカバリーキーの暗号鍵を画面に出しておく長さ（試作 D2 の 120 秒）。過ぎたら伏せる。 */
export const RECOVERY_SHOW_MS = 120_000;

/** リカバリーキーの確認の失敗。retry が真なら、同じ下書きと末尾 4 文字のまま送り直せる（Worker の失敗）。 */
export type RecoveryError = { message: string; retry: boolean };

/**
 * 「リカバリーキーを再発行」の段（試作 D2）。asking は再発行の確認、issuing は新しいリカバリーキーを作っている。
 * shown は 4 行の文字列（text）と下書きの ID を持つ。hideAt を過ぎたら暗号鍵を伏せ、entering は末尾 4 文字の入力の段にいる。
 * busy は確認を送っている、sentTail は最後に送った末尾 4 文字（送り直しに使う）、error は確認の失敗。
 * done は名簿の差し替えまで済んだ、failed は作成の失敗か下書きが無い（もう一度再発行する）。
 * text を持つのは shown の間だけで、閉じる、済む、失敗する、のどれでも捨てる。
 */
export type RecoveryStage =
  | { kind: 'idle' } | { kind: 'asking' } | { kind: 'issuing' }
  | { kind: 'shown'; text: string; draftId: string; hideAt: number; entering: boolean; busy: boolean; sentTail: string | null; error: RecoveryError | null }
  | { kind: 'done' } | { kind: 'failed'; message: string };

/**
 * スマホの解除の「元に戻す」を待っているスマホ（試作 E2）。この間は行を隠し、右下に「元に戻す」を出し、Worker には何も送らない。
 * 1 度に 1 台だけを持つ。5 秒たつか、別のスマホを解除すると解除を送る（runtime/cloudMember.ts）。
 */
export type PhoneUndo = { id: string; name: string };

/**
 * devices は Worker の PC の一覧（GET /api/sync/cloud-devices）で、設定に入ったときに取る。未取得は null。
 * phoneUndo は「元に戻す」を待っているスマホで、無ければ null。
 * phoneQueued は、別の解除を送っている間に 5 秒が過ぎ、送る順を待っているスマホの ID（解除は 1 度に 1 台）。その行も一覧に出さない。
 */
export type CloudMemberState = { devices: CloudDevicesDto | null; join: JoinStage; add: AddPcStage; revoke: RevokeStage | null; leave: LeaveStage; phone: PhoneStage; recovery: RecoveryStage; phoneUndo: PhoneUndo | null; phoneQueued: string[] };

export type CloudMemberEvent =
  | { type: 'devices.loaded'; devices: CloudDevicesDto }
  | { type: 'join.checking'; url: string } | { type: 'join.checked'; check: JoinCheckView } | { type: 'join.checkFailed'; failure: CloudFailure }
  | { type: 'join.requesting' } | { type: 'join.waiting'; sas: string; expiresAt: number } | { type: 'join.done' }
  | { type: 'join.failed'; reason: JoinFailReason; message: string } | { type: 'join.reenter' } | { type: 'join.reset' }
  | { type: 'add.issuing' } | { type: 'add.state'; state: JoinApproverState } | { type: 'add.rejected'; name: string } | { type: 'add.reset' }
  | { type: 'revoke.start'; id: string } | { type: 'revoke.done'; device: DeviceOut } | { type: 'revoke.failed'; id: string; failure: CloudFailure } | { type: 'revoke.reset' }
  | { type: 'leave.start' } | { type: 'leave.done'; revokeError: string | null } | { type: 'leave.failed'; failure: CloudFailure } | { type: 'leave.reset' }
  | { type: 'phone.loading' } | { type: 'phone.loaded'; pairing: MobilePairingDto } | { type: 'phone.failed'; message: string } | { type: 'phone.expired' } | { type: 'phone.reset' }
  | { type: 'phone.paired'; id: string; name: string }
  | { type: 'phoneUndo.start'; undo: PhoneUndo } | { type: 'phoneUndo.clear' }
  | { type: 'phoneQueue.push'; id: string } | { type: 'phoneQueue.shift' }
  | { type: 'recovery.ask' } | { type: 'recovery.issuing' } | { type: 'recovery.shown'; text: string; draftId: string; hideAt: number }
  | { type: 'recovery.saved' } | { type: 'recovery.reveal'; hideAt: number }
  | { type: 'recovery.confirming'; tail: string } | { type: 'recovery.confirmFailed'; error: RecoveryError }
  | { type: 'recovery.done' } | { type: 'recovery.failed'; message: string } | { type: 'recovery.reset' };

export function initialCloudMember(): CloudMemberState {
  return { devices: null, join: { kind: 'url', failure: null }, add: { kind: 'idle' }, revoke: null, leave: { kind: 'idle' }, phone: { kind: 'idle' }, recovery: { kind: 'idle' }, phoneUndo: null, phoneQueued: [] };
}

/** 表示中の段だけを書き換える。表示中でなければそのまま返す。 */
function onShown(s: CloudMemberState, f: (r: Extract<RecoveryStage, { kind: 'shown' }>) => RecoveryStage): CloudMemberState {
  return s.recovery.kind === 'shown' ? { ...s, recovery: f(s.recovery) } : s;
}

function phoneOf(pairing: MobilePairingDto): PhoneStage {
  switch (pairing.state) {
    case 'ready': return { kind: 'ready', pairUrl: pairing.pairUrl, pairText: pairing.pairText, expiresAt: pairing.expiresAt, pairId: pairing.pairId };
    case 'worker-too-old': return { kind: 'old', compat: pairing.compat };
    case 'rate-limited': return { kind: 'limited' };
    case 'not-joined': return { kind: 'notJoined' };
  }
}

/** 今の段が持つ接続先の確認の結果。確認する前と、完了した後は null。 */
export function joinCheckOf(j: JoinStage): JoinCheckView | null {
  return j.kind === 'code' || j.kind === 'requesting' || j.kind === 'waiting' || j.kind === 'failed' ? j.check : null;
}

/** サーバーの承認の状態を写す。拒否の後と発行を頼んでいる間に受信した idle は、画面の知らせを優先して保持する。 */
function addOf(s: AddPcStage, next: JoinApproverState): AddPcStage {
  if (next.kind === 'idle' && (s.kind === 'rejected' || s.kind === 'issuing')) return s;
  return next;
}

export function reduceCloudMember(s: CloudMemberState, e: CloudMemberEvent): CloudMemberState {
  switch (e.type) {
    case 'devices.loaded': return { ...s, devices: e.devices };
    case 'join.checking': return { ...s, join: { kind: 'checking', url: e.url } };
    case 'join.checked': return { ...s, join: { kind: 'code', check: e.check } };
    case 'join.checkFailed': return { ...s, join: { kind: 'url', failure: e.failure } };
    case 'join.requesting': {
      const check = joinCheckOf(s.join);
      return check ? { ...s, join: { kind: 'requesting', check } } : s;
    }
    case 'join.waiting': {
      const check = joinCheckOf(s.join);
      return check ? { ...s, join: { kind: 'waiting', check, sas: e.sas, expiresAt: e.expiresAt } } : s;
    }
    case 'join.done': {
      const check = joinCheckOf(s.join);
      return { ...s, join: { kind: 'done', host: check?.host ?? '' } };
    }
    case 'join.failed': return { ...s, join: { kind: 'failed', reason: e.reason, message: e.message, check: joinCheckOf(s.join) } };
    case 'join.reenter': {
      const check = joinCheckOf(s.join);
      return { ...s, join: check ? { kind: 'code', check } : { kind: 'url', failure: null } };
    }
    case 'join.reset': return { ...s, join: { kind: 'url', failure: null } };
    case 'add.issuing': return { ...s, add: { kind: 'issuing' } };
    case 'add.state': {
      const add = addOf(s.add, e.state);
      return add === s.add ? s : { ...s, add };
    }
    case 'add.rejected': return { ...s, add: { kind: 'rejected', name: e.name } };
    case 'add.reset': return { ...s, add: { kind: 'idle' } };
    case 'revoke.start': return { ...s, revoke: { id: e.id, kind: 'busy' } };
    case 'revoke.done': {
      // 取り直しを待たずに、その PC を「解除した PC」へ移す。名前は名簿から読んだ一覧の行のものを使う（Worker の行は名前を持たない）。
      const before = s.devices?.devices.find((d) => d.id === e.device.id);
      const devices = s.devices ? { ...s.devices, devices: s.devices.devices.map((d) => (d.id === e.device.id ? { ...d, revokedAt: e.device.revokedAt } : d)) } : s.devices;
      return { ...s, devices, revoke: { id: e.device.id, kind: 'done', name: before?.name ?? e.device.id } };
    }
    case 'revoke.failed': return { ...s, revoke: { id: e.id, kind: 'failed', failure: e.failure } };
    case 'revoke.reset': return { ...s, revoke: null };
    case 'leave.start': return { ...s, leave: { kind: 'busy' } };
    case 'leave.done': return { ...s, leave: { kind: 'left', revokeError: e.revokeError } };
    case 'leave.failed': return { ...s, leave: { kind: 'failed', failure: e.failure } };
    case 'leave.reset': return { ...s, leave: { kind: 'idle' } };
    // QR の段を開いたまま新しい QR を頼んだとき（期限切れの「新しい QR を出す」など）は renew を立て、段を畳まずに待つ。
    case 'phone.loading': return { ...s, phone: s.phone.kind === 'ready' || s.phone.kind === 'expired' || s.phone.kind === 'paired' ? { kind: 'loading', renew: true } : { kind: 'loading' } };
    case 'phone.loaded': return { ...s, phone: phoneOf(e.pairing) };
    case 'phone.paired': return s.phone.kind === 'ready' ? { ...s, phone: { kind: 'paired', id: e.id, name: e.name } } : s;
    case 'phoneUndo.start': return { ...s, phoneUndo: e.undo };
    case 'phoneUndo.clear': return s.phoneUndo === null ? s : { ...s, phoneUndo: null };
    case 'phoneQueue.push': return s.phoneQueued.includes(e.id) ? s : { ...s, phoneQueued: [...s.phoneQueued, e.id] };
    case 'phoneQueue.shift': return s.phoneQueued.length === 0 ? s : { ...s, phoneQueued: s.phoneQueued.slice(1) };
    case 'phone.failed': return { ...s, phone: { kind: 'failed', message: e.message } };
    case 'phone.expired': return s.phone.kind === 'ready' ? { ...s, phone: { kind: 'expired' } } : s;
    case 'phone.reset': return { ...s, phone: { kind: 'idle' } };
    case 'recovery.ask': return { ...s, recovery: { kind: 'asking' } };
    case 'recovery.issuing': return { ...s, recovery: { kind: 'issuing' } };
    case 'recovery.shown': return { ...s, recovery: { kind: 'shown', text: e.text, draftId: e.draftId, hideAt: e.hideAt, entering: false, busy: false, sentTail: null, error: null } };
    case 'recovery.saved': return onShown(s, (r) => ({ ...r, entering: true }));
    // もう一度表示するときは、入力の段から暗号鍵の段へ戻す（保存し直すため）。
    case 'recovery.reveal': return onShown(s, (r) => ({ ...r, hideAt: e.hideAt, entering: false, error: null }));
    case 'recovery.confirming': return onShown(s, (r) => ({ ...r, busy: true, sentTail: e.tail, error: null }));
    case 'recovery.confirmFailed': return onShown(s, (r) => ({ ...r, busy: false, error: e.error }));
    case 'recovery.done': return { ...s, recovery: { kind: 'done' } };
    case 'recovery.failed': return { ...s, recovery: { kind: 'failed', message: e.message } };
    case 'recovery.reset': return { ...s, recovery: { kind: 'idle' } };
  }
}
