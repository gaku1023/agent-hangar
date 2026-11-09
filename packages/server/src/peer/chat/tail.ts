import { createHash } from 'node:crypto';
import fs from 'node:fs';
import type { PeerChatAsk, PeerChatItem } from '@agent-hangar/shared';
import type { Db } from '../../db/open.ts';
import { splitLines } from '../../provider/claude-code/transcript/lines.ts';
import { DROPPED_LINE_TYPES, normalizeRecord, toolSummary } from '../../provider/claude-code/transcript/normalize.ts';

/**
 * Claude Code のトランスクリプト（jsonl）を、チャットの項目（PeerChatItem）に直して、after の後ろだけを返す。
 * 元の PC が長いポーリングで呼び、見る側の PC へ封をして返す。
 *
 * jsonl の読み方は provider/claude-code/transcript/normalize.ts の normalizeRecord に任せ、ここで新しい読み手は作らない。
 * ここがするのは、行の uuid を振ること、道具の呼び出しと結果を 1 項目にすること、見せないものを落とすこと、大きさを収めることの 4 つである。
 *
 * 見せるもの。
 * 利用者の文（user）を見せる。作業中に打って積んだ指示（queued_command）も含む。
 * Claude の返事の本文（assistant）を見せる。
 * 道具の呼び出しと結果（tool）を見せる。名前と主な引数の 1 行の要約と、成否だけを持つ。
 * 出ている許可と質問（permission、question）を見せる。トランスクリプトには出ないので、呼び出し側が渡す（PeerPendingAsk）。
 *
 * 見せないもの。thinking、meta、system、raw のブロック、サブエージェント（sidechain）の中身、要約の継続の行、ローカルコマンド。
 *
 * 項目の uuid。
 * 1 つの行から出る最初の項目は行の uuid、2 つ目からは `<uuid>:<番号>` にする。
 * 同じ uuid の行は二度読まない（再開で行が写されたときは、先に出たものだけを残す）。
 * 許可と質問の札の uuid は `<直前の項目の uuid>@ask:<askId>` である。
 * 札を受け取った見る側が after にそれを渡すと、札を繰り返さず、その前の項目の続きから返す。
 * 札が消えた後も、@ask: より前の部分で位置が分かるので、続きの項目を取り落とさない。
 *
 * 道具の途中。
 * 結果がまだ来ない道具の呼び出しは、成否が決まらないので、その呼び出しとその後ろの項目を出さない（結果が届いたら出る）。
 * 結果が来ないまま利用者の発言（user の行）が続いた呼び出しは、中断されたものとして ok: false で出す。
 *
 * 読み直しの省き。
 * 長いポーリングが同じ会話を続けて呼ぶので、読んだ結果を TailCache に覚える。
 * 鍵は経路、大きさ、更新時刻で、変わっていなければファイルを読まず、解析もしない。
 * 伸びたときは読み直す（途中からの解析はしない）。
 */

/** 返す項目の JSON の大きさの目安（バイト）。答えの封の上限（64 KiB）に、base64 と封筒の増え分を足しても収まる値。 */
export const PEER_CHAT_TAIL_BYTE_BUDGET = 40 * 1024;
/** 項目 1 つの本文の上限（UTF-8 のバイト）。これを超える本文は切って末尾に … を付ける。 */
export const PEER_CHAT_ITEM_TEXT_MAX_BYTES = 8 * 1024;
/** 札の input の上限（UTF-8 のバイト）。 */
export const PEER_CHAT_ASK_INPUT_MAX_BYTES = 2 * 1024;
/** 札の選択肢の数の上限。超える分は落とす。 */
export const PEER_CHAT_ASK_OPTIONS_MAX = 16;
/** 札の選択肢の label の上限（UTF-8 のバイト）。 */
export const PEER_CHAT_ASK_LABEL_MAX_BYTES = 256;
/** 札の選択肢の key の上限（UTF-8 のバイト）。 */
export const PEER_CHAT_ASK_KEY_MAX_BYTES = 32;
/** 覚えておく会話の数の上限。 */
export const PEER_CHAT_TAIL_CACHE_MAX = 8;
/** 道具の要約の上限（文字）。 */
export const PEER_CHAT_TOOL_SUMMARY_MAX = 160;
/** 既定の limit（transcript の項目の数）。 */
export const PEER_CHAT_TAIL_DEFAULT_LIMIT = 200;
/** 本文のファイルを読む大きさの上限。これより大きいファイルは末尾だけを読み、手前の項目は after からも届かない（truncated になる）。 */
export const PEER_CHAT_TAIL_READ_MAX_BYTES = 16 * 1024 * 1024;

/**
 * いま画面に出ている許可か質問。
 * 許可は SessionDto.permission（PermissionAskDto）と waitingFor から、質問は SessionActivityDto.question から、呼び出し側が作る。
 * options の label は、Claude Code が画面に出している選択肢の文そのままにする（T4 が label で画面の行を引く）。
 * key は選択肢ごとに一意で安定した文字列にする。空や重なりは、並びの番号（1 から）に直す。
 */
export type PeerPendingAsk = {
  kind: 'permission' | 'question';
  tool?: string;
  /** 許可のとき、命令やファイルの経路など、道具の入力の文字列。画面の札と突き合わせる。 */
  input?: string;
  /** 許可の説明（PermissionAskDto.description）。 */
  description?: string | null;
  /** 質問の文。 */
  question?: string | null;
  options: { key: string; label: string }[];
  multi: boolean;
  allowText: boolean;
  /** この PC が画面の札を照合して答えられないとき false（PeerChatAsk.answerable）。答えられるときは付けない。 */
  answerable?: false;
};

/**
 * 本文のファイルの手がかり。
 * key は経路、大きさ、更新時刻から作る文字列で、変わっていなければ中身も変わっていないとみなす。
 * read はその中身（全部、または末尾）を返す。末尾だけのときは、先頭が行の頭から始まること。
 * read は key が合わないとき（初めて、または変わったとき）だけ呼ばれる。
 */
export type TranscriptHandle = { key: string; read(): Buffer };

/** 解析の結果を会話ごとに覚える入れ物。PEER_CHAT_TAIL_CACHE_MAX 件までで、古い順に捨てる。 */
export type TailCache = Map<string, { key: string; scan: Scan }>;
export const createTailCache = (): TailCache => new Map();

export type TailDeps = {
  /** セッションの本文（jsonl）の手がかり。無ければ null。 */
  readTranscript(sessionId: string): TranscriptHandle | null;
  /** いま画面に出ている許可か質問。無ければ null。 */
  pendingAsk(sessionId: string): PeerPendingAsk | null;
  /** 渡せば、変わっていないファイルを読み直さない。渡さなければ毎回読む。 */
  cache?: TailCache;
};

export type TailResult = { items: PeerChatItem[]; cursor: string | null; truncated: boolean };

// ---- 本文の読み出し ----

/**
 * 索引（transcript_files）から、この PC にある本体の jsonl の手がかりを作る。
 * 他の端末から降ろした写し（device_id がある）とサブエージェントのファイル（agent_id がある）は使わない。
 * ファイルが PEER_CHAT_TAIL_READ_MAX_BYTES より大きければ末尾だけを読み、最初の改行までを捨てて行の頭に合わせる。
 * 手がかりを作るときに stat だけをして、中身は読まない。
 * copies を真にすると、他の端末から降ろした写しも使う（見る側の PC が、手元の写しの最後の uuid を知るのに使う）。
 * mtime が新しいものを選ぶ。
 */
export function dbTranscriptReader(db: Db, o: { copies?: boolean } = {}): (sessionId: string) => TranscriptHandle | null {
  const find = db.prepare(`select path from transcript_files where session_id = ? and agent_id is null${o.copies ? "" : " and device_id is null"} and agent = 'claude-code' order by mtime desc limit 1`);
  return (sessionId) => {
    const row = find.get(sessionId) as { path: string } | undefined;
    if (!row) return null;
    try {
      const st = fs.statSync(row.path);
      return { key: `${row.path}|${st.size}|${st.mtimeMs}`, read: () => readTail(row.path) };
    } catch { return null; }
  };
}

/** 実際の道具立て。索引からの読み出しと、解析の覚えを組む。pendingAsk は呼び出し側が渡す。 */
export function dbTailDeps(db: Db, pendingAsk: TailDeps['pendingAsk']): TailDeps {
  return { readTranscript: dbTranscriptReader(db), pendingAsk, cache: createTailCache() };
}

function readTail(file: string): Buffer {
  const size = fs.statSync(file).size;
  if (size <= PEER_CHAT_TAIL_READ_MAX_BYTES) return fs.readFileSync(file);
  const start = size - PEER_CHAT_TAIL_READ_MAX_BYTES;
  const buf = Buffer.alloc(PEER_CHAT_TAIL_READ_MAX_BYTES);
  const fd = fs.openSync(file, 'r');
  try { fs.readSync(fd, buf, 0, buf.length, start); } finally { fs.closeSync(fd); }
  const nl = buf.indexOf(10);
  return nl === -1 ? Buffer.alloc(0) : buf.subarray(nl + 1);
}

// ---- 行から項目へ ----

/** 項目 1 つ分の枠。道具の枠は、結果が来る（または中断が分かる）まで done が false である。 */
type Slot = { done: boolean; item: PeerChatItem; toolId: string; name: string };

const isRec = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** 文字列を UTF-8 で max バイトに収める。切ったら末尾に … を付ける。 */
function clipBytes(s: string, max: number): string {
  if (Buffer.byteLength(s) <= max) return s;
  const cut = Buffer.from(s).subarray(0, max - 3).toString('utf8').replace(/�+$/, '');
  return `${cut}…`;
}

function oneLine(s: string, max: number): string {
  const first = s.split(/\r?\n/, 1)[0] ?? '';
  return first.length > max ? `${first.slice(0, max - 1)}…` : first;
}

export type Scan = { slots: Slot[] };

/**
 * jsonl の全体を読み、項目の並び（道具は結果が来たものから先の順）にする。
 * 同じ uuid の行は、先の 1 行だけを読む。
 * 中断の判定（userSpoke）より前に落とすので、再開で写された利用者の行が、開いている道具を閉じることはない。
 */
function scan(buf: Buffer): Scan {
  const slots: Slot[] = [];
  const seenLines = new Set<string>();
  const open = new Map<string, Slot>();

  for (const l of splitLines(buf, 0).lines) {
    if (l.text.startsWith('{"type":"api-request')) continue;
    let raw: unknown;
    try { raw = JSON.parse(l.text); } catch { continue; }
    if (!isRec(raw)) continue;
    if (typeof raw.type === 'string' && DROPPED_LINE_TYPES.has(raw.type)) continue;
    if (raw.isSidechain === true || raw.isCompactSummary === true) continue;
    const uuid = typeof raw.uuid === 'string' ? raw.uuid : null;
    if (uuid === null || seenLines.has(uuid)) continue;
    seenLines.add(uuid);

    let k = 0;
    const nextUuid = (): string => (k++ === 0 ? uuid : `${uuid}:${k - 1}`);
    let userSpoke = false;
    for (const ev of normalizeRecord(raw, 0, null)) {
      const at = ev.ts ?? 0;
      if (ev.kind === 'user') {
        if (ev.text === '' || ev.text.trimStart().startsWith('[Request interrupted by user')) { if (raw.type === 'user') userSpoke = true; continue; }
        if (raw.type === 'user') userSpoke = true;
        const id = nextUuid();
        slots.push({ done: true, toolId: '', name: '', item: { uuid: id, at, kind: 'user', text: clipBytes(ev.text, PEER_CHAT_ITEM_TEXT_MAX_BYTES) } });
      } else if (ev.kind === 'assistant') {
        if (ev.text === '') continue;
        const id = nextUuid();
        slots.push({ done: true, toolId: '', name: '', item: { uuid: id, at, kind: 'assistant', text: clipBytes(ev.text, PEER_CHAT_ITEM_TEXT_MAX_BYTES) } });
      } else if (ev.kind === 'tool_call') {
        const id = nextUuid();
        const summary = oneLine(toolSummary(ev.name, ev.input), PEER_CHAT_TOOL_SUMMARY_MAX);
        const slot: Slot = { done: false, toolId: ev.toolId, name: ev.name, item: { uuid: id, at, kind: 'tool', text: summary, tool: { name: ev.name, summary, ok: true } } };
        slots.push(slot);
        if (ev.toolId) open.set(ev.toolId, slot);
      } else if (ev.kind === 'tool_result') {
        const slot = open.get(ev.toolId);
        if (!slot) continue;
        open.delete(ev.toolId);
        slot.item.tool!.ok = !ev.isError;
        slot.done = true;
      }
      // thinking、system、meta は出さない。
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
function settle(s: Scan): { items: PeerChatItem[]; waiting: Slot[] } {
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

// ---- 許可と質問の札 ----

/**
 * 札の askId。
 * sha256(JSON [kind, 拠り所, tool, 本文]) の先頭 24 桁（16 進）である。
 * 拠り所は、結果の来ていない道具の呼び出しのうち、ask.tool と名前が合う一番新しいものの tool_use の id（toolu_…）。
 * 本文は、許可なら input、質問なら問いの文。
 * 選択肢、説明、multi、allowText は含めない（画面から取った値の揺れで askId が変わらないようにする）。
 * 同じ許可なら何度呼んでも同じになる。
 * 命令が違えば変わり、同じ命令でも呼び出しが別（2 回目の確認）なら変わる。
 * 許可が出ている間にほかの行が増えても、道具の呼び出しは変わらないので、askId も変わらない。
 * 本文がまだ書かれる前（hook が先に届いた）は拠り所が無く '' になる。そのときの askId は、呼び出しが載った後に一度だけ変わる。
 */
export function peerAskId(ask: PeerPendingAsk, anchor: string): string {
  const body = ask.kind === 'question' ? ask.question ?? '' : ask.input ?? '';
  return createHash('sha256').update(JSON.stringify([ask.kind, anchor, ask.tool ?? '', body])).digest('hex').slice(0, 24);
}

/**
 * 選択肢を、数と長さを抑えたうえで、key を一意で空でないものに直す。
 * label は画面の文そのままで、上限を超えるときだけ切る。
 * 数は PEER_CHAT_ASK_OPTIONS_MAX までで、超える分は落とす。
 */
function normalizeOptions(options: { key: string; label: string }[]): { key: string; label: string }[] {
  const used = new Set<string>();
  return options.slice(0, PEER_CHAT_ASK_OPTIONS_MAX).map((o, i) => {
    const wanted = clipBytes(o.key, PEER_CHAT_ASK_KEY_MAX_BYTES);
    let key = wanted !== '' && !used.has(wanted) ? wanted : String(i + 1);
    for (let n = i + 1; used.has(key); n++) key = String(n + 1);
    used.add(key);
    return { key, label: clipBytes(o.label, PEER_CHAT_ASK_LABEL_MAX_BYTES) };
  });
}

function buildAsk(pending: PeerPendingAsk, waiting: { toolId: string; name: string }[]): PeerChatAsk {
  const anchor = [...waiting].reverse().find((w) => pending.tool !== undefined && w.name === pending.tool)?.toolId ?? '';
  const ask: PeerChatAsk = {
    askId: peerAskId(pending, anchor),
    kind: pending.kind,
    options: normalizeOptions(pending.options),
    multi: pending.multi,
    allowText: pending.allowText,
  };
  if (pending.tool !== undefined) ask.tool = pending.tool;
  if (pending.input !== undefined) ask.input = clipBytes(pending.input, PEER_CHAT_ASK_INPUT_MAX_BYTES);
  if (pending.answerable === false) ask.answerable = false;
  return ask;
}

const ASK_MARK = '@ask:';

function askItem(ask: PeerChatAsk, pending: PeerPendingAsk, base: string | null, at: number): PeerChatItem {
  const text = pending.kind === 'question' ? pending.question ?? '' : pending.description || pending.input || pending.tool || '';
  return { uuid: `${base ?? ''}${ASK_MARK}${ask.askId}`, at, kind: ask.kind, text: clipBytes(text, PEER_CHAT_ITEM_TEXT_MAX_BYTES), ask };
}

/**
 * いま出ている札（tail が最後の項目として出すものと同じ askId の ask）。無ければ null。
 * T4 が、画面の札と askId を突き合わせるのに使う。
 */
export function currentPendingAsk(sessionId: string, deps: TailDeps): PeerChatAsk | null {
  const pending = deps.pendingAsk(sessionId);
  if (!pending) return null;
  const { waiting } = settle(scanOf(sessionId, deps));
  return buildAsk(pending, waiting);
}

/**
 * 会話の解析の結果。deps.cache があり、手がかりの key が前と同じなら、読まず解析せずに前の結果を返す。
 * 覚えは PEER_CHAT_TAIL_CACHE_MAX 会話までで、一番長く使われていないものから捨てる。
 */
function scanOf(sessionId: string, deps: TailDeps): Scan {
  const handle = deps.readTranscript(sessionId);
  if (!handle) { deps.cache?.delete(sessionId); return { slots: [] }; }
  const cache = deps.cache;
  const hit = cache?.get(sessionId);
  if (cache && hit && hit.key === handle.key) {
    cache.delete(sessionId);
    cache.set(sessionId, hit);
    return hit.scan;
  }
  const result = scan(handle.read());
  if (cache) {
    cache.delete(sessionId);
    cache.set(sessionId, { key: handle.key, scan: result });
    while (cache.size > PEER_CHAT_TAIL_CACHE_MAX) cache.delete(cache.keys().next().value!);
  }
  return result;
}

// ---- 本体 ----

/**
 * after（見る側が最後に持っている uuid。null なら何も持っていない）の後ろの項目を返す。
 * limit は transcript の項目の数の上限で、札はそれとは別に最後へ足す。
 * after が見つからないか、後ろが limit を超えるときは、末尾 limit 件を返して truncated にする。
 * after が null のときは、全体が limit を超えるときだけ truncated にする。
 * cursor は返した最後の項目の uuid で、返す項目が無ければ after のまま。
 * 大きさが PEER_CHAT_TAIL_BYTE_BUDGET を超えるときは、古い項目から落として truncated にする（札は落とさない）。
 */
export function transcriptTail(sessionId: string, after: string | null, limit: number | undefined, deps: TailDeps): TailResult {
  const lim = Math.max(1, limit ?? PEER_CHAT_TAIL_DEFAULT_LIMIT);
  const { items: all, waiting } = settle(scanOf(sessionId, deps));
  const pending = deps.pendingAsk(sessionId);

  // after の位置。札の uuid は @ask: より前が transcript の位置である。
  const mark = after === null ? -1 : after.indexOf(ASK_MARK);
  const base = after === null ? null : mark === -1 ? after : after.slice(0, mark);
  let truncated = false;
  let rest: PeerChatItem[];
  if (after === null) {
    rest = all;
    if (rest.length > lim) { rest = rest.slice(-lim); truncated = true; }
  } else {
    // base が空なのは、札だけを受け取って transcript の項目がまだ無かったとき。先頭から返す。
    const idx = base === '' ? -2 : all.findIndex((i) => i.uuid === base);
    // 本文に 1 件も無いときは、落とした項目も無いので truncated にしない。
    if (idx === -1) { rest = all.slice(-lim); truncated = all.length > 0; }
    else {
      rest = all.slice(idx === -2 ? 0 : idx + 1);
      if (rest.length > lim) { rest = rest.slice(-lim); truncated = true; }
    }
  }

  const ask = pending ? buildAsk(pending, waiting) : null;
  const tailUuid = all.at(-1)?.uuid ?? null;
  const last = askItemOrNull(ask, pending, tailUuid, all.at(-1)?.at ?? 0);
  // 札を受け取った後の after には、同じ札を繰り返さない。
  const withAsk = last !== null && last.uuid !== after ? last : null;

  // 大きさの予算。札の分を先に引いて、新しい項目から詰め、入らなくなった古い項目を落とす。
  // 一番新しい項目は、大きくても残す（本文を縮めて収める）。
  const askSize = withAsk ? jsonSize(withAsk) + 1 : 0;
  let budget = PEER_CHAT_TAIL_BYTE_BUDGET - askSize;
  const kept: PeerChatItem[] = [];
  for (let i = rest.length - 1; i >= 0; i--) {
    const size = jsonSize(rest[i]!) + 1;
    if (size > budget && kept.length > 0) break;
    budget -= size;
    kept.push(rest[i]!);
  }
  kept.reverse();
  if (kept.length < rest.length) truncated = true;
  if (kept.length === 1 && budget < 0) kept[0] = shrink(kept[0]!, PEER_CHAT_TAIL_BYTE_BUDGET - askSize - 1);
  const items = withAsk ? [...kept, withAsk] : kept;
  const cursor = items.at(-1)?.uuid ?? after;
  return { items, cursor, truncated };
}

function askItemOrNull(ask: PeerChatAsk | null, pending: PeerPendingAsk | null, base: string | null, at: number): PeerChatItem | null {
  return ask && pending ? askItem(ask, pending, base, at) : null;
}

const jsonSize = (v: unknown): number => Buffer.byteLength(JSON.stringify(v));

/** 縮めるときの max の下限（バイト）。札が大きくて余りが少ないときも、max が負や 0 にならないようにする。 */
const SHRINK_MIN_MAX_BYTES = 1024;

/** 項目の JSON が max バイトに収まるまで本文を縮める。max は SHRINK_MIN_MAX_BYTES より小さくしない。 */
function shrink(item: PeerChatItem, max: number): PeerChatItem {
  const cap = Math.max(max, SHRINK_MIN_MAX_BYTES);
  let limit = Buffer.byteLength(item.text);
  let out = item;
  while (jsonSize(out) > cap && limit > 16) {
    limit = Math.floor(limit / 2);
    out = { ...item, text: clipBytes(item.text, limit) };
  }
  return out;
}
