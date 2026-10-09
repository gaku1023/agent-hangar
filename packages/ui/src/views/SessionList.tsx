import { type Intent, type SearchFilter, type StatusFilter } from '@agent-hangar/shared';
import { useId, useState, type KeyboardEvent, type ReactNode } from 'react';
import { useEmit } from '../intent/chain.tsx';
import { parseQuery } from '../lib/searchTokens.ts';
import type { SessionListProps, StatusTab, StatusTabProps } from '../presenters/sessions.ts';
import { isComposing } from './ime.ts';
import { Pager } from './Pager.tsx';
import { Icon } from './primitives/Icon.tsx';
import { useT } from './primitives/language.tsx';
import { Listbox } from './primitives/Listbox.tsx';
import { Segmented } from './primitives/Segmented.tsx';
import { SessionRows } from './SessionRows.tsx';

/** 件数は桁を区切る（タブの件数と同じ書き方）。 */
const fmt = (n: number) => n.toLocaleString('en-US');

/** その項目の絞り込みを外す patch。チップの × と、空の欄の Backspace で使う。 */
const unset = (key: keyof SearchFilter) => ({ [key]: undefined }) as Partial<SearchFilter>;

/**
 * 件数つきの状態のタブ。押すと search.filter で状態を絞り、「すべて」は外す。いま選んでいるタブは何も出さない。
 * 数字を灯すのは hot のタブ（確認待ちが 1 件以上のとき）。
 */
export function StatusTabs(props: { tabs: StatusTabProps[]; tab: StatusTab }) {
  const emit = useEmit();
  const t = useT();
  const pick = (tab: StatusTab) => { if (tab !== props.tab) emit({ type: 'search.filter', patch: { status: tab === 'all' ? undefined : tab } }); };
  return (
    <div className="sessions-tabs" role="group" aria-label={t('list.tabs.label')}>
      {props.tabs.map((x) => (
        <button key={x.tab} type="button" className="sessions-tab" data-empty={x.count === '0' ? 'true' : undefined} aria-pressed={x.tab === props.tab} onClick={() => pick(x.tab)}>
          {x.label}<span className="sessions-tab-n" data-hot={x.hot ? 'true' : undefined}>{x.count}</span>
        </button>
      ))}
    </div>
  );
}

/**
 * 検索の欄。欄を正とする。トークン（is:paused、since:7d、project:、file:）を受け、Enter で読んだ条件を search.query に添えて出す。
 * 効いている条件は欄の中のチップになる。Backspace は、欄が空のときに最後のチップを外す。
 * 欄は打った文字を自分で持つので、語が変わったら呼び手が key で作り直す。
 */
export function KeywordField(props: Pick<SessionListProps, 'text' | 'filter' | 'projects' | 'tokens'>) {
  const emit = useEmit();
  const t = useT();
  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (isComposing(e)) return;
    const input = e.currentTarget;
    if (e.key === 'Enter') {
      // 打ったトークンは今のチップに重ねる。読めた分は欄から消し、残った語だけを欄に残す。
      const { text, filter } = parseQuery(input.value, props.projects);
      input.value = text;
      emit({ type: 'search.query', text, filter: { ...props.filter, ...filter } });
    } else if (e.key === 'Backspace' && input.value === '' && props.tokens.length > 0) {
      // 空の欄で Backspace を押したら、最後のチップを外す。
      emit({ type: 'search.filter', patch: unset(props.tokens[props.tokens.length - 1]!.key) });
    }
  };
  return (
    <div className="sessions-keyword">
      <Icon name="fullText" />
      {props.tokens.map((x) => (
        <span key={x.key} className="sessions-token">
          <span className="sessions-token-text">{x.token}</span>
          <button type="button" className="sessions-token-x" aria-label={t('list.token.remove', { token: x.token })} onClick={() => emit({ type: 'search.filter', patch: unset(x.key) })}><Icon name="close" /></button>
        </span>
      ))}
      <input aria-label={t('list.search.label')} placeholder={props.tokens.length > 0 ? '' : t('list.search.placeholder')} defaultValue={props.text} onKeyDown={onKeyDown} />
      {/* 探すのは会話のトランスクリプトである（server/src/search/search.ts は event_fts の本文だけを引く）。名前と要約も引く形は PR 27 で足す。 */}
      <span className="sessions-keyword-tag">{t('list.search.tag')}</span>
      {/* 絞り込みを添えるのは、プロジェクトの画面で、画面を移さずに語だけを外すため（mediator/screen.ts の searchQueryStep）。ホームでは今の絞り込みのままで同じである。 */}
      {props.text && <button type="button" className="btn btn-sm sessions-keyword-clear" aria-label={t('list.search.clear')} onClick={() => emit({ type: 'search.query', text: '', filter: props.filter })}><Icon name="close" /></button>}
    </div>
  );
}

/** 読めなかったトークンの知らせ。欄のすぐ下に出す。 */
function Hints(props: { hints: string[] }) {
  if (props.hints.length === 0) return null;
  return <div className="sessions-hint" role="note">{props.hints.map((h) => <div key={h}>{h}</div>)}</div>;
}

/**
 * 絞り込みの条件のうち、絞り込みのボタンの中にあるもの（プロジェクト、期間、操作したファイル）の数。
 * ボタンの印に出す。語と状態と動きは、欄とタブがもう言っている。projectFixed のときはプロジェクトを数えない（選べないので）。
 */
export function panelConditionCount(filter: SearchFilter, projectFixed = false): number {
  return (!projectFixed && filter.projectId ? 1 : 0) + (filter.days ? 1 : 0) + (filter.file ? 1 : 0);
}

/**
 * 絞り込みのボタン（欄の横）。押すと絞り込み（プロジェクト、期間、操作したファイル）が欄の下に開き、効いている条件の数を印で出す。
 * 開いているかは View の中の状態で、Mediator には置かない。
 */
export function FilterButton(props: { open: boolean; count: number; controls: string; onToggle: () => void }) {
  const t = useT();
  const label = t('list.filter.button');
  return (
    <button type="button" className="btn filter-btn" aria-expanded={props.open} aria-controls={props.open ? props.controls : undefined}
      aria-label={props.count > 0 ? t('list.filter.buttonCount', { n: props.count }) : label} onClick={props.onToggle}>
      <Icon name="filter" /><span aria-hidden={props.count > 0 ? 'true' : undefined}>{label}</span>
      {props.count > 0 && <span className="filter-n num" aria-hidden="true">{props.count}</span>}
    </button>
  );
}

/**
 * 絞り込み（プロジェクト、期間、操作したファイル）。押すと search.filter を出し、効いている条件は欄のチップになる。
 * projectFixed は、プロジェクトの画面のようにプロジェクトが決まっているときで、プロジェクトの選択を出さない。
 */
export function Filters(props: Pick<SessionListProps, 'filter' | 'projects'> & { projectFixed?: boolean; id?: string }) {
  const emit = useEmit();
  const t = useT();
  const period = props.filter.days ? String(props.filter.days) : '';
  /**
   * 期間の選択肢。値は今日を含めた日数で、空は絞り込みなし。
   * 「今日」は暦の今日（0 時から）、「7 日」は今日とその前の 6 日である（mediator/screen.ts の periodStart）。
   */
  const periods = [{ value: '', label: t('list.period.all') }, { value: '1', label: t('list.period.today') }, { value: '7', label: t('list.period.week') }, { value: '30', label: t('list.period.month') }];
  return (
    <div className="sessions-filters" id={props.id}>
      {!props.projectFixed && (
        <Listbox label={t('list.filter.project')} value={props.filter.projectId ?? ''} options={[{ value: '', label: t('list.filter.allProjects') }, ...props.projects.map((p) => ({ value: p.id, label: p.name }))]}
          onChange={(v) => emit({ type: 'search.filter', patch: { projectId: v || undefined } })} faceClassName="listbox-face listbox-pill" minWidth={280} searchPlaceholder={t('list.filter.projectSearch')} />
      )}
      {/* 帯に無い期間（since:14d など）では、どの帯にも印を付けない。「全期間」に印が付くと、絞っていないように読める。 */}
      <Segmented label={t('list.filter.period')} value={period} options={periods}
        onChange={(v) => emit({ type: 'search.filter', patch: { days: v ? Number(v) : undefined } })} />
      {/* 条件をクリアしたときに欄の文字も消えるよう、値が変わったら作り直す。 */}
      <input key={props.filter.file ?? ''} className="input" aria-label={t('list.filter.file')} placeholder={t('list.filter.file')} defaultValue={props.filter.file ?? ''} onKeyDown={(e) => { if (e.key === 'Enter' && !isComposing(e)) emit({ type: 'search.filter', patch: { file: (e.target as HTMLInputElement).value || undefined } }); }} />
    </div>
  );
}

/**
 * 条件の行。効いている条件、「条件をクリア」、件数を並べる（D1）。
 * 状態のタブだけで絞っているときは出さない。選んだタブと欄の札（is:done）が、同じ条件と件数を既に言っている。
 * 語、期間、プロジェクト、ファイルのどれかが加わったら出す（そのときの件数はタブの数と違う）。
 */
export function ConditionRow(props: Pick<SessionListProps, 'conditions' | 'tab' | 'filter' | 'loading' | 'total'>) {
  const emit = useEmit();
  const t = useT();
  const tabOnly = props.tab !== 'all' && props.conditions.length === 1 && props.filter.status !== undefined;
  if (props.conditions.length === 0 || tabOnly) return null;
  // 件数は条件に合う全件で、いまのページの範囲は下のページ送りの帯が言う。
  const count = props.loading ? t('list.cond.searching') : t('list.cond.count', { n: fmt(props.total) });
  return (
    <div className="sessions-cond" role="status" aria-label={t('list.cond.label')}>
      <Icon name="filter" />
      <span className="sessions-cond-text">{props.conditions.map((c, i) => <span key={i}>{i > 0 && ' · '}<b>{c}</b></span>)}{t('list.cond.suffix')}</span>
      <button type="button" className="btn btn-sm sessions-cond-clear" onClick={() => emit({ type: 'search.clear' })}><Icon name="close" />{t('list.cond.clear')}</button>
      <span className="faint num sessions-cond-count">{count}</span>
    </div>
  );
}

/**
 * 検索の結果の末尾の「さらに N 件を読み込む」と、残りの件数。ページ送りの代わりに出す。
 * N は、残りが次に読む件数（step）に足りなければ残りの件数にする。
 * 読み込みの最中は押せない。
 */
export function LoadMore(props: { remaining: number; step: number; loading?: boolean; onLoad: () => void }) {
  const t = useT();
  if (props.remaining <= 0) return null;
  const n = Math.min(props.step, props.remaining);
  return (
    <div className="load-more">
      <button type="button" className="btn btn-sm" disabled={props.loading} onClick={props.onLoad}>{props.loading ? t('list.more.loading') : t('list.more.load', { n: fmt(n) })}</button>
      <span className="faint num load-more-rest">{t('list.more.rest', { n: fmt(props.remaining) })}</span>
    </div>
  );
}

/** 一覧の組み。ホームとプロジェクトの画面が、同じ部品を props の違いだけで使う。 */
export type SessionListOptions = {
  /** プロジェクトが決まっている画面（プロジェクトの画面）で、絞り込みにプロジェクトの選択を出さず、行にプロジェクト名を出さない。 */
  projectFixed?: boolean;
  /** 検索の結果の末尾に「さらに読み込む」を出す。あれば、ページ送りの代わりに出る。 */
  loadMore?: { remaining: number; step: number; loading?: boolean; onLoad: () => void };
  /** 行が 1 つも無いときに、既定の 1 行の代わりに出す札（ホームの初めての人の札）。 */
  empty?: ReactNode;
  /** 行の一覧の id と、開いたときにフォーカスを取るか。 */
  id?: string;
  autoFocus?: boolean;
};

/**
 * セッションの一覧。上から、件数つきの状態のタブ、欄と絞り込みのボタン、（開いていれば）絞り込み、読めなかったトークンの知らせ、条件の行、行、ページ送りの順に置く。
 * 見出しと器（.screen）は持たない。呼び手の器に直接並べ、一覧は器の高さを受け取る。
 * 一覧はいつも平らで、状態のタブで絞る。条件が無いときも節には分けない。
 * 動きの切替は外した。入力待ちと実行中は Home の帯が出し、ここでは is:running と is:waiting で届く。
 */
export function SessionList(props: SessionListProps & SessionListOptions) {
  const emit = useEmit();
  const t = useT();
  const uid = useId();
  const [filtersOpen, setFiltersOpen] = useState(false);
  const filtersId = `${uid}-filters`;
  // 行の状態の札を押すと、そのタブへ移る（★ の E）。
  const badgeIntent = (status: StatusFilter): Intent => ({ type: 'search.filter', patch: { status } });
  const id = props.id ?? 'session-results';
  const autoFocus = props.autoFocus ?? true;
  return (
    <>
      <StatusTabs tabs={props.tabs} tab={props.tab} />
      <div className="search-row">
        {/* 欄は打った文字を自分で持つので、語が変わったら作り直す。 */}
        <KeywordField key={props.text} text={props.text} filter={props.filter} projects={props.projects} tokens={props.tokens} />
        <FilterButton open={filtersOpen} count={panelConditionCount(props.filter, props.projectFixed)} controls={filtersId} onToggle={() => setFiltersOpen(!filtersOpen)} />
      </div>
      {filtersOpen && <Filters id={filtersId} filter={props.filter} projects={props.projects} projectFixed={props.projectFixed} />}
      <Hints hints={props.hints} />
      <ConditionRow conditions={props.conditions} tab={props.tab} filter={props.filter} loading={props.loading} total={props.total} />
      <SessionRows id={id} rows={props.rows} variant={props.projectFixed ? 'project' : 'search'} autoFocus={autoFocus} page={props.pager?.page} statusColumn={props.statusColumn} emptyText={props.mode === 'search' && !props.loading ? t('list.empty.noMatch') : undefined} emptyNode={props.empty} badgeIntent={badgeIntent} />
      {props.loadMore
        ? <LoadMore {...props.loadMore} />
        : props.pager && <Pager label={t('list.pager.label')} pager={props.pager} onPage={(page) => emit({ type: 'search.page', page })} onSize={(size) => emit({ type: 'list.pageSize', size })} />}
    </>
  );
}
