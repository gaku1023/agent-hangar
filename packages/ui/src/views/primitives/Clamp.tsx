import type { ReactNode } from 'react';
import { useOpen } from '../transcriptOpen.tsx';
import { Icon } from './Icon.tsx';
import { useT } from './language.tsx';

/** 出力（コマンドの出力、コード、結果の文）を切る行数。 */
export const OUT_LINES = 12;
/** 返答と指示を切る高さ（px）と、その高さに収まる行数の見積もり。 */
export const MSG_MAX_PX = 320;
export const MSG_LINES = 15;
/** 切っても隠れるのがこれより少なければ切らない。「残り 1 行」のために畳ませない。 */
const SLACK = 3;

/** 本文の見た目の行数の見積もり。76 字で折り返すとみなす。 */
export function estimateLines(text: string, width = 76): number {
  let n = 0;
  for (const line of text.split('\n')) n += Math.max(1, Math.ceil(line.length / width));
  return n;
}

/**
 * 長い中身の畳み（F1）。入れ子のスクロールは作らず、高さで切って下端をぼかし、「全文を表示（残り N 行）」を置く。
 * 開くと面そのものが伸び、下に「畳む」を置く。
 * lines は中身の行数、shown は畳んだときに見せる行数。中身は children(open) が描く（畳んだときに行で切るのは呼ぶ側）。
 * height を付けると、行で切らずに CSS の高さで切る（Markdown のように行と高さが揃わない中身）。
 */
export function Clamp(props: { seq: number; part: string; lines: number; shown: number; tone?: 'surface' | 'term' | 'accent'; height?: boolean; children: (open: boolean) => ReactNode }) {
  const t = useT();
  const [open, setOpen] = useOpen(props.seq, props.part);
  if (props.lines <= props.shown + SLACK) return <>{props.children(true)}</>;
  const rest = props.lines - props.shown;
  return (
    <div className="clamp" data-tone={props.tone ?? 'surface'} data-clamped={open ? undefined : 'true'} data-height={props.height ? 'true' : undefined}>
      <div className="clamp-body">{props.children(open)}</div>
      <div className="clamp-more">
        <button type="button" className="btn btn-sm" onClick={(e) => { e.stopPropagation(); setOpen(!open); }}>
          <Icon name={open ? 'chevronUp' : 'chevronDown'} />{open ? t('primitives.clamp.collapse') : t('primitives.clamp.expand', { rest })}
        </button>
      </div>
    </div>
  );
}

/** 行で切った文字。畳んでいれば先頭の shown 行だけを返す。 */
export const headLines = (text: string, open: boolean, shown = OUT_LINES): string => (open ? text : text.split('\n').slice(0, shown).join('\n'));
