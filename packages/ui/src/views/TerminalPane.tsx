import { createContext, useContext, useEffect, useRef, useState, type KeyboardEvent } from 'react';
import type { LiveStatus } from '@agent-hangar/shared';
import type { TerminalHost } from '../runtime/terminals.ts';
import { isComposing } from './ime.ts';
import { Icon } from './primitives/Icon.tsx';
import { LAYOUT_SETTLED, MOVING_ATTR } from './primitives/sidebarMotion.ts';

export const TerminalHostContext = createContext<TerminalHost | null>(null);

/** 次に自動でつなぐ時刻までの秒数を、1 秒ごとに数え直す。待っていない間は時計を止める。 */
function useSecondsUntil(at: number | null): number | null {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (at === null) return;
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [at]);
  return at === null ? null : Math.max(1, Math.ceil((at - now) / 1000));
}

/**
 * xterm を直接は持たない。マウント先の要素を TerminalHost に渡すだけで、接続と描画は Host が行う。
 * 接続の様子も枠ごとに Host から読む。分割して 2 つ並べたとき、片方だけが切れることがあるからである。
 * agent は Claude のタブか。transcript は、目次から跳ばした Claude が transcript を見せている間の帯（Claude の枠にだけ渡す）。
 */
export function TerminalPane(props: { tabId: string; hint: string | null; live: LiveStatus | null; agent?: boolean; transcript?: { when: string; onLatest: () => void } | null }) {
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

  const status = host?.status(props.tabId) ?? null;
  const link = host?.link(props.tabId) ?? { retryAt: null, dropped: false };
  const secs = useSecondsUntil(link.retryAt);
  // 切断（F1）。思いがけず切れたときと、サーバが断ったときだけカードを出す。最初のつなぎ中と、自分で切った後は隅の小さな文で足りる。
  const failed = status === 'error';
  const dropped = !failed && link.dropped && status !== 'connected';
  const off = failed || dropped;
  const who = props.agent ? 'Claude は' : 'シェルは';

  // transcript を表示している間の Esc は、Claude には渡さずに「最新へ戻る」と同じ道で抜ける。
  // Claude に渡すと transcript だけが閉じ、帯が残って食い違うからである。
  const onKeyCapture = (e: KeyboardEvent<HTMLDivElement>) => {
    if (!props.transcript || e.key !== 'Escape' || e.metaKey || e.ctrlKey || e.altKey || e.shiftKey || isComposing(e)) return;
    e.preventDefault();
    e.stopPropagation();
    props.transcript.onLatest();
  };

  // 縁はそのセッションの状態で灯る（base.css の .term-pane[data-live]）。終わったセッションと切れている間は灯さない。
  return (
    <div className="term-pane" data-testid={`term-${props.tabId}`} data-live={props.live ?? 'ended'} data-off={off ? 'true' : undefined} onKeyDownCapture={onKeyCapture}>
      {props.transcript && (
        <div className="term-band">
          <Icon name="transcriptView" />
          <b>transcript を表示中</b>
          <span className="term-band-sub">{props.transcript.when ? `${props.transcript.when} のターン · ` : ''}Claude は裏で動き続けています</span>
          <button type="button" className="btn" onClick={props.transcript.onLatest}><Icon name="latest" />最新へ戻る<kbd className="kc">esc</kbd></button>
        </div>
      )}
      {props.hint && <div className="term-hint" role="status">{props.hint}</div>}
      {/* key を付けて、タブが変わったら枠ごと作り直す。前のタブの xterm の要素を残さないためである。 */}
      <div key={props.tabId} ref={ref} className="term-host" data-tab={props.tabId} onClick={() => host?.focus(props.tabId)} />
      {off && (
        <div className="term-veil">
          <div className="term-off-card">
            <span className="term-off-ic"><Icon name="disconnected" /></span>
            <b role="alert">{failed ? 'ターミナルに接続できませんでした' : 'ターミナルとの接続が切れました'}</b>
            <p>{failed ? 'もう一度つなぐか、セッションを開き直してください。' : `${who}動き続けています。${secs !== null ? `${secs} 秒後にもう一度つなぎます。` : 'つなぎ直しています。'}`}</p>
            <button type="button" className="btn btn-primary" onClick={() => host?.reconnect(props.tabId)}><Icon name="reconnect" />再接続</button>
          </div>
        </div>
      )}
      {!off && status === 'closed' && <div className="term-status">接続していません</div>}
      {!off && status === 'connecting' && <div className="term-status">接続しています</div>}
    </div>
  );
}
