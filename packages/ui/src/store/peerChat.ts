import type { PeerChatGone, PeerChatItem, PeerChatLink, PeerChatQueued, PeerChatReason, PeerChatState, PeerChatStatus, PeerChatTargetDto, PeerChatUpdate } from '@agent-hangar/shared';

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
  items: PeerChatItem[];
  queued: PeerChatQueued[];
  cursor: string | null;
  sending: boolean;
  /** 答えを送って、結果を待っている札の askId。断られたら外す（札がまた押せるように）。 */
  answering: string[];
  /** 元の PC が他の PC からの操作を受け付けない設定だと分かった。入力欄と札を閉じる（会話は読める）。 */
  locked: boolean;
  restore: { n: number; text: string; images: string[] } | null;
  notice: { n: number; reason: PeerChatReason | 'gone' } | null;
  /** 自分が預けた文（queueId から文へ）。渡せずに消えた知らせ（gone）で入力欄へ戻すために持つ。 */
  mine: Record<string, string>;
};

/** 自分の預かりの控えの上限。古いものから捨てる。 */
const MINE_MAX = 20;

export function emptySlice(viewer: string): PeerChatSlice {
  return { viewers: [viewer], phase: 'loading', fallback: null, device: null, link: 'online', status: null, items: [], queued: [], cursor: null, sending: false, answering: [], locked: false, restore: null, notice: null, mine: {} };
}

/** 項目を重ね書きする。同じ uuid は置き換え、札は askId が同じものも置き換え、新しいものは末尾に足す。 */
export function upsertItems(items: PeerChatItem[], incoming: PeerChatItem[]): PeerChatItem[] {
  const out = [...items];
  for (const it of incoming) {
    let at = out.findIndex((x) => x.uuid === it.uuid);
    if (at < 0 && it.ask) at = out.findIndex((x) => x.ask?.askId === it.ask!.askId);
    if (at >= 0) out[at] = it;
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
  const items = u.replace ? [...u.items] : upsertItems(s.items, u.items);
  const next: PeerChatSlice = { ...s, phase: 'live', fallback: null, link: u.link, status: u.status ?? s.status, items, queued: u.queued, cursor: u.cursor ?? s.cursor };
  return applyGone(next, u.gone);
}

/** 操作の答えに付いてきた全体（send などの state）を重ねる。項目は重ね書き、状態と預かりは全体の値。 */
export function applyState(s: PeerChatSlice, st: PeerChatState): PeerChatSlice {
  return { ...s, status: st.status, items: upsertItems(s.items, st.items), queued: st.queued, cursor: st.cursor ?? s.cursor };
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
export function showNotice(s: PeerChatSlice, reason: PeerChatReason | 'gone'): PeerChatSlice {
  return { ...s, notice: { n: nextN(s.notice), reason } };
}

/** 一言を消す。 */
export function clearNotice(s: PeerChatSlice): PeerChatSlice {
  return s.notice === null ? s : { ...s, notice: null };
}
