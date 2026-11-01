import { useRef } from 'react';
import { percentLabel } from '../../presenters/format.ts';
import { collapseOut, motionOn } from './motionKit.ts';
import { usePresence } from './usePresence.ts';
import { foldAt } from '../headerFold.ts';
import { useT } from './language.tsx';
import { RollingNumber } from './RollingNumber.tsx';
import { ReasonGlyph } from './StatusDot.tsx';

/**
 * Claude の利用上限の枠（5 時間と週）の使用率の棒。
 * 幅 48px、高さ 6px で、80% 以上は警告色にする。
 * short は棒の前に常に出す見出し（5 時間、週）で、label は読み上げの名前である。
 * resets は枠が戻る時刻の文で、updated は最終更新の文である。あればホバーの title に添える。
 * 棒はヘッダーが狭いときに畳む（headerFold.ts）。見出しと数字は残す。
 * limited は、その枠の使用制限でセッションが止まっているときのリセットの時刻（試作 stop-reason-proto の H2）。
 * そのときは砂時計を添えて棒を使用制限の色にし、% の代わりに時刻を出す。
 * present が偽になったら（5 時間の枠が無くなった）、横に畳んで外す（collapseOut）。畳む間は最後の値のまま出す。
 */
export function UsageGauge(live: { label: string; short?: string; percent: number | null; resets?: string | null; updated?: string | null; limited?: string | null; present?: boolean }) {
  const t = useT();
  const open = live.present ?? true;
  const last = useRef(live);
  if (open) last.current = live;
  const p = usePresence<HTMLSpanElement>(open, (el) => (motionOn(el) ? collapseOut(el, 'x') : null));
  if (!p.mounted) return null;
  const props = open ? live : last.current;
  const limited = props.limited ?? null;
  const pct = limited !== null ? 100 : props.percent === null ? 0 : Math.max(0, Math.min(100, props.percent));
  const title = limited !== null
    ? t('stop.header.gaugeTitle', { label: props.label, time: limited })
    : `${props.label} ${percentLabel(t, props.percent)}${props.resets ? t('header.gauge.resetsTitle', { time: props.resets }) : ''}${props.updated ? t('header.gauge.updatedTitle', { time: props.updated }) : ''}`;
  return (
    <span ref={p.ref} className="gauge" aria-hidden={p.leaving ? true : undefined} title={title} data-limit={limited !== null ? 'true' : undefined}>
      {limited !== null && <ReasonGlyph reason="limit" />}
      {props.short && <span className="gauge-key" aria-hidden="true">{props.short}</span>}
      <span className="gauge-bar" data-fold-at={foldAt('gauge-bars')} role="meter" aria-label={props.label} aria-valuenow={limited !== null ? 100 : props.percent ?? undefined} aria-valuemin={0} aria-valuemax={100}>
        <span className="gauge-fill" data-high={limited === null && pct >= 80 ? 'true' : undefined} style={{ width: `${pct}%` }} />
      </span>
      <span className="gauge-num mono">{limited !== null ? limited : <RollingNumber value={props.percent === null ? null : Math.round(props.percent)} suffix="%" />}</span>
    </span>
  );
}
