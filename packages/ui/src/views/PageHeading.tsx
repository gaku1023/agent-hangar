import { formatRoute } from '@agent-hangar/shared';
import type { ReactNode } from 'react';
import { useEmit } from '../intent/chain.tsx';
import type { ParentLink } from '../presenters/heading.ts';

/**
 * 頁の見出し。今いる場所はヘッダではなくここで示す（設計は docs/superpowers/specs/2026-10-01-page-heading-design.md）。
 * 上から、親へのリンクの行、見出しの行、下の線を置く。親の行は親が無くても空けて取り、どの頁でも見出しと線の高さを揃える。
 * lead は見出しの前（セッションの状態の点）、children は見出しの後ろ（件数、絞り込み、操作のボタン）に並ぶ。
 * hero はセッションの上段の印で、一覧の行からこの行へ広がる動き（runtime/present.ts）が探す。
 */
export function PageHeading(props: { title: string; parent?: ParentLink | null; lead?: ReactNode; children?: ReactNode; titleClassName?: string; rowClassName?: string; hero?: string }) {
  const emit = useEmit();
  const parent = props.parent ?? null;
  return (
    <div className="page-head">
      <div className="page-parent">
        {parent && <><a href={formatRoute(parent.route)} title={parent.label} onClick={(e) => { e.preventDefault(); emit({ type: 'nav.go', to: parent.route }); }}>{parent.label}</a><span aria-hidden="true">›</span></>}
      </div>
      <div className={props.rowClassName ? `page-title-row ${props.rowClassName}` : 'page-title-row'} data-morph-hero={props.hero}>
        {props.lead}
        <h1 className={props.titleClassName ? `page-title ${props.titleClassName}` : 'page-title'} title={props.title}>{props.title}</h1>
        {props.children}
      </div>
    </div>
  );
}
