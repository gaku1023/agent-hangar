import type { Translate } from '@agent-hangar/shared';
import type { TranscriptItem } from './session.ts';

type ToolItem = Extract<TranscriptItem, { kind: 'tool' }>;

/**
 * 本文の 1 行（仮想スクロールの単位）。
 * key は行の先頭の seq で、tools が真の行は続けて呼んだツールのまとめ（T1）である。
 */
export type TranscriptRow = { key: number; items: TranscriptItem[]; tools: boolean };

/**
 * 本文の行の並び（2026-10-16 の試作の T1）。
 * 続けて並ぶツールの呼び出し（間に利用者や Claude の文、思考、知らせが挟まらないもの）を 1 つの行にまとめる。
 * サブエージェントを起こした呼び出しは、畳んだままでも「見る」を押せるよう、まとめずに 1 つで置く。
 * group が偽（詳細表示）なら、1 件ずつの行にし、ツールの行も今までの形で描く。
 */
export function groupRows(items: TranscriptItem[], group: boolean): TranscriptRow[] {
  const rows: TranscriptRow[] = [];
  let open: TranscriptRow | null = null;
  for (const it of items) {
    if (!group || it.kind !== 'tool') { rows.push({ key: it.seq, items: [it], tools: false }); open = null; continue; }
    if (it.subagent) { rows.push({ key: it.seq, items: [it], tools: true }); open = null; continue; }
    if (open) { open.items.push(it); continue; }
    open = { key: it.seq, items: [it], tools: true };
    rows.push(open);
  }
  return rows;
}

/** 呼び出し 1 つの説明。Bash は Claude が付けた description（無ければコマンド）、ほかは畳んだ行の要約の文。 */
function describe(it: ToolItem): string {
  const h = it.view.head;
  if (it.name === 'Bash' && h.dim) return h.dim;
  return h.main || it.summary;
}

export type ToolGroupHead = { label: string; desc: string; when: string; failed: number; failedLabel: string | null };

/**
 * まとめの行の見出し。
 * 札は、同じツールなら「Bash ×5」、混ざれば「ツール ×5」、1 回だけなら名前だけ（×1 は出さない）。
 * 説明と時刻は最後の呼び出しのもので、失敗した呼び出しがあればその数を添える。
 */
export function toolGroupHead(items: ToolItem[], t: Translate): ToolGroupHead {
  const last = items[items.length - 1]!;
  const name = items[0]!.name;
  const label = items.length === 1 ? name : items.every((it) => it.name === name) ? t('transcript.toolGroup.same', { name, n: items.length }) : t('transcript.toolGroup.mixed', { n: items.length });
  const failed = items.filter((it) => it.view.step === 'fail').length;
  return { label, desc: describe(last), when: last.when, failed, failedLabel: failed > 0 ? t('transcript.toolGroup.failed', { n: failed }) : null };
}
