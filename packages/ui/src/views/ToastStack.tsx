import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useEmit } from '../intent/chain.tsx';
import type { Toast } from '../mediator/types.ts';
import type { ToastsProps, WaitingCardProps } from '../presenters/toasts.ts';
import { Icon } from './primitives/Icon.tsx';

/** info のトーストが出ている時間。 */
export const INFO_TOAST_MS = 4000;

/**
 * 画面右下に積む知らせ。
 * 上から error と info のトースト、並べきれない入力待ちの数、入力待ちのカードの順に積む。
 * 入力待ちのカードは新しいものほど下（窓の角に近い側）に来る。
 * 時間で消すのは info だけで、時間切れはトーストごとに持つ。
 */
export function ToastStack(props: ToastsProps) {
  const emit = useEmit();
  return (
    <div className="toasts">
      {props.toasts.map((t) => (t.level === 'error' ? <ErrorToast key={t.id} toast={t} /> : <InfoToast key={t.id} toast={t} />))}
      {/* 新しく積まれたカードを読み上げに届ける。カードの中の操作は、それぞれのボタンで選ぶ。 */}
      <div className="toast-waiting-list" aria-live="polite">
        {props.more > 0 && <button type="button" className="toast toast-more" onClick={() => emit({ type: 'nav.go', to: { name: 'home' } })}>ほか {props.more} 件をホームで見る</button>}
        {props.waiting.map((c) => <WaitingCard key={c.sessionId} card={c} offerNotify={props.offerNotify} />)}
      </div>
    </div>
  );
}

/**
 * 入力待ちのカード。
 * 答えるまで（入力待ちが解けるまで）残るので、閉じるボタンは持たない。
 * どこを押してもそのセッションを開いてターミナルにフォーカスする。
 * キーボードと読み上げのためには「ターミナルで答える」のボタンを置く。
 */
function WaitingCard(props: { card: WaitingCardProps; offerNotify: boolean }) {
  const emit = useEmit();
  const c = props.card;
  const open = () => emit({ type: 'session.open', id: c.sessionId, focus: 'terminal' });
  return (
    <div className="toast toast-waiting" role="group" aria-label={`${c.name} が入力を待っています`} onClick={open}>
      <span className="dot" data-status="waiting" aria-hidden="true" />
      <div className="toast-body">
        <div className="toast-head"><b className="toast-name">{c.name}</b><small className="toast-waited">{c.waited}待っている</small></div>
        {c.projectName && <div className="toast-project">{c.projectName}</div>}
        <div className="toast-question">{c.question}</div>
        <div className="toast-actions">
          <button type="button" className="btn btn-primary btn-sm" onClick={(e) => { e.stopPropagation(); open(); }}><Icon name="shell" />ターミナルで答える</button>
          <span className="toast-hint">答えるまで残ります</span>
          {props.offerNotify && <button type="button" className="btn-link toast-notify" onClick={(e) => { e.stopPropagation(); emit({ type: 'notify.set', on: true }); }}>通知を受け取る</button>}
        </div>
      </div>
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

/** info のトースト。時間で消え、押しても消せる。 */
function InfoToast(props: { toast: Toast }) {
  const emit = useEmit();
  const dismiss = () => emit({ type: 'toast.dismiss', id: props.toast.id });
  const pause = useAutoDismiss(INFO_TOAST_MS, dismiss);
  return <div className="toast" data-level="info" role="status" onClick={dismiss} {...pause}>{props.toast.message}</div>;
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
    <div className="toast" data-level="error" role="alert" data-open={open ? 'true' : undefined}>
      <Icon name="alert" />
      <div className="toast-body">
        <div ref={message} className="toast-message">{props.toast.message}</div>
        {long && <button type="button" className="btn-link toast-more-link" aria-expanded={open} onClick={() => setOpen(!open)}>詳しく</button>}
      </div>
      <button type="button" className="toast-close" aria-label="閉じる" onClick={() => emit({ type: 'toast.dismiss', id: props.toast.id })}><Icon name="close" /></button>
    </div>
  );
}
