import { createContext, useContext, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { LiveStatus } from '@agent-hangar/shared';
import type { TerminalHost } from '../runtime/terminals.ts';
import { Icon } from './primitives/Icon.tsx';
import { useT } from './primitives/language.tsx';
import { LAYOUT_MOVING_ATTR, LAYOUT_SETTLED, beginLayoutMotion, endLayoutMotion } from './primitives/layoutMotion.ts';
import { collapseOut, growIn, motionOn } from './primitives/motionKit.ts';
import { usePresence } from './primitives/usePresence.ts';

export const TerminalHostContext = createContext<TerminalHost | null>(null);

/**
 * 次に自動でつなぐ時刻までの秒数を、1 秒ごとに数え直す。
 * 待っていない間は時計を止める。
 */
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
 * xterm を直接は持たない。
 * マウント先の要素を TerminalHost に渡すだけで、接続と描画は Host が行う。
 * 接続の様子も枠ごとに Host から読む。
 * 分割して 2 つ並べたとき、片方だけが切れることがあるからである。
 * agent は Claude のタブか。
 * transcript は、目次から跳ばした Claude が transcript を見せている間の帯（Claude の枠にだけ渡す）。
 */
export function TerminalPane(props: { tabId: string; hint: string | null; live: LiveStatus | null; aside?: boolean; agent?: boolean; transcript?: { when: string; onLatest: () => void } | null }) {
  const host = useContext(TerminalHostContext);
  const t = useT();
  const ref = useRef<HTMLDivElement>(null);
  const paneRef = useRef<HTMLDivElement>(null);
  // 帯の高さが変わる間は端末の寸法を合わせない（設計書 ⑧）。
  const withLayout = (run: () => Promise<void>) => {
    const p = paneRef.current;
    if (!p || !motionOn(p)) return null;
    beginLayoutMotion(p);
    return run().then(() => endLayoutMotion(p));
  };
  // 出る間も中身を読めるように、最後に出していた中身を控えておく。
  const lastHint = useRef(props.hint);
  if (props.hint) lastHint.current = props.hint;
  const hint = usePresence<HTMLDivElement>(props.hint !== null, (el) => withLayout(() => collapseOut(el)));
  const lastBand = useRef(props.transcript ?? null);
  if (props.transcript) lastBand.current = props.transcript;
  const band = usePresence<HTMLDivElement>(!!props.transcript, (el) => withLayout(() => collapseOut(el)));
  // 入るときは伸ばして、下の端末の面を押し下げる。最初の描画では動かさない。
  const shown = useRef({ hint: props.hint !== null, band: !!props.transcript });
  useLayoutEffect(() => {
    const p = paneRef.current;
    const grow = (el: HTMLElement | null) => {
      if (!el || !p) return;
      const a = growIn(el);
      if (!a) return;
      beginLayoutMotion(p);
      a.finished.then(() => endLayoutMotion(p), () => endLayoutMotion(p));
    };
    if (props.hint !== null && !shown.current.hint) grow(hint.ref.current);
    if (props.transcript && !shown.current.band) grow(band.ref.current);
    shown.current = { hint: props.hint !== null, band: !!props.transcript };
    // 入る向きの変わり目だけで動かすので、依存は有無だけにする。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.hint !== null, !!props.transcript]);
  useEffect(() => {
    const el = ref.current;
    if (!host || !el) return;
    host.mount(props.tabId, el);
    // 左右の欄や案内の帯が動いている間は本文の幅や高さが毎コマ変わる。合わせ直すたびに寸法をサーバへ送るので、止まってから一度だけ合わせる。
    // 止まった知らせは、どの箱の動きが止まっても届く。ほかの外側の箱がまだ動いているなら、それが止まるまで待つ。
    const fitIfStill = () => { if (!el.closest(`[${LAYOUT_MOVING_ATTR}]`)) host.fit(props.tabId); };
    const ro = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(fitIfStill);
    ro?.observe(el);
    window.addEventListener(LAYOUT_SETTLED, fitIfStill);
    return () => { ro?.disconnect(); window.removeEventListener(LAYOUT_SETTLED, fitIfStill); };
  }, [host, props.tabId]);

  const status = host?.status(props.tabId) ?? null;
  const link = host?.link(props.tabId) ?? { retryAt: null, dropped: false, gaveUp: false, detached: false };
  const secs = useSecondsUntil(link.retryAt);
  // 切断（F1）。
  // 思いがけず切れたときと、サーバが断ったときだけカードを出す。
  // 最初のつなぎ中と、自分で切った後は隅の小さな文で足りる。
  // 何度試してもつながらなかった（gaveUp）ときは、run が終わっているかもしれないので、動き続けているとは言わない。
  const failed = status === 'error';
  const dropped = !failed && link.dropped && status !== 'connected';
  // tmux から抜けて閉じたが、run とタブは生きている。自動ではつながないので、つなぎ直す手を出す。
  const detached = !failed && !dropped && link.detached && status !== 'connected';
  const off = failed || dropped || detached;
  const running = t(props.agent ? 'terminal.off.agentRunning' : 'terminal.off.shellRunning');

  // 帯が出ていても Esc は横取りしない。
  // Esc は Claude の中断に要るうえ、利用者が xterm で自分で transcript を抜けたことを hangar は知らない。
  // 横取りすると、抜けた後の中断の Esc が「最新へ」に化けて失われる。
  // 戻る手は帯の「最新へ戻る」と目次の「最新へ」に任せる。

  // 縁はそのセッションの状態で灯る（base.css の .term-pane[data-live]）。
  // 終わったセッションと切れている間は灯さない。
  return (
    <div ref={paneRef} className="term-pane" data-testid={`term-${props.tabId}`} data-live={props.aside === true && props.live === 'busy' ? 'aside' : props.live ?? 'ended'} data-off={off ? 'true' : undefined}>
      {band.mounted && lastBand.current && (
        <div ref={band.ref} className="term-band" aria-hidden={band.leaving ? 'true' : undefined}>
          <Icon name="transcriptView" />
          <b>{t('terminal.band.title')}</b>
          <span className="term-band-sub">{lastBand.current.when ? t('terminal.band.subWhen', { when: lastBand.current.when }) : t('terminal.band.sub')}</span>
          <button type="button" className="btn" onClick={lastBand.current.onLatest}><Icon name="latest" />{t('terminal.band.latest')}</button>
        </div>
      )}
      {hint.mounted && <div ref={hint.ref} className="term-hint" role={hint.leaving ? undefined : 'status'}>{props.hint ?? lastHint.current}</div>}
      {/* key を付けて、タブが変わったら枠ごと作り直す。前のタブの xterm の要素を残さないためである。 */}
      <div key={props.tabId} ref={ref} className="term-host" data-tab={props.tabId} data-painted={host?.painted(props.tabId) === false ? 'false' : undefined} onClick={() => host?.focus(props.tabId)} />
      {off && (
        <div className="term-veil">
          <div className="term-off-card">
            <span className="term-off-ic"><Icon name="disconnected" /></span>
            <b role="alert">{t(failed ? 'terminal.off.failed' : detached ? 'terminal.off.detached' : 'terminal.off.dropped')}</b>
            <p>{failed ? t('terminal.off.failedBody') : detached ? running : link.gaveUp ? t('terminal.off.gaveUp') : t('terminal.off.then', { first: running, next: t(secs !== null ? 'terminal.off.retryIn' : 'terminal.off.retrying', { n: secs ?? 0 }) })}</p>
            <button type="button" className="btn btn-primary" onClick={() => host?.reconnect(props.tabId)}><Icon name="reconnect" />{t(detached ? 'terminal.off.reattach' : 'terminal.off.reconnect')}</button>
          </div>
        </div>
      )}
      {!off && status === 'closed' && <div className="term-status">{t('terminal.status.closed')}</div>}
      {!off && status === 'connecting' && <div className="term-status">{t('terminal.status.connecting')}</div>}
    </div>
  );
}
