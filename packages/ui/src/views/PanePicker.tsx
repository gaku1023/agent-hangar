import type { PaneId } from '@agent-hangar/shared';
import { useLayoutEffect, useRef } from 'react';
import { useEmit } from '../action/chain.tsx';
import type { PickerRow } from '../presenters/panes.ts';
import { StatusDot } from './primitives/StatusDot.tsx';
import { useT } from './primitives/language.tsx';
import { staggerIn } from './primitives/motionKit.ts';

/**
 * 空のペインの中身。動いているセッションの一覧を出し、押すと pane.fill で、そのペインに入れる。
 * すでに木にあるセッションは presenter が外してある。
 */
export function PanePicker(props: { pane: PaneId; rows: PickerRow[] }) {
  const emit = useEmit();
  const t = useT();
  // 一覧の行は、開いたときに --stagger ずつずれて出る。
  const list = useRef<HTMLUListElement>(null);
  useLayoutEffect(() => { if (list.current) staggerIn([...list.current.children] as HTMLElement[]); }, []);
  return (
    <div className="pane-empty" data-pane-empty={props.pane}>
      <div className="pane-empty-lead">{t('pane.empty.lead')}</div>
      <ul ref={list} className="pane-empty-list">
        {props.rows.map((r) => (
          <li key={r.id}>
            <button type="button" className="pane-empty-row" data-session={r.id} onClick={() => emit({ type: 'pane.fill', pane: props.pane, sessionId: r.id })}>
              <StatusDot status={r.live} aside={r.aside} reason={r.reason} /><span className="pane-empty-name">{r.name}</span>
            </button>
          </li>
        ))}
      </ul>
      <div className="pane-empty-hint">{t('pane.empty.hint')}</div>
    </div>
  );
}
