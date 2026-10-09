import { type Intent, type SearchFilter, type StatusFilter } from '@agent-hangar/shared';
import type { KeyboardEvent } from 'react';
import { useEmit } from '../intent/chain.tsx';
import { parseQuery } from '../lib/searchTokens.ts';
import { SECTION_TAB, type SectionId } from '../presenters/sections.ts';
import type { SessionListProps, StatusTab, StatusTabProps } from '../presenters/sessions.ts';
import { isComposing } from './ime.ts';
import { Pager } from './Pager.tsx';
import { Icon } from './primitives/Icon.tsx';
import { Listbox } from './primitives/Listbox.tsx';
import { Segmented } from './primitives/Segmented.tsx';
import { SessionRows } from './SessionRows.tsx';

/**
 * 期間の選択肢。値は今日を含めた日数で、空は絞り込みなし。
 * 「今日」は暦の今日（0 時から）、「7 日」は今日とその前の 6 日である（mediator/screen.ts の periodStart）。
 */
const PERIODS = [{ value: '', label: '全期間' }, { value: '1', label: '今日' }, { value: '7', label: '7 日' }, { value: '30', label: '30 日' }];
/** 件数は桁を区切る（タブの件数と同じ書き方）。 */
const fmt = (n: number) => n.toLocaleString('en-US');
/** 欄が空のときの案内。トークンの書き方をここで見せる。 */
const PLACEHOLDER = 'キーワード、または is:paused · since:7d · project: · file:';

/** その項目の絞り込みを外す patch。チップの × と、空の欄の Backspace で使う。 */
const unset = (key: keyof SearchFilter) => ({ [key]: undefined }) as Partial<SearchFilter>;

/**
 * 件数つきの状態のタブ。押すと search.filter で状態を絞り、「すべて」は外す。いま選んでいるタブは何も出さない。
 * 数字を灯すのは hot のタブ（確かめるが 1 件以上のとき）。
 */
export function StatusTabs(props: { tabs: StatusTabProps[]; tab: StatusTab }) {
  const emit = useEmit();
  const pick = (tab: StatusTab) => { if (tab !== props.tab) emit({ type: 'search.filter', patch: { status: tab === 'all' ? undefined : tab } }); };
  return (
    <div className="sessions-tabs" role="group" aria-label="状態">
      {props.tabs.map((t) => (
        <button key={t.tab} type="button" className="sessions-tab" data-empty={t.count === '0' ? 'true' : undefined} aria-pressed={t.tab === props.tab} onClick={() => pick(t.tab)}>
          {t.label}<span className="sessions-tab-n" data-hot={t.hot ? 'true' : undefined}>{t.count}</span>
        </button>
      ))}
    </div>
  );
}

/**
 * 全文検索の欄。欄を正とする。トークン（is:paused、since:7d、project:、file:）を受け、Enter で読んだ条件を search.query に添えて出す。
 * 効いている条件は欄の中のチップになる。Backspace は、欄が空のときに最後のチップを外す。
 * 欄は打った文字を自分で持つので、語が変わったら呼び手が key で作り直す。
 */
export function KeywordField(props: Pick<SessionListProps, 'text' | 'filter' | 'projects' | 'tokens' | 'hints'>) {
  const emit = useEmit();
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
    <>
      <div className="sessions-keyword">
        <Icon name="fullText" />
        {props.tokens.map((t) => (
          <span key={t.key} className="sessions-token">
            <span className="sessions-token-text">{t.token}</span>
            <button type="button" className="sessions-token-x" aria-label={`${t.token} を外す`} onClick={() => emit({ type: 'search.filter', patch: unset(t.key) })}><Icon name="close" /></button>
          </span>
        ))}
        <input aria-label="キーワード" placeholder={props.tokens.length > 0 ? '' : PLACEHOLDER} defaultValue={props.text} onKeyDown={onKeyDown} />
        {/* 探すのは会話の本文である（server/src/search/search.ts は event_fts の本文だけを引く）。 */}
        <span className="sessions-keyword-tag">本文</span>
        {props.text && <button type="button" className="btn btn-sm sessions-keyword-clear" aria-label="キーワードを消す" onClick={() => emit({ type: 'search.query', text: '' })}><Icon name="close" /></button>}
      </div>
      {props.hints.length > 0 && <div className="sessions-hint" role="note">{props.hints.map((h) => <div key={h}>{h}</div>)}</div>}
    </>
  );
}

/**
 * 絞り込み（プロジェクト、期間、触ったファイル）。押すと search.filter を出し、効いている条件は欄のチップになる。
 * projectFixed は、プロジェクトの画面のようにプロジェクトが決まっているときで、プロジェクトの選択を出さない。
 */
export function Filters(props: Pick<SessionListProps, 'filter' | 'projects'> & { projectFixed?: boolean }) {
  const emit = useEmit();
  const period = props.filter.days ? String(props.filter.days) : '';
  return (
    <div className="sessions-filters">
      {!props.projectFixed && (
        <Listbox label="プロジェクト" value={props.filter.projectId ?? ''} options={[{ value: '', label: 'すべてのプロジェクト' }, ...props.projects.map((p) => ({ value: p.id, label: p.name }))]}
          onChange={(v) => emit({ type: 'search.filter', patch: { projectId: v || undefined } })} faceClassName="listbox-face listbox-pill" minWidth={280} searchPlaceholder="プロジェクトを探す" />
      )}
      {/* 帯に無い期間（since:14d など）では、どの帯にも印を付けない。「全期間」に印が付くと、絞っていないように読める。 */}
      <Segmented label="期間" value={period} options={PERIODS}
        onChange={(v) => emit({ type: 'search.filter', patch: { days: v ? Number(v) : undefined } })} />
      {/* 条件をクリアしたときに欄の文字も消えるよう、値が変わったら作り直す。 */}
      <input key={props.filter.file ?? ''} className="input" aria-label="ファイル" placeholder="触ったファイル" defaultValue={props.filter.file ?? ''} onKeyDown={(e) => { if (e.key === 'Enter' && !isComposing(e)) emit({ type: 'search.filter', patch: { file: (e.target as HTMLInputElement).value || undefined } }); }} />
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
  const tabOnly = props.tab !== 'all' && props.conditions.length === 1 && props.filter.status !== undefined;
  if (props.conditions.length === 0 || tabOnly) return null;
  // 件数は条件に合う全件で、いまのページの範囲は下のページ送りの帯が言う。
  const count = props.loading ? '検索しています' : `${fmt(props.total)} 件`;
  return (
    <div className="sessions-cond" role="status" aria-label="絞り込みの条件">
      <Icon name="filter" />
      <span className="sessions-cond-text">{props.conditions.map((c, i) => <span key={i}>{i > 0 && ' · '}<b>{c}</b></span>)} で絞り込み中</span>
      <button type="button" className="btn btn-sm sessions-cond-clear" onClick={() => emit({ type: 'search.clear' })}><Icon name="close" />条件をクリア</button>
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
  if (props.remaining <= 0) return null;
  const n = Math.min(props.step, props.remaining);
  return (
    <div className="load-more">
      <button type="button" className="btn btn-sm" disabled={props.loading} onClick={props.onLoad}>{props.loading ? '読み込んでいます' : `さらに ${fmt(n)} 件を読み込む`}</button>
      <span className="faint num load-more-rest">残り {fmt(props.remaining)} 件</span>
    </div>
  );
}

/** 一覧の組み。ホームとプロジェクトの画面が、同じ部品を props の違いだけで使う。 */
export type SessionListOptions = {
  /** プロジェクトが決まっている画面（プロジェクトの画面）で、絞り込みにプロジェクトの選択を出さない。 */
  projectFixed?: boolean;
  /** 検索の結果の末尾に「さらに読み込む」を出す。あれば、ページ送りの代わりに出る。 */
  loadMore?: { remaining: number; step: number; loading?: boolean; onLoad: () => void };
  /** 行の一覧の id と、開いたときにフォーカスを取るか。 */
  id?: string;
  autoFocus?: boolean;
  /** 節の見出しの「この節だけ見る」の意図。省くと、その節のタブを選ぶ（search.filter）。 */
  moreIntent?: (target: SectionId) => Intent | null;
};

/**
 * セッションの一覧。上から、件数つきの状態のタブ、全文検索の欄、絞り込み、条件の行、行、ページ送りの順に置く。
 * 見出しと器（.screen）は持たない。呼び手の器に直接並べ、一覧は器の高さを受け取る。
 * 条件が無いときは節で読み（sections）、条件かタブがあれば平らな結果（rows）を出す。
 * 動きの切替は外した。入力待ちと実行中は Home が出し、ここでは is:running と is:waiting で届く。
 */
export function SessionList(props: SessionListProps & SessionListOptions) {
  const emit = useEmit();
  // 見出しの「この節だけ見る」「ほか N 件」「表示」は、その節のタブを選ぶのと同じにする。今日戻るにはタブが無いので出さない。
  const moreIntent = props.moreIntent ?? ((target: SectionId): Intent | null => {
    const status = SECTION_TAB[target];
    return status ? { type: 'search.filter', patch: { status } } : null;
  });
  // 行の状態の札を押すと、そのタブへ移る（★ の E）。
  const badgeIntent = (status: StatusFilter): Intent => ({ type: 'search.filter', patch: { status } });
  const id = props.id ?? 'session-results';
  const autoFocus = props.autoFocus ?? true;
  return (
    <>
      <StatusTabs tabs={props.tabs} tab={props.tab} />
      <KeywordField text={props.text} filter={props.filter} projects={props.projects} tokens={props.tokens} hints={props.hints} />
      <Filters filter={props.filter} projects={props.projects} projectFixed={props.projectFixed} />
      <ConditionRow conditions={props.conditions} tab={props.tab} filter={props.filter} loading={props.loading} total={props.total} />
      {props.sections
        ? <SessionRows id={id} items={props.sections} variant="search" autoFocus={autoFocus} statusColumn={props.statusColumn} moreIntent={moreIntent} badgeIntent={badgeIntent} />
        : <SessionRows id={id} rows={props.rows} variant="search" autoFocus={autoFocus} page={props.pager?.page} statusColumn={props.statusColumn} emptyText={props.mode === 'search' && !props.loading ? '一致するセッションはありません' : undefined} badgeIntent={badgeIntent} />}
      {props.loadMore
        ? <LoadMore {...props.loadMore} />
        : props.pager && <Pager label="セッション" pager={props.pager} onPage={(page) => emit({ type: 'search.page', page })} onSize={(size) => emit({ type: 'list.pageSize', size })} />}
    </>
  );
}
