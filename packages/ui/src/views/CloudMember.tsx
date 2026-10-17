import { useEffect, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from 'react';
import { normalizeJoinCode } from '@agent-hangar/shared';
import { useEmit } from '../action/chain.tsx';
import { PAIR_TTL_MS, type CloudAddProps, type CloudJoinProps, type CloudMemberProps, type CloudPcRow, type CloudPhoneProps } from '../presenters/cloudMember.ts';
import { CommandLine, CopyButton } from './primitives/CommandLine.tsx';
import { Icon, type IconName } from './primitives/Icon.tsx';
import { useT } from './primitives/language.tsx';
import { collapseOut, fadeIn, growIn, motionOn, resizeFrom } from './primitives/motionKit.ts';
import { QrCode } from './primitives/QrCode.tsx';
import { useNow } from './primitives/useNow.ts';
import { usePresence } from './primitives/usePresence.ts';

/**
 * 設定のクラウド同期の節の、参加と「PC を追加」、PC の一覧と解除、この PC の参加の解除。
 * 参加は試作 cloud-e2e の B2（接続先の確認から参加コード）、「PC を追加」は A1（節の中に開く欄）、参加リクエストの通知は C1（ToastStack）である。
 * PC の一覧は表と行の中の確認、この PC の参加の解除は節の末尾の帯（0.4.0）のままである。
 * 参加と解除は殻の命令が行う。ブラウザで開いているときは、ボタンの代わりにターミナルのコマンドを出す。
 */

function Strip(props: { tone?: 'ok' | 'danger' | 'warn'; icon?: IconName; children: ReactNode; role?: 'alert' | 'status' }) {
  const icon = props.icon ?? (props.tone === 'ok' ? 'check' : props.tone === 'danger' || props.tone === 'warn' ? 'alert' : 'info');
  return (
    <div className="cm-strip" data-tone={props.tone} role={props.role}>
      <Icon name={icon} />
      <div className="cm-strip-body">{props.children}</div>
    </div>
  );
}

const clock = (ms: number): string => {
  const s = Math.ceil(Math.max(0, ms) / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

/** 参加コードと確認コードの有効期間（Worker の JOIN_CODE_TTL_MS と同じ 5 分）。残り時間の棒の長さの基準にする。 */
const JOIN_TTL_MS = 5 * 60_000;

/** 確認コードの箱。説明の文と、大きな等幅の 6 桁を並べる。 */
function SasBox(props: { note: string; sas: string; label: string }) {
  return (
    <div className="cm-sas">
      <span className="cm-sas-note">{props.note}</span>
      <b className="cm-sas-code" aria-label={`${props.label} ${props.sas}`}>{props.sas}</b>
    </div>
  );
}

/**
 * 中身を入れ替えたら、前の高さから今の高さへ resizeFrom で動かし、中身を fadeIn で現す。
 * group が同じ間（同じ段の中の入力など）は動かさない。前の高さは描くたびに控えておく。
 */
function useSwap<E extends HTMLElement>(group: string) {
  const box = useRef<E>(null);
  const body = useRef<HTMLDivElement>(null);
  const last = useRef<{ group: string; height: number } | null>(null);
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    const prev = last.current;
    if (prev && prev.group !== group) {
      resizeFrom(el, prev.height);
      if (body.current) fadeIn(body.current, '--dur-fast');
    }
    last.current = { group, height: el.offsetHeight };
  });
  return { box, body };
}

/**
 * 参加コードで参加（新しい PC の側、試作 B2）。接続先の URL と「次へ」で接続先を確認し、ホスト名と参加済みの PC の台数を出す。
 * 参加済みの PC の名前は封じた名簿にあり、承認の前は復号できないので出さない（設計書「試作との差」）。
 * 確認が済むと参加コードの欄が growIn で開き、「参加をリクエスト」で承認待ちの段へ resizeFrom で移る。
 * 形の違う参加コードは、その場で「参加コードの形が違います」と出し、殻にも Worker にも送らない。
 * onClose は段を閉じたときに呼ぶ（見出しのボタンの姿へ戻す）。
 */
export function CloudJoinSteps(props: { m: CloudMemberProps; onClose: () => void }) {
  const emit = useEmit();
  const t = useT();
  const j = props.m.join;
  const [url, setUrl] = useState(j.url ?? '');
  const [code, setCode] = useState('');
  const [bad, setBad] = useState(false);
  const urlInput = useRef<HTMLInputElement>(null);
  const codeInput = useRef<HTMLInputElement>(null);
  const codeBox = useRef<HTMLDivElement>(null);
  const form = j.kind === 'url' || j.kind === 'checking' || j.kind === 'code' || j.kind === 'requesting';
  const checked = j.kind === 'code' || j.kind === 'requesting';
  const swap = useSwap<HTMLDivElement>(form ? 'form' : j.kind);
  // 参加コードの欄は、接続先の確認が済んで現れたときだけ伸ばす（段のはじめの描画では動かさない）。
  const live = useRef(false);
  const wasChecked = useRef(checked);
  useLayoutEffect(() => {
    if (checked && !wasChecked.current && live.current && codeBox.current) growIn(codeBox.current);
    wasChecked.current = checked;
    live.current = true;
  }, [checked]);
  useEffect(() => { if (j.kind === 'url') urlInput.current?.focus(); else if (j.kind === 'code') codeInput.current?.focus(); }, [j.kind]);
  // 入力し直す段へ戻ったら、前の参加コードを空にする。
  useEffect(() => { if (j.kind === 'code') { setCode(''); setBad(false); } }, [j.kind]);
  const cancel = () => { emit({ type: 'cloud.join.cancel' }); setCode(''); props.onClose(); };
  const next = () => { const v = url.trim(); if (v) emit({ type: 'cloud.join.check', url: v }); };
  const send = () => {
    const n = normalizeJoinCode(code);
    if (n === null) { setBad(true); return; }
    // 送ったら欄を空にする。参加コードは殻へ渡すだけで、画面にも保持しない。
    setCode('');
    emit({ type: 'cloud.join.request', code: n });
  };

  let body: ReactNode;
  if (form) {
    body = (
      <>
        <p className="cm-join-title"><b>{t('cloudMember.join.title')}</b></p>
        <p className="cm-faint cm-join-lead">{t('cloudMember.join.lead')}</p>
        <label className="cm-field">
          {t('cloudMember.join.urlLabel')}
          <input
            ref={urlInput} className="input" type="url" autoComplete="off" spellCheck={false} disabled={j.kind !== 'url'}
            placeholder={t('cloudMember.join.urlPlaceholder')} value={url}
            onChange={(e) => setUrl(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') next(); }}
          />
        </label>
        {j.urlError && <div className="cm-error" role="alert">{j.urlError}</div>}
        {(j.kind === 'url' || j.kind === 'checking') && (
          <>
            {j.kind === 'checking' && <div className="cm-wait" role="status">{t('cloudMember.join.checking')}</div>}
            <div className="btns">
              <button type="button" className="btn" onClick={cancel}>{t('cloudMember.common.cancel')}</button>
              <button type="button" className="btn btn-primary" disabled={url.trim() === '' || j.kind === 'checking'} onClick={next}>{t('cloudMember.join.next')}</button>
            </div>
          </>
        )}
        {checked && (
          <div ref={codeBox} className="cm-join-code">
            <div className="cm-dest">
              <div className="cm-dest-host">{j.host}</div>
              <div className="cm-faint">{t('cloudMember.join.pcCount', { n: j.pcCount ?? 0 })}</div>
            </div>
            {j.rejoin && (
              <Strip tone="danger">
                <p><b>{t('cloudMember.rejoin.otherCloud')}</b></p>
                <dl className="cm-urls"><dt>{t('cloudMember.rejoin.current')}</dt><dd>{j.rejoin.current}</dd><dt>{t('cloudMember.rejoin.next')}</dt><dd>{j.rejoin.next}</dd></dl>
                <p>{t('cloudMember.rejoin.body')}</p>
              </Strip>
            )}
            <label className="cm-field">
              {t('cloudMember.join.codeLabel')}
              <input
                ref={codeInput} className="input cm-code-input" type="text" autoComplete="off" autoCapitalize="characters" spellCheck={false} disabled={j.kind !== 'code'}
                placeholder={t('cloudMember.join.codePlaceholder')} value={code} aria-invalid={bad || undefined}
                onChange={(e) => { setCode(e.target.value); setBad(false); }}
                onKeyDown={(e) => { if (e.key === 'Enter') send(); }}
              />
            </label>
            {bad && <div className="cm-error" role="alert">{t('cloudMember.join.badCode')}</div>}
            {j.kind === 'requesting' && <div className="cm-wait" role="status">{t('cloudMember.join.requesting')}</div>}
            <div className="btns">
              <button type="button" className="btn" disabled={j.kind === 'requesting'} onClick={() => emit({ type: 'cloud.join.cancel' })}>{t('cloudMember.join.back')}</button>
              <button type="button" className={j.rejoin ? 'btn btn-danger-fill' : 'btn btn-primary'} disabled={code.trim() === '' || j.kind === 'requesting'} onClick={send}>{t(j.rejoin ? 'cloudMember.join.overwrite' : 'cloudMember.join.request')}</button>
            </div>
          </div>
        )}
      </>
    );
  } else if (j.kind === 'waiting') {
    body = <JoinWaiting j={j} onCancel={cancel} />;
  } else if (j.kind === 'done') {
    body = <Strip tone="ok" role="status"><p><b>{t('cloudMember.join.done', { host: j.host ?? '' })}</b></p></Strip>;
  } else {
    const f = j.failure;
    body = (
      <>
        <Strip tone={f?.reason === 'no-answer' ? 'warn' : 'danger'} role="alert">
          <p><b>{f?.title}</b></p>
          <p>{f?.body}</p>
          <div className="btns">
            <button type="button" className="btn btn-sm" onClick={cancel}>{t('cloudMember.common.cancel')}</button>
            {j.reenter && <button type="button" className="btn btn-sm btn-primary" onClick={() => emit({ type: 'cloud.join.reenter' })}>{t('cloudMember.join.reenter')}</button>}
          </div>
        </Strip>
        <div className="cm-note">{t('cloudMember.join.nothingWritten')}</div>
      </>
    );
  }
  return <div ref={swap.box} className="cm-join"><div ref={swap.body}>{body}</div></div>;
}

/** 承認待ちの段（試作 B2 の「承認を待っています」）。確認コードと残り時間を出す。 */
function JoinWaiting(props: { j: CloudJoinProps; onCancel: () => void }) {
  const t = useT();
  const expiresAt = props.j.expiresAt ?? 0;
  const now = useNow(1000, { sync: expiresAt });
  return (
    <div className="cm-waiting" role="status">
      <div className="cm-waiting-title">{t('cloudMember.join.waitingTitle')}</div>
      <p>{t('cloudMember.join.waitingBody')}</p>
      <SasBox note={t('cloudMember.join.sasNote')} sas={props.j.sas ?? ''} label={t('cloudMember.join.sasLabel')} />
      <p className="cm-faint">{t('cloudMember.join.left', { time: clock(expiresAt - now) })}</p>
      <div className="btns"><button type="button" className="btn" onClick={props.onCancel}>{t('cloudMember.common.cancel')}</button></div>
    </div>
  );
}

/** 「PC を追加」のボタン（試作 A1）。今すぐ同期の段に置き、欄が開いている間は押せない。 */
export function CloudAddButton(props: { m: CloudMemberProps }) {
  const emit = useEmit();
  const t = useT();
  const k = props.m.add.kind;
  const open = k !== 'idle' && k !== 'done';
  return <button type="button" className="btn btn-primary" disabled={open} onClick={() => emit({ type: 'cloud.add.open' })}>{t('cloudMember.add.button')}</button>;
}

/** 欄を開いている段。完了と、何も発行していない間は閉じる。 */
const addOpen = (a: CloudAddProps): boolean => a.kind !== 'idle' && a.kind !== 'done';

/**
 * 「PC を追加」の欄（参加済みの PC の側、試作 A1）。ボタンの下に growIn で開く。
 * 参加コード（大きな等幅、コピー）、接続先の URL（コピー）、残り時間（5 分）と、参加リクエストを待つ 1 行を出す。
 * 参加リクエストを受信すると、同じ欄が承認の欄（名前、OS、確認コード、承認、拒否）に切り替わる（resizeFrom と fadeIn）。
 * 承認で欄は collapseOut で閉じ、完了の帯を出す。PC の表には新しい行が growIn で入る（CloudPcTable）。
 * 参加コードの平文はこの PC の画面にだけ出す（サーバーはこの PC の画面にだけ渡す）。
 */
export function CloudAddPc(props: { m: CloudMemberProps }) {
  const emit = useEmit();
  const t = useT();
  const a = props.m.add;
  const open = addOpen(a);
  const panel = usePresence<HTMLElement>(open, (el) => (motionOn(el) ? collapseOut(el) : null));
  // 閉じる動きの間は、最後に開いていた段の姿で描く。
  const last = useRef<CloudAddProps | null>(open ? a : null);
  if (open) last.current = a;
  const live = useRef(false);
  const wasOpen = useRef(open);
  useLayoutEffect(() => {
    if (open && !wasOpen.current && live.current && panel.ref.current) growIn(panel.ref.current);
    wasOpen.current = open;
    live.current = true;
  }, [open, panel.ref]);
  return (
    <>
      {panel.mounted && last.current && <AddPanel a={last.current} panelRef={panel.ref} />}
      {a.kind === 'done' && (
        <Strip tone="ok" role="status">
          <p>{t('cloudMember.add.done', { name: a.name ?? '' })}</p>
          <div className="btns"><button type="button" className="btn btn-sm" onClick={() => emit({ type: 'cloud.add.close' })}>{t('cloudMember.common.close')}</button></div>
        </Strip>
      )}
    </>
  );
}

/** 欄の中身。段の組（発行、待つ、承認、終わり）が替わるたびに、高さを resizeFrom で動かす。 */
function AddPanel(props: { a: CloudAddProps; panelRef: RefObject<HTMLElement | null> }) {
  const emit = useEmit();
  const t = useT();
  const a = props.a;
  const swap = useSwap<HTMLElement>(a.kind);
  // 欄の外枠（usePresence の ref）と、高さを動かす箱（swap.box）は同じ要素にする。
  const setRef = (el: HTMLElement | null) => {
    swap.box.current = el;
    props.panelRef.current = el;
  };
  const close = () => emit({ type: 'cloud.add.close' });
  const reissue = <button type="button" className="btn btn-sm btn-primary" onClick={() => emit({ type: 'cloud.add.open' })}>{t('cloudMember.add.reissue')}</button>;
  let body: ReactNode;
  if (a.kind === 'open' || a.kind === 'requested') {
    body = (
      <>
        <AddCode a={a} />
        {a.kind === 'open' ? (
          <>
            <div className="cm-wait" role="status">{t('cloudMember.add.waiting')}</div>
            <div className="btns"><button type="button" className="btn btn-sm" onClick={close}>{t('cloudMember.common.cancel')}</button></div>
          </>
        ) : a.request && (
          <div className="cm-req">
            <div className="cm-req-title"><b>{t('cloudMember.add.requested', { name: a.request.name })}</b></div>
            <div className="cm-faint">{a.request.os}</div>
            <SasBox note={t('cloudMember.add.sasNote')} sas={a.request.sas} label={t('cloudMember.join.sasLabel')} />
            <div className="btns">
              <button type="button" className="btn btn-sm" onClick={() => emit({ type: 'cloud.add.reject' })}>{t('cloudMember.add.reject')}</button>
              <button type="button" className="btn btn-sm btn-primary" onClick={() => emit({ type: 'cloud.add.approve' })}>{t('cloudMember.add.approve')}</button>
            </div>
          </div>
        )}
      </>
    );
  } else if (a.kind === 'issuing') {
    body = <div className="cm-wait" role="status">{t('cloudMember.add.issuing')}</div>;
  } else if (a.kind === 'approving') {
    body = <div className="cm-wait" role="status">{t('cloudMember.add.approving')}</div>;
  } else if (a.kind === 'expired') {
    body = (
      <Strip tone="warn" role="alert">
        <p><b>{t('cloudMember.add.expired')}</b></p>
        <p>{t('cloudMember.add.expiredHint')}</p>
        <div className="btns"><button type="button" className="btn btn-sm" onClick={close}>{t('cloudMember.common.close')}</button>{reissue}</div>
      </Strip>
    );
  } else if (a.kind === 'rejected') {
    body = (
      <Strip role="status">
        <p>{t('cloudMember.add.rejected', { name: a.name ?? '' })}</p>
        <div className="btns"><button type="button" className="btn btn-sm" onClick={close}>{t('cloudMember.common.close')}</button></div>
      </Strip>
    );
  } else {
    body = (
      <Strip tone="danger" role="alert">
        <p>{a.message}</p>
        <div className="btns"><button type="button" className="btn btn-sm" onClick={close}>{t('cloudMember.common.close')}</button>{reissue}</div>
      </Strip>
    );
  }
  return (
    <section ref={setRef} className="cm-add" aria-label={t('cloudMember.add.region')}>
      <div ref={swap.body} className="cm-add-body">{body}</div>
    </section>
  );
}

/** 参加コードと接続先の URL と残り時間（試作 A1 の上半分）。 */
function AddCode(props: { a: CloudAddProps }) {
  const t = useT();
  const a = props.a;
  const expiresAt = a.expiresAt ?? 0;
  const now = useNow(1000, { sync: expiresAt });
  const leftMs = Math.max(0, expiresAt - now);
  const left = Math.ceil(leftMs / 1000);
  return (
    <>
      <div className="cm-add-lead">{t('cloudMember.add.lead')}</div>
      <div className="cm-add-grid">
        <span className="cm-add-label">{t('cloudMember.add.url')}</span>
        <span className="cm-add-url mono">{a.url}</span>
        <CopyButton text={a.url ?? ''} label={t('cloudMember.add.copy')} ariaLabel={t('cloudMember.add.copyUrl')} />
        <span className="cm-add-label">{t('cloudMember.add.code')}</span>
        <span className="cm-add-code mono">{a.code}</span>
        <CopyButton text={a.code ?? ''} label={t('cloudMember.add.copy')} ariaLabel={t('cloudMember.add.copyCode')} />
      </div>
      <div className="tbar" data-low={left <= 10 ? 'true' : undefined} role="progressbar" aria-label={t('cloudMember.add.bar')} aria-valuemin={0} aria-valuemax={JOIN_TTL_MS / 1000} aria-valuenow={left}>
        <i style={{ width: `${Math.min(1, leftMs / JOIN_TTL_MS) * 100}%` }} />
      </div>
      <small className="cm-faint">{t('cloudMember.add.left', { time: clock(leftMs) })}</small>
    </>
  );
}

/** 解除の確認。行のすぐ下に開く。秘密の説明は「手放した PC、なくした PC のとき」に折りたたむ。 */
function RevokeConfirm(props: { row: CloudPcRow; onCancel: () => void }) {
  const emit = useEmit();
  const t = useT();
  const name = props.row.name;
  // スマホは券なしでは戻れず、なくすと全部の PC に会話を起動される。PC と違う文で確かめる（試作 A1）。
  if (props.row.phone) {
    return (
      <div className="cm-rowx">
        <Strip tone="danger">
          <p><b>{t('cloudMember.phone.confirmTitle', { name })}</b></p>
          <p>{t('cloudMember.phone.confirmBody')}</p>
          <p>{t('cloudMember.phone.confirmRisk')}</p>
          <div className="btns">
            <button type="button" className="btn btn-sm" onClick={props.onCancel}>{t('cloudMember.common.cancel')}</button>
            <button type="button" className="btn btn-sm btn-danger-fill" onClick={() => emit({ type: 'cloud.device.revoke', id: props.row.id })}>{t('cloudMember.pcs.do')}</button>
          </div>
        </Strip>
      </div>
    );
  }
  return (
    <div className="cm-rowx">
      <Strip tone="danger">
        <p><b>{t('cloudMember.pcs.confirmTitle', { name })}</b></p>
        <p>{t('cloudMember.pcs.confirmBody', { name })}</p>
        <details className="cm-help"><summary>{t('cloudMember.pcs.helpSummary')}</summary><p>{t('cloudMember.pcs.helpBody', { name })}</p></details>
        <div className="btns">
          <button type="button" className="btn btn-sm" onClick={props.onCancel}>{t('cloudMember.common.cancel')}</button>
          <button type="button" className="btn btn-sm btn-danger-fill" onClick={() => emit({ type: 'cloud.device.revoke', id: props.row.id })}>{t('cloudMember.pcs.do')}</button>
        </div>
      </Strip>
    </div>
  );
}

/** 表の 1 台分（行と、その下に開く確認）。enter なら、現れたときに growIn で伸びて入る。 */
function RowGroup(props: { enter: boolean; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  // 現れた描画でだけ動かす。後から enter が替わっても動かし直さない。
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useLayoutEffect(() => { if (props.enter && ref.current) growIn(ref.current); }, []);
  return <div ref={ref} role="rowgroup">{props.children}</div>;
}

/**
 * PC の表（試作の A）。名前（下に最後の IP と場所）、OS、参加日、最終同期と、ほかの PC には「解除…」を置く。
 * 解除した PC は表から抜けて、下の「解除した PC」へ移る。
 * Worker の一覧が無いとき（Worker が古い、繋がらない、まだ届かない）は、同期の表の一覧を出し、解除は出さない。
 */
export function CloudPcTable(props: { m: CloudMemberProps; heading: string }) {
  const emit = useEmit();
  const t = useT();
  const { pcs, revoke, desktop } = props.m;
  const [asking, setAsking] = useState<string | null>(null);
  // 解除が済むか失敗したら、開いていた確認を閉じる（失敗は行の下に理由を出す）。
  useEffect(() => { if (revoke && revoke.kind !== 'busy') setAsking(null); }, [revoke]);
  const canRevoke = desktop && pcs.state === 'ok';
  // Worker の一覧に新しく現れた行（QR で接続したスマホ、承認した新しい PC）だけが、表に伸びて入る。
  // 前の描画の Worker の一覧の ID を控え、そこに無かった ID だけを動かす。
  // はじめの描画と、同期の表の一覧から Worker の一覧へ替わった描画では、どの行も動かさない。
  const known = useRef<Set<string> | null>(null);
  const before = known.current;
  const isNew = (id: string) => pcs.state === 'ok' && before !== null && !before.has(id);
  useEffect(() => { known.current = pcs.state === 'ok' ? new Set(pcs.rows.map((r) => r.id)) : null; });
  return (
    <>
      <h4 className="sub-h">{props.heading}<span className="n">{pcs.rows.length}</span></h4>
      <div className="cm-table" role="table" aria-label={props.heading}>
        <div className="cm-row" data-head role="row">
          <span role="columnheader">{t('cloudMember.col.name')}</span>
          <span role="columnheader">{t('cloudMember.col.os')}</span>
          <span className="cm-col" role="columnheader">{t('cloudMember.col.joined')}</span>
          <span className="cm-col" role="columnheader">{t('cloudMember.col.lastSeen')}</span>
          <span />
        </div>
        {pcs.rows.map((r) => {
          const busy = revoke?.id === r.id && revoke.kind === 'busy';
          const failed = revoke?.id === r.id && revoke.kind === 'failed' ? revoke : null;
          return (
            <RowGroup key={r.id} enter={isNew(r.id)}>
              <div className="cm-row" role="row" data-focus={asking === r.id || failed ? 'true' : undefined}>
                <span className="cm-name" role="cell">
                  <span>{r.name}{r.self && <span className="cm-self">{t('settings.cloud.thisPc')}</span>}{r.phone && <span className="cm-chip">{t('cloudMember.phone.chip')}</span>}</span>
                </span>
                <span className="cm-faint" role="cell">{r.os}</span>
                <span className="cm-faint cm-col" role="cell">{r.joined ?? '—'}</span>
                <span className="cm-faint cm-col" role="cell">{r.lastSeen}</span>
                <span className="cm-act" role="cell">
                  {canRevoke && !r.self && (
                    <button type="button" className="btn btn-ghost btn-sm" aria-label={t(r.phone ? 'cloudMember.phone.removeAria' : 'cloudMember.pcs.removeAria', { name: r.name })} aria-expanded={asking === r.id} disabled={busy || revoke?.kind === 'busy'} onClick={() => { emit({ type: 'cloud.revoke.dismiss' }); setAsking(asking === r.id ? null : r.id); }}>
                      {busy ? t('cloudMember.pcs.busy') : t('cloudMember.pcs.remove')}
                    </button>
                  )}
                </span>
              </div>
              {asking === r.id && !busy && <RevokeConfirm row={r} onCancel={() => setAsking(null)} />}
              {failed && (
                <div className="cm-rowx">
                  <Strip tone="danger" role="alert">
                    <p>{t('cloudMember.pcs.failed', { name: failed.name, message: failed.message ?? '' })}</p>
                    <div className="btns">
                      <button type="button" className="btn btn-sm" onClick={() => emit({ type: 'cloud.revoke.dismiss' })}>{t('cloudMember.common.close')}</button>
                      <button type="button" className="btn btn-sm btn-danger-fill" onClick={() => emit({ type: 'cloud.device.revoke', id: r.id })}>{t('cloudMember.join.retry')}</button>
                    </div>
                  </Strip>
                </div>
              )}
            </RowGroup>
          );
        })}
      </div>
      {revoke?.kind === 'done' && <Strip tone="ok" role="status"><p>{t('cloudMember.pcs.done', { name: revoke.name })}</p></Strip>}
      {pcs.note && <div className="cm-note">{pcs.note}</div>}
      {pcs.removed.length > 0 && (
        <>
          <h4 className="sub-h">{t('cloudMember.pcs.removedHeading')}<span className="n">{pcs.removed.length}</span></h4>
          <div className="cm-table" role="table" aria-label={t('cloudMember.pcs.removedHeading')}>
            {pcs.removed.map((r) => (
              <div key={r.id} className="cm-row" data-dim role="row">
                <span className="cm-name" role="cell"><span>{r.name}</span></span>
                <span role="cell">{r.os}</span>
                <span className="cm-span" role="cell">{r.removedOn}</span>
              </div>
            ))}
          </div>
          <div className="cm-note">{t('cloudMember.pcs.removedNote')}</div>
        </>
      )}
      {!desktop && pcs.state === 'ok' && pcs.rows.length > 1 && (
        <>
          <div className="cm-note">{t('cloudMember.pcs.web')}</div>
          <CommandLine command={props.m.commands.revoke} />
        </>
      )}
    </>
  );
}

/** 参加を解除する確認の中身（削除するもの、残るもの、戻すとき）。revokeChoice が偽なら、クラウドでの解除の選択を出さない（解除された PC の後片付け）。 */
function LeaveConfirm(props: { m: CloudMemberProps; revokeChoice: boolean; onCancel: () => void }) {
  const emit = useEmit();
  const t = useT();
  const [revoke, setRevoke] = useState(true);
  const also = props.revokeChoice && revoke;
  const file = '~/.agent-hangar/cloud.json';
  return (
    <>
      {props.m.creator && <Strip tone="warn"><p><b>{t('cloudMember.leave.creatorTitle')}</b></p><p>{t('cloudMember.leave.creatorBody')}</p></Strip>}
      <Strip tone="danger">
        <p><b>{t('cloudMember.leave.confirmTitle', { name: props.m.thisPcName })}</b> {t('cloudMember.leave.confirmLead')}</p>
        <dl className="kv">
          <dt>{t('cloudMember.leave.removes')}</dt><dd>{also ? t('cloudMember.leave.removesValueCloud', { file }) : t('cloudMember.leave.removesValue', { file })}</dd>
          <dt>{t('cloudMember.leave.keeps')}</dt><dd>{t('cloudMember.leave.keepsValue', { remote: '~/.agent-hangar/remote' })}</dd>
          <dt>{t('cloudMember.leave.back')}</dt><dd>{t('cloudMember.leave.backValue')}</dd>
        </dl>
        {props.revokeChoice && <label className="cm-check"><input type="checkbox" checked={revoke} onChange={(e) => setRevoke(e.target.checked)} /><span>{t('cloudMember.leave.revokeToo')}</span></label>}
        <div className="btns">
          <button type="button" className="btn btn-sm" onClick={props.onCancel}>{t('cloudMember.common.cancel')}</button>
          <button type="button" className="btn btn-sm btn-danger-fill" onClick={() => emit({ type: 'cloud.leave', revoke: also })}>{t('cloudMember.leave.do')}</button>
        </div>
      </Strip>
    </>
  );
}

/** 参加の解除の進みと結果。済んだら殻が再起動する（クラウドで解除できなかったときだけ、読んでから押してもらう）。 */
function LeaveProgress(props: { m: CloudMemberProps }) {
  const emit = useEmit();
  const t = useT();
  const l = props.m.leave;
  if (l.kind === 'busy') return <div className="cm-wait" role="status">{t('cloudMember.leave.busy')}</div>;
  if (l.kind === 'left' && l.revokeError === null) return <Strip tone="ok" role="status"><p><b>{t('cloudMember.leave.left')}</b></p></Strip>;
  if (l.kind === 'left') {
    return (
      <Strip tone="warn" role="alert">
        <p>{t('cloudMember.leave.leftRevokeFailed', { message: l.revokeError ?? '' })}</p>
        <div className="btns"><button type="button" className="btn btn-sm btn-primary" onClick={() => emit({ type: 'shell.restart' })}>{t('cloudMember.leave.restart')}</button></div>
      </Strip>
    );
  }
  if (l.kind === 'failed') {
    return (
      <Strip tone="danger" role="alert">
        <p>{t('cloudMember.leave.failed', { message: l.message ?? '' })}</p>
        <div className="btns"><button type="button" className="btn btn-sm" onClick={() => emit({ type: 'cloud.leave.dismiss' })}>{t('cloudMember.common.close')}</button></div>
      </Strip>
    );
  }
  return null;
}

/**
 * この PC の参加を解除（試作の A）。節の末尾に、ほかの PC の解除から離して置く。
 * 「クラウドでもこの PC を解除する」は既定でオン。クラウドを作った PC では、teardown できなくなる旨を先に出す。
 */
export function CloudLeaveBand(props: { m: CloudMemberProps }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const l = props.m.leave;
  useEffect(() => { if (l.kind !== 'idle') setOpen(false); }, [l.kind]);
  return (
    <section className="cm-leave" aria-label={t('cloudMember.leave.title')}>
      <div className="cm-leave-head">
        <div className="cm-leave-text">
          <div className="cm-leave-title">{t('cloudMember.leave.title')}</div>
          <div className="cm-leave-desc">{t('cloudMember.leave.desc')}</div>
        </div>
        {props.m.desktop && <button type="button" className="btn btn-danger" disabled={open || l.kind === 'busy' || l.kind === 'left'} onClick={() => setOpen(true)}>{t('cloudMember.leave.button')}</button>}
      </div>
      {!props.m.desktop && <><div className="cm-note">{t('cloudMember.leave.web')}</div><CommandLine command={props.m.commands.leave} /></>}
      {open && l.kind === 'idle' && <LeaveConfirm m={props.m} revokeChoice onCancel={() => setOpen(false)} />}
      <LeaveProgress m={props.m} />
    </section>
  );
}

/**
 * この PC が同期から解除されたときの帯（節の先頭）。
 * 参加コードで再参加するか、この PC の同期の設定を削除するかを選ぶ。ブラウザではコマンドを出す。
 */
export function CloudRevokedBand(props: { m: CloudMemberProps; joinCommand: string }) {
  const t = useT();
  const [mode, setMode] = useState<'none' | 'join' | 'clear'>('none');
  const m = props.m;
  return (
    <>
      <Strip tone="danger" role="alert">
        <p><b>{t('cloudMember.revoked.title')}</b></p>
        <p>{t('cloudMember.revoked.body', { name: m.thisPcName })}{m.pending > 0 && ` ${t('cloudMember.revoked.unsent', { n: m.pending })}`}</p>
        {m.desktop && mode === 'none' && m.leave.kind === 'idle' && (
          <div className="btns">
            <button type="button" className="btn btn-primary" onClick={() => setMode('join')}>{t('cloudMember.revoked.rejoin')}</button>
            <button type="button" className="btn" onClick={() => setMode('clear')}>{t('cloudMember.revoked.clear')}</button>
          </div>
        )}
        <p className="cm-faint">{t('cloudMember.revoked.hint')}</p>
      </Strip>
      {!m.desktop && <><div className="cm-note">{t('cloudMember.revoked.web')}</div><CommandLine command={props.joinCommand} /></>}
      {mode === 'join' && <CloudJoinSteps m={m} onClose={() => setMode('none')} />}
      {mode === 'clear' && m.leave.kind === 'idle' && <LeaveConfirm m={m} revokeChoice={false} onCancel={() => setMode('none')} />}
      <LeaveProgress m={m} />
    </>
  );
}

/** QR の段が開いている段。段を開いたまま新しい券を待つ間（loading の renew）も、段を畳まずに薄い図で待つ。 */
type PanelStage = Extract<CloudPhoneProps, { kind: 'ready' | 'expired' | 'paired' }> | { kind: 'loading'; renew: true };
const isPanel = (p: CloudPhoneProps): p is PanelStage => p.kind === 'ready' || p.kind === 'expired' || p.kind === 'paired' || (p.kind === 'loading' && p.renew === true);

/** QR の一辺（px）。 */
const QR_SIZE = 172;
/**
 * 期限切れと接続の後に薄く描く図の中身。QR の中身（スマホ用の暗号鍵）はもう持たないので、意味の無い文字列を描く。
 * 升目の細かさが本物の QR と近くなるよう、本物と同じくらいの長さにする。
 */
const QR_PLACEHOLDER = 'hangar-qr-placeholder/'.repeat(14);

/** 現れた描画でだけ fadeIn で現れる箱。animate が偽（段のはじめの描画）なら動かさない。 */
function Appear(props: { animate: boolean; className?: string; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useLayoutEffect(() => { if (props.animate && ref.current) fadeIn(ref.current); }, []);
  return <div ref={ref} className={props.className}>{props.children}</div>;
}

/**
 * QR の段（試作 A1）。左に QR、右に 3 つの手順、残り時間の棒、「この QR を人に見せない」の黄色の帯、「文字列をコピー」と「閉じる」。
 * 5 分を過ぎたら QR を薄くして「新しい QR を出す」を重ね、スマホが参加したら「〈名前〉が接続しました」を重ねる（どちらも fadeIn）。
 */
function PairPanel(props: { p: PanelStage }) {
  const emit = useEmit();
  const t = useT();
  const p = props.p;
  const ready = p.kind === 'ready';
  const now = useNow(1000, { active: ready, sync: ready ? p.expiresAt : null });
  const leftMs = ready ? Math.max(0, p.expiresAt - now) : 0;
  const dead = !ready || leftMs <= 0;
  // 新しい券を待つ間（loading）は重ねず、薄い図のまま待つ。
  const over = p.kind === 'paired' ? 'paired' : p.kind === 'loading' ? null : dead ? 'expired' : null;
  // 段のはじめの描画で重なりがあるとき（期限切れのまま設定を開き直したなど）は動かさない。
  const shown = useRef(false);
  useEffect(() => { shown.current = true; }, []);
  const close = () => emit({ type: 'cloud.phone.close' });
  return (
    <div className="cm-pair-in">
      <div className="cm-qr-wrap">
        <div className="cm-qr" data-dead={dead ? 'true' : undefined} aria-hidden={dead ? 'true' : undefined}>
          <QrCode text={ready ? p.pairUrl : QR_PLACEHOLDER} size={QR_SIZE} label={t('cloudMember.phone.qrLabel')} fallback={t('cloudMember.phone.qrTooLong')} />
        </div>
        {over === 'expired' && (
          <Appear key="expired" animate={shown.current} className="cm-qr-over">
            <b>{t('cloudMember.phone.expired')}</b>
            <button type="button" className="btn btn-sm btn-primary" onClick={() => emit({ type: 'cloud.phone.pair' })}>{t('cloudMember.phone.again')}</button>
          </Appear>
        )}
        {p.kind === 'paired' && (
          <Appear key="paired" animate={shown.current} className="cm-qr-over" >
            <span className="cm-qr-ok"><Icon name="check" /></span>
            <b>{t('cloudMember.phone.paired', { name: p.name })}</b>
            <span>{t('cloudMember.phone.used')}</span>
          </Appear>
        )}
      </div>
      <div className="cm-pair-body">
        <div className="cm-pair-title">{t('cloudMember.phone.title')}</div>
        {p.kind === 'paired' ? (
          <Appear animate={shown.current}>
            <Strip tone="ok" role="status"><p>{t('cloudMember.phone.pairedNote', { name: p.name })}</p></Strip>
          </Appear>
        ) : (
          <>
            <ol className="cm-steps">
              <li>{t('cloudMember.phone.step1')}</li>
              <li>{t('cloudMember.phone.step2')}</li>
              <li>{t('cloudMember.phone.step3')}</li>
            </ol>
            {p.kind === 'loading' ? <div className="cm-wait" role="status">{t('cloudMember.phone.loading')}</div> : <div className="cm-timer">
              <span>{t('cloudMember.phone.left', { time: clock(leftMs) })}</span>
              <span className="cm-bar" role="progressbar" aria-label={t('cloudMember.phone.bar')} aria-valuemin={0} aria-valuemax={PAIR_TTL_MS / 1000} aria-valuenow={Math.ceil(leftMs / 1000)}>
                <i style={{ width: `${Math.min(1, leftMs / PAIR_TTL_MS) * 100}%` }} />
              </span>
            </div>}
            <Strip tone="warn"><p>{t('cloudMember.phone.warn')}</p></Strip>
          </>
        )}
        <div className="btns">
          {!dead && ready && <CopyButton text={p.pairText} label={t('cloudMember.phone.copy')} ariaLabel={t('cloudMember.phone.copy')} />}
          <button type="button" className="btn btn-sm btn-ghost" onClick={close}>{t('cloudMember.common.close')}</button>
        </div>
      </div>
    </div>
  );
}

/**
 * 「スマホ」の小見出しと「スマホを接続」（試作 A1）。PC の表の下に置き、押すと節の中に QR の段が開く（growIn、閉じると collapseOut）。
 * QR の中身は Runtime が取り、ready の間だけ持つ。参加したスマホは PC と同じ表に「スマホ」の札つきで並ぶ。
 * 「Remote Control を付けて起動する」の設定は「連携」にあるので、その旨を 1 行で案内する（試作 B1）。
 */
export function CloudPhones(props: { m: CloudMemberProps }) {
  const emit = useEmit();
  const t = useT();
  const p = props.m.phone;
  const open = isPanel(p);
  const panel = usePresence<HTMLDivElement>(open, (el) => (motionOn(el) ? collapseOut(el) : null));
  // 閉じる動きの間は、最後に開いていた段の姿で描く。
  const last = useRef<PanelStage | null>(open ? p : null);
  if (open) last.current = p;
  const live = useRef(false);
  useEffect(() => { live.current = true; }, []);
  // 節が外れたら（設定の画面を離れたなど）QR を閉じる。3 秒ごとの再読み込みを止め、QR の中身を Store から捨てる。
  const emitRef = useRef(emit);
  emitRef.current = emit;
  useEffect(() => () => { emitRef.current({ type: 'cloud.phone.close' }); }, []);
  const wasOpen = useRef(open);
  useLayoutEffect(() => {
    if (open && !wasOpen.current && live.current && panel.ref.current) growIn(panel.ref.current);
    wasOpen.current = open;
  }, [open, panel.ref]);
  const heading = t('cloudMember.phone.heading');
  return (
    <section className="cm-phones" aria-label={heading}>
      <h4 className="sub-h">
        {heading}
        <span className="cm-sp" />
        {!open && <button type="button" className="btn btn-sm" disabled={p.kind === 'loading'} onClick={() => emit({ type: 'cloud.phone.pair' })}>{t('cloudMember.phone.pair')}</button>}
      </h4>
      {!open && (
        <>
          <div className="cm-note">{t('cloudMember.phone.lead')}</div>
          <div className="cm-note">{t('cloudMember.phone.rcPointer')}</div>
        </>
      )}
      {p.kind === 'loading' && !open && <div className="cm-wait" role="status">{t('cloudMember.phone.loading')}</div>}
      {p.kind === 'old' && (
        <Strip tone="warn">
          <p>{p.compat !== null ? t('cloudMember.phone.old', { compat: p.compat }) : t('cloudMember.phone.oldUnknown')}</p>
          <p className="cm-faint">{t('cloudMember.phone.oldHint')}</p>
        </Strip>
      )}
      {p.kind === 'limited' && <Strip tone="warn" role="alert"><p>{t('cloudMember.phone.limited')}</p></Strip>}
      {p.kind === 'notJoined' && <Strip tone="warn"><p>{t('cloudMember.phone.notJoined')}</p></Strip>}
      {p.kind === 'failed' && <Strip tone="danger" role="alert"><p>{t('cloudMember.phone.failed', { message: p.message })}</p></Strip>}
      {panel.mounted && last.current && <div ref={panel.ref} className="cm-pair"><PairPanel p={last.current} /></div>}
    </section>
  );
}
