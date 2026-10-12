import { Fragment, useId, useLayoutEffect, useRef, useState } from 'react';
import { useEmit } from '../action/chain.tsx';
import type { BandAction, BandGroup, BandLead, BandRow, BandSection, HomeBandProps } from '../presenters/home.ts';
import { OverlapChip } from './OverlapPopover.tsx';
import { CountChip } from './primitives/Chip.tsx';
import { Icon, type IconName } from './primitives/Icon.tsx';
import { useT } from './primitives/language.tsx';
import { collapseOut, fadeIn, fadeOut, growIn, motionOn, resizeFrom } from './primitives/motionKit.ts';
import { StatusDot } from './primitives/StatusDot.tsx';
import { useMotionList } from './primitives/useMotionList.ts';
import { usePresence } from './primitives/usePresence.ts';

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
 * 動き（設計書「Home の帯と引き出し」）：引き出しは伸びて開き、畳んで閉じる（閉じる間は前の中身のまま、役も焦点も持たない）。
 * 群を替えたら、引き出しの高さを補間し、中身を --dur-fast で薄れから現す。引き出しの行は伸びて入り、畳んで出る。並びが替わったら滑らせず、上がった行に淡い黄の印を付ける。件数は回す。注記は薄く出入りする。
 */
export function HomeBand(props: HomeBandProps & { searching?: boolean; note?: string | null }) {
  const t = useT();
  const uid = useId();
  const pills = useRef(new Map<string, HTMLButtonElement | null>());
  const [open, setOpen] = useState<string | null>(props.morning);
  const [foldOpen, setFoldOpen] = useState(false);
  const empty = props.groups.every((g) => g.count === 0);
  const searching = props.searching === true;
  const shown = empty || searching ? null : props.groups.find((g) => g.id === open && g.count > 0) ?? null;
  // 閉じる間も中身を読めるように、最後に開いていた群を控えておく。
  const lastShown = useRef(shown);
  if (shown) lastShown.current = shown;
  const drawer = usePresence<HTMLDivElement>(shown !== null, (el) => (motionOn(el) ? collapseOut(el) : null));
  const body = useRef<HTMLDivElement>(null);
  // 群を替える前の引き出しの高さ。錠剤を押した時点で測り、替えた描画で補間する。
  const switchFrom = useRef<number | null>(null);
  const wasOpen = useRef(shown !== null);
  useLayoutEffect(() => {
    const el = drawer.ref.current;
    if (el && shown && !wasOpen.current) growIn(el);
    else if (el && shown && switchFrom.current !== null) {
      resizeFrom(el, switchFrom.current);
      if (body.current) fadeIn(body.current, '--dur-fast');
    }
    switchFrom.current = null;
    wasOpen.current = shown !== null;
    // 開いている群が替わったときだけ動かす。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shown?.id ?? null]);
  if (empty) return null;
  const drawerId = (g: BandGroup) => `${uid}-${g.id}`;
  const note = searching ? t('home.band.searchNote') : props.note ?? null;
  const d = shown ?? (drawer.mounted ? lastShown.current : null);
  const leaving = drawer.leaving;
  const pick = (g: BandGroup, expanded: boolean) => {
    if (!expanded && shown && drawer.ref.current) switchFrom.current = drawer.ref.current.offsetHeight;
    setOpen(expanded ? null : g.id);
  };
  return (
    <section className="home-band" aria-label={t('home.band.label')}>
      <div className="band">
        {props.groups.map((g) => {
          const chip = { label: g.label, count: g.count, countText: g.countText, icon: g.icon, tone: g.tone, rolling: true, mark: g.mark ?? null } as const;
          // 検索の間と 0 件は、onClick を渡さず、読むだけの札にする。
          const bar = g.progress !== undefined ? <span className="band-prog" aria-hidden="true"><span style={{ width: `${g.progress}%` }} /></span> : null;
          if (searching || g.count === 0) return <Fragment key={g.id}><CountChip {...chip} />{bar}</Fragment>;
          const expanded = shown?.id === g.id;
          return (
            <Fragment key={g.id}>
              <CountChip {...chip} expanded={expanded} aria-controls={expanded ? drawerId(g) : undefined}
                ref={(el) => { pills.current.set(g.id, el); }}
                onClick={() => pick(g, expanded)} />
              {bar}
            </Fragment>
          );
        })}
        <BandNote text={note} />
      </div>
      {d && drawer.mounted && (
        // 閉じる間（leaving）は、見た目だけを残す。役も、焦点も、読み上げも持たせない。
        <div ref={drawer.ref} className="drawer" id={leaving ? undefined : drawerId(d)} data-group={d.id} role={leaving ? undefined : 'region'} aria-label={leaving ? undefined : d.label} aria-hidden={leaving ? true : undefined} inert={leaving || undefined}>
          <div ref={body} className="drawer-body">
            <div className="drawer-h">
              <b>{d.label}</b>
              {d.summary !== '' && <span className="faint">{d.summary}</span>}
              {d.headActions && d.headActions.length > 0 && (
                <span className="drawer-acts">
                  {d.headActions.map((a) => <BandButton key={a.id} action={a} />)}
                </span>
              )}
              <button type="button" className="drawer-close" onClick={() => { setOpen(null); pills.current.get(d.id)?.focus(); }}>
                {t('home.band.collapse')}<Icon name="chevronUp" />
              </button>
            </div>
            <BandRows rows={d.rows} scope={d.id} />
            {d.fold && (
              <>
                <button type="button" className="drawer-fold" aria-expanded={foldOpen} aria-controls={foldOpen ? `${drawerId(d)}-fold` : undefined} onClick={() => setFoldOpen(!foldOpen)}>
                  <Icon name="check" /><span>{d.fold.text}</span><Icon name={foldOpen ? 'chevronDown' : 'chevron'} />
                </button>
                {foldOpen && <BandRows rows={d.fold.rows} scope={`${d.id}:fold`} folded id={`${drawerId(d)}-fold`} />}
              </>
            )}
          </div>
        </div>
      )}
    </section>
  );
}

/**
 * 帯の右端の 1 行の注記。出るときは --dur-fast で薄れから現し、消えるときは薄れてから外す。文が替わったら、新しい文を薄れから現す。
 */
function BandNote(props: { text: string | null }) {
  const last = useRef(props.text);
  if (props.text !== null) last.current = props.text;
  const p = usePresence<HTMLSpanElement>(props.text !== null, (el) => (motionOn(el) ? fadeOut(el) : null));
  const prev = useRef(props.text);
  useLayoutEffect(() => {
    if (props.text !== null && props.text !== prev.current && p.ref.current) fadeIn(p.ref.current, '--dur-fast');
    prev.current = props.text;
    // 文が替わったときだけ動かす。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.text]);
  if (!p.mounted) return null;
  return <span ref={p.ref} className="band-text" aria-hidden={p.leaving ? true : undefined}>{props.text ?? last.current}</span>;
}

/**
 * 引き出しの行の並び。来た行は伸びて入り、解けた行は畳んで出る（useMotionList の grow）。
 * 並びが替わっても滑らせず、上がった行の地だけを淡い黄から薄れさせる（一覧の ⑤ の c と同じ。実行中の並びは数秒おきに替わるので、滑らせると目がうるさい）。
 * scope は群で、群を替えた描画は出入りに見せない。畳んで出る行は、役も焦点も持たない見た目だけにする。
 */
function BandRows(props: { rows: BandRow[]; scope: string; folded?: boolean; id?: string }) {
  const { list, ref } = useMotionList(props.rows, (r) => r.key, { enter: 'grow', flip: false, hitRisen: true, scope: props.scope });
  return (
    <ul className={props.folded ? 'drawer-list drawer-folded' : 'drawer-list'} id={props.id}>
      {list.map((e, i) => {
        // 小見出し（アカウント）は、区切りが前の行と替わったところに置く。
        const sec = e.item.section;
        const head = sec && (i === 0 || list[i - 1]!.item.section?.key !== sec.key) ? <BandSectionHead key={`sec:${sec.key}`} section={sec} /> : null;
        return <Fragment key={e.key}>{head}<BandRowView row={e.item} leaving={e.leaving} rowRef={ref(e.key)} /></Fragment>;
      })}
    </ul>
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
    case 'ring': return <span className="int-ring" data-spin={l.spin ? 'true' : undefined} role="img" aria-label={l.label} />;
  }
}

/** 行と見出しのボタン。icon があれば絵だけを出し、読み上げの名前は ariaLabel のままにする。 */
function BandButton(props: { action: BandAction }) {
  const emit = useEmit();
  const a = props.action;
  const cls = `btn btn-sm${a.primary ? ' btn-primary' : ''}${a.ghost ? ' btn-ghost' : ''}${a.icon ? ' btn-icon' : ''}`;
  return (
    <button type="button" className={cls} aria-label={a.ariaLabel} title={a.icon ? a.label : undefined} disabled={a.disabled} onClick={() => emit(a.send)}>
      {a.icon ? <Icon name={a.icon} /> : a.label}
    </button>
  );
}

/** 引き出しの中の小見出し（中断の群のアカウント）。色の点、名前、5 時間の使用率、添える一言、ボタン（ログイン）。 */
function BandSectionHead(props: { section: BandSection }) {
  const s = props.section;
  return (
    <li className="crow-sec">
      <span className="sec-dot" style={{ background: s.color }} aria-hidden="true" />
      <b>{s.name}</b>
      {s.meter && (
        <span className="sec-meter" data-high={s.meter.high ? 'true' : undefined}>
          <span>{s.meter.label}</span>
          <span className="sec-bar" aria-hidden="true"><span style={{ width: `${Math.min(100, Math.max(0, s.meter.percent))}%` }} /></span>
        </span>
      )}
      {s.note && <span className="sec-note" data-tone={s.note.tone}>{s.note.text}</span>}
      {s.action && <BandButton action={s.action} />}
    </li>
  );
}

/** 引き出しの 1 行。1 件を 1 行で読み、ボタンは右端に置く。 */
function BandRowView(props: { row: BandRow; leaving?: boolean; rowRef?: (el: HTMLElement | null) => void }) {
  const emit = useEmit();
  const r = props.row;
  const open = r.open;
  return (
    <li ref={props.rowRef} className="crow" data-k={r.tone ?? (r.lead.kind === 'check' ? 'check' : r.lead.kind === 'place' ? 'place' : undefined)} aria-hidden={props.leaving ? true : undefined} inert={props.leaving || undefined}>
      <Lead lead={r.lead} />
      {open
        ? <button type="button" className="c-name c-link" onClick={() => emit(open)}>{r.name}</button>
        : <span className="c-name">{r.name}{r.badge && <span className="c-badge">{r.badge}</span>}</span>}
      {r.context !== null && <span className="c-proj">{r.context}</span>}
      {r.textHead && <span className="c-head" data-tone={r.textHead.tone}>{r.textHead.text}</span>}
      {r.lead.kind === 'check'
        // 確認の行は、説明を先に切り、命令（コピーする文）を残す。
        ? <span className="c-text"><span className="c-desc">{r.text}</span>{r.detail !== null && <i>{r.detail}</i>}</span>
        : <span className="c-text">{r.text}{r.text !== '' && r.detail !== null && '　'}{r.detail !== null && <i>{r.detail}</i>}</span>}
      <span className="c-end">
        {r.overlap && <OverlapChip overlap={r.overlap} name={r.name} />}
        {r.trail.map((x, i) => <span key={i} data-tone={x.tone}>{x.text}</span>)}
        {r.actions.map((a) => <BandButton key={a.id} action={a} />)}
      </span>
    </li>
  );
}
