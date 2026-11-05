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

/** 止まった理由（idle、question、permission、ended）の文。 */
export const stopReasonText = (lang: Language, reason: PeerLaunchResult['reason']): string => render(lang, msg(`mcp.peer.reason.${reason}`));

/** ターンが止まるたびの結果を、1 通の文にする。返答が長くて 1 通に収まらなければ、さらに切って truncated の扱いにする。 */
export function resultText(lang: Language, o: { device: string; result: PeerLaunchResult }): string {
  const r = o.result;
  const head = render(lang, msg('mcp.peer.head', { device: oneLine(o.device, 80), title: oneLine(r.title, 80), sessionId: oneLine(r.sessionId, 80), reason: render(lang, msg(`mcp.peer.reason.${r.reason}`)) }));
  const lines = [head];
  if (r.status) lines.push(render(lang, msg('mcp.peer.status', { status: oneLine(r.status, 40) })));
  if (r.summary) lines.push(render(lang, msg('mcp.peer.summary', { summary: clean(r.summary).trim().slice(0, 1_000) })));
  const reply = clean(r.lastReply).trim();
  if (r.reason === 'ended' && reply === '') return lines.join('\n');
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
} as const satisfies Record<PeerLaunchRefusal, string>;

/** 断られた答えの文。detail は相手の PC が添えた短い説明で、あれば末尾に足す。 */
export function refusalText(lang: Language, o: { device: string; reason: PeerLaunchRefusal; detail?: string }): string {
  const why = render(lang, msg(REFUSAL_KEY[o.reason]));
  const detail = o.detail ? ` (${oneLine(o.detail, 200)})` : '';
  return render(lang, msg('mcp.peer.refused', { device: oneLine(o.device, 80), reason: why + detail }));
}

/** 受け取られないまま期限が過ぎた頼みの文。 */
export function expiredText(lang: Language, o: { device: string }): string {
  return render(lang, msg('mcp.peer.expired', { device: oneLine(o.device, 80) }));
}

/** 呼び出し元が止まっているときに、未読と通知へ出す短い文。 */
export function heldNotice(lang: Language, o: { device: string; title: string | null }): string {
  const device = oneLine(o.device, 80);
  return o.title === null ? render(lang, msg('mcp.peer.notice.heldRefused', { device })) : render(lang, msg('mcp.peer.notice.held', { device, title: oneLine(o.title, 80) }));
}

/** 呼び出し元が消えているときに、利用者への通知へ出す短い文。reason はその報告の止まった理由の文。 */
export function goneNotice(lang: Language, o: { device: string; title: string | null; reason: string }): string {
  return render(lang, msg('mcp.peer.notice.gone', { device: oneLine(o.device, 80), title: o.title === null ? '' : oneLine(o.title, 80), reason: o.reason }));
}
