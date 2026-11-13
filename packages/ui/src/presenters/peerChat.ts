import type { PeerChatItem, PeerChatReason, PeerChatStatus, SessionDto } from '@agent-hangar/shared';
import type { Translate } from '@agent-hangar/shared';
import type { Store } from '../store/store.ts';
import { emptySlice, type PeerChatSlice } from '../store/peerChat.ts';
import { peerChatDeviceName } from './peerChatDevice.ts';

/**
 * ほかの PC の Claude Code の会話をチャットの形で見る画面（views/PeerChatPane.tsx）の描き分け。
 * 画面は state を読まず、ここで決めた値だけを描く。
 * 対象は、ほかの PC の Claude Code の会話だけである。Codex と opencode の会話、相手の hangar が古いとき、見続けられないときは null で、読み取り専用のトランスクリプトのまま。
 */

export type PeerChatRow =
  | { kind: 'user'; key: string; text: string; from: string | null }
  | { kind: 'assistant'; key: string; text: string; /** 読み上げている発言（統括の柱）。左に印を出す。 */ speaking?: boolean }
  | { kind: 'tool'; key: string; name: string; summary: string; ok: boolean }
  | { kind: 'system'; key: string; text: string }
  | { kind: 'ask'; key: string; askId: string; askKind: 'permission' | 'question'; title: string; input: string | null; options: { key: string; label: string }[]; multi: boolean; allowText: boolean; answered: string | null; /** 元の PC で答える札（この PC からは答えられない）。案内の文。答えられる札と、答えが付いた札は null。 */ hostOnly: string | null; /** 答えを送って結果を待っている。 */ pending: boolean; /** 受け付けない設定の PC。押せない。 */ locked: boolean }
  | { kind: 'queued'; key: string; queueId: string; text: string; images: number; tag: string; from: string | null; mine: boolean; delivering: boolean };

/** 送る口の形。send は今すぐ渡る、queue はターンが止まるまで預かる、resume は止まっている会話を再開して渡す、blocked は送れない。 */
export type PeerChatComposerKind = 'send' | 'queue' | 'resume' | 'blocked';

export type PeerChatView = {
  sessionId: string;
  device: string;
  status: PeerChatStatus | null;
  statusLabel: string;
  /** 状態の点の色の種類（StatusDot と同じ向き）。 */
  tone: 'busy' | 'idle' | 'waiting' | 'ended';
  loading: boolean;
  rows: PeerChatRow[];
  composer: {
    kind: PeerChatComposerKind;
    sendLabel: string;
    placeholder: string;
    hint: string | null;
    /** つながっていないときの 1 行（入力欄は閉じ、「この PC で再開」を並べる）。 */
    offline: string | null;
    canTakeOver: boolean;
    canInterrupt: boolean;
    sending: boolean;
  };
  restore: PeerChatSlice['restore'];
  /** 入力欄のそばの一言（断りの理由と、渡せなかったこと）。n は同じ一言をもう一度出すための印。 */
  notice: { n: number; text: string } | null;
};

/**
 * ほかの PC の Claude Code の会話か（ここで見張りを始めてよいか）。
 * ほかの PC で動いている（lock）、手元に本文が無い（remoteOnly）に加え、ほかの PC に手元より新しい続きがある会話（newerElsewhere。A → B → A で、B で止まっていて手元に古い写しが残る）も含める。
 */
export function isPeerChatCandidate(s: SessionDto | undefined): boolean {
  return !!s && s.provider === 'claude-code' && (s.lock !== null || s.remoteOnly || s.newerElsewhere === true);
}

const STATUS_KEY = { busy: 'peerChat.status.busy', idle: 'peerChat.status.idle', waiting: 'peerChat.status.waiting', stopped: 'peerChat.status.stopped' } as const;
const TONE = { busy: 'busy', idle: 'idle', waiting: 'waiting', stopped: 'ended' } as const;

const REFUSAL_KEY = {
  offline: 'peerChat.refusal.offline', 'refused-by-setting': 'peerChat.refusal.refusedBySetting', 'not-claude': 'peerChat.refusal.notClaude', 'session-unknown': 'peerChat.refusal.sessionUnknown',
  expired: 'peerChat.refusal.expired', 'already-answered': 'peerChat.refusal.alreadyAnswered', 'ask-mismatch': 'peerChat.refusal.askMismatch', 'resume-failed': 'peerChat.refusal.resumeFailed',
  'queue-expired': 'peerChat.refusal.queueExpired', 'too-large': 'peerChat.refusal.tooLarge', rate: 'peerChat.refusal.rate', 'host-error': 'peerChat.refusal.hostError', 'too-many': 'peerChat.refusal.tooMany',
} as const;

/** 断りの理由を、入力欄のそばに出す一言にする。知らない理由は「送れませんでした」。 */
export function refusalText(t: Translate, reason: PeerChatReason | 'gone' | 'cancel-late', device: string): string {
  if (reason === 'gone') return t('peerChat.notice.gone');
  if (reason === 'cancel-late') return t('peerChat.notice.cancelLate');
  const key = (REFUSAL_KEY as Record<string, (typeof REFUSAL_KEY)[keyof typeof REFUSAL_KEY]>)[reason];
  return key ? t(key, { device }) : t('peerChat.refusal.other');
}

/**
 * 許可の答えの文を、固定の語（許可、今後も許可、拒否）にする。
 * 元の PC は Claude Code が画面に出している選択肢の文（Yes、Yes, and don't ask again …、No）をそのまま返すので、その形で見分ける。
 * 合う形が無ければ null で、呼び手は元の文をそのまま引用する。
 */
export function permissionWord(t: Translate, label: string): string | null {
  const l = label.trim();
  if (/^yes\b.*\b(don.?t ask again|always)\b/i.test(l)) return t('peerChat.ask.wordAlways');
  if (/^yes$/i.test(l)) return t('peerChat.ask.wordAllow');
  if (/^no$/i.test(l)) return t('peerChat.ask.wordDeny');
  return null;
}

function answerLine(t: Translate, it: PeerChatItem): string | null {
  const a = it.ask?.answered;
  if (!a) return null;
  // 元の PC の手元で答えた札は、選んだ行が分からない（label が空）。
  if (a.label === '') return t('peerChat.ask.answeredHere', { device: a.by.deviceName });
  const word = it.ask!.kind === 'permission' ? permissionWord(t, a.label) : null;
  // 許可の文が決めた形に合うときは語で、合わないとき（と質問）は元の文を引用する。
  return word !== null ? t('peerChat.ask.answeredPermission', { device: a.by.deviceName, label: word }) : t('peerChat.ask.answeredQuestion', { device: a.by.deviceName, label: a.label });
}

/**
 * 答えの付かない札を閉じて見せるか（開いたまま残さない安全網）。
 * 元の PC が答えの記録を付けそこねても、入力待ちでなくなった、または後ろに項目が続いたら、答えを待つ札ではない。
 * 状態がまだ分からない間（status が null）は閉じない。
 */
function staleAsk(slice: PeerChatSlice, index: number): boolean {
  if (slice.status === null) return false;
  return slice.status !== 'waiting' || index < slice.items.length - 1;
}

function rowOf(t: Translate, it: PeerChatItem, slice: PeerChatSlice, index: number, device: string): PeerChatRow {
  if (it.ask) {
    const answered = answerLine(t, it) ?? (staleAsk(slice, index) ? t('peerChat.ask.closed') : null);
    return { kind: 'ask', key: `ask:${it.ask.askId}`, askId: it.ask.askId, askKind: it.ask.kind, title: t(it.ask.kind === 'permission' ? 'peerChat.ask.permission' : 'peerChat.ask.question'), input: it.ask.input ?? it.text ?? null, options: it.ask.options, multi: it.ask.multi, allowText: it.ask.allowText, answered, hostOnly: answered === null && it.ask.answerable === false ? t('peerChat.ask.hostOnly', { device }) : null, pending: slice.answering.includes(it.ask.askId), locked: slice.locked };
  }
  switch (it.kind) {
    case 'user': return { kind: 'user', key: it.uuid, text: it.text, from: it.from ? t('peerChat.log.sentFrom', { device: it.from.deviceName }) : null };
    case 'assistant': return { kind: 'assistant', key: it.uuid, text: it.text };
    case 'tool': return { kind: 'tool', key: it.uuid, name: it.tool?.name ?? '', summary: it.tool?.summary ?? it.text, ok: it.tool?.ok !== false };
    default: return { kind: 'system', key: it.uuid, text: it.text };
  }
}

/**
 * 画面の描き分けを決める。
 * 作業中と入力待ち（許可や質問に答えるまで）は、送った文を預かる（預ける）。アイドルはそのまま渡す（送る）。
 * 停止中は「{device} で再開して送る」で、再開してから渡す。
 * 接続が切れているときは入力欄を閉じて理由と「この PC で再開」を出す。元の PC の中の失敗（host-error）のときは入力欄は閉じ、再試行している旨だけを出す。
 */
export function presentPeerChat(store: Store, sessionId: string, t: Translate): PeerChatView | null {
  const s = store.sessions[sessionId];
  // 見張りの頼みが済む前も、読み込み中の殻を出す（読み取り専用の画面が 1 コマ見えてしまうのを避ける）。
  const slice = store.peerChat[sessionId] ?? emptySlice('');
  if (!isPeerChatCandidate(s) || slice.phase === 'fallback') return null;
  const device = peerChatDeviceName(store, s!, slice);
  const myId = store.device?.id ?? null;
  const status = slice.status;
  const rows: PeerChatRow[] = slice.items.map((it, i) => rowOf(t, it, slice, i, device));
  for (const q of slice.queued) {
    const mine = myId !== null && q.from.deviceId === myId;
    rows.push({ kind: 'queued', key: `queued:${q.queueId}`, queueId: q.queueId, text: q.text, images: q.images, tag: t(q.state === 'delivering' ? 'peerChat.queued.delivering' : 'peerChat.queued.tag'), from: mine ? null : t('peerChat.queued.from', { device: q.from.deviceName }), mine, delivering: q.state === 'delivering' });
  }
  const offline = slice.link === 'offline';
  const hostError = slice.link === 'host-error';
  const clockOff = slice.link === 'clock';
  const locked = slice.locked;
  const kind: PeerChatComposerKind = offline || hostError || clockOff || locked ? 'blocked' : status === 'stopped' ? 'resume' : status === 'busy' || status === 'waiting' ? 'queue' : 'send';
  const sendLabel = kind === 'resume' ? t('peerChat.composer.resume', { device }) : kind === 'queue' ? t('peerChat.composer.queue') : t('peerChat.composer.send');
  const hint = kind === 'queue' && slice.queued.length === 0 ? t(status === 'waiting' ? 'peerChat.composer.hintWaiting' : 'peerChat.composer.hintBusy') : kind === 'resume' ? t('peerChat.composer.hintStopped', { device }) : hostError ? t('peerChat.composer.hostError') : clockOff ? t('peerChat.composer.clock', { device }) : locked ? refusalText(t, 'refused-by-setting', device) : null;
  const statusLabel = offline ? t('peerChat.status.offline') : hostError ? t('peerChat.status.hostError') : clockOff ? t('peerChat.status.clock') : status ? t(STATUS_KEY[status]) : t('peerChat.log.loading');
  return {
    sessionId, device, status, statusLabel,
    tone: offline || hostError || clockOff || status === null ? 'ended' : TONE[status],
    loading: slice.phase === 'loading',
    rows,
    composer: {
      kind, sendLabel,
      placeholder: t(offline ? 'peerChat.composer.placeholderOffline' : 'peerChat.composer.placeholder', { device }),
      hint,
      offline: offline ? t('peerChat.composer.offline', { device }) : null,
      canTakeOver: offline && isPeerChatCandidate(s),
      // 札が出ている間（waiting）は、Escape が札の断りになり、元の PC が ask-mismatch で断る。止めるボタンは出さない。
      canInterrupt: !offline && !hostError && !clockOff && !locked && status === 'busy',
      sending: slice.sending,
    },
    restore: slice.restore,
    notice: slice.notice ? { n: slice.notice.n, text: refusalText(t, slice.notice.reason, device) } : null,
  };
}
