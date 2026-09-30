import { createContext, useContext, useEffect, useRef } from 'react';
import type { LiveStatus } from '@agent-hangar/shared';
import type { TerminalHost, TerminalStatus } from '../runtime/terminals.ts';
import { LAYOUT_SETTLED, MOVING_ATTR } from './primitives/sidebarMotion.ts';

export const TerminalHostContext = createContext<TerminalHost | null>(null);

/** xterm を直接は持たない。マウント先の要素を TerminalHost に渡すだけで、接続と描画は Host が行う。 */
export function TerminalPane(props: { tabId: string; status: TerminalStatus | null; hint: string | null; live: LiveStatus | null }) {
  const host = useContext(TerminalHostContext);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!host || !el) return;
    host.mount(props.tabId, el);
    // サイドバーの開閉の間は本文の幅が毎コマ変わる。合わせ直すたびに寸法をサーバへ送るので、止まってから一度だけ合わせる。
    const ro = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(() => { if (!el.closest(`[${MOVING_ATTR}]`)) host.fit(props.tabId); });
    ro?.observe(el);
    const settled = () => host.fit(props.tabId);
    window.addEventListener(LAYOUT_SETTLED, settled);
    return () => { ro?.disconnect(); window.removeEventListener(LAYOUT_SETTLED, settled); };
  }, [host, props.tabId]);
  // 縁はそのセッションの状態で灯る（base.css の .term-pane[data-live]）。終わったセッションは灯さない。
  return (
    <div className="term-pane" data-testid={`term-${props.tabId}`} data-live={props.live ?? 'ended'}>
      {props.hint && <div className="term-hint" role="status">{props.hint}</div>}
      {/* key を付けて、タブが変わったら枠ごと作り直す。前のタブの xterm の要素を残さないためである。 */}
      <div key={props.tabId} ref={ref} className="term-host" data-tab={props.tabId} onClick={() => host?.focus(props.tabId)} />
      {props.status === 'closed' && <div className="term-status">接続していません</div>}
      {props.status === 'connecting' && <div className="term-status">接続しています</div>}
      {props.status === 'error' && <div className="term-status term-status-error">ターミナルに接続できませんでした</div>}
    </div>
  );
}
