import { useCallback, useRef, useState, type KeyboardEvent, type PointerEvent, type ReactNode, type RefObject } from 'react';
import type { Intent } from '@agent-hangar/shared';
import { IntentBoundary, useEmit, type Handled } from '../intent/chain.tsx';

const clamp = (r: number) => (Number.isFinite(r) ? Math.max(0.2, Math.min(0.8, r)) : 0.5);

/** 仕切り。境界の内側なので、ここで出す split.resize は SplitPane が受けて止める。 */
function Divider(props: { hostRef: RefObject<HTMLDivElement | null>; ratio: number; onDrag: (dragging: boolean) => void }) {
  const emit = useEmit();
  const onPointerDown = (e: PointerEvent) => {
    e.preventDefault();
    const host = props.hostRef.current;
    if (!host) return;
    const rect = host.getBoundingClientRect();
    props.onDrag(true);
    const move = (ev: globalThis.PointerEvent) => emit({ type: 'split.resize', ratio: (ev.clientX - rect.left) / rect.width });
    const up = () => { props.onDrag(false); window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    e.preventDefault();
    emit({ type: 'split.resize', ratio: props.ratio + (e.key === 'ArrowLeft' ? -0.02 : 0.02) });
  };
  // いまの割合を読み上げに出す。丸めの範囲をそのまま min と max にするので、端に着いたことも分かる。
  const percent = Math.round(props.ratio * 100);
  return <div className="split-divider" role="separator" aria-label="分割の幅" aria-orientation="vertical"
    aria-valuenow={percent} aria-valuemin={20} aria-valuemax={80} aria-valuetext={`左 ${percent}%`}
    tabIndex={0} onPointerDown={onPointerDown} onKeyDown={onKeyDown} />;
}

/**
 * 2 つのペーンを横に並べる。
 * 幅の割合は中間層のここだけで持ち、Mediator には渡さない。
 * ドラッグ中に毎フレーム状態機械を回さないためである。
 * 幅は保存せず、開き直すと 0.5 に戻る。
 * 高さは親から受け取る。自分では決めない（.split-h は height: 100%）。
 */
export function SplitPane(props: { left: ReactNode; right: ReactNode }) {
  const [ratio, setRatio] = useState(0.5);
  const [dragging, setDragging] = useState(false);
  const hostRef = useRef<HTMLDivElement>(null);
  const handle = useCallback((intent: Intent): Handled => {
    if (intent.type !== 'split.resize') return { handled: false };
    setRatio(clamp(intent.ratio));
    return { handled: true };
  }, []);
  // 類名は split-h にする。
  // .split はフェーズ 2 の SessionScreen がターミナルとトランスクリプトの 2 列に使っている。
  const columns = `${Number(ratio.toFixed(4))}fr 6px ${Number((1 - ratio).toFixed(4))}fr`;
  return (
    <IntentBoundary handle={handle}>
      {/* 掴んでいる間は data-dragging を立てて transition を切る。
          実測で、150ms の transition を残したままだと指を動かしてから列が追いつくまで 150ms 遅れる。 */}
      <div className="split-h" data-testid="split" ref={hostRef} data-dragging={dragging ? 'true' : undefined} style={{ gridTemplateColumns: columns }}>
        <div className="split-pane">{props.left}</div>
        <Divider hostRef={hostRef} ratio={ratio} onDrag={setDragging} />
        <div className="split-pane">{props.right}</div>
      </div>
    </IntentBoundary>
  );
}
