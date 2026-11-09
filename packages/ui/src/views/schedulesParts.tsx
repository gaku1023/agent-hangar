import { formatRoute, SCHEDULE_RUNS_KEPT } from '@agent-hangar/shared';
import { useEffect, useLayoutEffect, useRef } from 'react';
import { useEmit } from '../action/chain.tsx';
import type { ScheduleRunRow } from '../presenters/schedules.ts';
import { collapseOut, growIn, popMark } from './primitives/motionKit.ts';
import { usePresence } from './primitives/usePresence.ts';

/**
 * 予定の画面の部品。
 * 時刻の予定とイベントの行が分け合う（SchedulesScreen と EventRows と EventBindingForm）。
 */

/**
 * 開け閉めの枠。
 * 中身が出入りするときに高さを動かす。
 */
export function Grow(props: { open: boolean; children: () => React.ReactNode }) {
  const { mounted, ref } = usePresence<HTMLDivElement>(props.open, (el) => collapseOut(el));
  useLayoutEffect(() => { if (props.open && ref.current) growIn(ref.current); }, [props.open, ref, mounted]);
  if (!mounted) return null;
  return <div ref={ref} className="sch-grow">{props.children()}</div>;
}

/**
 * 直近の回の丸。
 * 新しい回が来たら、その丸だけ跳ねる。
 */
export function RunDots(props: { runs: ScheduleRunRow[] }) {
  const box = useRef<HTMLSpanElement>(null);
  const seen = useRef<Set<string> | null>(null);
  useEffect(() => {
    if (seen.current) {
      for (const r of props.runs) {
        if (seen.current.has(r.id)) continue;
        const el = box.current?.querySelector<HTMLElement>(`[data-run="${r.id}"]`);
        if (el) popMark(el);
      }
    }
    seen.current = new Set(props.runs.map((r) => r.id));
  }, [props.runs]);
  // 古い回を左に、新しい回を右に置く。
  return <span className="sch-dots" ref={box}>{[...props.runs].slice(0, SCHEDULE_RUNS_KEPT).reverse().map((r) => <i key={r.id} data-run={r.id} className="sch-dot" data-result={r.result} role="img" aria-label={`${r.at} ${r.label}`} title={`${r.at} ${r.label}`} />)}</span>;
}

export function RunList(props: { runs: ScheduleRunRow[] }) {
  const emit = useEmit();
  if (props.runs.length === 0) return null;
  return (
    <ul className="sch-runs">
      {props.runs.map((r) => (
        <li key={r.id} className="sch-run">
          <i className="sch-dot" data-result={r.result} aria-hidden="true" />
          {r.sessionId
            ? <a className="sch-run-name" href={formatRoute({ name: 'session', id: r.sessionId })} onClick={(e) => { e.preventDefault(); emit({ type: 'nav.go', to: { name: 'session', id: r.sessionId! } }); }}>{r.title || r.label}</a>
            : <span className="sch-run-name faint">{r.label}</span>}
          <span className="faint num">{r.took ?? ''}</span>
          <span className="num">{r.at}</span>
        </li>
      ))}
    </ul>
  );
}

