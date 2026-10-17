import { useEffect, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from 'react';
import { useEmit } from '../action/chain.tsx';
import { normalizeRecoveryTail, type CloudMemberProps, type CloudRecoveryProps } from '../presenters/cloudMember.ts';
import { saveRecoveryKeyFile } from '../runtime/recoveryKeyOut.ts';
import { RECOVERY_SHOW_MS } from '../store/cloudMember.ts';
import { clock, Strip, useSwap } from './CloudMember.tsx';
import { CopyButton } from './primitives/CommandLine.tsx';
import { Icon } from './primitives/Icon.tsx';
import { useT } from './primitives/language.tsx';
import { collapseOut, growIn, motionOn } from './primitives/motionKit.ts';
import { useNow } from './primitives/useNow.ts';
import { usePresence } from './primitives/usePresence.ts';

/**
 * 設定のクラウド同期の節の「リカバリーキーを再発行」（試作 cloud-e2e の D2）。
 * 試作の「リカバリーキーを表示」は「リカバリーキーを再発行」にした（設計書「試作との差」）。PC はリカバリーキーの秘密鍵を持たないためである。
 * 押すと節の中に欄が開き（growIn）、再発行の確認、作成、表示、末尾 4 文字の入力の段を、同じ欄の中で切り替える（resizeFrom と fadeIn）。
 * 暗号鍵は 120 秒たつと伏せる。「保存しました」で入力の欄が伸びて開き（growIn）、暗号鍵を伏せ字にする。
 * 入力の段では、コピー、ファイルに保存、残り時間を出さない。保存先を開いて読み返させるためで、コピーで末尾を確かめられないようにする。
 * ファイルに保存は、殻の中なら殻の保存のダイアログ、ブラウザならダウンロード（runtime/recoveryKeyOut.ts）。
 * コピーは、60 秒たってクリップボードが写した値のままなら空にする。
 * 末尾 4 文字が合うまで「完了」は押せない。確認が済むまで、サーバーは名簿も keybox も差し替えない。
 */

/** 伏せ字。区切りの位置はそのままに、文字だけを●にする。 */
const maskOf = (secret: string): string => secret.replace(/[^-]/g, '●');

const isOpen = (k: CloudRecoveryProps['kind']): boolean => k === 'asking' || k === 'issuing' || k === 'shown';

/** 「リカバリーキーを再発行」のボタン。今すぐ同期の段に置き、欄が開いている間は押せない。 */
export function CloudRecoveryButton(props: { m: CloudMemberProps }) {
  const emit = useEmit();
  const t = useT();
  return <button type="button" className="btn btn-ghost" disabled={isOpen(props.m.recovery.kind)} onClick={() => emit({ type: 'cloud.recovery.ask' })}>{t('cloudMember.recovery.button')}</button>;
}

/**
 * リカバリーキーの欄。ボタンの下に growIn で開き、閉じると collapseOut で畳んでから外す。
 * 節が外れたら（設定の画面を離れたなど）、リカバリーキーの文字列を Store から捨てる。
 */
export function CloudRecoveryKey(props: { m: CloudMemberProps }) {
  const emit = useEmit();
  const r = props.m.recovery;
  const open = r.kind !== 'idle';
  const panel = usePresence<HTMLElement>(open, (el) => (motionOn(el) ? collapseOut(el) : null));
  // 閉じる動きの間は、最後に開いていた段の姿で描く（暗号鍵は伏せた姿になる）。
  const last = useRef<CloudRecoveryProps | null>(open ? r : null);
  if (open) last.current = r;
  const live = useRef(false);
  const wasOpen = useRef(open);
  useLayoutEffect(() => {
    if (open && !wasOpen.current && live.current && panel.ref.current) growIn(panel.ref.current);
    wasOpen.current = open;
    live.current = true;
  }, [open, panel.ref]);
  const emitRef = useRef(emit);
  emitRef.current = emit;
  const kind = useRef(r.kind);
  kind.current = r.kind;
  useEffect(() => () => { if (kind.current !== 'idle') emitRef.current({ type: 'cloud.recovery.close' }); }, []);
  return panel.mounted && last.current ? <RecoveryPanel r={last.current} panelRef={panel.ref} closing={!open} /> : null;
}

/** 欄の中身。段（確認、作成、表示、済み、失敗）が替わるたびに、高さを resizeFrom で動かす。 */
function RecoveryPanel(props: { r: CloudRecoveryProps; panelRef: RefObject<HTMLElement | null>; closing: boolean }) {
  const emit = useEmit();
  const t = useT();
  const r = props.r;
  const swap = useSwap<HTMLElement>(r.kind);
  // 欄の外枠（usePresence の ref）と、高さを動かす箱（swap.box）は同じ要素にする。
  const setRef = (el: HTMLElement | null) => {
    swap.box.current = el;
    props.panelRef.current = el;
  };
  const close = () => emit({ type: 'cloud.recovery.close' });
  let body: ReactNode;
  if (r.kind === 'asking') {
    body = (
      <Strip tone="warn">
        <p><b>{t('cloudMember.recovery.askTitle')}</b></p>
        <p>{t('cloudMember.recovery.askBody')}</p>
        <div className="btns">
          <button type="button" className="btn btn-sm" onClick={close}>{t('cloudMember.common.cancel')}</button>
          <button type="button" className="btn btn-sm btn-primary" onClick={() => emit({ type: 'cloud.recovery.reissue' })}>{t('cloudMember.recovery.askDo')}</button>
        </div>
      </Strip>
    );
  } else if (r.kind === 'issuing') {
    body = <div className="cm-wait" role="status">{t('cloudMember.recovery.issuing')}</div>;
  } else if (r.kind === 'shown') {
    body = <RecoveryShown r={r} closing={props.closing} />;
  } else if (r.kind === 'done') {
    body = (
      <Strip tone="ok" role="status">
        <p>{t('cloudMember.recovery.finished')}</p>
        <div className="btns"><button type="button" className="btn btn-sm" onClick={close}>{t('cloudMember.common.close')}</button></div>
      </Strip>
    );
  } else {
    body = (
      <Strip tone="danger" role="alert">
        <p>{r.message}</p>
        <div className="btns">
          <button type="button" className="btn btn-sm" onClick={close}>{t('cloudMember.common.close')}</button>
          <button type="button" className="btn btn-sm btn-primary" onClick={() => emit({ type: 'cloud.recovery.reissue' })}>{t('cloudMember.recovery.again')}</button>
        </div>
      </Strip>
    );
  }
  return (
    <section ref={setRef} className="cm-add cm-rk" aria-label={t('cloudMember.recovery.region')}>
      <div ref={swap.body} className="cm-add-body cm-rk-body">{body}</div>
    </section>
  );
}

/**
 * 表示と入力の段（試作 D2 の「リカバリーキーを表示」と「末尾を入力」）。
 * 見出し、作成日、URL、暗号鍵（区切りつきの base32）を並べ、コピーとファイルへの保存、120 秒の残り時間の棒を出す。
 * 入力の段では暗号鍵を伏せ字にし、コピー、保存、残り時間を出さず、戻る口として小さな「もう一度表示」だけを残す。
 * 時間切れの帯は入力の段では出さない（入力の段から時間が尽きても、帯と入力の欄を同時に出さない）。
 * 末尾 4 文字が合うまで「完了」を押せない。入力はサーバーの照合と同じくそろえて比べる。
 */
function RecoveryShown(props: { r: CloudRecoveryProps; closing: boolean }) {
  const emit = useEmit();
  const t = useT();
  const r = props.r;
  const hideAt = r.hideAt ?? 0;
  const now = useNow(1000, { sync: hideAt });
  const leftMs = Math.max(0, hideAt - now);
  const hidden = !r.entering && (leftMs <= 0 || props.closing);
  const masked = r.entering || hidden || props.closing;
  const [saveFailed, setSaveFailed] = useState(false);
  const save = () => {
    setSaveFailed(false);
    saveRecoveryKeyFile(r.text ?? '').catch(() => setSaveFailed(true));
  };
  const [tail, setTail] = useState('');
  const typed = normalizeRecoveryTail(tail);
  const match = r.tail !== null && typed === r.tail;
  const enterBox = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  // 入力の欄は「保存しました」で現れたときだけ伸ばす（はじめから入力の段で描いたときは動かさない）。
  const live = useRef(false);
  const wasEntering = useRef(r.entering);
  useLayoutEffect(() => {
    if (r.entering && !wasEntering.current && live.current && enterBox.current) growIn(enterBox.current);
    wasEntering.current = r.entering;
    live.current = true;
  }, [r.entering]);
  useEffect(() => {
    if (r.entering) input.current?.focus();
    else setTail('');
  }, [r.entering]);
  const finish = () => { if (match && !r.busy) emit({ type: 'cloud.recovery.confirm', tail: typed }); };
  const secret = r.secret ?? '';
  return (
    <>
      <div className="cm-rk-title"><b>{t('cloudMember.recovery.title')}</b></div>
      <p className="cm-rk-lead">{t('cloudMember.recovery.lead')}</p>
      <div className="cm-rk-kit">
        <div className="cm-rk-text mono">
          <div className="cm-rk-heading">{r.heading}</div>
          {r.fields.map((f) => <div key={f.label}><span className="cm-rk-label">{f.label}:</span> <span className="cm-rk-value">{f.value}</span></div>)}
          <div>
            <span className="cm-rk-label">{r.secretLabel}:</span>{' '}
            {masked
              ? <span className="cm-rk-mask" aria-label={t('cloudMember.recovery.masked')}>{maskOf(secret)}</span>
              : <b className="cm-rk-key">{secret}</b>}
          </div>
        </div>
        {r.entering ? (
          <div className="cm-rk-acts">
            <button type="button" className="linkish" onClick={() => emit({ type: 'cloud.recovery.reveal' })}>{t('cloudMember.recovery.reveal')}</button>
          </div>
        ) : hidden ? (
          <Strip tone="warn">
            <p>{t('cloudMember.recovery.hidden')}</p>
            <div className="btns"><button type="button" className="btn btn-sm btn-primary" onClick={() => emit({ type: 'cloud.recovery.reveal' })}>{t('cloudMember.recovery.reveal')}</button></div>
          </Strip>
        ) : (
          <>
            <div className="btns cm-rk-acts">
              <CopyButton text={r.text ?? ''} label={t('cloudMember.recovery.copy')} ariaLabel={t('cloudMember.recovery.copyAria')} />
              <button type="button" className="copy-btn" onClick={save}>
                <Icon name="download" />
                <span>{t('cloudMember.recovery.save')}</span>
              </button>
            </div>
            {saveFailed && <div className="cm-rk-miss cm-rk-save-failed" role="alert">{t('cloudMember.recovery.saveFailed')}</div>}
            <div className="tbar" data-low={leftMs <= 10_000 ? 'true' : undefined} role="progressbar" aria-label={t('cloudMember.recovery.bar')} aria-valuemin={0} aria-valuemax={RECOVERY_SHOW_MS / 1000} aria-valuenow={Math.ceil(leftMs / 1000)}>
              <i style={{ width: `${Math.min(1, leftMs / RECOVERY_SHOW_MS) * 100}%` }} />
            </div>
            <small className="cm-faint">{t('cloudMember.recovery.left', { time: clock(leftMs) })}</small>
          </>
        )}
      </div>
      {!r.entering ? (
        <div className="btns">
          <button type="button" className="btn btn-sm" onClick={() => emit({ type: 'cloud.recovery.close' })}>{t('cloudMember.common.cancel')}</button>
          <button type="button" className="btn btn-sm btn-primary" onClick={() => emit({ type: 'cloud.recovery.saved' })}>{t('cloudMember.recovery.saved')}</button>
        </div>
      ) : (
        <div ref={enterBox} className="cm-rk-enter">
          <p className="cm-rk-ask">{t('cloudMember.recovery.tailLead')}</p>
          <input
            ref={input} className="input cm-rk-tail mono" type="text" autoComplete="off" autoCapitalize="characters" spellCheck={false} maxLength={12}
            aria-label={t('cloudMember.recovery.tailLabel')} value={tail} disabled={r.busy}
            aria-invalid={typed.length >= 4 && !match ? true : undefined}
            onChange={(e) => setTail(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') finish(); }}
          />
          {typed.length >= 4 && !match && <div className="cm-faint cm-rk-miss">{t('cloudMember.recovery.tailMismatch')}</div>}
          {r.busy && <div className="cm-wait" role="status">{t('cloudMember.recovery.confirming')}</div>}
          {r.error && (
            <Strip tone="danger" role="alert">
              <p>{r.error.message}</p>
              {r.error.retry && <div className="btns"><button type="button" className="btn btn-sm btn-primary" disabled={r.busy} onClick={() => emit({ type: 'cloud.recovery.retry' })}>{t('cloudMember.recovery.retry')}</button></div>}
            </Strip>
          )}
          <div className="btns">
            <button type="button" className="btn btn-sm" disabled={r.busy} onClick={() => emit({ type: 'cloud.recovery.close' })}>{t('cloudMember.common.cancel')}</button>
            <button type="button" className="btn btn-sm btn-primary" disabled={!match || r.busy} onClick={finish}>{t('cloudMember.recovery.done')}</button>
          </div>
        </div>
      )}
    </>
  );
}
