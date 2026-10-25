import { useId, useLayoutEffect, useRef } from 'react';
import type { LaunchPrepChoice } from '@agent-hangar/shared';
import { elapsedLabel, type LaunchPrepAskView, type LaunchPrepView } from '../presenters/launchPrep.ts';
import { Icon } from './primitives/Icon.tsx';
import { useT } from './primitives/language.tsx';
import { collapseOut, fadeIn, growIn, motionOn } from './primitives/motionKit.ts';
import { useNow } from './primitives/useNow.ts';
import { usePresence } from './primitives/usePresence.ts';

/**
 * 起動前の準備の見せ方（docs/design.md「起動前の準備」、試作 s5-launch-prep の案 1）。新しいセッションのダイアログの本文の末尾に置く 3 つの箱。
 * どれも出るときは高さを 0 から伸ばし（growIn）、消えるときは高さを畳んでから外れる（collapseOut）。畳む間は前の中身のまま描き、読み上げからは外す。
 */

/** 伸びて入り、畳んで出る箱の出入り。open の向きが変わった描画でだけ動かす。 */
function useGrow<E extends HTMLElement>(open: boolean) {
  const p = usePresence<E>(open, (el) => (motionOn(el) ? collapseOut(el) : null));
  useLayoutEffect(() => {
    if (open && p.ref.current) growIn(p.ref.current);
    // 入る向きの変わり目だけで動かす。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);
  return p;
}

/** 畳む間も中身を読めるように、最後に渡されたものを控えておく。 */
function useLast<T>(value: T | null): T | null {
  const last = useRef(value);
  if (value !== null) last.current = value;
  return value ?? last.current;
}

/** 今の段の 1 行（スピナー、文、経過時間 m:ss）。ダイアログの箱と右下の札が同じ形で使う。 */
export function PrepLine(props: { text: string; startedAt: number | null; active: boolean }) {
  const now = useNow(1000, { active: props.active && props.startedAt !== null });
  return (
    <div className="launch-prep-line">
      <span className="int-ring" data-spin="true" aria-hidden="true" />
      <span className="launch-prep-text">{props.text}</span>
      {props.startedAt !== null && <span className="launch-prep-time">{elapsedLabel(now - props.startedAt)}</span>}
    </div>
  );
}

/** 済んだ段の 1 行（✓）。入るときに薄れから現す。 */
function DoneRow(props: { text: string }) {
  const ref = useRef<HTMLLIElement>(null);
  useLayoutEffect(() => { if (ref.current) fadeIn(ref.current, '--dur-fast'); }, []);
  return <li ref={ref}><Icon name="check" />{props.text}</li>;
}

/**
 * 進みの箱。1 行の今の段、load と reload の間だけの進みの帯（中身は不定）、済んだ段の一覧を出す。
 * open は、準備が走っていて起動を待っている間（呼び手が決める）。経過時間は準備を始めた時刻から数える。
 */
export function LaunchPrepBox(props: { open: boolean; view: LaunchPrepView | null }) {
  const box = useGrow<HTMLDivElement>(props.open);
  const view = useLast(props.view);
  if (!box.mounted || !view) return null;
  return (
    <div ref={box.ref} className="launch-prep" role={box.leaving ? undefined : 'status'} aria-hidden={box.leaving ? 'true' : undefined}>
      <PrepLine text={view.line.text} startedAt={view.startedAt} active={props.open} />
      {view.line.bar
        ? <div className="update-bar launch-prep-bar" role="progressbar" aria-label={view.line.text} data-indeterminate="true"><i /></div>
        : <span className="launch-prep-bar-gap" aria-hidden="true" />}
      {view.done.length > 0 && <ul className="launch-prep-done">{view.done.map((d) => <DoneRow key={d.id} text={d.text} />)}</ul>}
    </div>
  );
}

/** 「準備を中止」。進みの間だけ、始めるボタンの左に出す。出るときに薄れから現す。 */
export function CancelPrepButton(props: { onClick: () => void }) {
  const t = useT();
  const ref = useRef<HTMLButtonElement>(null);
  useLayoutEffect(() => { if (ref.current) fadeIn(ref.current, '--dur-fast'); }, []);
  return <button ref={ref} type="button" className="btn" onClick={props.onClick}>{t('launchPrep.button.cancel')}</button>;
}

/**
 * 準備が問いで止まったときの札（試作の黄色い札）。見出し、本文、補足、答えのボタンを出す。
 * 答えは起動の要求に添えて送り直す（呼び手が onChoose で送る）。
 */
export function LaunchPrepAsk(props: { ask: LaunchPrepAskView | null; onChoose: (choice: LaunchPrepChoice) => void }) {
  const card = useGrow<HTMLDivElement>(props.ask !== null);
  const ask = useLast(props.ask);
  const titleId = useId();
  if (!card.mounted || !ask) return null;
  return (
    <div ref={card.ref} className="launch-card" data-tone="warn" role={card.leaving ? undefined : 'group'} aria-labelledby={card.leaving ? undefined : titleId} aria-hidden={card.leaving ? 'true' : undefined}>
      <div className="launch-card-h" id={titleId}>{ask.title}</div>
      <div className="launch-card-b">{ask.body}</div>
      {ask.hint && <div className="launch-card-b">{ask.hint}</div>}
      <div className="launch-card-acts">
        {ask.choices.map((c) => (
          <button key={c.id} type="button" className={c.primary ? 'btn btn-sm btn-primary' : 'btn btn-sm'} onClick={() => props.onChoose(c.choice)}>{c.label}</button>
        ))}
      </div>
    </div>
  );
}

/** 準備が失敗したときの札。見出しは「モデルのロードに失敗しました」か「（接続先）の準備に失敗しました」、本文は理由。 */
export function LaunchPrepFailed(props: { reason: string | null; title: string | null }) {
  const card = useGrow<HTMLDivElement>(props.reason !== null);
  const reason = useLast(props.reason);
  const title = useLast(props.title);
  if (!card.mounted || reason === null) return null;
  return (
    <div ref={card.ref} className="launch-card" data-tone="bad" role={card.leaving ? undefined : 'alert'} aria-hidden={card.leaving ? 'true' : undefined}>
      <div className="launch-card-h">{title}</div>
      <div className="launch-card-b">{reason}</div>
    </div>
  );
}
