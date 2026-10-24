import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useEmit } from '../action/chain.tsx';
import type { EditorMissingProps } from '../presenters/editor.ts';
import { Icon } from './primitives/Icon.tsx';
import { useT } from './primitives/language.tsx';
import { installLastPressed, lastPressed } from './primitives/lastPressed.ts';

installLastPressed();

/** 面の幅。ボタンの下に出し、窓からはみ出すときは内側へ寄せる。 */
const WIDTH = 300;
const GAP = 6;

/**
 * エディタが見つからないときの面（試作の 1-3 の B）。押したボタンのそばに出す。
 * 理由（見つからない、最後に見つけた場所）と次の手（設定でエディタを選ぶ、今回はほかのエディタで開く、再確認）を並べる。
 * 閉じたら、その回数（n）を覚えて出さない。もう一度断られたら n が進むので、また出す。
 */
export function EditorMissing(props: EditorMissingProps) {
  const emit = useEmit();
  const t = useT();
  const box = useRef<HTMLDivElement>(null);
  const [closed, setClosed] = useState(0);
  const [at, setAt] = useState<{ left: number; top: number } | null>(null);
  const open = closed !== props.n;
  useLayoutEffect(() => {
    if (!open) return;
    const r = lastPressed()?.getBoundingClientRect() ?? null;
    const vw = window.innerWidth;
    const left = r ? Math.max(8, Math.min(r.left, vw - WIDTH - 8)) : Math.max(8, (vw - WIDTH) / 2);
    setAt({ left, top: r ? r.bottom + GAP : 80 });
  }, [open, props.n]);
  useEffect(() => {
    if (!open) return;
    box.current?.querySelector<HTMLElement>('.menu-item')?.focus({ preventScroll: true });
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setClosed(props.n); };
    const onDown = (e: PointerEvent) => { if (box.current && e.target instanceof Node && !box.current.contains(e.target)) setClosed(props.n); };
    // 画面を移ったら（キーや戻るでも）閉じる。押したボタンはもう無いからである。
    const onMove = () => setClosed(props.n);
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('pointerdown', onDown, true);
    window.addEventListener('hashchange', onMove);
    return () => { window.removeEventListener('keydown', onKey, true); window.removeEventListener('pointerdown', onDown, true); window.removeEventListener('hashchange', onMove); };
  }, [open, props.n]);
  if (!open || !at) return null;
  return (
    <div ref={box} className="menu-pop editor-missing" role="dialog" aria-label={props.title} style={{ left: at.left, top: at.top, width: WIDTH }}>
      <div className="menu-head">
        <b className="editor-missing-title">{props.title}</b>
        {props.lastPath && <span>{t('editor.missing.lastPath', { path: props.lastPath })}</span>}
      </div>
      {props.choices.map((c) => (
        <button key={c.key} type="button" className="menu-item" onClick={() => { setClosed(props.n); emit(c.send); }}>
          <Icon name={c.icon} /><span className="menu-item-text">{c.label}</span>
        </button>
      ))}
    </div>
  );
}
