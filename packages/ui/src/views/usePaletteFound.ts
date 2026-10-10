import { useEffect, useState } from 'react';
import type { SearchParamsDto } from '@agent-hangar/shared';
import type { PaletteFound } from '../presenters/palette.ts';

/** 打ち終えてから件数を引くまで待つ時間。打つたびに引かないための間である。 */
export const PALETTE_COUNT_DELAY_MS = 250;

/**
 * パレットの最後の行（ホームの欄へ渡す行）に添える件数を、少し待ってから引く。
 * 件数は、同じ語をホームの欄に打ったときに並ぶ行の数なので、欄と同じ条件（名前、要約、トランスクリプト、Archived を除く）で 1 件だけ引いて total を取る。
 * 画面の Store や Mediator には入れない。パレットの中だけで使う一時の値だからである。
 * 引けなかったときは件数を出さないだけで、失敗は知らせない（パレットの行き先は件数に依らない）。
 * 引いた語を持つので、語が変われば古い件数は使われない（presentPalette が語を突き合わせる）。
 */
export function usePaletteFound(search: (params: SearchParamsDto) => Promise<{ total: number }>, query: string, open: boolean): PaletteFound | null {
  const [found, setFound] = useState<PaletteFound | null>(null);
  const q = query.trim();
  // 閉じたら忘れる。開き直して同じ語を打ったときに、前の回の件数を出さないためである。
  useEffect(() => { if (!open) setFound(null); }, [open]);
  useEffect(() => {
    if (!open || q === '') return;
    let live = true;
    const timer = setTimeout(() => {
      search({ q, limit: 1, hideArchived: true }).then((r) => { if (live) setFound({ q, total: r.total }); }).catch(() => {});
    }, PALETTE_COUNT_DELAY_MS);
    return () => { live = false; clearTimeout(timer); };
  }, [open, q]);   // eslint-disable-line react-hooks/exhaustive-deps
  return found;
}
