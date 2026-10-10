import { useState, type KeyboardEvent } from 'react';
import type { PagerProps } from '../presenters/pager.ts';
import { isComposing } from './ime.ts';
import { useT } from './primitives/language.tsx';
import { Listbox } from './primitives/Listbox.tsx';

/** 件数は桁を区切る（タブの件数と同じ書き方）。 */
const fmt = (n: number) => n.toLocaleString('en-US');

/**
 * 並べるページの番号。両端と、いまのページの前後 1 つを残し、間は … で詰める。
 * 端の近くでは端から 4 つまでを続けて出し、… が 1 つだけを飛ばすことが無いようにする。
 */
export function pageButtons(page: number, count: number): (number | '…')[] {
  const keep = new Set([1, count, page - 1, page, page + 1]);
  if (page <= 3) for (const n of [2, 3, 4]) keep.add(n);
  if (page >= count - 2) for (const n of [count - 1, count - 2, count - 3]) keep.add(n);
  const nums = [...keep].filter((n) => n >= 1 && n <= count).sort((a, b) => a - b);
  const out: (number | '…')[] = [];
  nums.forEach((n, i) => {
    if (i > 0 && n - nums[i - 1]! > 1) out.push('…');
    out.push(n);
  });
  return out;
}

/**
 * 一覧の下に貼るページ送りの帯（A4）。左に範囲と全件、中ほどに番号、右にページの番号の入力と 1 ページの件数を置く。
 * label は何のページかを読み上げに添える語（「セッション」「最近」など）。
 */
export function Pager(props: { label: string; pager: PagerProps; onPage: (page: number) => void; onSize: (size: number) => void }) {
  const t = useT();
  const { page, pageCount, size, sizes, from, to, total } = props.pager;
  // 打っている途中の番号。ページが変わったら打ち直しは捨てる。
  const [draft, setDraft] = useState<{ page: number; text: string } | null>(null);
  const text = draft && draft.page === page ? draft.text : String(page);
  const go = (n: number) => { if (n >= 1 && n <= pageCount && n !== page) props.onPage(n); };
  const jump = () => {
    const n = Number.parseInt(text, 10);
    setDraft(null);
    if (Number.isFinite(n)) go(Math.min(Math.max(1, n), pageCount));
  };
  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key !== 'Enter' || isComposing(e)) return;
    e.preventDefault();
    jump();
  };
  return (
    <nav className="pager" aria-label={t('pager.nav.label', { label: props.label })}>
      <span className="pager-range num"><b>{`${fmt(from)}–${fmt(to)}`}</b> {t('pager.range.total', { total: fmt(total) })}</span>
      <span className="pager-nums">
        <button type="button" className="pager-btn" aria-label={t('pager.nav.prev')} disabled={page <= 1} onClick={() => go(page - 1)}>‹</button>
        {pageButtons(page, pageCount).map((n, i) => (n === '…'
          ? <span key={`gap${i}`} className="pager-gap" aria-hidden="true">…</span>
          : <button key={n} type="button" className="pager-btn" aria-label={t('pager.nav.page', { n })} aria-current={n === page ? 'page' : undefined} onClick={() => go(n)}>{n}</button>))}
        <button type="button" className="pager-btn" aria-label={t('pager.nav.next')} disabled={page >= pageCount} onClick={() => go(page + 1)}>›</button>
      </span>
      <label className="pager-jump">{t('pager.jump.label')}
        <input className="input" type="number" min={1} max={pageCount} aria-label={t('pager.jump.input')} value={text}
          onChange={(e) => setDraft({ page, text: e.target.value })} onKeyDown={onKeyDown} onBlur={() => setDraft(null)} />
        <span className="num">/ {fmt(pageCount)}</span>
      </label>
      <Listbox label={t('pager.size.label')} value={String(size)} options={sizes.map((n) => ({ value: String(n), label: t('pager.size.option', { n }) }))}
        onChange={(v) => props.onSize(Number(v))} faceClassName="listbox-face listbox-pill" align="end" />
    </nav>
  );
}
