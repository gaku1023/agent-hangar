import type { KeyboardEvent, PointerEvent } from 'react';
import { useEmit } from '../action/chain.tsx';
import { cleanOrchWidth, ORCH_WIDTH_DEFAULT, ORCH_WIDTH_MAX, ORCH_WIDTH_VIEWPORT, orchWidthCss } from '../mediator/orchestrator.ts';
import { beginLayoutMotion, endLayoutMotion } from './primitives/layoutMotion.ts';
import { useT } from './primitives/language.tsx';

const STEP = 16;

/** いまの窓で出せる一番広い幅。--orch-w の clamp と同じ式。 */
const cap = () => Math.max(ORCH_WIDTH_DEFAULT, Math.min(ORCH_WIDTH_MAX, window.innerWidth * ORCH_WIDTH_VIEWPORT));

/**
 * 統括の柱の左の縁。サイドバーの縁（SidebarGrip）と同じ作りで、掴んで左右に動かすと柱の幅が変わり、ダブルクリックで既定の幅に戻る。
 * 柱は右にあるので、左へ動かすと広がる。
 * ドラッグの途中は .shell の --orch-w を直に書き換え、状態機械は回さない。離したときに 1 回だけ orchestrator.width を出し、保存は中間層に任せる。
 * 掴んでいる間は .shell に data-orch-drag を立て、本文が動いている扱いにする（layoutMotion）。端末が毎フレーム寸法を合わせて tmux を描き直させないためで、離したら 1 度だけ合わせる。
 */
export function OrchestratorGrip(props: { width: number }) {
  const emit = useEmit();
  const t = useT();
  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const shell = e.currentTarget.closest<HTMLElement>('.shell');
    if (!shell) return;
    const x0 = e.clientX;
    // 窓の幅で頭打ちになっているときは、見えている幅から動かし始める。
    const w0 = Math.min(props.width, cap());
    let w = w0;
    shell.dataset.orchDrag = 'true';
    beginLayoutMotion(shell);
    const move = (ev: globalThis.PointerEvent) => {
      w = Math.round(Math.min(cap(), cleanOrchWidth(w0 - (ev.clientX - x0))));
      shell.style.setProperty('--orch-w', orchWidthCss(w));
      document.documentElement.style.setProperty('--orch-w', orchWidthCss(w));
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
      delete shell.dataset.orchDrag;
      // 動かさずに離したら、書き換えた値を元に戻す。React は style の値が変わらないので書き戻さない。
      if (w === w0) { shell.style.setProperty('--orch-w', orchWidthCss(props.width)); document.documentElement.style.setProperty('--orch-w', orchWidthCss(props.width)); }
      else emit({ type: 'orchestrator.width', width: w });
      endLayoutMotion(shell);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
  };
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    e.preventDefault();
    emit({ type: 'orchestrator.width', width: props.width + (e.key === 'ArrowLeft' ? STEP : -STEP) });
  };
  return <div className="orch-grip" role="separator" aria-orientation="vertical" aria-label={t('orchestratorPane.width.label')}
    aria-valuenow={props.width} aria-valuemin={ORCH_WIDTH_DEFAULT} aria-valuemax={ORCH_WIDTH_MAX} aria-valuetext={t('sidebar.width.valueText', { width: props.width })}
    title={t('sidebar.width.tip')} tabIndex={0} onPointerDown={onPointerDown} onKeyDown={onKeyDown}
    onDoubleClick={() => emit({ type: 'orchestrator.width', width: ORCH_WIDTH_DEFAULT })} />;
}
