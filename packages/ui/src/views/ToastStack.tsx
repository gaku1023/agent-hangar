import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useEmit } from '../intent/chain.tsx';
import type { Toast } from '../mediator/types.ts';
import type { ReturnDueCardProps, ToastsProps, WaitingCardProps } from '../presenters/toasts.ts';
import { Icon } from './primitives/Icon.tsx';

/** info のトーストが出ている時間。 */
export const INFO_TOAST_MS = 4000;

/**
 * 画面右下に積む知らせ。
 * 上から error と info のトースト、戻る時刻を過ぎた札、通知の誘い、並べきれない入力待ちの数、入力待ちのカードの順に積む。
 * 入力待ちのカードは新しいものほど下（窓の角に近い側）に来る。
 * どの札も、種類の色を敷いた見出しと、その下の本文の 2 段でできている。
 * 時間で消すのは info だけで、時間切れはトーストごとに持つ。
 */
export function ToastStack(props: ToastsProps) {
  const emit = useEmit();
  return (
    <div className="toasts">
      {props.toasts.map((t) => (t.level === 'error' ? <ErrorToast key={t.id} toast={t} /> : <InfoToast key={t.id} toast={t} />))}
      {/* 新しく積まれたカードを読み上げに届ける。 */}
      <div className="toast-waiting-list" aria-live="polite">
        {/* 通知の誘いはカードごとに繰り返さず、積みの上に 1 回だけ出す。 */}
        {props.returning.map((c) => <ReturnDueCard key={c.sessionId} card={c} blocked={props.blocked} />)}
        {props.offerNotify && props.waiting.length > 0 && <div className="toast toast-pill toast-offer">離れていても気づけます<button type="button" className="btn-link" onClick={() => emit({ type: 'notify.set', on: true })}>通知を受け取る</button></div>}
        {props.more > 0 && <button type="button" className="toast toast-pill toast-more" disabled={props.blocked} onClick={() => emit({ type: 'nav.go', to: { name: 'home' } })}>ほか {props.more} 件をホームで見る</button>}
        {props.waiting.map((c) => <WaitingCard key={c.sessionId} card={c} blocked={props.blocked} />)}
      </div>
    </div>
  );
}

/**
 * 入力待ちのカード。
 * 答えるまで（入力待ちが解けるまで）残るので、閉じるボタンは持たない。
 * カードそのものが 1 つのボタンで、押すとそのセッションを開いてターミナルにフォーカスする。
 * 見出しにどのセッションか、その下に問いを出す。問いが取れないときは、名前を問いの段へ上げる。
 * 確認や入力のあるダイアログが開いている間（blocked）は押せない。
 * 押してもダイアログの裏で画面は移らないので、押せるように見せず、理由は乗せたときの説明に出す。
 */
function WaitingCard(props: { card: WaitingCardProps; blocked: boolean }) {
  const emit = useEmit();
  const c = props.card;
  const label = c.question === null ? `${c.name} が入力を待っています` : `${c.name} が入力を待っています：${c.question}`;
  return (
    <button type="button" className="toast notice" data-kind="waiting" aria-label={label} disabled={props.blocked} title={props.blocked ? 'ダイアログを閉じると開けます' : undefined} onClick={() => emit({ type: 'session.open', id: c.sessionId, focus: 'terminal' })}>
      <span className="notice-head">
        <span className="notice-dot" aria-hidden="true" />
        <span className="notice-label">入力待ち</span>
        {c.question !== null && <><span className="notice-sep" aria-hidden="true">·</span><span className="notice-who">{c.name}</span></>}
        <span className="notice-end">{c.waited}</span>
      </span>
      <span className="notice-body"><span className="notice-title">{c.question ?? c.name}</span></span>
    </button>
  );
}

/**
 * 戻る時刻を過ぎた Paused の札。
 * 入力待ちと違って待たせている相手がいないので、閉じるボタンで下げられる。開いても下がる。
 * 見出しにどのセッションかと戻る時刻、その下に何を確かめに戻るかを出す。理由が無いときは、名前を本文の段へ上げる。
 * 本文が 1 つのボタンで、押すとそのセッションを開く。確認や入力のあるダイアログが開いている間（blocked）は押せない。
 */
function ReturnDueCard(props: { card: ReturnDueCardProps; blocked: boolean }) {
  const emit = useEmit();
  const c = props.card;
  return (
    <div className="toast notice" data-kind="return">
      <div className="notice-head">
        <span className="notice-dot" aria-hidden="true" />
        <span className="notice-label">戻る時刻</span>
        {c.reason !== null && <><span className="notice-sep" aria-hidden="true">·</span><span className="notice-who">{c.name}</span></>}
        <span className="notice-end">{c.time}</span>
        <button type="button" className="notice-close" aria-label={`${c.name} の知らせを閉じる`} onClick={() => emit({ type: 'return.toast.dismiss', id: c.sessionId })}><Icon name="close" /></button>
      </div>
      <button type="button" className="notice-body notice-open" aria-label={c.reason === null ? `${c.name} を開く` : `${c.name} を開く：${c.reason}`} disabled={props.blocked} title={props.blocked ? 'ダイアログを閉じると開けます' : undefined} onClick={() => emit({ type: 'session.open', id: c.sessionId })}>
        <span className="notice-title">{c.reason ?? c.name}</span>
      </button>
    </div>
  );
}

/**
 * ms が経ったら onDone を呼ぶ。
 * マウスを乗せている間とフォーカスが中にある間は止め、離れたら残りの時間から数え直す。
 */
function useAutoDismiss(ms: number, onDone: () => void) {
  const [paused, setPaused] = useState(false);
  const left = useRef(ms);
  const done = useRef(onDone);
  done.current = onDone;
  useEffect(() => {
    if (paused) return;
    const started = Date.now();
    const t = setTimeout(() => done.current(), left.current);
    return () => { clearTimeout(t); left.current = Math.max(0, left.current - (Date.now() - started)); };
  }, [paused]);
  const hold = () => setPaused(true);
  const release = () => setPaused(false);
  return { onMouseEnter: hold, onMouseLeave: release, onFocus: hold, onBlur: release };
}

/**
 * info のトースト。
 * 時間で消え、押しても消せる。
 */
function InfoToast(props: { toast: Toast }) {
  const emit = useEmit();
  const dismiss = () => emit({ type: 'toast.dismiss', id: props.toast.id });
  const pause = useAutoDismiss(INFO_TOAST_MS, dismiss);
  return (
    <div className="toast notice" data-kind="info" role="status" onClick={dismiss} {...pause}>
      <div className="notice-head"><span className="notice-dot" aria-hidden="true" /><span className="notice-label">お知らせ</span></div>
      <div className="notice-body"><div className="notice-message">{props.toast.message}</div></div>
    </div>
  );
}

/**
 * error のトースト。
 * 読み落とさないよう時間では消さず、閉じるボタンで消す。
 * 本文は 2 行まで見せ、収まらないときだけ「詳しく」で開く。
 */
function ErrorToast(props: { toast: Toast }) {
  const emit = useEmit();
  const message = useRef<HTMLDivElement>(null);
  const [long, setLong] = useState(false);
  const [open, setOpen] = useState(false);
  // 2 行で切れているかは、描いてから測るしかない。
  useLayoutEffect(() => {
    const el = message.current;
    if (el) setLong(el.scrollHeight > el.clientHeight + 1);
  }, [props.toast.message]);
  return (
    <div className="toast notice" data-kind="error" role="alert" data-open={open ? 'true' : undefined}>
      <div className="notice-head">
        <Icon name="alert" />
        <span className="notice-label">エラー</span>
        <button type="button" className="notice-close" aria-label="閉じる" onClick={() => emit({ type: 'toast.dismiss', id: props.toast.id })}><Icon name="close" /></button>
      </div>
      <div className="notice-body">
        <div ref={message} className="notice-message">{props.toast.message}</div>
        {long && <button type="button" className="btn-link notice-more" aria-expanded={open} onClick={() => setOpen(!open)}>詳しく</button>}
      </div>
    </div>
  );
}
