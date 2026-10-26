import { StatusDot } from './primitives/StatusDot.tsx';
import { useT } from './primitives/language.tsx';
import { usePaneDrag } from './paneDrag.ts';

const SIDE_KEY = { left: 'pane.drop.left', right: 'pane.drop.right', up: 'pane.drop.up', down: 'pane.drop.down' } as const;

/**
 * ドロップの予告の枠とドラッグの札。ドラッグの間だけ Root に 1 つずつ置き、位置と大きさは style（fixed の座標）で替える。
 * 予告の枠（.pane-drop-preview）は 1 つだけで、落とし先が替わっても作り直さない（T5 が left、top、width、height に transition を足す）。
 * 中央は、サイドバーからなら「ここで開く」（置き換え）、見出しからなら「位置を入れ替える」。自分の上は落とせない印（data-blocked）。
 */
export function PaneDropOverlay() {
  const t = useT();
  const drag = usePaneDrag();
  if (!drag) return null;
  const { source, hit } = drag;
  const label = !hit ? '' : hit.blocked ? t('pane.drop.self') : hit.side === 'center' ? t(source.kind === 'pane' ? 'pane.drop.swap' : 'pane.drop.open') : t(SIDE_KEY[hit.side]);
  return (
    <>
      <div className="pane-drop-preview" data-pane-drop-preview="true" data-on={hit ? 'true' : undefined} data-side={hit?.side} data-replace={hit?.side === 'center' && !hit.blocked ? 'true' : undefined} data-blocked={hit?.blocked ? 'true' : undefined}
        style={hit ? { left: hit.rect.left, top: hit.rect.top, width: hit.rect.width, height: hit.rect.height } : undefined} aria-hidden="true">
        <span>{label}</span>
      </div>
      <div className="pane-drop-ghost" data-pane-drop-ghost={source.kind} style={{ left: drag.x, top: drag.y }} aria-hidden="true">
        {source.kind === 'session' && <StatusDot status={source.live ?? null} />}{source.name}
      </div>
    </>
  );
}
