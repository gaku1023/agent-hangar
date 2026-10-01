import { formatRoute } from '@agent-hangar/shared';
import { useLayoutEffect, useRef, type ReactNode } from 'react';
import { useEmit } from '../intent/chain.tsx';
import type { ParentLink } from '../presenters/heading.ts';

/**
 * 頁の見出し。今いる場所はヘッダではなくここで示す（設計は docs/superpowers/specs/2026-10-01-page-heading-design.md）。
 * 上から、親へのリンクの行、見出しの行、下の線を置く。親の行は親が無くても空けて取り、どの頁でも見出しと線の高さを揃える。
 * lead は見出しの前（セッションの状態の点）、children は見出しの後ろ（件数、絞り込み、操作のボタン）に並ぶ。
 * hero はセッションの上段の印で、一覧の行からこの行へ広がる動き（runtime/present.ts）が探す。
 * 窓が狭くて見出しの行に入り切らないときは、ボタンの名前（.btn-label）を隠して印だけにする（fitRow）。
 */
export function PageHeading(props: { title: string; parent?: ParentLink | null; lead?: ReactNode; children?: ReactNode; titleClassName?: string; rowClassName?: string; hero?: string }) {
  const emit = useEmit();
  const parent = props.parent ?? null;
  const rowRef = useRef<HTMLDivElement>(null);
  // 並ぶボタンは画面の状態で増減するので、描くたびに測り直す。幅が変わったときは ResizeObserver で測り直す。
  useLayoutEffect(() => { if (rowRef.current) fitRow(rowRef.current); });
  useLayoutEffect(() => {
    const row = rowRef.current;
    if (!row || typeof ResizeObserver === 'undefined') return;
    // 見るのは横幅だけにする。縮めた結果で行の高さが変わっても、測り直しを繰り返さない。
    let last = -1;
    const ro = new ResizeObserver(() => { const w = row.clientWidth; if (w !== last) { last = w; fitRow(row); } });
    ro.observe(row);
    // 字形が届くと文字の幅が変わる。行の幅は変わらないので、ここで一度測り直す。
    let alive = true;
    void document.fonts?.ready.then(() => { if (alive) fitRow(row); });
    return () => { alive = false; ro.disconnect(); };
  }, []);
  return (
    <div className="page-head">
      <div className="page-parent">
        {parent && <><a href={formatRoute(parent.route)} title={parent.label} onClick={(e) => { e.preventDefault(); emit({ type: 'nav.go', to: parent.route }); }}>{parent.label}</a><span aria-hidden="true">›</span></>}
      </div>
      <div ref={rowRef} className={props.rowClassName ? `page-title-row ${props.rowClassName}` : 'page-title-row'} data-morph-hero={props.hero}>
        {props.lead}
        <h1 className={props.titleClassName ? `page-title ${props.titleClassName}` : 'page-title'} title={props.title}>{props.title}</h1>
        {props.children}
      </div>
    </div>
  );
}

/**
 * 見出しの行が入り切るかを測り、入り切らなければ data-compact を付ける。
 * 名前を出した形で一度測るので、広がったときにも名前が戻る。付け外しは同じ描画の中で済み、ちらつかない。
 * 縮めたボタンには名前を title で残す。読み上げの名前は隠した文字のまま変わらない。
 * ボタンが自分の title（セッション画面の主の操作の押せない理由など）を持つときは、それを消さずに名前の後ろへ添え、広がったら元に戻す。
 */
export function fitRow(row: HTMLElement): void {
  row.removeAttribute('data-compact');
  const compact = row.scrollWidth > row.clientWidth + 1;
  if (compact) row.setAttribute('data-compact', 'true');
  for (const label of row.querySelectorAll<HTMLElement>('.btn > .btn-label')) {
    const btn = label.parentElement!;
    // 今の title が前にここで書いた値と違えば、React が書き直した自分の title である。
    // 同じなら、自分の title は前に控えた値のままである。
    const now = btn.getAttribute('title') ?? '';
    const own = btn.dataset.fitTitle !== undefined && now === btn.dataset.fitTitle ? btn.dataset.fitOwn ?? '' : now;
    const name = label.textContent ?? '';
    const next = compact ? (own ? `${name}（${own}）` : name) : own;
    if (next) btn.setAttribute('title', next);
    else btn.removeAttribute('title');
    btn.dataset.fitOwn = own;
    btn.dataset.fitTitle = next;
  }
}
