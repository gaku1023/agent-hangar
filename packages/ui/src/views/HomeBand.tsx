import { Fragment, useId, useRef, useState } from 'react';
import { useEmit } from '../intent/chain.tsx';
import type { BandGroup, BandLead, BandRow, HomeBandProps } from '../presenters/home.ts';
import { CountChip } from './primitives/Chip.tsx';
import { Icon, type IconName } from './primitives/Icon.tsx';
import { useT } from './primitives/language.tsx';
import { StatusDot } from './primitives/StatusDot.tsx';

/**
 * ホームの帯（試作 B）。上の細い帯に件数の錠剤を並べ、押した群だけが帯の下に引き出しで開く。
 * 錠剤は groups の並びのまま出す。群を足す（確認の要約、未解決のプロジェクト）には、presentHomeBand の extra に群を渡すだけでよい。
 * 開いている群は View の中に持つ（設計書 4.4）。はじめは Presenter の morning（朝に開く群）で、あとは利用者が決める。
 * 押した群が開き、開いている群をもう一度押すと閉じる。引き出しは 1 つずつしか開かない。
 * 0 件の群は薄い札にして押せない。件数が 0 になった群の引き出しは残さない。
 * searching の間は引き出しを閉じ、錠剤を件数だけの札にして、「検索中は引き出しを閉じています」を添える。検索が終われば、元の開き方へ戻る。
 * どの群も 0 件のときは何も描かない。「実行中のセッションはありません」の 1 行は、画面の側が出す。
 * note は帯の右端に添える 1 行の注記で、画面が渡す（始める前の確認の要約など）。
 * 群が progress を持てば錠剤の横に進みの棒を、fold を持てば引き出しの末尾に畳んだ 1 行を出す（始める前の確認）。畳んだ行を押すと、済んだものの行が開く。
 */
export function HomeBand(props: HomeBandProps & { searching?: boolean; note?: string | null }) {
  const t = useT();
  const uid = useId();
  const pills = useRef(new Map<string, HTMLButtonElement | null>());
  const [open, setOpen] = useState<string | null>(props.morning);
  const [foldOpen, setFoldOpen] = useState(false);
  if (props.groups.every((g) => g.count === 0)) return null;
  const searching = props.searching === true;
  const shown = searching ? null : props.groups.find((g) => g.id === open && g.count > 0) ?? null;
  const drawerId = (g: BandGroup) => `${uid}-${g.id}`;
  const note = searching ? t('home.band.searchNote') : props.note ?? null;
  return (
    <section className="home-band" aria-label={t('home.band.label')}>
      <div className="band">
        {props.groups.map((g) => {
          const chip = { label: g.label, count: g.count, countText: g.countText, icon: g.icon, tone: g.tone } as const;
          // 検索の間と 0 件は、onClick を渡さず、読むだけの札にする。
          const bar = g.progress !== undefined ? <span className="band-prog" aria-hidden="true"><span style={{ width: `${g.progress}%` }} /></span> : null;
          if (searching || g.count === 0) return <Fragment key={g.id}><CountChip {...chip} />{bar}</Fragment>;
          const expanded = shown?.id === g.id;
          return (
            <Fragment key={g.id}>
              <CountChip {...chip} expanded={expanded} aria-controls={expanded ? drawerId(g) : undefined}
                ref={(el) => { pills.current.set(g.id, el); }}
                onClick={() => setOpen(expanded ? null : g.id)} />
              {bar}
            </Fragment>
          );
        })}
        {note && <span className="band-text">{note}</span>}
      </div>
      {shown && (
        <div className="drawer" id={drawerId(shown)} data-group={shown.id} role="region" aria-label={shown.label}>
          <div className="drawer-h">
            <b>{shown.label}</b>
            {shown.summary !== '' && <span className="faint">{shown.summary}</span>}
            <button type="button" className="drawer-close" onClick={() => { setOpen(null); pills.current.get(shown.id)?.focus(); }}>
              {t('home.band.collapse')}<Icon name="chevronUp" />
            </button>
          </div>
          <ul className="drawer-list">
            {shown.rows.map((r) => <BandRowView key={r.key} row={r} />)}
          </ul>
          {shown.fold && (
            <>
              <button type="button" className="drawer-fold" aria-expanded={foldOpen} aria-controls={foldOpen ? `${drawerId(shown)}-fold` : undefined} onClick={() => setFoldOpen(!foldOpen)}>
                <Icon name="check" /><span>{shown.fold.text}</span><Icon name={foldOpen ? 'chevronDown' : 'chevron'} />
              </button>
              {foldOpen && <ul className="drawer-list drawer-folded" id={`${drawerId(shown)}-fold`}>{shown.fold.rows.map((r) => <BandRowView key={r.key} row={r} />)}</ul>}
            </>
          )}
        </div>
      )}
    </section>
  );
}

/** 始める前の確認の印。色だけでなく形（✓、ⓘ、!、✗）でも分ける。 */
const CHECK_ICON: Record<'ok' | 'info' | 'soft' | 'ng', IconName> = { ok: 'ok', info: 'info', soft: 'alert', ng: 'ng' };

/** 行頭の印。 */
function Lead(props: { lead: BandLead }) {
  const l = props.lead;
  switch (l.kind) {
    case 'dot': return <StatusDot status={l.live} aside={l.aside} />;
    case 'tag': return l.tone === 'cand'
      ? <span className="home-cand">{l.text}</span>
      : <span className="return-when" data-due={l.tone === 'due' ? 'true' : undefined} title={l.title}>{l.text}</span>;
    case 'todo': return <span className="cand-mark" aria-hidden="true" />;
    case 'place': return <span className="place-mark" aria-hidden="true"><Icon name="folder" /></span>;
    case 'check': return <span className="ck-mark" data-tone={l.tone} role="img" aria-label={l.label}><Icon name={CHECK_ICON[l.tone]} /></span>;
  }
}

/** 引き出しの 1 行。1 件を 1 行で読み、ボタンは右端に置く。 */
function BandRowView(props: { row: BandRow }) {
  const emit = useEmit();
  const r = props.row;
  const open = r.open;
  return (
    <li className="crow" data-k={r.tone ?? (r.lead.kind === 'check' ? 'check' : r.lead.kind === 'place' ? 'place' : undefined)}>
      <Lead lead={r.lead} />
      {open
        ? <button type="button" className="c-name c-link" onClick={() => emit(open)}>{r.name}</button>
        : <span className="c-name">{r.name}{r.badge && <span className="c-badge">{r.badge}</span>}</span>}
      {r.context !== null && <span className="c-proj">{r.context}</span>}
      {r.lead.kind === 'check'
        // 確認の行は、説明を先に切り、命令（コピーする文）を残す。
        ? <span className="c-text"><span className="c-desc">{r.text}</span>{r.detail !== null && <i>{r.detail}</i>}</span>
        : <span className="c-text">{r.text}{r.text !== '' && r.detail !== null && '　'}{r.detail !== null && <i>{r.detail}</i>}</span>}
      <span className="c-end">
        {r.trail.map((x, i) => <span key={i} data-tone={x.tone}>{x.text}</span>)}
        {r.actions.map((a) => (
          <button key={a.id} type="button" className={`btn btn-sm${a.primary ? ' btn-primary' : ''}${a.ghost ? ' btn-ghost' : ''}`} aria-label={a.ariaLabel} onClick={() => emit(a.intent)}>{a.label}</button>
        ))}
      </span>
    </li>
  );
}
