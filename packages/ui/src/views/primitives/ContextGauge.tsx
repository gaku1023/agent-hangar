import type { CSSProperties } from 'react';
import type { ContextGauge } from '../../presenters/contextGauge.ts';

/**
 * サイドバーの行の、状態の点のまわりの輪（試作の案 C）。
 * 満ち具合は --p（0 から 100 の数、base.css の @property で登録）、色は data-level で決める。乗せると title で label が出る。
 */
export function ContextRing(props: { gauge: ContextGauge }) {
  const g = props.gauge;
  return <span className="ctx-ring" data-level={g.level} title={g.label} style={{ '--p': Math.round(g.fraction * 1000) / 10 } as CSSProperties} />;
}

/** 状態の行の右端の label（試作の案 3）。等幅の小さめの字で、量の数字だけ太字にする。窓があれば「/1000K」が続く。 */
export function ContextLabel(props: { gauge: ContextGauge }) {
  const g = props.gauge;
  const [used, ...rest] = g.label.split('/');
  return <span className="ctx-label" data-level={g.level}><b>{used}</b>{rest.length > 0 ? `/${rest.join('/')}` : ''}</span>;
}
