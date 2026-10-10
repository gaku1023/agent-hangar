import { Fragment, useState } from 'react';
import type { ConfigApplyOrderEntryIn } from '@agent-hangar/shared';
import { useEmit } from '../action/chain.tsx';
import type { ConfigApproveDialogProps, ConfigConflictsDialogProps, ConfigDialogProps, ConfigReviewDialogProps, ConfigSendDialogProps } from '../presenters/configSync.ts';
import { ConfigGroup, MarkTags } from './ConfigSyncParts.tsx';
import { Dialog } from './primitives/Dialog.tsx';
import { Icon } from './primitives/Icon.tsx';
import { useT } from './primitives/language.tsx';

const MARK = { ctx: ' ', add: '+', del: '-' } as const;

/** 適用の指示書を書き、殻のネイティブの確認へ進む。ブラウザでは、指示書を書いたあとにターミナルで hangar config apply を実行する。 */
function NativeNote(props: { native: boolean }) {
  const t = useT();
  return props.native ? null : <span className="faint">{t('configSyncUi.dialog.browserNote')}</span>;
}

/**
 * (a) 1 台目でスイッチを入れるとき：ほかの PC へ送るものの一覧。種類ごとの折りたたみで、見出しに件数、settings.json は鍵と値を出す。
 * 承諾すると新しい実装のスイッチが入る。承諾するまで、クラウドへは何も送らない。
 */
function SendDialog(props: ConfigSendDialogProps) {
  const t = useT();
  const emit = useEmit();
  const close = () => emit({ type: 'overlay.close' });
  return (
    <Dialog title={t('configSyncUi.send.title')} icon="sync" className="dialog-config" onClose={close}
      footer={(
        <>
          {!props.alreadyOn && <span className="faint">{t('configSyncUi.send.footNote')}</span>}
          <span className="spacer" />
          <button type="button" className="btn" onClick={close}>{props.alreadyOn ? t('configSyncUi.word.close') : t('common.button.cancel')}</button>
          {!props.alreadyOn && (
            <button type="button" className="btn btn-primary" disabled={props.loading} onClick={() => emit({ type: 'configSync.send.confirm' })}>
              {props.total > 0 ? t('configSyncUi.send.confirm', { n: props.total }) : t('configSyncUi.send.confirmEmpty')}
            </button>
          )}
        </>
      )}>
      <div className="muted">{props.loading ? t('settings.common.loading') : t('configSyncUi.send.lead', { n: props.total })}</div>
      {!props.loading && props.total === 0 && <div className="faint">{t('configSyncUi.send.empty')}</div>}
      {props.groups.map((g) => <ConfigGroup key={g.id} group={g} />)}
      {props.dropped && <ConfigGroup group={props.dropped} />}
    </Dialog>
  );
}

/**
 * (b) 2 台目：適用内容の確認。操作ごとの折りたたみで、競合、削除、上書き、新規の順に置く。各群の見出しの下に、その操作で何が起きるかを 1 文で書く。
 * 「適用…」を押すと、承諾できる項目が指示書になり、殻がネイティブの確認を出す（D9）。
 */
function ReviewDialog(props: ConfigReviewDialogProps) {
  const t = useT();
  const emit = useEmit();
  const close = () => { if (!props.working) emit({ type: 'overlay.close' }); };
  return (
    <Dialog title={t('configSyncUi.review.title')} icon="sync" className="dialog-config" onClose={close}
      footer={(
        <>
          <span className="faint">{t('configSyncUi.review.backupNote')}</span>
          <span className="spacer" />
          <button type="button" className="btn" disabled={props.working} onClick={close}>{t('common.button.cancel')}</button>
          <button type="button" className="btn btn-primary" disabled={props.working || props.loading || props.total === 0} onClick={() => emit({ type: 'configSync.apply', entries: props.entries })}>{props.working ? t('configSyncUi.word.applying') : t('configSyncUi.word.apply')}</button>
        </>
      )}>
      <div className="muted">{props.loading ? t('settings.common.loading') : t('configSyncUi.review.lead', { n: props.total, summary: props.summary })}</div>
      <NativeNote native={props.native} />
      {(props.awaiting > 0 || props.conflicts > 0) && (
        <div className="cfg-jumps">
          {props.conflicts > 0 && <button type="button" className="btn btn-sm" disabled={props.working} onClick={() => emit({ type: 'configSync.open', part: 'conflicts' })}>{t('configSyncUi.review.openConflicts', { n: props.conflicts })}</button>}
          {props.awaiting > 0 && <button type="button" className="btn btn-sm" disabled={props.working} onClick={() => emit({ type: 'configSync.open', part: 'approve' })}>{t('configSyncUi.review.openApprove', { n: props.awaiting })}</button>}
        </div>
      )}
      {!props.loading && props.groups.length === 0 && <div className="faint">{t('configSyncUi.review.empty')}</div>}
      {props.groups.map((g) => <ConfigGroup key={g.id} group={g} />)}
    </Dialog>
  );
}

/**
 * (c) 届いたスキル、コマンド、エージェントの承諾。1 本の表にチェックを付ける。
 * フックとコマンド実行の印が無い行だけを「まとめて選択」でき、印のある行は中身を開いてから 1 件ずつ選ぶ。「すべて選択」は置かない。
 */
function ApproveDialog(props: ConfigApproveDialogProps) {
  const t = useT();
  const emit = useEmit();
  const [checked, setChecked] = useState<ReadonlySet<string>>(new Set());
  // 中身を開いた行。印のある行は、1 度開くまで選べない。
  const [opened, setOpened] = useState<ReadonlySet<string>>(new Set());
  const [shown, setShown] = useState<ReadonlySet<string>>(new Set());
  // 取り直しで消えた行は、選んだ数から外す。
  const chosen = props.rows.filter((r) => checked.has(r.id)).map((r) => r.id);
  const plain = props.rows.filter((r) => !r.marked);
  const flip = (set: ReadonlySet<string>, id: string): Set<string> => { const n = new Set(set); if (n.has(id)) n.delete(id); else n.add(id); return n; };
  const toggleShown = (id: string) => { setShown((s) => flip(s, id)); setOpened((s) => new Set(s).add(id)); };
  const close = () => { if (!props.working) emit({ type: 'overlay.close' }); };
  const entries: ConfigApplyOrderEntryIn[] = chosen.map((id) => ({ id }));
  return (
    <Dialog title={t('configSyncUi.approve.title')} icon="sync" className="dialog-config" onClose={close}
      footer={(
        <>
          <span className="faint">{t('configSyncUi.approve.selected', { n: chosen.length })}</span>
          <span className="spacer" />
          <button type="button" className="btn" disabled={props.working} onClick={close}>{t('configSyncUi.approve.later')}</button>
          <button type="button" className="btn btn-primary" disabled={props.working || chosen.length === 0} onClick={() => emit({ type: 'configSync.apply', entries })}>{props.working ? t('configSyncUi.word.applying') : t('configSyncUi.approve.apply', { n: chosen.length })}</button>
        </>
      )}>
      <div className="muted">{props.loading ? t('settings.common.loading') : t('configSyncUi.approve.lead', { n: props.rows.length, from: props.from ?? '' })}</div>
      <NativeNote native={props.native} />
      {!props.loading && props.rows.length === 0 && <div className="faint">{t('configSyncUi.approve.empty')}</div>}
      {props.rows.length > 0 && (
        <>
          <div className="cfg-chips">
            <button type="button" className="cfg-chip" data-on={plain.length > 0 && plain.every((r) => checked.has(r.id)) ? 'true' : undefined} disabled={plain.length === 0} onClick={() => setChecked(new Set([...chosen, ...plain.map((r) => r.id)]))}>{t('configSyncUi.approve.selectPlain', { n: plain.length })}</button>
            <button type="button" className="cfg-chip" disabled={chosen.length === 0} onClick={() => setChecked(new Set())}>{t('configSyncUi.approve.clear')}</button>
            <span className="faint">{t('configSyncUi.approve.markedNote')}</span>
          </div>
          <table className="cfg-table">
            <thead><tr><th aria-label={t('configSyncUi.approve.col.select')} /><th>{t('configSyncUi.approve.col.name')}</th><th>{t('configSyncUi.approve.col.kind')}</th><th>{t('configSyncUi.approve.col.marks')}</th><th>{t('configSyncUi.approve.col.from')}</th><th /></tr></thead>
            <tbody>
              {props.rows.map((r) => {
                const locked = r.marked && !opened.has(r.id);
                const isChecked = checked.has(r.id);
                return (
                  <Fragment key={r.id}>
                    <tr data-open={shown.has(r.id) ? 'true' : undefined}>
                      <td className="cfg-cell-cb">
                        <button type="button" role="checkbox" className="cfg-cb" aria-checked={isChecked} disabled={locked || props.working}
                          aria-label={t('configSyncUi.approve.check', { name: r.label })}
                          title={locked ? t('configSyncUi.approve.lockedHint') : undefined}
                          onClick={() => setChecked((s) => flip(s, r.id))} />
                      </td>
                      <td className="mono cfg-cell-name" title={r.label}>{r.label}</td>
                      <td><span className="cfg-act" data-a="kind">{r.kind}</span></td>
                      <td><MarkTags marks={r.marks} /></td>
                      <td className="faint">{r.opLabel}{t('configSyncUi.approve.fromSep')}{r.from}</td>
                      <td className="cfg-cell-r">
                        <button type="button" className="btn btn-sm btn-ghost" aria-expanded={shown.has(r.id)} aria-label={t('configSyncUi.approve.content.label', { name: r.label })} onClick={() => toggleShown(r.id)}>{t('configSyncUi.approve.content')}<Icon name={shown.has(r.id) ? 'chevronDown' : 'chevron'} /></button>
                      </td>
                    </tr>
                    {shown.has(r.id) && (
                      <tr className="cfg-detail-row">
                        <td colSpan={6}>
                          <pre className="cfg-pre" aria-label={t('configSyncUi.approve.content.label', { name: r.label })}>{r.head.length === 0 ? t('configSyncUi.approve.noHead') : r.head.map((l, i) => (l.hot ? <mark key={i}>{l.text}{'\n'}</mark> : <span key={i}>{l.text}{'\n'}</span>))}</pre>
                          {r.truncated && <div className="faint">{t('configSyncUi.approve.truncated')}</div>}
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </>
      )}
    </Dialog>
  );
}

/**
 * (d) 競合。1 件を 1 枚の札にし、差分を最初から出す。採る側を選び、選んだ分をまとめて適用する。
 * 手元から相手への差分で、赤は手元にだけあり、緑は相手にだけある。
 */
function ConflictsDialog(props: ConfigConflictsDialogProps) {
  const t = useT();
  const emit = useEmit();
  const [take, setTake] = useState<Readonly<Record<string, 'remote' | 'mine'>>>({});
  const entries: ConfigApplyOrderEntryIn[] = props.cards.filter((c) => take[c.id] !== undefined).map((c) => ({ id: c.id, take: take[c.id]! }));
  const close = () => { if (!props.working) emit({ type: 'overlay.close' }); };
  const pick = (id: string, side: 'remote' | 'mine') => setTake((s) => (s[id] === side ? Object.fromEntries(Object.entries(s).filter(([k]) => k !== id)) : { ...s, [id]: side }));
  return (
    <Dialog title={t('configSyncUi.conflicts.dialog.title', { n: props.cards.length })} icon="sync" className="dialog-config" onClose={close}
      footer={(
        <>
          <span className="faint">{t('configSyncUi.conflicts.dialog.selected', { n: entries.length, total: props.cards.length })}</span>
          <span className="spacer" />
          <button type="button" className="btn" disabled={props.working} onClick={close}>{t('configSyncUi.word.close')}</button>
          <button type="button" className="btn btn-primary" disabled={props.working || entries.length === 0} onClick={() => emit({ type: 'configSync.apply', entries })}>{props.working ? t('configSyncUi.word.applying') : t('configSyncUi.conflicts.dialog.apply', { n: entries.length })}</button>
        </>
      )}>
      <div className="muted">{props.loading ? t('settings.common.loading') : t('configSyncUi.conflicts.dialog.lead')}</div>
      <NativeNote native={props.native} />
      {!props.loading && props.cards.length === 0 && <div className="faint">{t('configSyncUi.conflicts.none')}</div>}
      {props.cards.map((c) => (
        <div key={c.id} className="cfg-card">
          <div className="cfg-card-t mono">{c.label}<span className="cfg-act" data-a="conflict">{t('configSyncUi.op.conflict')}</span>{c.kind !== c.label && <span className="cfg-act" data-a="kind">{c.kind}</span>}<MarkTags marks={c.marks} /></div>
          <p className="cfg-card-d">{t('configSyncUi.conflicts.dialog.when', { remote: c.remoteName, remoteWhen: c.remoteWhen, localWhen: c.localWhen })}</p>
          <div className="diff mono cfg-diff" role="group" aria-label={t('configSyncUi.conflicts.dialog.diff', { name: c.label })}>
            {c.lines.length === 0 && <div className="diff-ctx">{t('configSyncUi.conflicts.dialog.noDiff')}</div>}
            {c.lines.map((l, i) => <div key={i} className={`diff-${l.kind}`}>{MARK[l.kind]} {l.text}</div>)}
          </div>
          <div className="btns">
            <button type="button" className="btn btn-sm" aria-pressed={take[c.id] === 'remote'} disabled={props.working} onClick={() => pick(c.id, 'remote')}>{take[c.id] === 'remote' && <Icon name="check" />}{t('configSyncUi.conflicts.dialog.takeRemote', { name: c.remoteName })}</button>
            <button type="button" className="btn btn-sm" aria-pressed={take[c.id] === 'mine'} disabled={props.working} onClick={() => pick(c.id, 'mine')}>{take[c.id] === 'mine' && <Icon name="check" />}{t('configSyncUi.conflicts.dialog.takeMine')}</button>
          </div>
        </div>
      ))}
      {props.cards.length > 0 && <div className="faint">{t('configSyncUi.conflicts.dialog.mineNote')}</div>}
    </Dialog>
  );
}

/** 設定の同期のダイアログ。part で 4 つの顔を切り替える。 */
export function ConfigSyncDialog(props: ConfigDialogProps) {
  switch (props.part) {
    case 'send': return <SendDialog {...props} />;
    case 'review': return <ReviewDialog {...props} />;
    case 'approve': return <ApproveDialog key="approve" {...props} />;
    case 'conflicts': return <ConflictsDialog key="conflicts" {...props} />;
  }
}
