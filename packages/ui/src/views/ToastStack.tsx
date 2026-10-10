import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useEmit } from '../intent/chain.tsx';
import type { Toast } from '../mediator/types.ts';
import type { ToastsProps, WaitingCardProps } from '../presenters/toasts.ts';
import { Icon } from './primitives/Icon.tsx';
import { useT } from './primitives/language.tsx';

/** info のトーストが出ている時間。 */
export const INFO_TOAST_MS = 4000;

/**
 * 画面右下に積む知らせ。
 * 上から error と info のトースト、並べきれない入力待ちの数、入力待ちのカードの順に積む。
 * トーストは操作の結果だけである。戻る時刻の札、通知の誘い、保持期間の帯、互換の知らせはベルの一覧にある（PR 29）。
 * 入力待ちのカードは新しいものほど下（窓の角に近い側）に来る。
 * どの札も、種類の色を敷いた見出しと、その下の本文の 2 段でできている。
 * 時間で消すのは info だけで、時間切れはトーストごとに持つ。
 */
export function ToastStack(props: ToastsProps) {
  const emit = useEmit();
  const t = useT();
  return (
    <div className="toasts">
      {props.toasts.map((toast) => (toast.level === 'error' ? <ErrorToast key={toast.id} toast={toast} /> : <InfoToast key={toast.id} toast={toast} />))}
      {props.arrived && <ArrivedCard count={props.arrived.count} blocked={props.blocked} />}
      {/* 新しく積まれたカードを読み上げに届ける。 */}
      <div className="toast-waiting-list" aria-live="polite">
        {props.more > 0 && <button type="button" className="toast toast-pill toast-more" disabled={props.blocked} onClick={() => emit({ type: 'nav.go', to: { name: 'home' } })}>{t('toasts.more.view', { n: props.more })}</button>}
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
  const t = useT();
  const c = props.card;
  const label = c.question === null ? t('toasts.waiting.label', { name: c.name }) : t('toasts.waiting.labelQuestion', { name: c.name, question: c.question });
  return (
    <button type="button" className="toast notice" data-kind="waiting" aria-label={label} disabled={props.blocked} title={props.blocked ? t('toasts.blocked.title') : undefined} onClick={() => emit({ type: 'session.open', id: c.sessionId, focus: 'terminal' })}>
      <span className="notice-head">
        <span className="notice-dot" aria-hidden="true" />
        <span className="notice-label">{t('toasts.waiting.head')}</span>
        {c.question !== null && <><span className="notice-sep" aria-hidden="true">·</span><span className="notice-who">{c.name}</span></>}
        <span className="notice-end">{c.waited}</span>
      </span>
      <span className="notice-body"><span className="notice-title">{c.question ?? c.name}</span></span>
    </button>
  );
}

/**
/**
 * 他の PC から届いたプロジェクトの札（設計書 2.11.5）。
 * 同期で降りた分を 1 枚にまとめ、件数を出す。時間では消えず、「あとで決める」で下げる。ダイアログは開かない。
 * 「プロジェクトで見る」はプロジェクトの一覧へ移る。そこで、各行の「この PC にパスがありません」の札から場所を再指定できる。
 * 確認や入力のあるダイアログが開いている間（blocked）は、画面を移せないので「プロジェクトで見る」を押せない。
 */
function ArrivedCard(props: { count: number; blocked: boolean }) {
  const emit = useEmit();
  const t = useT();
  return (
    <div className="toast notice" data-kind="arrived" role="status">
      <div className="notice-head"><span className="notice-dot" aria-hidden="true" /><span className="notice-label">{t('projects.arrived.label')}</span></div>
      <div className="notice-body">
        <div className="notice-message">{t('projects.arrived.message', { n: props.count })}</div>
        <div className="notice-acts">
          <button type="button" className="btn btn-sm btn-primary" disabled={props.blocked} title={props.blocked ? t('toasts.blocked.title') : undefined} onClick={() => emit({ type: 'projects.arrived.view' })}>{t('projects.arrived.view')}</button>
          <button type="button" className="btn btn-sm btn-ghost" onClick={() => emit({ type: 'projects.arrived.dismiss' })}>{t('projects.arrived.later')}</button>
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

/**
 * info のトースト。
 * 時間で消え、押しても消せる。
 */
function InfoToast(props: { toast: Toast }) {
  const emit = useEmit();
  const t = useT();
  const dismiss = () => emit({ type: 'toast.dismiss', id: props.toast.id });
  const pause = useAutoDismiss(INFO_TOAST_MS, dismiss);
  return (
    <div className="toast notice" data-kind="info" role="status" onClick={dismiss} {...pause}>
      <div className="notice-head"><span className="notice-dot" aria-hidden="true" /><span className="notice-label">{t('toasts.info.head')}</span></div>
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
  const t = useT();
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
        <span className="notice-label">{t('toasts.error.head')}</span>
        <button type="button" className="notice-close" aria-label={t('common.button.close')} onClick={() => emit({ type: 'toast.dismiss', id: props.toast.id })}><Icon name="close" /></button>
      </div>
      <div className="notice-body">
        <div ref={message} className="notice-message">{props.toast.message}</div>
        {long && <button type="button" className="btn-link notice-more" aria-expanded={open} onClick={() => setOpen(!open)}>{t('toasts.error.more')}</button>}
      </div>
    </div>
  );
}
