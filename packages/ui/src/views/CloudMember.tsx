import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { useEmit } from '../action/chain.tsx';
import { PAIR_TTL_MS, type CloudMemberProps, type CloudPcRow, type CloudPhoneProps } from '../presenters/cloudMember.ts';
import { CommandLine, CopyButton } from './primitives/CommandLine.tsx';
import { Icon, type IconName } from './primitives/Icon.tsx';
import { useT } from './primitives/language.tsx';
import { collapseOut, fadeIn, growIn, motionOn } from './primitives/motionKit.ts';
import { QrCode } from './primitives/QrCode.tsx';
import { useNow } from './primitives/useNow.ts';
import { usePresence } from './primitives/usePresence.ts';

/**
 * 設定のクラウド同期の節の、参加と、PC の一覧と解除と、この PC の参加の解除（0.4.0）。
 * 試作 settings-040-proto の推す組み合わせで、参加は A（節の中の段）、PC は A（表と行の中の確認）、この PC の参加の解除は A（節の末尾の帯）である。
 * 参加と解除は殻の命令が行う。ブラウザで開いているときは、ボタンの代わりにターミナルのコマンドを出す。
 * 参加トークンは password の欄で受け、「次へ」で殻へ渡したら欄を空にする。Store にも残さない（Runtime だけが持つ）。
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

/** 宛先の箱。ホストを大きく、URL を小さく、CLI と同じ注意を添える。 */
function Destination(props: { host: string; url: string }) {
  const t = useT();
  return (
    <div className="cm-dest">
      <div className="cm-dest-label">{t('cloudMember.dest.label')}</div>
      <div className="cm-dest-host">{props.host}</div>
      <div className="cm-dest-url">{props.url}</div>
      <p className="cm-dest-note">{t('cloudMember.dest.note')}</p>
    </div>
  );
}

/**
 * 参加の段（試作の A）。貼る → 宛先を確認 → 参加が節の中で上から開く。
 * 確認はチェック 1 つで押せる（CLI の y と同じ重さ）。別のクラウドに参加済みなら、赤い警告と「上書きして参加」に変える（CLI の overwrite と同じ段）。
 * onClose は段を閉じたときに呼ぶ（見出しのボタンの姿へ戻す）。
 */
export function CloudJoinSteps(props: { m: CloudMemberProps; onClose: () => void }) {
  const emit = useEmit();
  const t = useT();
  const j = props.m.join;
  const [token, setToken] = useState('');
  const [agree, setAgree] = useState(false);
  // 失敗の後の「もう一度試す」は、確かめたときと同じ上書きの承諾で送る。
  const [overwrite, setOverwrite] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => { if (j.kind === 'idle') input.current?.focus(); }, [j.kind]);
  useEffect(() => { if (j.kind === 'confirm') setAgree(false); }, [j.kind, j.url]);
  const cancel = () => { emit({ type: 'cloud.join.cancel' }); setToken(''); props.onClose(); };
  const repaste = () => { emit({ type: 'cloud.join.cancel' }); setToken(''); };
  const next = () => {
    const v = token.trim();
    if (!v) return;
    // 読んだら欄を空にする。トークンは殻へ渡し、画面には残さない。
    setToken('');
    emit({ type: 'cloud.join.plan', token: v });
  };
  const go = () => {
    const ow = j.rejoin !== null;
    setOverwrite(ow);
    emit({ type: 'cloud.join.go', overwrite: ow });
  };

  if (j.kind === 'idle') {
    return (
      <>
        <label className="cm-field">
          {t('cloudMember.join.tokenLabel')}
          <input
            ref={input} className="input" type="password" autoComplete="off" spellCheck={false}
            placeholder={t('cloudMember.join.placeholder')} value={token}
            onChange={(e) => setToken(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') next(); }}
          />
          <small className="cm-faint">{t('cloudMember.join.tokenNote')}</small>
        </label>
        <div className="btns">
          <button type="button" className="btn" onClick={cancel}>{t('cloudMember.common.cancel')}</button>
          <button type="button" className="btn btn-primary" disabled={token.trim() === ''} onClick={next}>{t('cloudMember.join.next')}</button>
        </div>
      </>
    );
  }
  if (j.kind === 'checking') return <div className="cm-wait" role="status">{t('cloudMember.join.checking')}</div>;
  if (j.kind === 'joined') return <Strip tone="ok" role="status"><p><b>{t('cloudMember.join.joined', { host: j.host ?? '' })}</b></p></Strip>;
  const dest = j.host !== null && j.url !== null ? <Destination host={j.host} url={j.url} /> : null;
  if (j.kind === 'joining') return <>{dest}<div className="cm-wait" role="status">{t('cloudMember.join.joining', { host: j.host ?? '' })}</div></>;
  if (j.kind === 'failed' && j.failure) {
    // 宛先を確かめる前の失敗は、トークンを持っていないので貼り直してもらう。
    const again = j.url === null ? 'repaste' : j.failure.again;
    return (
      <>
        {dest}
        <Strip tone="danger" role="alert"><p><b>{j.failure.title}</b></p><p>{j.failure.body}</p></Strip>
        <div className="btns">
          <button type="button" className="btn" onClick={cancel}>{t('cloudMember.common.cancel')}</button>
          {again === 'retry'
            ? <button type="button" className="btn btn-primary" onClick={() => emit({ type: 'cloud.join.go', overwrite })}>{t('cloudMember.join.retry')}</button>
            : <button type="button" className="btn btn-primary" onClick={repaste}>{t('cloudMember.join.repaste')}</button>}
        </div>
        <div className="cm-note">{t('cloudMember.join.nothingWritten')}</div>
      </>
    );
  }
  // 宛先の確認。
  return (
    <>
      <div className="cm-read">{t('cloudMember.join.read')}<button type="button" className="btn btn-ghost btn-sm" onClick={repaste}>{t('cloudMember.join.repaste')}</button></div>
      {dest}
      {j.rejoin && (
        <Strip tone="danger">
          <p><b>{j.rejoin.title}</b></p>
          <dl className="cm-urls"><dt>{t('cloudMember.rejoin.current')}</dt><dd>{j.rejoin.current}</dd><dt>{t('cloudMember.rejoin.next')}</dt><dd>{j.rejoin.next}</dd></dl>
          <p>{t('cloudMember.rejoin.body')}</p>
        </Strip>
      )}
      <label className="cm-check"><input type="checkbox" checked={agree} onChange={(e) => setAgree(e.target.checked)} /><span>{t('cloudMember.dest.agree')}</span></label>
      <div className="btns">
        <button type="button" className="btn" onClick={cancel}>{t('cloudMember.common.cancel')}</button>
        <button type="button" className={j.rejoin ? 'btn btn-danger-fill' : 'btn btn-primary'} disabled={!agree} onClick={go}>{t(j.rejoin ? 'cloudMember.join.overwrite' : 'cloudMember.join.go')}</button>
      </div>
    </>
  );
}

/**
 * 名前の下の 1 行。場所を先に置いて縮めず、縮んで省略記号になるのは最後の IP だけにする。
 * IPv6 の IP は長く、IP を先に置くと、窓を広げても場所が切られて見えなかった（0.4.0-rc.1 の Windows）。IP の全文は title で読む。
 */
function Where(props: { row: CloudPcRow }) {
  const t = useT();
  const { ip, place } = props.row;
  if (ip === null) return null;
  return (
    <span className="cm-where">
      {place && <span className="cm-place" title={place}>{place}</span>}
      {place && <span className="cm-sep" aria-hidden="true">·</span>}
      <span className="cm-ip" title={t('cloudMember.pcs.lastIpTitle', { ip })}>{ip}</span>
    </span>
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
  // QR を出している間に参加したスマホの行は、表に伸びて入る。表を描いた後に現れたときだけ動かす（はじめの描画では動かさない）。
  const live = useRef(false);
  useEffect(() => { live.current = true; }, []);
  const entering = props.m.phone.kind === 'paired' ? props.m.phone.id : null;
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
            <RowGroup key={r.id} enter={live.current && entering === r.id}>
              <div className="cm-row" role="row" data-focus={asking === r.id || failed ? 'true' : undefined}>
                <span className="cm-name" role="cell">
                  <span>{r.name}{r.self && <span className="cm-self">{t('settings.cloud.thisPc')}</span>}{r.phone && <span className="cm-chip">{t('cloudMember.phone.chip')}</span>}</span>
                  <Where row={r} />
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
      {pcs.state === 'ok' && pcs.rows.some((r) => r.ip !== null) && <div className="cm-note">{t('cloudMember.pcs.placeNote')}</div>}
      {pcs.removed.length > 0 && (
        <>
          <h4 className="sub-h">{t('cloudMember.pcs.removedHeading')}<span className="n">{pcs.removed.length}</span></h4>
          <div className="cm-table" role="table" aria-label={t('cloudMember.pcs.removedHeading')}>
            {pcs.removed.map((r) => (
              <div key={r.id} className="cm-row" data-dim role="row">
                <span className="cm-name" role="cell"><span>{r.name}</span><Where row={r} /></span>
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
 * 参加トークンで参加し直すか、この PC の同期の設定を削除するかを選ぶ。ブラウザではコマンドを出す。
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

const clock = (ms: number): string => {
  const s = Math.ceil(Math.max(0, ms) / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

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
