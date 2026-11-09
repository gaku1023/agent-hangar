import { useEffect, useRef, useState } from 'react';
import { useEmit } from '../action/chain.tsx';
import type { EventRow, PrClaimRow } from '../presenters/schedules.ts';
import { Icon } from './primitives/Icon.tsx';
import { useT } from './primitives/language.tsx';
import { collapseOut } from './primitives/motionKit.ts';
import { HookUrlCard, RepoHookChip } from './HookParts.tsx';
import { Grow, RunDots, RunList } from './schedulesParts.tsx';

/**
 * 行の中の、外の webhook の URL のカード（D1）と、GitHub の repo の札（D3）。
 * 承認待ちの外の webhook はまだ URL が無いので何も出さない。承認待ちの GitHub は、付けられなかった理由の札と、承認をやり直す再試行を持つ。
 * 承認済みの行の失敗には再試行を出さない（サーバに付け直す道が、承認待ちの承認にしか無い）。
 */
export function EventRowExtra(props: { row: EventRow; rev: number }) {
  const emit = useEmit();
  const r = props.row;
  if (r.sourceKind === 'hook') return r.pending ? null : <HookUrlCard id={r.id} />;
  if (!r.repo) return null;
  return <RepoHookChip repo={r.repo} rev={props.rev} {...(r.pending ? { onRetry: () => emit({ type: 'events.approve', id: r.id }) } : {})} />;
}

/** 起動設定の札と、できごとなどの読み取り専用の札の列。 */
function EventChips(props: { row: EventRow; detail: boolean }) {
  const t = useT();
  const r = props.row;
  return (
    <div className="sch-chips">
      {props.detail && (
        <>
          <span className="set-chip sch-chip"><span className="set-chip-value">{r.source}</span></span>
          {r.when && <span className="set-chip sch-chip"><span className="set-chip-value">{r.when}</span></span>}
          {r.filters.map((f) => <span key={f} className="set-chip sch-chip"><span className="set-chip-value">{f}</span></span>)}
          <span className="set-chip sch-chip"><span className="set-chip-value">{r.action}</span></span>
          {r.passBody && <span className="set-chip sch-chip"><span className="set-chip-value">{t('schedules.event.passBody')}</span></span>}
          {r.allowAuthors.length > 0 && <span className="set-chip sch-chip"><span className="set-chip-name">{t('schedules.event.allowAuthors')}</span><span className="set-chip-value">{r.allowAuthors.join(', ')}</span></span>}
        </>
      )}
      {r.chips.map((c) => <span key={c.name} className="set-chip sch-chip" data-tone={c.danger ? 'danger' : 'default'}><span className="set-chip-name">{c.name}</span><span className="set-chip-value">{c.value}</span>{c.suffix && <span className="wt-suffix" aria-hidden="true">{c.suffix}</span>}</span>)}
    </div>
  );
}

/** 承認待ちの下書き（MCP から）。閉じずに、指示と元と動きと起動設定を全部見せてから、承認か却下を選ばせる。 */
function DraftRow(props: { row: EventRow; rev: number }) {
  const emit = useEmit();
  const t = useT();
  const r = props.row;
  return (
    <li className="sch-row sch-draft" data-pending="true">
      <div className="sch-draft-body">
        <span className="sch-mark"><Icon name="bolt" /></span>
        <div className="sch-draft-main">
          <div className="sch-draft-head"><span className="sch-ev-chip" data-state="pending">{t('schedules.event.state.pending')}</span><span className="sch-when">{[r.source, r.when].filter(Boolean).join(' · ')}</span></div>
          <div className="sch-full">{r.prompt}</div>
          <EventChips row={r} detail />
          <EventRowExtra row={r} rev={props.rev} />
        </div>
        <div className="sch-acts">
          <button type="button" className="btn btn-ghost" onClick={() => emit({ type: 'events.remove', id: r.id })}>{t('schedules.event.reject')}</button>
          <button type="button" className="btn btn-primary" onClick={() => emit({ type: 'events.approve', id: r.id })}>{t('schedules.event.approve')}</button>
        </div>
      </div>
    </li>
  );
}

/** 担当する PR の印の下書き（MCP の claim_pr）。承認するまで、レビューやコメントの宛先には使われない。 */
function ClaimRowView(props: { row: PrClaimRow }) {
  const emit = useEmit();
  const t = useT();
  const c = props.row;
  const answer = (op: 'approve' | 'reject') => emit({ type: 'events.claim', op, sessionId: c.sessionId, repo: c.repo, pr: c.pr });
  return (
    <li className="sch-row sch-draft" data-pending="true">
      <div className="sch-draft-body">
        <span className="sch-mark"><Icon name="bolt" /></span>
        <div className="sch-draft-main"><div className="sch-draft-head"><span className="sch-ev-chip" data-state="pending">{t('schedules.event.state.pending')}</span><span className="sch-claim">{c.text}</span></div></div>
        <div className="sch-acts">
          <button type="button" className="btn btn-ghost" onClick={() => answer('reject')}>{t('schedules.event.reject')}</button>
          <button type="button" className="btn btn-primary" onClick={() => answer('approve')}>{t('schedules.event.approve')}</button>
        </div>
      </div>
    </li>
  );
}

function EventRowView(props: { row: EventRow; rev: number; open: boolean; onOpen: (id: string | null) => void }) {
  const emit = useEmit();
  const t = useT();
  const r = props.row;
  const [askDelete, setAskDelete] = useState(false);
  const [gone, setGone] = useState(false);
  const box = useRef<HTMLLIElement | null>(null);
  useEffect(() => { if (!props.open) setAskDelete(false); }, [props.open]);
  const remove = () => {
    setGone(true);
    const el = box.current;
    void (el ? collapseOut(el) : Promise.resolve()).then(() => emit({ type: 'events.remove', id: r.id }));
  };
  return (
    <li className="sch-row" data-open={props.open ? 'true' : undefined} data-gone={gone ? 'true' : undefined} data-held={r.held ? 'true' : undefined} ref={box}>
      <div className="sch-head" onClick={() => props.onOpen(props.open ? null : r.id)}>
        <span className="sch-mark"><Icon name="bolt" /></span>
        <button type="button" className="sch-title" aria-expanded={props.open}>{r.prompt}</button>
        <span className="sch-when">{r.when || r.source}</span>
        <span className="sch-next">{r.held && <span className="sch-ev-chip" data-state="held">{t('schedules.event.state.held')}</span>}</span>
        <RunDots runs={r.runs} />
      </div>
      <Grow open={props.open}>
        {() => (
          <div className="sch-detail">
            <EventChips row={r} detail />
            {r.note && <div className="faint">{r.note}</div>}
            <div className="sch-full">{r.prompt}</div>
            <RunList runs={r.runs} />
            <EventRowExtra row={r} rev={props.rev} />
            <div className="sch-acts">
              <span className="spacer" />
              {askDelete
                ? <><button type="button" className="btn btn-ghost" onClick={() => setAskDelete(false)}>{t('common.button.cancel')}</button><button type="button" className="btn btn-danger-fill" onClick={remove}>{t('schedules.action.deleteConfirm')}</button></>
                : <button type="button" className="btn btn-ghost btn-danger" onClick={() => setAskDelete(true)}>{t('schedules.action.delete')}</button>}
            </div>
          </div>
        )}
      </Grow>
    </li>
  );
}

/** イベントの節の中身。承認待ち（下書きと PR の印）を頭に、そのあとに有効な行。 */
export function EventList(props: { drafts: EventRow[]; claims: PrClaimRow[]; rows: EventRow[]; rev: number; open: string | null; onOpen: (id: string | null) => void }) {
  return (
    <ul className="sch-evlist">
      {props.claims.map((c) => <ClaimRowView key={c.key} row={c} />)}
      {props.drafts.map((r) => <DraftRow key={r.id} row={r} rev={props.rev} />)}
      {props.rows.map((r) => <EventRowView key={r.id} row={r} rev={props.rev} open={props.open === r.id} onOpen={props.onOpen} />)}
    </ul>
  );
}
