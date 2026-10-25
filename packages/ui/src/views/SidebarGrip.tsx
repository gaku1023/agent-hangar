import type { KeyboardEvent, PointerEvent } from 'react';
import { useEmit } from '../action/chain.tsx';
import { cleanSidebarWidth, SIDEBAR_WIDTH_DEFAULT, SIDEBAR_WIDTH_MAX, SIDEBAR_WIDTH_VIEWPORT, sidebarWidthCss } from '../mediator/sidebar.ts';
import { beginLayoutMotion, endLayoutMotion } from './primitives/layoutMotion.ts';
import { useT } from './primitives/language.tsx';

const STEP = 16;

/** いまの窓で出せる一番広い幅。--sidebar-w の clamp と同じ式。 */
const cap = () => Math.max(SIDEBAR_WIDTH_DEFAULT, Math.min(SIDEBAR_WIDTH_MAX, window.innerWidth * SIDEBAR_WIDTH_VIEWPORT));

/**
 * サイドバーの右の縁。掴んで左右に動かすと幅が変わり、ダブルクリックで既定の幅に戻る。
 * ドラッグの途中は .shell の --sidebar-w を直に書き換え、状態機械は回さない（SplitPane と同じ理由）。
 * 離したときに 1 回だけ sidebar.width を出し、保存は中間層に任せる。
 * 掴んでいる間は .shell に data-sidebar-drag を立て、離して幅を出すときは data-sidebar-dropped を立てる。Shell はこれを見て、幅の変わり目を動かさない。
 * 掴んでいる間は本文が動いている扱いにする（layoutMotion）。端末が毎フレーム寸法を合わせて tmux を描き直させないためである。
 */
export function SidebarGrip(props: { width: number }) {
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
    shell.dataset.sidebarDrag = 'true';
    beginLayoutMotion(shell);
    const move = (ev: globalThis.PointerEvent) => {
      w = Math.round(Math.min(cap(), cleanSidebarWidth(w0 + ev.clientX - x0)));
      shell.style.setProperty('--sidebar-w', sidebarWidthCss(w));
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
      delete shell.dataset.sidebarDrag;
      // 動かさずに離したら、書き換えた値を元に戻す。React は style の値が変わらないので書き戻さない。
      if (w === w0) shell.style.setProperty('--sidebar-w', sidebarWidthCss(props.width));
      else { shell.dataset.sidebarDropped = 'true'; emit({ type: 'sidebar.width', width: w }); }
      endLayoutMotion(shell);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
  };
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    e.preventDefault();
    emit({ type: 'sidebar.width', width: props.width + (e.key === 'ArrowLeft' ? -STEP : STEP) });
  };
  return <div className="sidebar-grip" role="separator" aria-orientation="vertical" aria-controls="sidebar" aria-label={t('sidebar.width.label')}
    aria-valuenow={props.width} aria-valuemin={SIDEBAR_WIDTH_DEFAULT} aria-valuemax={SIDEBAR_WIDTH_MAX} aria-valuetext={t('sidebar.width.valueText', { width: props.width })}
    title={t('sidebar.width.tip')} tabIndex={0} onPointerDown={onPointerDown} onKeyDown={onKeyDown}
    onDoubleClick={() => emit({ type: 'sidebar.width', width: SIDEBAR_WIDTH_DEFAULT })} />;
}
