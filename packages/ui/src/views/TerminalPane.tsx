import { createContext, useContext, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { LiveStatus, StopReason } from '@agent-hangar/shared';
import type { TerminalHost } from '../runtime/terminals.ts';
import { Icon } from './primitives/Icon.tsx';
import { useT } from './primitives/language.tsx';
import { useEmit } from '../action/chain.tsx';
import { presentRemoteShell } from '../presenters/remoteShell.ts';
import { LAYOUT_MOVING_ATTR, LAYOUT_SETTLED, beginLayoutMotion, endLayoutMotion } from './primitives/layoutMotion.ts';
import { collapseOut, fadeIn, fadeOut, growIn, motionOn, resizeFrom, riseIn } from './primitives/motionKit.ts';
import { usePresence } from './primitives/usePresence.ts';
import { useNow } from './primitives/useNow.ts';
import type { PeerOriginProps } from '../presenters/peerOrigin.ts';
import { PeerBadge, usePeerFlash } from './PeerOrigin.tsx';
import { TermTranslations } from './TermTranslate.tsx';

export const TerminalHostContext = createContext<TerminalHost | null>(null);

/** 「中断して渡す」を押したあと、何も動かなければ帯を元に戻すまでの長さ（サーバの急がせの PEER_QUEUE_RUSH_MS に少し足す）。 */
const PEER_RUSH_SHOW_MS = 12_000;

/** SSH のシェルタブの宛先。deviceName は札の名前、host は手元で上書きしている Host 名（無ければ null）。 */
export type RemoteTarget = { deviceId: string; deviceName: string; host: string | null };

/**
 * SSH のシェルタブがつなげなかったときの、端末の中央の塊。
 * 理由、相手の PC の名前、3 つの操作の順に並べる。「住所を変える」は塊をそのまま伸ばして、入力欄と「つなぐ」を足す（Enter でも決まる）。
 * 入力欄を空にして決めると上書きを解く。
 */
function RemoteFailed(props: { tabId: string; target: RemoteTarget; why: string; reason: string; detail: string | null; address: string | null; leaving: boolean; boxRef: (el: HTMLDivElement | null) => void }) {
  const emit = useEmit();
  const t = useT();
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState(props.target.host ?? '');
  const centerRef = useRef<HTMLDivElement | null>(null);
  const rowRef = useRef<HTMLDivElement>(null);
  const from = useRef<number | null>(null);
  const toggle = () => { from.current = centerRef.current?.offsetHeight ?? null; setOpen((o) => !o); };
  // 塊の高さを、開く前の高さから今の高さへ動かす。入力の行は下から入れる。
  useLayoutEffect(() => {
    const c = centerRef.current;
    if (c && from.current !== null) resizeFrom(c, from.current);
    from.current = null;
    if (open && rowRef.current) { riseIn(rowRef.current); rowRef.current.querySelector('input')?.focus(); }
  }, [open]);
  useLayoutEffect(() => { if (centerRef.current) fadeIn(centerRef.current); }, []);
  const go = () => {
    emit({ type: 'remote.sshHost', deviceId: props.target.deviceId, host: value.trim() === '' ? null : value.trim(), retryTabId: props.tabId });
    from.current = centerRef.current?.offsetHeight ?? null;
    setOpen(false);
  };
  return (
    <div ref={(el) => { centerRef.current = el; props.boxRef(el); }} className="term-remote-center" aria-hidden={props.leaving ? 'true' : undefined}>
      <Icon name="warning" />
      <b role={props.leaving ? undefined : 'alert'}>{props.why}</b>
      <span className="term-remote-host">{props.target.deviceName}</span>
      <div className="term-remote-row">
        <button type="button" className="btn btn-primary" onClick={() => emit({ type: 'investigate.open', op: 'remoteShell', message: props.why, code: props.reason, remote: { device: props.target.deviceName, ...(props.address ? { address: props.address } : {}), ...(props.detail ? { detail: props.detail } : {}) } })}>{t('setupGuide.launch.button')}</button>
        <button type="button" className="btn" aria-expanded={open} onClick={toggle}>{t('remoteShell.action.change')}</button>
        <button type="button" className="btn btn-ghost" onClick={() => emit({ type: 'remote.retry', tabId: props.tabId })}>{t('remoteShell.action.retry')}</button>
      </div>
      {open && (
        <div ref={rowRef} className="term-remote-addr">
          <input type="text" spellCheck={false} autoComplete="off" aria-label={t('remoteShell.addr.field')} value={value} onChange={(e) => setValue(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); go(); } }} />
          <button type="button" className="btn btn-primary" onClick={go}>{t('remoteShell.action.go')}</button>
        </div>
      )}
    </div>
  );
}

/**
 * 次に自動でつなぐ時刻までの秒数を、1 秒ごとに数え直す。
 * 待っていない間は時計を止める。
 */
function useSecondsUntil(at: number | null): number | null {
  // 隠れている間は数え直さない（useNow）。
  const now = useNow(1000, { active: at !== null, sync: at });
  return at === null ? null : Math.max(1, Math.ceil((at - now) / 1000));
}

/**
 * 端末の縁の灯（base.css の .term-pane[data-live]）。
 * 裏だけ動いているものは薄いオレンジ、リセット済みは入力待ちの赤、使用制限は灰の輪で静かに（試作 stop-reason-proto の N1）。
 * 許可待ちは入力待ちと同じ赤である。
 */
export function liveEdge(live: LiveStatus | null, aside: boolean, reason: StopReason | null): string {
  if (reason === 'limit') return 'limit';
  if (reason === 'reset') return 'waiting';
  return aside && live === 'busy' ? 'aside' : live ?? 'ended';
}

/**
 * xterm を直接は持たない。
 * マウント先の要素を TerminalHost に渡すだけで、接続と描画は Host が行う。
 * 接続の様子も枠ごとに Host から読む。
 * 分割して 2 つ並べたとき、片方だけが切れることがあるからである。
 * agent は Claude のタブか。
 * transcript は、目次から跳ばした Claude が transcript を見せている間の帯（Claude の枠にだけ渡す）。
 * peer は、ほかの PC から来た文の知らせ（Claude の枠にだけ渡す）。預かっている間は端末の下に帯を出し、渡した直後は右上に札を数秒出す。
 * replies は、訳を重ねる英語の返答（終わったターンのもの、古い順）。Claude の枠にだけ渡す（views/TermTranslate.tsx）。
 */
export function TerminalPane(props: { tabId: string; hint: string | null; live: LiveStatus | null; aside?: boolean; reason?: StopReason | null; agent?: boolean; transcript?: { when: string; onLatest: () => void } | null; peer?: PeerOriginProps | null; /** 預かりの帯の「中断して渡す」。省くとボタンを出さない。 */ onPeerRush?: () => void; replies?: readonly string[] | null; /** SSH のシェルタブのときの宛先。つなげなかったときは暗幕の代わりに中央の塊を出し、つなぎ直している間は端末を薄める。 */ remote?: RemoteTarget }) {
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
  // 預かりの帯は端末の下に置く。入るときと畳むときは、上の帯と同じ形で動かす。
  const lastPeer = useRef(props.peer?.band ?? null);
  if (props.peer?.band) lastPeer.current = props.peer.band;
  const peerBand = usePresence<HTMLDivElement>(!!props.peer?.band, (el) => withLayout(() => collapseOut(el)));
  const flash = usePeerFlash(props.peer?.flash ?? null);
  // 「中断して渡す」を押してから、預かりが動く（帯の文が変わる、帯が畳まれる）までの間。
  // 断られて何も動かないときのために、PEER_RUSH_SHOW_MS で元に戻す。
  const [rushing, setRushing] = useState(false);
  const peerText = props.peer?.band ?? null;
  useEffect(() => { setRushing(false); }, [peerText]);
  useEffect(() => {
    if (!rushing) return;
    const timer = setTimeout(() => setRushing(false), PEER_RUSH_SHOW_MS);
    return () => clearTimeout(timer);
  }, [rushing]);
  // 入るときは伸ばして、下の端末の面を押し下げる。最初の描画では動かさない。
  const shown = useRef({ hint: props.hint !== null, band: !!props.transcript, peer: !!props.peer?.band });
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
    if (props.peer?.band && !shown.current.peer) grow(peerBand.ref.current);
    shown.current = { hint: props.hint !== null, band: !!props.transcript, peer: !!props.peer?.band };
    // 入る向きの変わり目だけで動かすので、依存は有無だけにする。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.hint !== null, !!props.transcript, !!props.peer?.band]);
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
  // SSH のシェルタブは、つなぎの様子を札（host.remote）で受ける。暗幕の代わりに中央の塊を出す。
  const rface = props.remote ? presentRemoteShell(host?.remote(props.tabId) ?? null, props.remote.deviceName, t) : null;
  const rFailed = useRef(rface);
  if (rface?.phase === 'failed') rFailed.current = rface;
  const remoteFailed = usePresence<HTMLDivElement>(rface?.phase === 'failed', (el) => (motionOn(el) ? fadeOut(el) : null));
  const off = !props.remote && (failed || dropped || detached);
  const running = t(props.agent ? 'terminal.off.agentRunning' : 'terminal.off.shellRunning');

  // 帯が出ていても Esc は横取りしない。
  // Esc は Claude の中断に要るうえ、利用者が xterm で自分で transcript を抜けたことを hangar は知らない。
  // 横取りすると、抜けた後の中断の Esc が「最新へ」に化けて失われる。
  // 戻る手は帯の「最新へ戻る」と目次の「最新へ」に任せる。

  // 縁はそのセッションの状態で灯る（base.css の .term-pane[data-live]）。
  // 終わったセッションと切れている間は灯さない。
  return (
    <div ref={paneRef} className="term-pane" data-testid={`term-${props.tabId}`} data-live={liveEdge(props.live, props.aside === true, props.reason ?? null)} data-off={off ? 'true' : undefined} data-dim={rface && (rface.dim || rface.phase === 'failed') ? 'true' : undefined}>
      {band.mounted && lastBand.current && (
        <div ref={band.ref} className="term-band" aria-hidden={band.leaving ? 'true' : undefined}>
          <Icon name="transcriptView" />
          <b>{t('terminal.band.title')}</b>
          {lastBand.current.when && <span className="term-band-sub">{lastBand.current.when}</span>}
          <button type="button" className="btn" onClick={lastBand.current.onLatest}><Icon name="latest" />{t('terminal.band.latest')}</button>
        </div>
      )}
      {hint.mounted && <div ref={hint.ref} className="term-hint" role={hint.leaving ? undefined : 'status'}>{props.hint ?? lastHint.current}</div>}
      {/* key を付けて、タブが変わったら枠ごと作り直す。前のタブの xterm の要素を残さないためである。 */}
      <div key={props.tabId} ref={ref} className="term-host" data-tab={props.tabId} data-painted={host?.painted(props.tabId) === false ? 'false' : undefined} onClick={() => host?.focus(props.tabId)} />
      {host && props.replies && props.replies.length > 0 && <TermTranslations host={host} tabId={props.tabId} replies={props.replies} />}
      {peerBand.mounted && lastPeer.current && (
        <div ref={peerBand.ref} className="term-peer-band" data-testid="peer-band" role={peerBand.leaving ? undefined : 'status'} aria-hidden={peerBand.leaving ? 'true' : undefined}>
          {rushing ? <span className="term-peer-spin" aria-hidden="true" /> : <Icon name="reminder" />}
          <span>{rushing ? t('terminal.peer.rushing') : props.peer?.band ?? lastPeer.current}</span>
          {!rushing && !peerBand.leaving && props.onPeerRush && (
            <button type="button" className="term-peer-rush" onClick={() => { setRushing(true); props.onPeerRush!(); }}>{t('terminal.peer.rush')}</button>
          )}
        </div>
      )}
      <PeerBadge flash={flash} />
      {off && (
        <div className="term-veil">
          <div className="term-off-card">
            <span className="term-off-ic"><Icon name="disconnected" /></span>
            <b role="alert">{t(failed ? 'terminal.off.failed' : detached ? 'terminal.off.detached' : 'terminal.off.dropped')}</b>
            {/* 断られたときは、見出しと再接続のボタンで足りるので本文を置かない。 */}
            {!failed && <p>{detached ? running : link.gaveUp ? t('terminal.off.gaveUp') : t('terminal.off.then', { first: running, next: t(secs !== null ? 'terminal.off.retryIn' : 'terminal.off.retrying', { n: secs ?? 0 }) })}</p>}
            <button type="button" className="btn btn-primary" onClick={() => host?.reconnect(props.tabId)}><Icon name="reconnect" />{t(detached ? 'terminal.off.reattach' : 'terminal.off.reconnect')}</button>
          </div>
        </div>
      )}
      {props.remote && remoteFailed.mounted && rFailed.current && (
        <RemoteFailed tabId={props.tabId} target={props.remote} why={rFailed.current.why ?? ''} reason={rFailed.current.reason ?? 'dropped'} detail={rFailed.current.detail} address={rFailed.current.address} leaving={remoteFailed.leaving} boxRef={(el) => { remoteFailed.ref.current = el; }} />
      )}
      {!off && !props.remote && status === 'closed' && <div className="term-status">{t('terminal.status.closed')}</div>}
      {!off && !props.remote && status === 'connecting' && <div className="term-status">{t('terminal.status.connecting')}</div>}
    </div>
  );
}
