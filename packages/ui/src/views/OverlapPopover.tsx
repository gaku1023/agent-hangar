import type { ReactNode } from 'react';
import { useEmit } from '../action/chain.tsx';
import type { OverlapProps } from '../presenters/overlap.ts';
import { Icon } from './primitives/Icon.tsx';
import { useT } from './primitives/language.tsx';
import { Popover, type PopoverFaceProps } from './primitives/Popover.tsx';
import { StatusDot } from './primitives/StatusDot.tsx';

/**
 * 同じファイルの編集の中身（2026-10-12 の試作の 2-5 の b）。ホームの実行中の行の札と、現在の札の「詳細」から、同じこの面を開く。
 * 上から、相手（押すとそのセッションを開く）、重なったファイルと最後に編集した時刻（交互なら印）、拾えない書き換えの注記、
 * 「次は worktree で」の 1 行と新しいセッションのボタン、「このファイルでは表示しない」と「閉じる」を積む。
 * 動いている 2 本には触らない（止めない、移さない）。
 */
export function OverlapPopover(props: { overlap: OverlapProps; face: (p: PopoverFaceProps) => ReactNode; align?: 'start' | 'end' }) {
  const t = useT();
  const emit = useEmit();
  const o = props.overlap;
  return (
    <Popover label={o.title} width={420} align={props.align ?? 'end'} className="ov-pop" face={props.face}>
      {({ close }) => (
        <>
          <h4 className="pop-title ov-title"><Icon name="warning" />{o.title}</h4>
          <ul className="ov-partners">
            {o.partners.map((p) => (
              <li key={p.id} className="ov-partner">
                <StatusDot status={p.live} aside={p.aside} />
                <button type="button" className="btn-link ov-name" onClick={() => { close(); emit(p.open); }}>{p.name}</button>
                <span className="ov-ctx">{p.context}</span>
              </li>
            ))}
          </ul>
          <table className="ov-files">
            <thead><tr><th>{t('overlap.table.file')}</th><th>{t('overlap.table.mine')}</th><th>{t('overlap.table.theirs')}</th></tr></thead>
            <tbody>
              {o.files.map((f) => (
                <tr key={f.key}>
                  <td><code className="ov-path">{f.path}</code>{f.alternating && <span className="ov-alt">{t('overlap.table.alternating')}</span>}</td>
                  <td className="num">{f.mine}</td>
                  <td className="num">{f.theirs}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="ov-note">{t('overlap.pop.note')}</p>
          <div className="ov-wt">
            <button type="button" className="btn btn-sm" onClick={() => { close(); emit(o.worktree); }}>{t('overlap.worktree.action')}</button>
          </div>
          <div className="ov-foot">
            <button type="button" className="btn btn-sm btn-ghost" onClick={() => { close(); for (const a of o.dismiss) emit(a); }}>{t('overlap.pop.dismiss')}</button>
            <button type="button" className="btn btn-sm" onClick={close}>{t('common.button.close')}</button>
          </div>
        </>
      )}
    </Popover>
  );
}

/** ホームの実行中の行の右端に置く琥珀の札（「⚠ 同じファイル 2」）。押すと中身が開く。 */
export function OverlapChip(props: { overlap: OverlapProps; name: string }) {
  const t = useT();
  const o = props.overlap;
  return (
    <OverlapPopover overlap={o} face={(p) => (
      <button type="button" className="ov-chip" aria-label={t('home.band.actionFor', { action: o.chip, name: props.name })} {...p}>
        <Icon name="warning" /><span>{o.chip}</span>
      </button>
    )} />
  );
}

/**
 * 現在の札の「同じファイルを編集中」の 1 節（試作の 2-2 の B）。意図とツール呼び出しの下、数の札の上に置く。
 * 相手の名前は押すとそのセッションを開き、「詳細」で中身の面が開く。
 */
export function OverlapBlock(props: { overlap: OverlapProps }) {
  const t = useT();
  const emit = useEmit();
  const o = props.overlap;
  return (
    <div className="ov-block" role="note">
      <div className="ov-block-h"><Icon name="warning" /><span>{o.title}</span></div>
      <p className="ov-block-text">
        {o.partners.map((p, i) => (
          <span key={p.id}>{i > 0 && t('common.list.separator')}<button type="button" className="btn-link" onClick={() => emit(p.open)}>{p.name}</button></span>
        ))}{' '}{o.summary}
      </p>
      <OverlapPopover overlap={o} align="start" face={(p) => <button type="button" className="btn-link ov-more" {...p}>{t('overlap.card.details')}</button>} />
    </div>
  );
}
