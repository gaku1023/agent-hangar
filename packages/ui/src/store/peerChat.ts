import { peerAskInsertIndex } from '@agent-hangar/shared';
import type { PeerChatCard, PeerChatGone, PeerChatItem, PeerChatLink, PeerChatQueued, PeerChatReason, PeerChatState, PeerChatStatus, PeerChatTargetDto, PeerChatTurn, PeerChatUpdate } from '@agent-hangar/shared';

/**
 * ほかの PC の Claude Code の会話を、チャットの形で見ている 1 画面ぶんの状態。
 * 持ち主は Runtime（runtime/peerChat.ts）で、会話の項目は WebSocket の peerChat.update が運ぶ。
 * 同じ会話を複数の画面（分割のペイン）で開くと、1 つの状態を共有し、見ている人（viewers）を画面ごとに持つ。
 * 最後の人が閉じたら捨てる（開き直すと、元の PC からまた取る）。
 *
 * phase は、loading が最初の問い合わせの間、live が見ている間、fallback が見続けられなかったとき（読み取り専用のトランスクリプトに戻す）。
 * restore は、入力欄へ戻す文（預かりの取り消し、渡せなかった、送れなかった）。n が増えるたびに入力欄が取り込む。
 * notice は、入力欄のそばに出す一言（断りの理由）。
 */
export type PeerChatSlice = {
  /** この会話を見ている画面（見ている人の ID）。画面ごとに 1 つ。 */
  viewers: string[];
  phase: 'loading' | 'live' | 'fallback';
  fallback: PeerChatReason | null;
  device: PeerChatTargetDto | null;
  link: PeerChatLink;
  status: PeerChatStatus | null;
  /** 元の PC が送ってきた現在の札の材料。送ってこない（古い相手、止まった会話）ときは null で、画面は右の欄を出さない。 */
  card: PeerChatCard | null;
  items: PeerChatItem[];
  queued: PeerChatQueued[];
  cursor: string | null;
  sending: boolean;
  /** 答えを送って、結果を待っている札の askId。断られたら外す（札がまた押せるように）。 */
  answering: string[];
  /** 答えを送った札の、選んだ答えの文（askId から）。相手の返事を待たずに、札を答えた形で見せるために持つ。 */
  picked: Record<string, string>;
  /** 「中断して渡す」を送った預かりの queueId。断られたら外す。渡し終えた預かりは一覧から消えるので、残っても表示には出ない。 */
  rushing: string[];
  /** 元の PC が他の PC からの操作を受け付けない設定だと分かった。入力欄と札を閉じる（会話は読める）。 */
  locked: boolean;
  restore: { n: number; text: string; images: string[] } | null;
  notice: { n: number; reason: PeerChatReason | 'gone' | 'cancel-late' | 'rush-ask-open' | 'answer-timeout' } | null;
  /** 自分が預けた文（queueId から文へ）。渡せずに消えた知らせ（gone）で入力欄へ戻すために持つ。 */
  mine: Record<string, string>;
  /**
   * 上へ読み足した古い分（古い順）。items は末尾の窓で、tail の update と replace はそちらだけを書き換える。
   * 画面に出す本文は joinedItems（older の後ろに items、同じ uuid は重ねない）。
   */
  older: PeerChatItem[];
  /** さらに古い分が元の PC に残っているか。最初は分からないので true で、older の答えの more が偽になったら false。 */
  olderMore: boolean;
  loadingOlder: boolean;
  /** 元の PC が知らせた全ターンの数。null（古い相手）のときは目次を頼まない。 */
  turnCount: number | null;
  /** 目次の行（古い順）。turnsMore は、さらに古い行が残っていること。 */
  turns: PeerChatTurn[];
  turnsMore: boolean;
  /** 最初の目次の答えが済んだ（仮の行をやめる）。 */
  turnsLoaded: boolean;
  /** 最後に目次を頼んだときの turnCount。turnCount がこれと違えば頼み直す。 */
  turnsFor: number | null;
  loadingTurns: boolean;
  /** 本文のこの項目へ跳ぶ。n が増えるたびに本文が 1 度跳ぶ。 */
  jump: { uuid: string; n: number } | null;
  /** 目次の行を押して、その古い分を読み足している間の uuid。 */
  jumping: string | null;
};

/** 自分の預かりの控えの上限。古いものから捨てる。 */
const MINE_MAX = 20;

export function emptySlice(viewer: string): PeerChatSlice {
  return { viewers: [viewer], phase: 'loading', fallback: null, device: null, link: 'online', status: null, card: null, items: [], queued: [], cursor: null, sending: false, answering: [], picked: {}, rushing: [], locked: false, restore: null, notice: null, mine: {}, older: [], olderMore: true, loadingOlder: false, turnCount: null, turns: [], turnsMore: false, turnsLoaded: false, turnsFor: null, loadingTurns: false, jump: null, jumping: null };
}

/**
 * 項目を重ね書きする。同じ uuid は置き換え、札は askId が同じものも置き換え、新しいものは末尾に足す。
 * 初めて見る札は、札が呼んだ位置（直前の項目の直後）に入れる（答えの記録が、続きの返答のあとに届くことがある）。
 */
export function upsertItems(items: PeerChatItem[], incoming: PeerChatItem[]): PeerChatItem[] {
  const out = [...items];
  for (const it of incoming) {
    let at = out.findIndex((x) => x.uuid === it.uuid);
    if (at < 0 && it.ask) at = out.findIndex((x) => x.ask?.askId === it.ask!.askId);
    if (at >= 0) out[at] = it;
    else if (it.ask) out.splice(peerAskInsertIndex(out, it), 0, it);
    else out.push(it);
  }
  return out;
}

const nextN = (cur: { n: number } | null): number => (cur?.n ?? 0) + 1;

/** 渡せずに消えた預かり（自分のもの）の文を、入力欄へ戻す。同じ queueId は 1 度だけ戻す（控えから外すので）。 */
function applyGone(s: PeerChatSlice, gone: PeerChatGone[] | undefined): PeerChatSlice {
  if (!gone || gone.length === 0) return s;
  const mine = { ...s.mine };
  const texts: string[] = [];
  for (const g of gone) {
    const text = mine[g.queueId];
    if (text === undefined) continue;
    delete mine[g.queueId];
    texts.push(text);
  }
  if (texts.length === 0) return s;
  return { ...s, mine, restore: { n: nextN(s.restore), text: texts.join('\n'), images: [] }, notice: { n: nextN(s.notice), reason: 'gone' } };
}

/** 最初の問い合わせ（GET）の答え、または WebSocket の更新を重ねる。reason があれば見続けられないので fallback にする。 */
export function applyUpdate(s: PeerChatSlice, u: PeerChatUpdate): PeerChatSlice {
  if (u.reason) return { ...s, phase: 'fallback', fallback: u.reason, link: u.link };
  let { older, olderMore } = s;
  let incoming = u.items;
  // 読み足した古い分にある項目（札の答えなど）は、その場で置き換え、末尾の窓へは足さない。
  if (!u.replace && older.length > 0) {
    const inTail = new Set(s.items.map((i) => i.uuid));
    const inOlder = new Set(older.map((i) => i.uuid));
    const byId = new Map(incoming.filter((i) => inOlder.has(i.uuid) && !inTail.has(i.uuid)).map((i) => [i.uuid, i]));
    if (byId.size > 0) {
      older = older.map((i) => byId.get(i.uuid) ?? i);
      incoming = incoming.filter((i) => !byId.has(i.uuid));
    }
  }
  const items = u.replace ? [...u.items] : upsertItems(s.items, incoming);
  // 差し替えが、手元に読んだ分とつながる（重なる）ときは、重なる手前までを古い分に畳んで残す。つながらなければ継ぎ目に穴が空くので捨てる。
  if (u.replace && (older.length > 0 || s.items.length > 0)) {
    const now = new Set(items.map((i) => i.uuid));
    const known = joinedItems(s);
    const at = known.findIndex((i) => now.has(i.uuid));
    if (at >= 0) older = known.slice(0, at);
    else { older = []; olderMore = true; }
  }
  const next: PeerChatSlice = { ...s, phase: 'live', fallback: null, link: u.link, status: u.status ?? s.status, card: u.card ?? null, items, queued: u.queued, cursor: u.cursor ?? s.cursor, older, olderMore, turnCount: u.turnCount ?? s.turnCount };
  return applyGone(next, u.gone);
}

/** 操作の答えに付いてきた全体（send などの state）を重ねる。項目は重ね書き、状態と預かりは全体の値。 */
export function applyState(s: PeerChatSlice, st: PeerChatState): PeerChatSlice {
  return { ...s, status: st.status, card: st.card ?? null, items: upsertItems(s.items, st.items), queued: st.queued, cursor: st.cursor ?? s.cursor };
}

/** 自分の預かりの文を控える。 */
export function rememberMine(s: PeerChatSlice, queueId: string, text: string): PeerChatSlice {
  const mine = { ...s.mine, [queueId]: text };
  const keys = Object.keys(mine);
  for (const k of keys.slice(0, Math.max(0, keys.length - MINE_MAX))) delete mine[k];
  return { ...s, mine };
}

/** 入力欄へ文を戻す。 */
export function restoreText(s: PeerChatSlice, text: string, images: string[] = []): PeerChatSlice {
  return { ...s, restore: { n: nextN(s.restore), text, images } };
}

/** 入力欄のそばの一言を出す。 */
export function showNotice(s: PeerChatSlice, reason: PeerChatReason | 'gone' | 'cancel-late' | 'rush-ask-open' | 'answer-timeout'): PeerChatSlice {
  return { ...s, notice: { n: nextN(s.notice), reason } };
}

/** 一言を消す。 */
export function clearNotice(s: PeerChatSlice): PeerChatSlice {
  return s.notice === null ? s : { ...s, notice: null };
}

/** 画面に出す本文の項目（古い順）。読み足した古い分の後ろに末尾の窓を続け、同じ uuid は末尾の窓を採る。 */
export function joinedItems(s: PeerChatSlice): PeerChatItem[] {
  if (s.older.length === 0) return s.items;
  const tail = new Set(s.items.map((i) => i.uuid));
  return [...s.older.filter((i) => !tail.has(i.uuid)), ...s.items];
}

/** 古い分（古い順）を本文の頭に足す。すでにある項目は足さない。more は、さらに古い分が残っているか。 */
export function applyOlder(s: PeerChatSlice, items: PeerChatItem[], more: boolean): PeerChatSlice {
  const have = new Set(joinedItems(s).map((i) => i.uuid));
  const fresh = items.filter((i) => !have.has(i.uuid));
  return { ...s, older: [...fresh, ...s.older], olderMore: more, loadingOlder: false };
}

/**
 * 目次の答えを重ねる。before が無い頁は最新の側で、前に読んだ古い行と重なれば古い行を残してつなぎ、重ならなければ差し替える。
 * before がある頁は、その行より前の古い行で、頭に足す。
 */
export function applyTurns(s: PeerChatSlice, r: { rows: PeerChatTurn[]; total: number; more: boolean }, before: string | null): PeerChatSlice {
  const done = { loadingTurns: false, turnsLoaded: true };
  if (before !== null) {
    const have = new Set(s.turns.map((t) => t.uuid));
    return { ...s, ...done, turns: [...r.rows.filter((t) => !have.has(t.uuid)), ...s.turns], turnsMore: r.more };
  }
  const first = r.rows[0];
  const at = first ? s.turns.findIndex((t) => t.uuid === first.uuid) : -1;
  if (at >= 0) return { ...s, ...done, turns: [...s.turns.slice(0, at), ...r.rows] };
  return { ...s, ...done, turns: [...r.rows], turnsMore: r.more };
}
