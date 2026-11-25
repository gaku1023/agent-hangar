import { contextGaugeOf, type ContextGauge } from './contextGauge.ts';
import { stopReasonOf, type PeerChatAsk, type PeerChatCard, type PeerChatItem, type PeerChatReason, type PeerChatStatus, type SessionDto, type TranscriptEvent } from '@agent-hangar/shared';
import type { Translate } from '@agent-hangar/shared';
import type { Store } from '../store/store.ts';
import { emptySlice, joinedItems, type PeerChatSlice } from '../store/peerChat.ts';
import type { TurnCount, TurnRowProps } from './session.ts';
import { asideOf, asideWord } from '../lib/aside.ts';
import { durationLabel } from './format.ts';
import { presentNowCard, type NowCardProps } from './live.ts';
import { peerChatDeviceName } from './peerChatDevice.ts';

/**
 * ほかの PC の Claude Code の会話をチャットの形で見る画面（views/PeerChatPane.tsx）の描き分け。
 * 画面は state を読まず、ここで決めた値だけを描く。
 * 対象は、ほかの PC の会話（Claude Code、Codex、opencode）である。相手の hangar が古いとき、見続けられないときは null で、読み取り専用のトランスクリプトのまま。
 */

/**
 * 許可と質問の札の部品（views/AskCard.tsx）が描く値。peer chat の列、本文の真上の帯、ホームの行で同じものを使う。
 * hostOnly は、この画面から答えられない札の案内の文（答えられる札と、答えが付いた札は null）。
 * secret は入力を伏せ字にし、答えの行に値を残さない。textKind・min・max は数の欄の確かめ。
 */
export type AskCardModel = {
  askId: string; askKind: 'permission' | 'question'; title: string; header: string | null; input: string | null;
  options: { key: string; label: string; description?: string }[]; multi: boolean; allowText: boolean;
  secret: boolean; textKind: 'number' | 'integer' | null; min: number | null; max: number | null;
  answered: string | null; hostOnly: string | null; /** 答えを送って結果を待っている。 */ pending: boolean; /** 受け付けない設定の PC。押せない。 */ locked: boolean;
};

export type PeerChatRow =
  | { kind: 'user'; key: string; text: string; from: string | null }
  | { kind: 'assistant'; key: string; text: string; /** 読み上げている発言（統括の柱）。左に印を出す。 */ speaking?: boolean }
  | { kind: 'tool'; key: string; name: string; summary: string; ok: boolean }
  // 続けて呼んだ 2 本以上のツールのまとめ（本文の画面の「ツール呼び出し N 回」と同じ）。key は先頭のツールの key のままにし、2 本目が来ても入る動きを出し直さない。
  | { kind: 'tools'; key: string; label: string; failed: string | null; items: { key: string; name: string; summary: string; ok: boolean }[] }
  | { kind: 'system'; key: string; text: string }
  | ({ kind: 'ask'; key: string } & AskCardModel)
  | { kind: 'queued'; key: string; queueId: string; text: string; images: number; tag: string; from: string | null; mine: boolean; delivering: boolean; rushing: boolean };

/** 送る口の形。send は今すぐ渡る、queue はターンが止まるまで預かる、resume は止まっている会話を再開して渡す、blocked は送れない。 */
export type PeerChatComposerKind = 'send' | 'queue' | 'resume' | 'blocked';

export type PeerChatView = {
  sessionId: string;
  device: string;
  status: PeerChatStatus | null;
  statusLabel: string;
  /** 今の context の量（状態の隣の label）。無ければ無し。 */
  ctx?: ContextGauge | null;
  /** 状態の点の色の種類（StatusDot と同じ向き）。 */
  tone: 'busy' | 'aside' | 'idle' | 'waiting' | 'ended';
  loading: boolean;
  rows: PeerChatRow[];
  /** さらに古い分が元の PC に残っている（本文の頭へ上スクロールで読み足す）。 */
  hasOlder: boolean;
  /** 古い分を読み足している間。 */
  loadingOlder: boolean;
  /** 目次の行を押して、本文のこの項目へ跳ぶ。n が増えるたびに 1 度跳ぶ。 */
  jump: { uuid: string; n: number } | null;
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
 * ほかの PC の会話か（Claude Code・Codex・opencode。相手が受けるかはサーバが決める。ここで見張りを始めてよいか）。
 * ほかの PC で動いている（lock）、手元に本文が無い（remoteOnly）に加え、ほかの PC に手元より新しい続きがある会話（newerElsewhere。A → B → A で、B で止まっていて手元に古い写しが残る）も含める。
 */
export function isPeerChatCandidate(s: SessionDto | undefined): boolean {
  return !!s && (s.lock !== null || s.remoteOnly || s.newerElsewhere === true);
}

const STATUS_KEY = { busy: 'peerChat.status.busy', idle: 'peerChat.status.idle', waiting: 'peerChat.status.waiting', stopped: 'peerChat.status.stopped' } as const;
const TONE = { busy: 'busy', idle: 'idle', waiting: 'waiting', stopped: 'ended' } as const;

const REFUSAL_KEY = {
  offline: 'peerChat.refusal.offline', 'refused-by-setting': 'peerChat.refusal.refusedBySetting', 'not-claude': 'peerChat.refusal.notClaude', 'session-unknown': 'peerChat.refusal.sessionUnknown',
  expired: 'peerChat.refusal.expired', 'already-answered': 'peerChat.refusal.alreadyAnswered', 'ask-mismatch': 'peerChat.refusal.askMismatch', 'resume-failed': 'peerChat.refusal.resumeFailed',
  'queue-expired': 'peerChat.refusal.queueExpired', 'too-large': 'peerChat.refusal.tooLarge', rate: 'peerChat.refusal.rate', 'host-error': 'peerChat.refusal.hostError', 'too-many': 'peerChat.refusal.tooMany',
  'account-unavailable': 'peerChat.refusal.accountUnavailable',
} as const;

/** 断りの理由を、入力欄のそばに出す一言にする。知らない理由は「送れませんでした」。 */
export function refusalText(t: Translate, reason: PeerChatReason | 'gone' | 'cancel-late' | 'rush-ask-open' | 'answer-timeout', device: string): string {
  if (reason === 'gone') return t('peerChat.notice.gone');
  if (reason === 'cancel-late') return t('peerChat.notice.cancelLate');
  if (reason === 'rush-ask-open') return t('peerChat.notice.rushAskOpen', { device });
  if (reason === 'answer-timeout') return t('peerChat.notice.answerTimeout', { device });
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

/**
 * 答えの記録の文。
 * 元の PC の手元で答えた札は、選んだ行が分からない（label が空）。
 * 伏せる入力は、値も選んだ行も出さない。
 * 許可の文が英数字で始まるときは、「で」との間に半角空白を置く（「Mac で 1 回だけ許可」）。
 */
export function answeredText(t: Translate, kind: 'permission' | 'question', secret: boolean, device: string, label: string): string {
  if (secret) return t('peerChat.ask.answeredSecret', { device });
  if (label === '') return t('peerChat.ask.answeredHere', { device });
  if (kind === 'permission') {
    // 画面の選択肢の文（Yes、No …）は固定の語にする。
    // Codex・opencode のように日本語の文で来る許可は、その文のまま「<PC> で<文>」にする。合わない英語の文は引用する。
    const word = permissionWord(t, label) ?? (/[^\x00-\x7f]/.test(label) ? label : null);
    if (word !== null) return t(/^[0-9A-Za-z]/.test(word) ? 'peerChat.ask.answeredPermissionAscii' : 'peerChat.ask.answeredPermission', { device, label: word });
  }
  return t('peerChat.ask.answeredQuestion', { device, label });
}

function answerLine(t: Translate, it: PeerChatItem, mine: { label: string; deviceName: string } | null): string | null {
  // この PC から送って、相手の返事を待っている札は、選んだ答えで答えた形に見せる。
  const a = it.ask?.answered ?? (mine ? { by: { deviceName: mine.deviceName }, label: mine.label } : null);
  if (!a) return null;
  return answeredText(t, it.ask!.kind, it.ask!.secret === true, a.by.deviceName, a.label);
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

/** MCP の道具の名前（mcp__server__tool）は、道具の名前だけにする。 */
const shortToolName = (name: string): string => name.replace(/^mcp__.+?__/, '');
/** 送られてくる要旨は頭に道具の名前を持つ（toolSummary）。名前は札に出すので、要旨からは外す。 */
const dropName = (summary: string, name: string): string => (summary === name ? '' : summary.startsWith(`${name} `) ? summary.slice(name.length + 1) : summary);

/** 続けて並ぶ 2 本以上のツールを 1 行にまとめる。間に文や札が挟まれば区切る。 */
function foldTools(rows: PeerChatRow[], t: Translate): PeerChatRow[] {
  const out: PeerChatRow[] = [];
  let run: Extract<PeerChatRow, { kind: 'tool' }>[] = [];
  const flush = () => {
    if (run.length === 1) out.push(run[0]!);
    else if (run.length > 1) {
      const failed = run.filter((r) => !r.ok).length;
      out.push({ kind: 'tools', key: run[0]!.key, label: t('transcript.toolGroup.count', { n: run.length }), failed: failed > 0 ? t('transcript.toolGroup.failed', { n: failed }) : null, items: run.map(({ key, name, summary, ok }) => ({ key, name, summary, ok })) });
    }
    run = [];
  };
  for (const r of rows) {
    if (r.kind === 'tool') { run.push(r); continue; }
    flush();
    out.push(r);
  }
  flush();
  return out;
}

/** 札の部品（views/AskCard.tsx）が描く値にする。peer chat の列と、この PC の札（本文の真上の帯、ホームの行）で共用する。 */
export function askModelOf(t: Translate, ask: PeerChatAsk, o: { text?: string | null; answered: string | null; hostOnly: string | null; pending: boolean; locked: boolean }): AskCardModel {
  return { askId: ask.askId, askKind: ask.kind, title: t(ask.kind === 'permission' ? 'peerChat.ask.permission' : 'peerChat.ask.question'), header: ask.header ?? null, input: ask.input ?? o.text ?? null, options: ask.options, multi: ask.multi, allowText: ask.allowText, secret: ask.secret === true, textKind: ask.textKind ?? null, min: ask.min ?? null, max: ask.max ?? null, answered: o.answered, hostOnly: o.hostOnly, pending: o.pending, locked: o.locked };
}

function rowOf(t: Translate,it: PeerChatItem, slice: PeerChatSlice, index: number, device: string, myName: string): PeerChatRow {
  if (it.ask) {
    const pick = slice.answering.includes(it.ask.askId) ? slice.picked[it.ask.askId] : undefined;
    const answered = answerLine(t, it, pick !== undefined ? { label: pick, deviceName: myName } : null) ?? (staleAsk(slice, index) ? t('peerChat.ask.closed') : null);
    return { kind: 'ask', key: `ask:${it.ask.askId}`, ...askModelOf(t, it.ask, { text: it.text, answered, hostOnly: answered === null && it.ask.answerable === false ? t('peerChat.ask.unanswerable', { device }) : null, pending: slice.answering.includes(it.ask.askId), locked: slice.locked }) };
  }
  switch (it.kind) {
    case 'user': return { kind: 'user', key: it.uuid, text: it.text, from: it.from ? t('peerChat.log.sentFrom', { device: it.from.deviceName }) : null };
    // 思考は返答と同じ形で出す（区別を付けない）。
    case 'thinking':
    case 'assistant': return { kind: 'assistant', key: it.uuid, text: it.text };
    case 'tool': {
      const name = it.tool?.name ?? '';
      return { kind: 'tool', key: it.uuid, name: shortToolName(name), summary: dropName(it.tool?.summary ?? it.text, name), ok: it.tool?.ok !== false };
    }
    default: return { kind: 'system', key: it.uuid, text: it.text };
  }
}

/**
 * 画面に出す状態。
 * この PC から札に答えて、相手の返事を待っている間は、答えたあとの状態（許可は実行中、拒否は入力待ち）に見せる。
 */
function statusOf(store: Store, sessionId: string, slice: PeerChatSlice): PeerChatStatus | null {
  const hold = store.peerAnswered[sessionId];
  return hold && slice.status === 'waiting' ? hold.live : slice.status;
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
  // この PC から札に答えて、相手の返事を待っている間は、答えたあとの状態（許可は実行中、拒否は入力待ち）に見せる。
  const status = statusOf(store, sessionId, slice);
  // 本体は入力を受け付けていて、裏だけが動いている（元の PC が札の材料で知らせる。status は busy のまま）。手元の会話と同じ「バックグラウンドで作業中」で見せ、預かりの案内は出さない。
  const aside = status === 'busy' && slice.card?.aside != null;
  const myName = store.device?.name ?? '';
  // 読み足した古い分を頭に足した本文。札の閉じ判定（staleAsk）も、この並びの中の位置で見る。
  const all = { ...slice, items: joinedItems(slice) };
  const rows: PeerChatRow[] = foldTools(all.items.map((it, i) => rowOf(t, it, all, i, device, myName)), t);
  for (const q of slice.queued) {
    const mine = myId !== null && q.from.deviceId === myId;
    const delivering = q.state === 'delivering';
    const rushing = !delivering && slice.rushing.includes(q.queueId);
    rows.push({ kind: 'queued', key: `queued:${q.queueId}`, queueId: q.queueId, text: q.text, images: q.images, tag: t(delivering ? 'peerChat.queued.delivering' : rushing ? 'peerChat.queued.rushing' : 'peerChat.queued.tag'), from: mine ? null : t('peerChat.queued.from', { device: q.from.deviceName }), mine, delivering, rushing });
  }
  const offline = slice.link === 'offline';
  const hostError = slice.link === 'host-error';
  const clockOff = slice.link === 'clock';
  const locked = slice.locked;
  const kind: PeerChatComposerKind = offline || hostError || clockOff || locked ? 'blocked' : status === 'stopped' ? 'resume' : (status === 'busy' && !aside) || status === 'waiting' ? 'queue' : 'send';
  const sendLabel = kind === 'resume' ? t('peerChat.composer.resume', { device }) : kind === 'queue' ? t('peerChat.composer.queue') : t('peerChat.composer.send');
  const hint = kind === 'queue' && slice.queued.length === 0 ? t(status === 'waiting' ? 'peerChat.composer.hintWaiting' : 'peerChat.composer.hintBusy') : kind === 'resume' ? t('peerChat.composer.hintStopped', { device }) : hostError ? t('peerChat.composer.hostError') : clockOff ? t('peerChat.composer.clock', { device }) : locked ? refusalText(t, 'refused-by-setting', device) : null;
  const statusLabel = offline ? t('peerChat.status.offline') : hostError ? t('peerChat.status.hostError') : clockOff ? t('peerChat.status.clock') : aside ? asideWord(t) : status ? t(STATUS_KEY[status]) : t('peerChat.log.loading');
  return {
    sessionId, device, status, statusLabel, ctx: contextGaugeOf(s!.stats, store.settings ?? {}),
    tone: offline || hostError || clockOff || status === null ? 'ended' : aside ? 'aside' : TONE[status],
    loading: slice.phase === 'loading',
    rows,
    hasOlder: slice.phase === 'live' && slice.olderMore && all.items.length > 0,
    loadingOlder: slice.loadingOlder,
    jump: slice.jump,
    composer: {
      kind, sendLabel,
      placeholder: t(offline ? 'peerChat.composer.placeholderOffline' : 'peerChat.composer.placeholder', { device }),
      hint,
      offline: offline ? t('peerChat.composer.offline', { device }) : null,
      canTakeOver: offline && isPeerChatCandidate(s),
      // 札が出ている間（waiting）は、Escape が札の断りになり、元の PC が ask-mismatch で断る。止めるボタンは出さない。
      canInterrupt: !offline && !hostError && !clockOff && !locked && status === 'busy' && !aside,
      sending: slice.sending,
    },
    restore: slice.restore,
    notice: slice.notice ? { n: slice.notice.n, text: refusalText(t, slice.notice.reason, device) } : null,
  };
}

/** 札の材料の行を、presentNowCard が読む形（TranscriptEvent）に戻す。 */
function cardEvents(c: PeerChatCard): TranscriptEvent[] {
  return c.events.map((e): TranscriptEvent => e.kind === 'user' ? { kind: 'user', seq: e.seq, ...(e.ts !== undefined ? { ts: e.ts } : {}), text: e.text }
    : e.kind === 'tool_call' ? { kind: 'tool_call', seq: e.seq, ...(e.ts !== undefined ? { ts: e.ts } : {}), toolId: e.toolId, name: e.name, input: e.input, summary: '' }
      : { kind: 'tool_result', seq: e.seq, ...(e.ts !== undefined ? { ts: e.ts } : {}), toolId: e.toolId, text: '', isError: e.isError });
}

/**
 * ほかの PC の会話の、右の欄の現在の札。
 * 元の PC が送った材料（slice.card）を、手元の会話と同じ presentNowCard に通して組む。
 * 材料が無い（古い相手、止まった会話、見続けられない）ときは null で、画面は右の欄を出さない。
 * アーティファクトは数だけを持つ（本文は元の PC のもの）。
 */
export function presentPeerCard(store: Store, sessionId: string, t: Translate, o: { now: number; clock: (ts: number) => string }): NowCardProps | null {
  const s = store.sessions[sessionId];
  const slice = store.peerChat[sessionId];
  if (!isPeerChatCandidate(s) || !slice || slice.phase === 'fallback' || !slice.card) return null;
  const live = statusOf(store, sessionId, slice);
  if (live === null || live === 'stopped') return null;
  const c = slice.card;
  const since = durationLabel(t, o.now - (s!.lastActivityAt ?? o.now));
  const card = presentNowCard({
    digest: c.digest, events: cardEvents(c), turnFrom: c.turnFrom, live, aside: asideOf(live, c.aside), activity: c.activity, now: o.now, viewingAgent: false, clock: o.clock,
    idleFor: since, waited: since, artifacts: [], droppedCalls: c.droppedCalls ?? 0,
    reason: stopReasonOf({ live, waitingFor: c.waitingFor, activity: c.activity, permission: c.permission, limit: c.limit }), permission: c.permission, limit: c.limit, waitingFor: c.waitingFor, liveHints: c.hints,
  }, t);
  return { ...card, artifacts: { count: c.artifacts, items: [] } };
}

/** ほかの PC の会話の右の欄の目次（手元の TurnIndex の入力）。 */
export type PeerToc = {
  rows: TurnRowProps[];
  /** 行の番号（seq）から、押したときに本文へ跳ぶ項目の uuid。 */
  uuids: Record<number, string>;
  /** さらに古い行が元の PC に残っている（さらに読む）。 */
  hasMore: boolean;
  /** さらに読む、または古い分を読み足している間。 */
  loading: boolean;
  /** 行を押して古い分を読み足している間の、その行。 */
  busySeq: number | null;
  count: TurnCount;
  /** 最初の答えが届く前（仮の行を出す）。 */
  pending: boolean;
};

/**
 * ほかの PC の会話の目次。元の PC の turns の行（uuid、at、1 行目、道具の数）を、手元の目次の行の形に写す。
 * 元の PC が全ターンの数（turnCount）を送ってこない（古い相手）ときと、見続けられないときは null で、目次を出さない。
 * 行の番号（seq）は時刻を使い、同じ時刻がぶつかったら 1 ずつずらす（行の入る動きの識別に使う）。
 */
export function presentPeerToc(store: Store, sessionId: string, t: Translate, o: { clock: (ts: number) => string }): PeerToc | null {
  void t;
  const s = store.sessions[sessionId];
  const slice = store.peerChat[sessionId];
  if (!isPeerChatCandidate(s) || !slice || slice.phase !== 'live' || slice.turnCount === null) return null;
  if (slice.turnsLoaded && slice.turns.length === 0) return null;
  const uuids: Record<number, string> = {};
  let prev = -Infinity;
  const rows: TurnRowProps[] = slice.turns.map((r) => {
    const seq = r.at > prev ? r.at : prev + 1;
    prev = seq;
    uuids[seq] = r.uuid;
    return { seq, when: o.clock(r.at), text: r.text, head: r.text, tools: r.tools, open: false, band: [] };
  });
  const busy = slice.jumping === null ? null : rows.find((r) => uuids[r.seq] === slice.jumping)?.seq ?? null;
  return { rows, uuids, hasMore: slice.turnsMore, loading: slice.loadingTurns || slice.jumping !== null, busySeq: busy, count: { n: slice.turnCount, plus: false }, pending: !slice.turnsLoaded };
}
