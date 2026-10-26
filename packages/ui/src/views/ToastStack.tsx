import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useEmit } from '../action/chain.tsx';
import type { Toast } from '../mediator/types.ts';
import type { ContextShortCardProps, JoinCardProps, PhoneLaunchCardProps, PrepProgressCardProps, ToastsProps, WaitingCardProps } from '../presenters/toasts.ts';
import { newPrepKey } from '../lib/prepKey.ts';
import { PrepLine } from './LaunchPrepBox.tsx';
import type { UpdateAct, UpdateCardProps, WhatsNewCardProps } from '../presenters/update.ts';
import type { CodexVersionCardProps } from '../presenters/codexNotice.ts';
import type { OpencodeVersionCardProps } from '../presenters/opencodeNotice.ts';
import { ReasonGlyph } from './primitives/StatusDot.tsx';
import { Icon } from './primitives/Icon.tsx';
import { useT } from './primitives/language.tsx';
import { collapseOut, slideAway } from './primitives/motionKit.ts';
import { useMotionList } from './primitives/useMotionList.ts';

/** info のトーストが出ている時間。 */
export const INFO_TOAST_MS = 4000;

/** 札が出るときに右へ抜ける距離（px）。ガラスの面が横から入る距離（base.css の glass-arrive-side）と同じ値にする。 */
const EXIT_DX = 28;

/** 出る形（⑨ の b）。右へ抜けて薄れ、そのあと高さだけを畳む。抜ける途中で戻ったら、畳みは始めない。 */
async function exitCard(el: HTMLElement): Promise<void> {
  if (await slideAway(el, EXIT_DX)) await collapseOut(el, 'y', { fade: false });
}

/** 入りは CSS の slide のまま（JS では動かさない）。最後の 1 枚が消えるのもふつうの出来事なので、空になる描画でも出す形で残す。 */
const CARD_MOTION = { enter: 'none', flip: false, exit: exitCard, exitWhenEmpty: true } as const;

/** 出る間の札の印。見た目だけを残し、役も、焦点も、読み上げも持たせない。 */
type CardMotion = { ref: (el: HTMLElement | null) => void; leaving: boolean };
const motionAttrs = (m: CardMotion) => ({ ref: m.ref, 'aria-hidden': m.leaving ? true : undefined, inert: m.leaving || undefined });

type TopCard = { kind: 'toast'; toast: Toast } | { kind: 'update'; card: UpdateCardProps } | { kind: 'whatsNew'; card: WhatsNewCardProps } | { kind: 'opencodeVersion'; card: OpencodeVersionCardProps } | { kind: 'codexVersion'; card: CodexVersionCardProps } | { kind: 'arrived'; count: number } | { kind: 'join'; card: JoinCardProps } | { kind: 'phoneUndo'; name: string } | { kind: 'phoneLaunchMore'; n: number } | { kind: 'phoneLaunch'; card: PhoneLaunchCardProps } | { kind: 'prepProgress'; card: PrepProgressCardProps } | { kind: 'contextShort'; card: ContextShortCardProps };
type WaitingItem = { kind: 'more'; n: number } | { kind: 'waiting'; card: WaitingCardProps };
const topKey = (c: TopCard) => (c.kind === 'toast' ? `toast:${c.toast.id}` : c.kind === 'phoneLaunch' ? `phoneLaunch:${c.card.sessionId}` : c.kind === 'contextShort' ? `contextShort:${c.card.sessionId}` : c.kind);

/** スマホから起動した会話の通常の通知が出ている時間（Bypass permissions の通知は時間では消さない）。読む文が info より長いので、その 2 倍にする。 */
export const PHONE_LAUNCH_TOAST_MS = INFO_TOAST_MS * 2;
const waitingKey = (c: WaitingItem) => (c.kind === 'more' ? 'more' : `waiting:${c.card.sessionId}`);

/**
 * 画面右下に積む知らせ。
 * 上から error と info のトースト、更新の札、更新したあとの札、未検証の opencode の版の札、他の PC から届いたプロジェクトの札、参加リクエストの通知、スマホの解除の「元に戻す」、並べきれないスマホからの通知の数、スマホから起動した会話の通知、
 * 閉じた後に走り続ける起動前の準備の進み、起動後にコンテキストが足りなかった札、並べきれない入力待ちの数、入力待ちのカードの順に積む。
 * トーストは操作の結果だけである。戻る時刻の札はホームの帯に、通知の誘いは始める前の確認に、保持期間と互換の知らせはヘッダーの注意にある。
 * 入力待ちのカードは新しいものほど下（窓の角に近い側）に来る。
 * どの札も、種類の色を敷いた見出しと、その下の本文の 2 段でできている。
 * 時間で消すのは info だけで、時間切れはトーストごとに持つ。
 * 札は右から滑って入り（CSS の slide）、出るときは右へ抜けて薄れてから高さを畳む（useMotionList の exit）。ほかの札は押されて詰まる。
 * 出る間の札は前の中身のまま描き、役も焦点も持たない。
 */
export function ToastStack(props: ToastsProps) {
  const emit = useEmit();
  const t = useT();
  const tops: TopCard[] = [
    ...props.toasts.map((toast) => ({ kind: 'toast' as const, toast })),
    ...(props.update ? [{ kind: 'update' as const, card: props.update }] : []),
    ...(props.whatsNew ? [{ kind: 'whatsNew' as const, card: props.whatsNew }] : []),
    ...(props.opencodeVersion ? [{ kind: 'opencodeVersion' as const, card: props.opencodeVersion }] : []),
    ...(props.codexVersion ? [{ kind: 'codexVersion' as const, card: props.codexVersion }] : []),
    ...(props.arrived ? [{ kind: 'arrived' as const, count: props.arrived.count }] : []),
    ...(props.join ? [{ kind: 'join' as const, card: props.join }] : []),
    ...(props.phoneUndo ? [{ kind: 'phoneUndo' as const, name: props.phoneUndo.name }] : []),
    ...((props.phoneLaunchMore ?? 0) > 0 ? [{ kind: 'phoneLaunchMore' as const, n: props.phoneLaunchMore! }] : []),
    ...(props.phoneLaunches ?? []).map((card) => ({ kind: 'phoneLaunch' as const, card })),
    ...(props.prepProgress ? [{ kind: 'prepProgress' as const, card: props.prepProgress }] : []),
    ...(props.contextShorts ?? []).map((card) => ({ kind: 'contextShort' as const, card })),
  ];
  const waits: WaitingItem[] = [
    ...(props.more > 0 ? [{ kind: 'more' as const, n: props.more }] : []),
    ...props.waiting.map((card) => ({ kind: 'waiting' as const, card })),
  ];
  const top = useMotionList(tops, topKey, CARD_MOTION);
  const wait = useMotionList(waits, waitingKey, CARD_MOTION);
  return (
    <div className="toasts">
      {top.list.map(({ item, key, leaving }) => {
        const m = { ref: top.ref(key), leaving };
        if (item.kind === 'toast') return item.toast.level === 'error' ? <ErrorToast key={key} toast={item.toast} motion={m} /> : <InfoToast key={key} toast={item.toast} motion={m} />;
        if (item.kind === 'update') return <UpdateCard key={key} card={item.card} motion={m} />;
        if (item.kind === 'whatsNew') return <WhatsNewCard key={key} card={item.card} motion={m} />;
        if (item.kind === 'opencodeVersion') return <OpencodeVersionCard key={key} card={item.card} blocked={props.blocked} motion={m} />;
        if (item.kind === 'codexVersion') return <OpencodeVersionCard key={key} agent="codex" card={item.card} blocked={props.blocked} motion={m} />;
        if (item.kind === 'join') return <JoinCard key={key} card={item.card} blocked={props.blocked} motion={m} />;
        if (item.kind === 'phoneUndo') return <PhoneUndoCard key={key} name={item.name} motion={m} />;
        if (item.kind === 'phoneLaunch') return <PhoneLaunchCard key={key} card={item.card} blocked={props.blocked} motion={m} />;
        if (item.kind === 'prepProgress') return <PrepProgressCard key={key} card={item.card} motion={m} />;
        if (item.kind === 'contextShort') return <ContextShortCard key={key} card={item.card} motion={m} />;
        // 並べきれないスマホからの通知の数。押す先は無いので、ボタンにせず文だけの 1 行にする。
        if (item.kind === 'phoneLaunchMore') return <div key={key} className="toast toast-pill" data-kind="phone-launch-more" {...motionAttrs(m)}>{t('phoneLaunch.notice.more', { n: item.n })}</div>;
        return <ArrivedCard key={key} count={item.count} blocked={props.blocked} motion={m} />;
      })}
      {/* 新しく積まれたカードを読み上げに届ける。 */}
      <div className="toast-waiting-list" aria-live="polite">
        {wait.list.map(({ item, key, leaving }) => {
          const m = { ref: wait.ref(key), leaving };
          return item.kind === 'more'
            ? <button key={key} type="button" className="toast toast-pill toast-more" disabled={props.blocked} {...motionAttrs(m)} onClick={() => emit({ type: 'nav.go', to: { name: 'home' } })}>{t('toasts.more.view', { n: item.n })}</button>
            : <WaitingCard key={key} card={item.card} blocked={props.blocked} motion={m} />;
        })}
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
function WaitingCard(props: { card: WaitingCardProps; blocked: boolean; motion: CardMotion }) {
  const emit = useEmit();
  const t = useT();
  const c = props.card;
  // 許可待ちは、問いの代わりに道具と命令を出す（試作 stop-reason-proto の K1）。リセット済みは、続きを指示するよう言う。
  const ask = c.reason === 'permission' ? c.ask : null;
  const label = c.reason === 'permission'
    ? (ask ? t('stop.toast.permissionLabel', { name: c.name, what: `${ask.tool} ${ask.input}`.trim() }) : t('stop.toast.permissionLabelBare', { name: c.name }))
    : c.reason === 'reset' ? t('stop.toast.resetLabel', { name: c.name })
      : c.question === null ? t('toasts.waiting.label', { name: c.name }) : t('toasts.waiting.labelQuestion', { name: c.name, question: c.question });
  const head = c.reason === 'permission' ? t('stop.state.permission') : c.reason === 'reset' ? t('stop.state.reset') : t('toasts.waiting.head');
  const named = ask !== null || c.question !== null;
  return (
    <button type="button" className="toast notice" data-kind="waiting" data-reason={c.reason ?? undefined} aria-label={label} {...motionAttrs(props.motion)} disabled={props.blocked} title={props.blocked ? t('toasts.blocked.title') : undefined} onClick={() => emit({ type: 'session.open', id: c.sessionId, focus: 'terminal' })}>
      <span className="notice-head">
        {c.reason === 'permission' ? <ReasonGlyph reason="permission" /> : <span className="notice-dot" aria-hidden="true" />}
        <span className="notice-label">{head}</span>
        {named && <><span className="notice-sep" aria-hidden="true">·</span><span className="notice-who">{c.name}</span></>}
        <span className="notice-end">{c.waited}</span>
      </span>
      <span className="notice-body">
        {ask
          ? <span className="notice-title"><span className="notice-tool">{ask.tool}</span>{ask.input !== '' && <code className="notice-cmd">{ask.input}</code>}</span>
          : <span className="notice-title">{c.question ?? c.name}</span>}
      </span>
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
function ArrivedCard(props: { count: number; blocked: boolean; motion: CardMotion }) {
  const emit = useEmit();
  const t = useT();
  return (
    <div className="toast notice" data-kind="arrived" role="status" {...motionAttrs(props.motion)}>
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
 * 参加リクエストの通知（試作 C1）。この PC が発行した参加コードで、新しい PC が参加リクエストを送ったときに出す。
 * 名前と OS と確認コードを出し、「確認して承認」で設定のクラウド同期の「PC を追加」の欄（A1）へ移る。承認と拒否はそこで行う。
 * 時間では消えず、承認か拒否か期限切れで消える（サーバーの承認の状態が requested でなくなる）。
 * 確認や入力のあるダイアログが開いている間（blocked）は、画面を移せないので押せない。
 */
function JoinCard(props: { card: JoinCardProps; blocked: boolean; motion: CardMotion }) {
  const emit = useEmit();
  const t = useT();
  const c = props.card;
  return (
    <div className="toast notice" data-kind="join" role="status" aria-label={t('cloudMember.toast.head')} {...motionAttrs(props.motion)}>
      <div className="notice-head"><span className="notice-dot" aria-hidden="true" /><span className="notice-label">{t('cloudMember.toast.head')}</span></div>
      <div className="notice-body">
        <div className="notice-title">{t('cloudMember.toast.title', { name: c.name })}</div>
        <div className="notice-sub">{c.os}</div>
        <div className="notice-sas"><span>{t('cloudMember.join.sasLabel')}</span><b className="mono">{c.sas}</b></div>
        <div className="notice-acts">
          <button type="button" className="btn btn-sm btn-primary" disabled={props.blocked} title={props.blocked ? t('toasts.blocked.title') : undefined} onClick={() => emit({ type: 'nav.go', to: { name: 'settings', at: 'cloud' } })}>{t('cloudMember.toast.open')}</button>
        </div>
      </div>
    </div>
  );
}

/**
 * スマホの解除の「元に戻す」（試作 E2）。スマホの行の「解除」の 1 クリックで出す。
 * 5 秒は Runtime が数え（この札は時間で消さない）、その間は Worker に何も送らない。5 秒たつと解除を送り、札は消える。
 * 「元に戻す」で行が戻る。画面を移さないので、ダイアログが開いていても押せる。
 */
function PhoneUndoCard(props: { name: string; motion: CardMotion }) {
  const emit = useEmit();
  const t = useT();
  return (
    <div className="toast notice" data-kind="phone-undo" role="status" aria-label={t('cloudMember.phone.undoHead')} {...motionAttrs(props.motion)}>
      <div className="notice-head"><span className="notice-dot" aria-hidden="true" /><span className="notice-label">{t('cloudMember.phone.undoHead')}</span></div>
      <div className="notice-body">
        <div className="notice-title">{t('cloudMember.phone.undoTitle', { name: props.name })}</div>
        <div className="notice-sub">{t('cloudMember.phone.undoBody', { name: props.name })}</div>
        <div className="notice-acts">
          <button type="button" className="btn btn-sm" onClick={() => emit({ type: 'cloud.phone.undo' })}>{t('cloudMember.phone.undo')}</button>
        </div>
      </div>
    </div>
  );
}

/**
 * スマホから起動した会話の通知（試作 F1）。見出し「スマホから起動」、題「〈スマホの名前〉から起動：〈プロジェクト〉（〈権限モード〉）」、その下に会話の名前、「開く」。
 * Bypass permissions で起こしたものは赤い通知（data-tone="err"、role="alert"）にし、注意の文と「停止」を置く。
 * 時間では消さず、見出しの閉じるボタンで下げる（run が終わって「停止」が消えた後も閉じられるように）。閉じるは画面を移さないので、ダイアログの間も押せる。
 * 通常の通知は PHONE_LAUNCH_TOAST_MS で消える（乗せている間は止める）。
 * 確認や入力のあるダイアログが開いている間（blocked）は、画面を移せず停止の確認も出せないので押せない。
 */
function PhoneLaunchCard(props: { card: PhoneLaunchCardProps; blocked: boolean; motion: CardMotion }) {
  const emit = useEmit();
  const t = useT();
  const c = props.card;
  const pause = useAutoDismiss(c.bypass ? null : PHONE_LAUNCH_TOAST_MS, () => emit({ type: 'phoneLaunch.dismiss', sessionId: c.sessionId }));
  const head = t(c.bypass ? 'phoneLaunch.notice.headBypass' : 'phoneLaunch.notice.head');
  const blockedTitle = props.blocked ? t('toasts.blocked.title') : undefined;
  return (
    <div className="toast notice" data-kind="phone-launch" data-tone={c.bypass ? 'err' : undefined} role={c.bypass ? 'alert' : 'status'} aria-label={head} {...motionAttrs(props.motion)} {...pause}>
      <div className="notice-head">
        {c.bypass ? <Icon name="alert" /> : <span className="notice-dot" aria-hidden="true" />}
        <span className="notice-label">{head}</span>
        {c.bypass && <button type="button" className="notice-close" aria-label={t('common.button.close')} onClick={() => emit({ type: 'phoneLaunch.dismiss', sessionId: c.sessionId })}><Icon name="close" /></button>}
      </div>
      <div className="notice-body">
        <div className="notice-title">{c.title}</div>
        <div className="notice-sub">{c.name}</div>
        {c.bypass && <div className="notice-message">{t('phoneLaunch.notice.bypassNote')}</div>}
        <div className="notice-acts">
          {c.bypass && c.stop && <button type="button" className="btn btn-sm btn-danger" disabled={props.blocked} title={blockedTitle} onClick={() => emit({ type: 'phoneLaunch.stop', sessionId: c.sessionId, stop: c.stop! })}>{t('phoneLaunch.button.stop')}</button>}
          <button type="button" className={c.bypass ? 'btn btn-sm btn-primary' : 'btn btn-sm'} disabled={props.blocked} title={blockedTitle} onClick={() => emit({ type: 'phoneLaunch.open', sessionId: c.sessionId })}>{t('phoneLaunch.button.open')}</button>
        </div>
      </div>
    </div>
  );
}

/**
 * ダイアログを閉じた後に走り続ける起動前の準備の進み（試作 s5-launch-prep の案 1の「途中で閉じる」）。1 行の今の段と経過時間、「準備を中止」を出す。
 * 準備が済めば「開始しました」の知らせ、失敗すればエラーのトーストに替わる（mediator/launch.ts）。画面を移さないので、ダイアログが開いていても押せる。
 */
function PrepProgressCard(props: { card: PrepProgressCardProps; motion: CardMotion }) {
  const emit = useEmit();
  const t = useT();
  const c = props.card;
  return (
    <div className="toast notice" data-kind="prep-progress" role="status" {...motionAttrs(props.motion)}>
      <div className="notice-body">
        <PrepLine text={c.line} startedAt={c.startedAt} active />
        <div className="notice-acts">
          <button type="button" className="btn btn-sm" onClick={() => emit({ type: 'launchPrep.cancel', key: c.key })}>{t('launchPrep.button.cancel')}</button>
        </div>
      </div>
    </div>
  );
}

/**
 * 起動した後にコンテキストが足りなかった会話の札（試作の §3）。同じ会話は 1 枚で、見出し、本文、「再ロードして再開」と「閉じる」を出す。
 * 「再ロードして再開」は新しい鍵を作って整え直しを頼み、進みは札の中に 1 行で出す（その間はボタンを外す）。済んだら「再ロードしました」の知らせに替わり、PHONE_LAUNCH_TOAST_MS で下がる。
 * 画面を移さないので、ダイアログが開いていても押せる。
 */
function ContextShortCard(props: { card: ContextShortCardProps; motion: CardMotion }) {
  const emit = useEmit();
  const t = useT();
  const c = props.card;
  const dismiss = () => emit({ type: 'launchPrep.short.dismiss', sessionId: c.sessionId });
  const pause = useAutoDismiss(c.done ? PHONE_LAUNCH_TOAST_MS : null, dismiss);
  if (c.done) {
    return (
      <div className="toast notice" data-kind="context-short" data-tone="ok" role="status" {...motionAttrs(props.motion)} {...pause}>
        <div className="notice-head">
          <Icon name="check" />
          <button type="button" className="notice-close" aria-label={t('common.button.close')} onClick={dismiss}><Icon name="close" /></button>
        </div>
        <div className="notice-body"><div className="notice-title">{t('launchPrep.short.done')}</div></div>
      </div>
    );
  }
  return (
    <div className="toast notice" data-kind="context-short" role="status" aria-label={t('launchPrep.short.title')} {...motionAttrs(props.motion)}>
      <div className="notice-head"><Icon name="alert" /><span className="notice-label">{t('launchPrep.short.title')}</span></div>
      <div className="notice-body">
        <div className="notice-message">{t('launchPrep.short.body')}</div>
        {c.fix ? <PrepLine text={c.fix.text} startedAt={c.fix.startedAt} active /> : (
          <div className="notice-acts">
            <button type="button" className="btn btn-sm btn-primary" onClick={() => emit({ type: 'launchPrep.short.fix', sessionId: c.sessionId, prepKey: newPrepKey() })}>{t('launchPrep.short.fix')}</button>
            <button type="button" className="btn btn-sm btn-ghost" onClick={dismiss}>{t('launchPrep.short.close')}</button>
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * アプリの更新の札（段 5-4、試作の A2）。新しい版が出たこと、取得の進み、再起動の確認、失敗までを、この 1 枚の中で移す。
 * 時間では消えず、「あとで」か「閉じる」で下げる（その版の札は 2 度出さない）。取得中とインストール中は操作を持たない。
 * 画面を移さないので、ダイアログが開いていても押せる。
 */
function UpdateCard(props: { card: UpdateCardProps; motion: CardMotion }) {
  const t = useT();
  const c = props.card;
  return (
    <div className="toast notice" data-kind="update" data-tone={c.tone} role="status" {...motionAttrs(props.motion)}>
      <div className="notice-head">
        <Icon name={c.tone === 'err' ? 'alert' : c.tone === 'ok' ? 'check' : 'download'} />
        <span className="notice-label">{c.head}</span>
      </div>
      <div className="notice-body">
        <div className="notice-title">{c.title}</div>
        {c.progress && (
          <>
            <div className="update-bar" role="progressbar" aria-label={t('update.card.progressLabel')} aria-valuemin={0} aria-valuemax={100} aria-valuenow={c.progress.percent ?? undefined} data-indeterminate={c.progress.percent === null ? 'true' : undefined}>
              <i style={c.progress.percent === null ? undefined : { width: `${c.progress.percent}%` }} />
            </div>
            <div className="notice-sub">{c.progress.label}</div>
          </>
        )}
        {c.detail !== null && <div className="notice-sub">{c.detail}</div>}
        <NotePoints beforeLabel={c.beforeLabel} before={c.before} points={c.points} />
        <NoticeActs actions={c.actions} />
      </div>
    </div>
  );
}

/**
 * 更新したあと、初めて開いたときの札（試作の B1）。要点と、版を飛ばしたときに含む版を言い、閉じるかすべて読むで下げる。
 * 時間では消えない。読みに行かなくても、閉じれば次の版までは出さない。
 */
function WhatsNewCard(props: { card: WhatsNewCardProps; motion: CardMotion }) {
  const c = props.card;
  return (
    <div className="toast notice" data-kind="whats-new" data-tone="ok" role="status" {...motionAttrs(props.motion)}>
      <div className="notice-head">
        <Icon name="check" />
        <span className="notice-label">{c.head}</span>
      </div>
      <div className="notice-body">
        <div className="notice-title">{c.title}</div>
        <NotePoints beforeLabel={c.beforeLabel} before={c.before} points={c.points} />
        {c.sub !== null && <div className="notice-sub">{c.sub}</div>}
        <NoticeActs actions={c.actions} />
      </div>
    </div>
  );
}

/**
 * 未検証の opencode の版の札（C7、試作の N1）。Codex の札（C4）も同じ形で、agent="codex" のとき操作が codex の操作になる。更新の札と同じ形と出入りで、見出しは Paused と同じ黄にする。
 * 見出しに種類と版、その下に題と本文、ボタン（設定を開く）と文字だけの操作（このまま続行）を 1 行に並べる。
 * 時間では消えず、「このまま続行」か閉じるで下げる。その版の札は二度出さない（mediator/opencodeVersion.ts）。
 * 確認や入力のあるダイアログが開いている間（blocked）は、画面を移す「設定を開く」だけを押せなくする。
 */
function OpencodeVersionCard(props: { card: OpencodeVersionCardProps; blocked: boolean; motion: CardMotion; agent?: 'codex' }) {
  const emit = useEmit();
  const t = useT();
  const c = props.card;
  const kind = props.agent ?? 'opencode';
  const proceed = () => emit({ type: `${kind}.version.continue`, version: c.version });
  return (
    <div className="toast notice" data-kind={`${kind}-version`} role="status" aria-label={c.title} {...motionAttrs(props.motion)}>
      <div className="notice-head">
        <Icon name="alert" />
        <span className="notice-label">{c.head}</span>
        <span className="notice-sep" aria-hidden="true">·</span><span className="notice-who">{c.who}</span>
        <button type="button" className="notice-close" aria-label={t('common.button.close')} onClick={proceed}><Icon name="close" /></button>
      </div>
      <div className="notice-body">
        <div className="notice-title">{c.title}</div>
        <div className="notice-sub">{c.body}</div>
        <div className="notice-acts">
          <button type="button" className="btn btn-sm" disabled={props.blocked} title={props.blocked ? t('toasts.blocked.title') : undefined} onClick={() => emit({ type: `${kind}.version.settings`, version: c.version })}>{c.settings}</button>
          <button type="button" className="btn-link notice-link" onClick={proceed}>{c.proceed}</button>
        </div>
      </div>
    </div>
  );
}

/** リリースノートの注意（黄色い地、試作の C1）と要点の箇条書き。どちらも無ければ何も描かない。 */
function NotePoints(props: { beforeLabel: string; before: string | null; points: string[] }) {
  return (
    <>
      {/* 行を切るのは内側の span にする。外側で切ると、地の余白に次の行が覗き、箇条書きの点も消える。 */}
      {props.before !== null && <div className="notice-before"><span><strong>{props.beforeLabel}</strong>{props.before}</span></div>}
      {props.points.length > 0 && <ul className="notice-points">{props.points.map((p) => <li key={p}><span>{p}</span></li>)}</ul>}
    </>
  );
}

/** 札の操作の段。link の操作は枠の無い文字だけにして、左に寄せる。 */
function NoticeActs(props: { actions: UpdateAct[] }) {
  const emit = useEmit();
  if (props.actions.length === 0) return null;
  return (
    <div className="notice-acts">
      {props.actions.map((a) => <button key={a.label} type="button" className={a.link ? 'btn-link notice-link' : `btn btn-sm ${a.primary ? 'btn-primary' : 'btn-ghost'}`} onClick={() => emit(a.action)}>{a.label}</button>)}
    </div>
  );
}

/**
 * ms が経ったら onDone を呼ぶ。ms が null なら時間では呼ばない。
 * マウスを乗せている間とフォーカスが中にある間は止め、離れたら残りの時間から数え直す。
 */
function useAutoDismiss(ms: number | null, onDone: () => void) {
  const [paused, setPaused] = useState(false);
  const left = useRef(ms);
  const done = useRef(onDone);
  done.current = onDone;
  useEffect(() => {
    if (paused || left.current === null) return;
    const started = Date.now();
    const t = setTimeout(() => done.current(), left.current);
    return () => { clearTimeout(t); left.current = Math.max(0, (left.current ?? 0) - (Date.now() - started)); };
  }, [paused]);
  const hold = () => setPaused(true);
  const release = () => setPaused(false);
  return { onMouseEnter: hold, onMouseLeave: release, onFocus: hold, onBlur: release };
}

/**
 * info のトースト。
 * 時間で消え、押しても消せる。長さは既定が INFO_TOAST_MS で、holdMs を持つものはその長さである。
 */
function InfoToast(props: { toast: Toast; motion: CardMotion }) {
  const emit = useEmit();
  const t = useT();
  const dismiss = () => emit({ type: 'toast.dismiss', id: props.toast.id });
  const pause = useAutoDismiss(props.toast.holdMs ?? INFO_TOAST_MS, dismiss);
  return (
    <div className="toast notice" data-kind="info" role="status" {...motionAttrs(props.motion)} onClick={dismiss} {...pause}>
      <div className="notice-head"><span className="notice-dot" aria-hidden="true" /><span className="notice-label">{t('toasts.info.head')}</span></div>
      <div className="notice-body">
        <div className="notice-message">{props.toast.message}</div>
        {props.toast.action && (
          <button type="button" className="btn btn-sm notice-action" onClick={(e) => { e.stopPropagation(); emit(props.toast.action!.send); dismiss(); }}>{props.toast.action.label}</button>
        )}
      </div>
    </div>
  );
}

/**
 * error のトースト。
 * 読み落とさないよう時間では消さず、閉じるボタンで消す。
 * holdMs を持つもの（プロジェクトを外で開けなかったときなど、押した直後に読めば足りる失敗）だけは、その長さで消える。乗せている間は止める。
 * 本文は 2 行まで見せ、収まらないときだけ「詳しく」で開く。
 */
function ErrorToast(props: { toast: Toast; motion: CardMotion }) {
  const emit = useEmit();
  const t = useT();
  const message = useRef<HTMLDivElement>(null);
  const [long, setLong] = useState(false);
  const [open, setOpen] = useState(false);
  const pause = useAutoDismiss(props.toast.holdMs ?? null, () => emit({ type: 'toast.dismiss', id: props.toast.id }));
  // 2 行で切れているかは、描いてから測るしかない。
  useLayoutEffect(() => {
    const el = message.current;
    if (el) setLong(el.scrollHeight > el.clientHeight + 1);
  }, [props.toast.message]);
  return (
    <div className="toast notice" data-kind="error" role="alert" data-open={open ? 'true' : undefined} {...motionAttrs(props.motion)} {...pause}>
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
