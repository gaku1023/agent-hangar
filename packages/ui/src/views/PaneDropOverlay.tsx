import { useLayoutEffect, useRef } from 'react';
import { paneDrag, usePaneDrag, usePaneDragEnd, type Box } from './paneDrag.ts';
import { StatusDot } from './primitives/StatusDot.tsx';
import { useT } from './primitives/language.tsx';
import { landGhost, previewIn } from './primitives/splitMotion.ts';

const SIDE_KEY = { left: 'pane.drop.left', right: 'pane.drop.right', up: 'pane.drop.up', down: 'pane.drop.down' } as const;

/**
 * ドロップの予告の枠とドラッグの札。ドラッグの間だけ Root に 1 つずつ置き、位置と大きさは style（fixed の座標）で替える。
 * 予告の枠（.pane-drop-preview）は 1 つだけで、落とし先が替わっても作り直さない。辺から辺へは CSS の transition で滑る。
 * 最初の 1 回は左上から滑らせず、その場で拡大しながら出す（previewIn）。
 * 札は、落としたら入る場所へ吸い込まれ、やめたら元の行へ戻る（landGhost）。動きの間は、札と薄れる枠をこのまま描く。
 * 中央は、サイドバーからなら「ここで開く」（置き換え）、見出しからなら「位置を入れ替える」。自分の上は落とせない印（data-blocked）。
 */
export function PaneDropOverlay() {
  const t = useT();
  const drag = usePaneDrag();
  const end = usePaneDragEnd();
  const preview = useRef<HTMLDivElement>(null);
  const ghost = useRef<HTMLDivElement>(null);
  // 最後に見せた枠の座標。落とし先が無くなっても、薄れる間はこの場所に置く（左上へ飛ばさない）。
  const lastRect = useRef<Box | null>(null);
  const hit = drag?.hit ?? null;
  if (hit) lastRect.current = hit.rect;
  // 枠が無い状態から出たとき（ドラッグの最初と、ペインの外から戻ったとき）。
  const wasOn = useRef(false);
  useLayoutEffect(() => {
    if (hit && !wasOn.current && preview.current) previewIn(preview.current);
    wasOn.current = !!hit;
  }, [hit]);
  // 札の終わり。動きが終わったら札と枠を外す。
  useLayoutEffect(() => {
    if (!end) return;
    const el = ghost.current;
    if (!el) { paneDrag.landed(); return; }
    let alive = true;
    void landGhost(el, end.to, end.ok).then(() => { if (alive) paneDrag.landed(); });
    return () => { alive = false; };
  }, [end]);
  const shown = drag ?? end;
  if (!shown) { lastRect.current = null; return null; }
  const { source } = shown;
  const label = !hit ? '' : hit.blocked ? t('pane.drop.self') : hit.side === 'center' ? t(source.kind === 'pane' ? 'pane.drop.swap' : 'pane.drop.open') : t(SIDE_KEY[hit.side]);
  const rect = hit?.rect ?? lastRect.current;
  return (
    <>
      <div ref={preview} className="pane-drop-preview" data-pane-drop-preview="true" data-on={hit ? 'true' : undefined} data-side={hit?.side} data-replace={hit?.side === 'center' && !hit.blocked ? 'true' : undefined} data-blocked={hit?.blocked ? 'true' : undefined}
        style={rect ? { left: rect.left, top: rect.top, width: rect.width, height: rect.height } : undefined} aria-hidden="true">
        <span>{label}</span>
      </div>
      <div key={end ? 'end' : 'drag'} ref={ghost} className="pane-drop-ghost" data-pane-drop-ghost={source.kind} style={{ left: shown.x, top: shown.y }} aria-hidden="true">
        {source.kind === 'session' && <StatusDot status={source.live ?? null} />}{source.name}
      </div>
    </>
  );
}
