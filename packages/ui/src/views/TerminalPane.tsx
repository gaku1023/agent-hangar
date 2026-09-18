import { createContext, useContext, useEffect, useRef } from 'react';
import type { TerminalHost, TerminalStatus } from '../runtime/terminals.ts';

export const TerminalHostContext = createContext<TerminalHost | null>(null);

/** xterm を直接は持たない。マウント先の要素を TerminalHost に渡すだけで、接続と描画は Host が行う。 */
export function TerminalPane(props: { tabId: string; status: TerminalStatus | null; hint: string | null }) {
  const host = useContext(TerminalHostContext);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!host || !el) return;
    host.mount(props.tabId, el);
    const ro = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(() => host.fit(props.tabId));
    ro?.observe(el);
    return () => ro?.disconnect();
  }, [host, props.tabId]);
  return (
    <div className="term-pane">
      {props.hint && <div className="term-hint" role="status">{props.hint}</div>}
      {/* key を付けて、タブが変わったら枠ごと作り直す。前のタブの xterm の要素を残さないためである。 */}
      <div key={props.tabId} ref={ref} className="term-host" data-tab={props.tabId} onClick={() => host?.focus(props.tabId)} />
      {props.status === 'closed' && <div className="term-status">接続していません</div>}
      {props.status === 'connecting' && <div className="term-status">接続しています</div>}
      {props.status === 'error' && <div className="term-status term-status-error">ターミナルに接続できませんでした</div>}
    </div>
  );
}
