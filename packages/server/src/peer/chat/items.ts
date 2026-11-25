import { PEER_CHAT_TURN_TEXT_MAX_BYTES, utteranceHead, type PeerChatItem, type PeerChatOlder, type PeerChatTurn, type PeerChatTurns, type TranscriptEvent } from '@agent-hangar/shared';
import { toolSummary } from '../../provider/claude-code/transcript/normalize.ts';

/**
 * 本文の共通の層。
 * provider ごとの読み口（tailSource.ts の TailSource）が作る「id 付きの行」の並びから、項目（PeerChatItem）の並びを作る。
 * ここは provider を知らない。TranscriptEvent だけを見る。
 *
 * 項目の id（uuid）。
 * 1 つの行から出る最初の項目は行の id、2 つ目からは `<id>:<番号>`（番号は 1 から）にする。
 * 行の id は読み口が決める（Claude は jsonl の uuid、索引の読み口は `s<seq>`）。この作りは buildScan の中の 1 か所だけにある。
 *
 * 道具の途中。
 * 結果がまだ来ない道具の呼び出しは、成否が決まらないので、その呼び出しとその後ろの項目を出さない（settle）。
 * 結果が来ないまま利用者の発言の行（isUserLine）が続いた呼び出しは、中断されたものとして ok: false で出す。
 */

/** 返す項目の JSON の大きさの目安（バイト）。答えの封の上限（64 KiB）に、base64 と封筒の増え分を足しても収まる値。 */
export const PEER_CHAT_TAIL_BYTE_BUDGET = 40 * 1024;
/** 項目 1 つの本文の上限（UTF-8 のバイト）。これを超える本文は切って末尾に … を付ける。 */
export const PEER_CHAT_ITEM_TEXT_MAX_BYTES = 8 * 1024;
/** 道具の要約の上限（文字）。 */
export const PEER_CHAT_TOOL_SUMMARY_MAX = 160;

/**
 * 読み口が返す 1 行。
 * id は行を一意に指す文字列。events はその行から出る TranscriptEvent（順序どおり）。
 * isUserLine は、この行が利用者の発言の行か（真なら、結果の来ていない道具を中断として閉じる。events に user が無くてもよい）。
 */
export type TailRow = { id: string; isUserLine: boolean; events: TranscriptEvent[] };

/** 項目 1 つ分の枠。道具の枠は、結果が来る（または中断が分かる）まで done が false である。 */
export type Slot = { done: boolean; item: PeerChatItem; toolId: string; name: string };

export type Scan = { slots: Slot[] };

/** 文字列を UTF-8 で max バイトに収める。切ったら末尾に … を付ける。 */
export function clipBytes(s: string, max: number): string {
  if (Buffer.byteLength(s) <= max) return s;
  const cut = Buffer.from(s).subarray(0, max - 3).toString('utf8').replace(/�+$/, '');
  return `${cut}…`;
}

export function oneLine(s: string, max: number): string {
  const first = s.split(/\r?\n/, 1)[0] ?? '';
  return first.length > max ? `${first.slice(0, max - 1)}…` : first;
}

export const jsonSize = (v: unknown): number => Buffer.byteLength(JSON.stringify(v));

/**
 * 行の並びを、項目の枠の並び（道具は結果が来たものから先の順）にする。
 * 中断の判定（isUserLine）は行の単位で、行の中の事象を読み終えてから閉じる。
 */
export function buildScan(rows: Iterable<TailRow>): Scan {
  const slots: Slot[] = [];
  const open = new Map<string, Slot>();

  for (const row of rows) {
    let k = 0;
    const nextId = (): string => (k++ === 0 ? row.id : `${row.id}:${k - 1}`);
    let userSpoke = false;
    for (const ev of row.events) {
      const at = ev.ts ?? 0;
      if (ev.kind === 'user') {
        if (ev.text === '' || ev.text.trimStart().startsWith('[Request interrupted by user')) { if (row.isUserLine) userSpoke = true; continue; }
        if (row.isUserLine) userSpoke = true;
        slots.push({ done: true, toolId: '', name: '', item: { uuid: nextId(), at, kind: 'user', text: clipBytes(ev.text, PEER_CHAT_ITEM_TEXT_MAX_BYTES) } });
      } else if (ev.kind === 'assistant') {
        if (ev.text === '') continue;
        slots.push({ done: true, toolId: '', name: '', item: { uuid: nextId(), at, kind: 'assistant', text: clipBytes(ev.text, PEER_CHAT_ITEM_TEXT_MAX_BYTES) } });
      } else if (ev.kind === 'thinking') {
        if (ev.text.trim() === '') continue;
        slots.push({ done: true, toolId: '', name: '', item: { uuid: nextId(), at, kind: 'thinking', text: clipBytes(ev.text, PEER_CHAT_ITEM_TEXT_MAX_BYTES) } });
      } else if (ev.kind === 'tool_call') {
        const summary = oneLine(toolSummary(ev.name, ev.input), PEER_CHAT_TOOL_SUMMARY_MAX);
        const slot: Slot = { done: false, toolId: ev.toolId, name: ev.name, item: { uuid: nextId(), at, kind: 'tool', text: summary, tool: { name: ev.name, summary, ok: true } } };
        slots.push(slot);
        if (ev.toolId) open.set(ev.toolId, slot);
      } else if (ev.kind === 'tool_result') {
        const slot = open.get(ev.toolId);
        if (!slot) continue;
        open.delete(ev.toolId);
        slot.item.tool!.ok = !ev.isError;
        slot.done = true;
      }
      // system、meta は出さない。
    }
    // 結果が来ないまま利用者が続けた道具は、中断されたものとして閉じる。
    if (userSpoke) {
      for (const slot of open.values()) {
        slot.item.tool!.ok = false;
        slot.done = true;
      }
      open.clear();
    }
  }
  return { slots };
}

/** 結果の来ていない道具の呼び出しの手前までの項目と、その後ろで結果待ちの道具（札の拠り所を探すのに使う）。 */
export function settle(s: Scan): { items: PeerChatItem[]; waiting: Slot[] } {
  const items: PeerChatItem[] = [];
  let i = 0;
  for (; i < s.slots.length; i++) {
    const slot = s.slots[i]!;
    if (!slot.done) break;
    items.push(slot.item);
  }
  const waiting = s.slots.slice(i).filter((x) => !x.done);
  return { items, waiting };
}

/** 縮めるときの max の下限（バイト）。札が大きくて余りが少ないときも、max が負や 0 にならないようにする。 */
const SHRINK_MIN_MAX_BYTES = 1024;

/** 項目の JSON が max バイトに収まるまで本文を縮める。max は SHRINK_MIN_MAX_BYTES より小さくしない。 */
export function shrink(item: PeerChatItem, max: number): PeerChatItem {
  const cap = Math.max(max, SHRINK_MIN_MAX_BYTES);
  let limit = Buffer.byteLength(item.text);
  let out = item;
  while (jsonSize(out) > cap && limit > 16) {
    limit = Math.floor(limit / 2);
    out = { ...item, text: clipBytes(item.text, limit) };
  }
  return out;
}

// ---- 項目の並びの上で動くもの ----

/** 項目の並びの中での uuid の位置。無ければ -1。 */
export function positionIn(items: PeerChatItem[], uuid: string): number {
  if (uuid === '') return -1;
  return items.findIndex((i) => i.uuid === uuid);
}

/** from の後ろから to までが、返答の文（assistant、thinking）だけか。どちらかが見つからないか、to が from より前なら false。 */
export function onlyRepliesIn(items: PeerChatItem[], from: string, to: string): boolean {
  if (from === '' || to === '') return false;
  const i = items.findIndex((x) => x.uuid === from);
  const j = items.findIndex((x) => x.uuid === to);
  if (i === -1 || j <= i) return false;
  return items.slice(i + 1, j + 1).every((x) => x.kind === 'assistant' || x.kind === 'thinking');
}

/**
 * 古い分（older の本体）。範囲を予算（PEER_CHAT_TAIL_BYTE_BUDGET）で切る。
 * from が無ければ before の前を、新しい側から詰める（before は含まない）。
 * from があれば from から前向きに、before の手前（null なら末尾）まで、古い側から詰める。
 */
export function olderIn(all: PeerChatItem[], o: { before: string | null; from?: string }): PeerChatOlder {
  const empty: PeerChatOlder = { items: [], more: false };
  let start = 0;
  if (o.from !== undefined) {
    start = all.findIndex((i) => i.uuid === o.from);
    if (start === -1) return empty;
  }
  let end = all.length;
  if (o.before !== null) {
    end = all.findIndex((i) => i.uuid === o.before);
    if (end === -1) return empty;
  }
  const range = all.slice(start, Math.max(start, end));
  if (range.length === 0) return empty;
  let budget = PEER_CHAT_TAIL_BYTE_BUDGET;
  const kept: PeerChatItem[] = [];
  const forward = o.from !== undefined;
  for (let k = 0; k < range.length; k++) {
    const it = forward ? range[k]! : range[range.length - 1 - k]!;
    const size = jsonSize(it) + 1;
    if (size > budget && kept.length > 0) break;
    budget -= size;
    kept.push(it);
  }
  if (!forward) kept.reverse();
  if (kept.length === 1 && budget < 0) kept[0] = shrink(kept[0]!, PEER_CHAT_TAIL_BYTE_BUDGET - 1);
  return { items: kept, more: kept.length < range.length };
}

/** 目次の行の元。利用者の指示の項目ごとに、次の指示までの道具の数を数える。 */
export function turnRowsIn(items: PeerChatItem[]): PeerChatTurn[] {
  const rows: PeerChatTurn[] = [];
  for (const it of items) {
    if (it.kind === 'user') rows.push({ uuid: it.uuid, at: it.at, text: clipBytes(oneLine(utteranceHead(it.text), PEER_CHAT_TURN_TEXT_MAX_BYTES), PEER_CHAT_TURN_TEXT_MAX_BYTES), tools: 0 });
    else if (it.kind === 'tool' && rows.length > 0) rows[rows.length - 1]!.tools++;
  }
  return rows;
}

/** 目次（turns の本体）。before のターンより前だけを、新しい側から予算で詰めて古い順に返す。total は全ターンの数。 */
export function turnsIn(items: PeerChatItem[], o: { before?: string }): PeerChatTurns {
  const all = turnRowsIn(items);
  let end = all.length;
  if (o.before !== undefined) {
    const i = all.findIndex((r) => r.uuid === o.before);
    if (i !== -1) end = i;
  }
  let budget = PEER_CHAT_TAIL_BYTE_BUDGET;
  const kept: PeerChatTurn[] = [];
  for (let i = end - 1; i >= 0; i--) {
    const size = jsonSize(all[i]) + 1;
    if (size > budget) break;
    budget -= size;
    kept.push(all[i]!);
  }
  kept.reverse();
  return { rows: kept, total: all.length, more: kept.length < end };
}
