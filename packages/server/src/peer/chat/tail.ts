import { createHash } from 'node:crypto';
import type { PeerChatAsk, PeerChatAskStep, PeerChatItem, PeerChatOlder, PeerChatTurns } from '@agent-hangar/shared';
import {
  PEER_CHAT_ITEM_TEXT_MAX_BYTES,
  PEER_CHAT_TAIL_BYTE_BUDGET,
  buildScan,
  clipBytes,
  jsonSize,
  olderIn,
  onlyRepliesIn,
  positionIn,
  settle,
  shrink,
  turnsIn,
  type Scan,
} from './items.ts';
import { claudeTailSource, type TailSource, type TranscriptHandle } from './tailSource.ts';

// 本文の層は items.ts（TranscriptEvent の行 → 項目）と tailSource.ts（provider ごとの読み口）に分かれている。
// 呼び出し側が今までどおり tail.ts から取れるように、ここから再出する。
export { PEER_CHAT_ITEM_TEXT_MAX_BYTES, PEER_CHAT_TAIL_BYTE_BUDGET, PEER_CHAT_TOOL_SUMMARY_MAX, type Scan, type TailRow } from './items.ts';
export { PEER_CHAT_INDEX_READ_MAX_EVENTS, PEER_CHAT_TAIL_READ_MAX_BYTES, dbTranscriptReader, indexTailSource, routedTailSource, type TailSource, type TranscriptHandle } from './tailSource.ts';

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
 * 思考（thinking）の本文があるものは、返答と同じ流れに thinking の項目として出す（上限は返答と同じ）。本文が空のもの（署名だけ）は出さない。
 *
 * 見せないもの。meta、system、raw のブロック、サブエージェント（sidechain）の中身、要約の継続の行、ローカルコマンド。
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

/** 札の input の上限（UTF-8 のバイト）。 */
export const PEER_CHAT_ASK_INPUT_MAX_BYTES = 2 * 1024;
/** 札の選択肢の数の上限。超える分は落とす。 */
export const PEER_CHAT_ASK_OPTIONS_MAX = 16;
/** 札の選択肢の label の上限（UTF-8 のバイト）。 */
export const PEER_CHAT_ASK_LABEL_MAX_BYTES = 256;
/** 札の選択肢の説明（description）の上限（UTF-8 のバイト）。 */
export const PEER_CHAT_ASK_DESCRIPTION_MAX_BYTES = 512;
/** 札の選択肢の key の上限（UTF-8 のバイト）。 */
export const PEER_CHAT_ASK_KEY_MAX_BYTES = 32;
/** 覚えておく会話の数の上限。 */
export const PEER_CHAT_TAIL_CACHE_MAX = 8;
/** 既定の limit（transcript の項目の数）。 */
export const PEER_CHAT_TAIL_DEFAULT_LIMIT = 200;

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
  options: { key: string; label: string; description?: string }[];
  multi: boolean;
  allowText: boolean;
  /** この PC が画面の札を照合して答えられないとき false（PeerChatAsk.answerable）。答えられるときは付けない。 */
  answerable?: false;
  /** 問いが複数ある質問の、今のタブ（PeerChatAsk.step）。問いが 1 つの札は付けない。 */
  step?: PeerChatAskStep;
};

/** 解析の結果を会話ごとに覚える入れ物。PEER_CHAT_TAIL_CACHE_MAX 件までで、古い順に捨てる。 */
export type TailCache = Map<string, { key: string; scan: Scan }>;
export const createTailCache = (): TailCache => new Map();

export type TailDeps = {
  /** セッションの本文（jsonl）の手がかり。無ければ null。Claude Code の読み口（claudeTailSource）を作るのに使う。source があればそちらが先。 */
  readTranscript?(sessionId: string): TranscriptHandle | null;
  /** 本文の読み口。渡せば readTranscript より先に使う（codex、opencode の読み口はここから差す）。 */
  source?: TailSource;
  /** いま画面に出ている許可か質問。無ければ null。 */
  pendingAsk(sessionId: string): PeerPendingAsk | null;
  /** 渡せば、変わっていないファイルを読み直さない。渡さなければ毎回読む。 */
  cache?: TailCache;
};

export type TailResult = { items: PeerChatItem[]; cursor: string | null; truncated: boolean };

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
 * 問いが複数ある質問は、今のタブ（番号と、確認のタブか）も入れる。
 * 呼び出しは同じでも、タブが進めば別の札になり、答えた askId の記録とぶつからない。
 * 問いが 1 つの札は入れない（askId は今までと同じ）。
 */
export function peerAskId(ask: PeerPendingAsk, anchor: string): string {
  const body = ask.kind === 'question' ? ask.question ?? '' : ask.input ?? '';
  const parts: unknown[] = [ask.kind, anchor, ask.tool ?? '', body];
  if (ask.step) parts.push(ask.step.index, ask.step.submit === true);
  return createHash('sha256').update(JSON.stringify(parts)).digest('hex').slice(0, 24);
}

/**
 * 選択肢を、数と長さを抑えたうえで、key を一意で空でないものに直す。
 * label は画面の文そのままで、上限を超えるときだけ切る。
 * description は付いているものだけ PEER_CHAT_ASK_DESCRIPTION_MAX_BYTES で切って持つ（askId には入れない）。
 * 数は PEER_CHAT_ASK_OPTIONS_MAX までで、超える分は落とす。
 */
function normalizeOptions(options: { key: string; label: string; description?: string }[]): { key: string; label: string; description?: string }[] {
  const used = new Set<string>();
  return options.slice(0, PEER_CHAT_ASK_OPTIONS_MAX).map((o, i) => {
    const wanted = clipBytes(o.key, PEER_CHAT_ASK_KEY_MAX_BYTES);
    let key = wanted !== '' && !used.has(wanted) ? wanted : String(i + 1);
    for (let n = i + 1; used.has(key); n++) key = String(n + 1);
    used.add(key);
    const label = clipBytes(o.label, PEER_CHAT_ASK_LABEL_MAX_BYTES);
    return o.description ? { key, label, description: clipBytes(o.description, PEER_CHAT_ASK_DESCRIPTION_MAX_BYTES) } : { key, label };
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
  if (pending.step) ask.step = { ...pending.step };
  return ask;
}

const ASK_MARK = '@ask:';

function askItem(ask: PeerChatAsk, pending: PeerPendingAsk, base: string | null, at: number): PeerChatItem {
  const text = pending.kind === 'question' ? pending.question ?? '' : pending.description || pending.input || pending.tool || '';
  // 答えられない札（answerable が false）の uuid には ! を付ける。印が変わると uuid が変わり、同じ札でも after の続きとして流し直される（askId は変えない）。
  return { uuid: `${base ?? ''}${ASK_MARK}${ask.askId}${ask.answerable === false ? '!' : ''}`, at, kind: ask.kind, text: clipBytes(text, PEER_CHAT_ITEM_TEXT_MAX_BYTES), ask };
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
 * transcript の項目（札を除く）の中での uuid の位置。無ければ -1。
 * 答えの記録の札が呼んだ位置が、返した範囲から落ちたのか、transcript に最初から無いのかを分けるのに使う（解析は覚えを使う）。
 */
export function transcriptPosition(sessionId: string, uuid: string, deps: TailDeps): number {
  return positionIn(settle(scanOf(sessionId, deps)).items, uuid);
}

/**
 * transcript の項目（札を除く）で、from の後ろから to までが、返答の文（assistant）だけか。
 * どちらかが見つからないか、to が from より前なら false。
 * 札を呼ぶ前の一言が tool_use より先に載ると、札の直前の項目がずれる。その間に道具や発言が無ければ、同じ札の言い換えと見てよい。
 */
export function onlyRepliesBetween(sessionId: string, from: string, to: string, deps: TailDeps): boolean {
  return onlyRepliesIn(settle(scanOf(sessionId, deps)).items, from, to);
}

/**
 * 会話の解析の結果。deps.cache があり、手がかりの key が前と同じなら、読まず解析せずに前の結果を返す。
 * 覚えは PEER_CHAT_TAIL_CACHE_MAX 会話までで、一番長く使われていないものから捨てる。
 */
function scanOf(sessionId: string, deps: TailDeps): Scan {
  const source = sourceOf(deps);
  const key = source?.key(sessionId) ?? null;
  if (!source || key === null) { deps.cache?.delete(sessionId); return { slots: [] }; }
  const cache = deps.cache;
  const hit = cache?.get(sessionId);
  if (cache && hit && hit.key === key) {
    cache.delete(sessionId);
    cache.set(sessionId, hit);
    return hit.scan;
  }
  const result = buildScan(source.read(sessionId));
  if (cache) {
    cache.delete(sessionId);
    cache.set(sessionId, { key, scan: result });
    while (cache.size > PEER_CHAT_TAIL_CACHE_MAX) cache.delete(cache.keys().next().value!);
  }
  return result;
}

/** deps の読み口。source を優先し、無ければ readTranscript から Claude Code の読み口を作る。 */
function sourceOf(deps: TailDeps): TailSource | null {
  if (deps.source) return deps.source;
  return deps.readTranscript ? claudeTailSource(deps.readTranscript.bind(deps)) : null;
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

// ---- 古い分と目次 ----

/**
 * 古い分を読む（older の本体）。transcript の項目（札は含まない）の並びから、範囲を予算（PEER_CHAT_TAIL_BYTE_BUDGET）で切る。
 * from が無ければ before の前を、新しい側から詰める（before は含まない）。
 * from があれば from から前向きに、before の手前（null なら末尾）まで、古い側から詰める。
 * 項目は古い順で、範囲に入りきらない分が残れば more。知らない uuid や本文が無いときは空で more なし。
 * 最低 1 件は返す（大きくても本文を縮める）。
 */
export function transcriptOlder(sessionId: string, o: { before: string | null; from?: string }, deps: TailDeps): PeerChatOlder {
  return olderIn(settle(scanOf(sessionId, deps)).items, o);
}

/** 会話の全ターンの数（見る側の目次の頼み直しの合図。解析は覚えを使う）。 */
export function transcriptTurnCount(sessionId: string, deps: TailDeps): number {
  return settle(scanOf(sessionId, deps)).items.filter((i) => i.kind === 'user').length;
}

/**
 * 目次の行（turns の本体）。
 * before のターンより前だけを、新しい側から予算で詰めて古い順に返す。入りきらない古い行があれば more。
 * total は会話の全ターンの数で、before に関わらない。
 */
export function transcriptTurns(sessionId: string, o: { before?: string }, deps: TailDeps): PeerChatTurns {
  return turnsIn(settle(scanOf(sessionId, deps)).items, o);
}
