import type { PaneId } from '@agent-hangar/shared';
import { useEmit } from '../action/chain.tsx';
import type { PickerRow } from '../presenters/panes.ts';
import { StatusDot } from './primitives/StatusDot.tsx';
import { useT } from './primitives/language.tsx';

/**
 * 空のペインの中身。動いているセッションの一覧を出し、押すと pane.fill で、そのペインに入れる。
 * すでに木にあるセッションは presenter が外してある。
 */
export function PanePicker(props: { pane: PaneId; rows: PickerRow[] }) {
  const emit = useEmit();
  const t = useT();
  return (
    <div className="pane-empty" data-pane-empty={props.pane}>
      <div className="pane-empty-lead">{t('pane.empty.lead')}</div>
      <ul className="pane-empty-list">
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
