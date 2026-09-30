import { MAX_JUMP_HEADS, promptHead, type TranscriptEvent } from '@agent-hangar/shared';

/**
 * ターンの目次。利用者が打った指示（とスラッシュコマンド）ごとに会話を区切る。
 * Claude Code の transcript の `{` `}` が止まる単位と揃えるので、左のターミナルをその指示へ跳ばすときの数え方にもなる。
 */
export type Turn = {
  /** 区切りになった行の seq。ターンの識別子にも使う。 */
  seq: number;
  /** このターンに入る行の seq の範囲（from 以上 to 未満）。 */
  from: number; to: number;
  ts: number | undefined;
  text: string;
  /** Claude Code の画面の指示の行と突き合わせる書き出し。 */
  head: string;
  tools: number;
};

const COMMAND = /<command-name>([^<]*)<\/command-name>/;
const ARGS = /<command-args>([^<]*)<\/command-args>/;

/** 区切りになる行なら、その指示の本文を返す。 */
function promptOf(e: TranscriptEvent): string | null {
  // 中断の知らせは user の行として残るが、Claude Code は指示として描かない。
  if (e.kind === 'user') return e.text.startsWith('[Request interrupted') ? null : e.text;
  if (e.kind === 'system') {
    const m = COMMAND.exec(e.text);
    if (!m) return null;
    const args = ARGS.exec(e.text)?.[1]?.trim();
    return args ? `${m[1]!.trim()} ${args}` : m[1]!.trim();
  }
  return null;
}

/** seq の昇順に並んだ行からターンを組む。最初の指示より前の行はどのターンにも入れない。 */
export function buildTurns(events: TranscriptEvent[]): Turn[] {
  const turns: Turn[] = [];
  for (const e of events) {
    const text = promptOf(e);
    if (text !== null) {
      const prev = turns[turns.length - 1];
      if (prev) prev.to = e.seq;
      turns.push({ seq: e.seq, from: e.seq, to: Infinity, ts: e.ts, text, head: promptHead(text), tools: 0 });
    } else if (e.kind === 'tool_call' && turns.length > 0) {
      turns[turns.length - 1]!.tools++;
    }
  }
  return turns;
}

/** 近い端の向こう側にも添える書き出しの数。着いた先で見えた指示を一覧に当てるための余白である。 */
const JUMP_MARGIN = 5;

export type JumpWindow = { heads: string[]; index: number; from: 'top' | 'bottom' };

/**
 * 跳ぶ要求に載せる書き出しの切り出し。1 キーごとに描き直しを待つので、近い端から数える。
 * 先頭から数えてよいのは、会話の最初の指示まで読み込んでいる（complete）ときだけである。
 * 送れる数を超えるときは null。
 */
export function jumpWindow(heads: string[], index: number, complete: boolean): JumpWindow | null {
  const n = heads.length;
  const fromTop = complete && index < n - index;
  if (fromTop) {
    const end = Math.min(n, index + JUMP_MARGIN + 1);
    return end <= MAX_JUMP_HEADS ? { heads: heads.slice(0, end), index, from: 'top' } : null;
  }
  const start = Math.max(0, index - JUMP_MARGIN);
  return n - start <= MAX_JUMP_HEADS ? { heads: heads.slice(start), index: index - start, from: 'bottom' } : null;
}
