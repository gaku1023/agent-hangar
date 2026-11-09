import type { Language, PeerLaunchRefusal, PeerLaunchResult } from '@agent-hangar/shared';
import { msg, render } from '../i18n/message.ts';

/**
 * 呼び出し元の会話へ送り込む 1 通の文面（D14）。文は i18n（mcp.peer.*）に置く。
 * 1 通の長さの上限。tmux の貼り付けは 8,000 字までなので、見出しと要約の分を残して返答を切る（mcp/screenTools.ts の MAX_SEND_CHARS と同じ事情）。
 */
export const PEER_TEXT_MAX = 7_800;

/** 相手の PC から来た文字を、貼り付けに入れてよい形にする。ESC を含む制御文字を落とし、改行とタブだけ残す。 */
const clean = (s: string): string => s.replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '');
const oneLine = (s: string, max: number): string => clean(s).replace(/\s+/g, ' ').trim().slice(0, max);

/** 止まった理由（idle、question、permission、stopped、ended）の文。 */
export const stopReasonText = (lang: Language, reason: PeerLaunchResult['reason']): string => render(lang, msg(`mcp.peer.reason.${reason}`));

/** ターンが止まるたびの結果を、1 通の文にする。返答が長くて 1 通に収まらなければ、さらに切って truncated の扱いにする。 */
export function resultText(lang: Language, o: { device: string; result: PeerLaunchResult }): string {
  const r = o.result;
  const head = render(lang, msg('mcp.peer.head', { device: oneLine(o.device, 80), title: oneLine(r.title, 80), sessionId: oneLine(r.sessionId, 80), reason: render(lang, msg(`mcp.peer.reason.${r.reason}`)) }));
  const lines = [head];
  if (r.status) lines.push(render(lang, msg('mcp.peer.status', { status: oneLine(r.status, 40) })));
  if (r.summary) lines.push(render(lang, msg('mcp.peer.summary', { summary: clean(r.summary).trim().slice(0, 1_000) })));
  const reply = clean(r.lastReply).trim();
  if ((r.reason === 'ended' || r.reason === 'stopped') && reply === '') return lines.join('\n');
  if (reply === '') {
    lines.push(render(lang, msg('mcp.peer.noReply')));
    return lines.join('\n');
  }
  const note = render(lang, msg('mcp.peer.truncated'));
  const budget = Math.max(0, PEER_TEXT_MAX - lines.join('\n').length - note.length - 64);
  const cut = reply.length > budget;
  lines.push(render(lang, msg('mcp.peer.reply', { reply: cut ? reply.slice(0, budget) : reply })));
  if (r.truncated || cut) lines.push(note);
  return lines.join('\n');
}

const REFUSAL_KEY = {
  'project-missing': 'mcp.peer.refusal.projectMissing',
  'account-missing': 'mcp.peer.refusal.accountMissing',
  'account-logged-out': 'mcp.peer.refusal.accountLoggedOut',
  'agent-missing': 'mcp.peer.refusal.agentMissing',
  'depth-exceeded': 'mcp.peer.refusal.depthExceeded',
  'bad-payload': 'mcp.peer.refusal.badPayload',
  'expired': 'mcp.peer.refusal.expired',
  'launch-failed': 'mcp.peer.refusal.launchFailed',
  'not-spawned-by-caller': 'mcp.peer.refusal.notSpawnedByCaller',
} as const satisfies Record<PeerLaunchRefusal, string>;

/** 頼んだ PC の側で決まる断り。承認で断られた、承認が時間切れになった（D8）。 */
export type PeerLocalRefusal = 'approval-denied' | 'approval-timeout';
const LOCAL_REFUSAL_KEY = { 'approval-denied': 'mcp.peer.refusal.approvalDenied', 'approval-timeout': 'mcp.peer.refusal.approvalTimeout' } as const satisfies Record<PeerLocalRefusal, string>;

/** 断られた答えの文。detail は相手の PC が添えた短い説明で、あれば末尾に足す。 */
export function refusalText(lang: Language, o: { device: string; reason: PeerLaunchRefusal | PeerLocalRefusal; detail?: string; op?: 'launch' | 'send' | 'stop' }): string {
  const why = render(lang, msg(o.reason === 'approval-denied' || o.reason === 'approval-timeout' ? LOCAL_REFUSAL_KEY[o.reason] : REFUSAL_KEY[o.reason]));
  const detail = o.detail ? ` (${oneLine(o.detail, 200)})` : '';
  const key = o.op === 'send' ? 'mcp.peer.refusedSend' : o.op === 'stop' ? 'mcp.peer.refusedStop' : 'mcp.peer.refused';
  return render(lang, msg(key, { device: oneLine(o.device, 80), reason: why + detail }));
}

/** SSH の張り直しを諦めたときの、呼び出し元への文。頼みは終わらせず、つながれば続きを受け取る。 */
export function sshGaveUpText(lang: Language, o: { device: string }): string {
  return render(lang, msg('mcp.peer.sshGaveUp', { device: oneLine(o.device, 80) }));
}

/** 受け取られないまま期限が過ぎた頼みの文。 */
export function expiredText(lang: Language, o: { device: string }): string {
  return render(lang, msg('mcp.peer.expired', { device: oneLine(o.device, 80) }));
}

/**
 * 預かっている知らせについて、未読と通知へ出す短い文。title が null なら起動の答え、あれば報告の文にする。
 * scene は場面で、stopped は呼び出し元が止まっている（再開で渡る）、blocked は札か打ちかけで止めて長引いた、dropped は上限を超えて外した。
 */
export function heldNotice(lang: Language, o: { device: string; title: string | null; scene?: 'stopped' | 'blocked' | 'dropped' }): string {
  const device = oneLine(o.device, 80);
  const scene = o.scene ?? 'stopped';
  if (o.title === null) {
    const key = scene === 'blocked' ? 'mcp.peer.notice.heldBlockedRefused' : scene === 'dropped' ? 'mcp.peer.notice.heldDroppedRefused' : 'mcp.peer.notice.heldRefused';
    return render(lang, msg(key, { device }));
  }
  const key = scene === 'blocked' ? 'mcp.peer.notice.heldBlocked' : scene === 'dropped' ? 'mcp.peer.notice.heldDropped' : 'mcp.peer.notice.held';
  return render(lang, msg(key, { device, title: oneLine(o.title, 80) }));
}

/** 画面から人が頼んだ起動が、相手で起きたときの札の文。 */
export function screenStartedText(lang: Language, o: { device: string; title: string }): string {
  const device = oneLine(o.device, 80);
  const title = oneLine(o.title, 80);
  return title === '' ? render(lang, msg('mcp.peer.screenStartedPlain', { device })) : render(lang, msg('mcp.peer.screenStarted', { device, title }));
}

/** 画面から人が頼んだ起動が断られた（相手の答え、置く前の検査）ときの札の文。 */
export function screenRefusalText(lang: Language, o: { device: string; reason: PeerLaunchRefusal | PeerLocalRefusal; detail?: string }): string {
  const why = render(lang, msg(o.reason === 'approval-denied' || o.reason === 'approval-timeout' ? LOCAL_REFUSAL_KEY[o.reason] : REFUSAL_KEY[o.reason]));
  const detail = o.detail ? ` (${oneLine(o.detail, 200)})` : '';
  return render(lang, msg('mcp.peer.screenRefused', { device: oneLine(o.device, 80), reason: why + detail }));
}

/** 画面から人が頼んだ起動が、受け取られないまま期限を過ぎたときの札の文。 */
export function screenExpiredText(lang: Language, o: { device: string }): string {
  return render(lang, msg('mcp.peer.screenExpired', { device: oneLine(o.device, 80) }));
}

/** 呼び出し元が消えているときに、利用者への通知へ出す短い文。reason はその報告の止まった理由の文。 */
export function goneNotice(lang: Language, o: { device: string; title: string | null; reason: string }): string {
  return render(lang, msg('mcp.peer.notice.gone', { device: oneLine(o.device, 80), title: o.title === null ? '' : oneLine(o.title, 80), reason: o.reason }));
}
