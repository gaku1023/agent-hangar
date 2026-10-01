import { parseQuery, type Intent, type SearchFilter, type StatusFilter } from '@agent-hangar/shared';
import type { KeyboardEvent } from 'react';
import { useEmit } from '../intent/chain.tsx';
import { SECTION_TAB, type SectionId } from '../presenters/sections.ts';
import type { SessionsProps, StatusTab } from '../presenters/sessions.ts';
import { isComposing } from './ime.ts';
import { Icon } from './primitives/Icon.tsx';
import { PageHeading } from './PageHeading.tsx';
import { SessionRows } from './SessionRows.tsx';
import { Listbox } from './primitives/Listbox.tsx';
import { Segmented } from './primitives/Segmented.tsx';

/**
 * 期間の選択肢。値は今日を含めた日数で、空は絞り込みなし。
 * 「今日」は暦の今日（0 時から）、「7 日」は今日とその前の 6 日である（mediator/screen.ts の periodStart）。
 */
const PERIODS = [{ value: '', label: '全期間' }, { value: '1', label: '今日' }, { value: '7', label: '7 日' }, { value: '30', label: '30 日' }];
/** サーバが 1 度に返す件数（server/src/search/search.ts の既定）。続きもこの件数ずつ読む。 */
const PAGE = 50;
/** 欄が空のときの案内。トークンの書き方をここで見せる。 */
const PLACEHOLDER = 'キーワード、または is:paused · since:7d · project: · file:';

/** その項目の絞り込みを外す patch。チップの × と、空の欄の Backspace で使う。 */
const unset = (key: keyof SearchFilter) => ({ [key]: undefined }) as Partial<SearchFilter>;

/**
 * セッション横断の一覧と検索（★）。
 * 上から、件数つきの状態のタブ、全文検索の欄、絞り込み、条件の行、一覧の順に置く。
 * 欄を正とする。欄はトークン（is:paused、since:7d、project:、file:）を受け、Enter で読んだ条件を search.query に添えて出す（パレットの「全文検索」の行も search.query へ来る）。
 * タブと絞り込みはその表示で、押すと search.filter を出し、効いている条件は欄の中のチップになる。
 * 条件が無いときは節で読み（sections）、条件かタブがあれば平らな結果（rows）を出す。
 * 条件が 1 つでも効いていれば、欄と絞り込みの下に条件の行を出し、効いている条件、「条件をクリア」、件数を並べる（D1）。
 * 動きの切替は外した。入力待ちと実行中は Home が出し、ここでは is:running と is:waiting で届く。
 */
export function SessionsScreen(props: SessionsProps) {
  const emit = useEmit();
  const period = props.filter.days ? String(props.filter.days) : '';
  // サーバが返したのが上位の一部なら、全件の数と並べて、並ぶ行の数と食い違わないようにする。
  const count = props.loading ? '検索しています' : props.shown < props.total ? `上位 ${props.shown} / ${props.total} 件` : `${props.total} 件`;
  const filtered = props.conditions.length > 0;
  const left = props.total - props.shown;
  const more = props.mode === 'search' && !props.loading && left > 0;
  const foot = more ? (
    <div className="sessions-more">
      <button type="button" className="btn btn-sm" disabled={props.loadingMore} onClick={() => emit({ type: 'search.more', offset: props.shown })}>{props.loadingMore ? '読み込んでいます' : `さらに ${Math.min(PAGE, left)} 件を読み込む`}</button>
      <span className="faint">残り {left} 件</span>
    </div>
  ) : undefined;
  const pickTab = (tab: StatusTab) => { if (tab !== props.tab) emit({ type: 'search.filter', patch: { status: tab === 'all' ? undefined : tab } }); };
  // 見出しの「この節だけ見る」「ほか N 件」「表示」は、その節のタブを選ぶのと同じにする。今日戻るにはタブが無いので出さない。
  const moreIntent = (target: SectionId): Intent | null => {
    const status = SECTION_TAB[target];
    return status ? { type: 'search.filter', patch: { status } } : null;
  };
  // 行の状態の札を押すと、そのタブへ移る（★ の E）。
  const badgeIntent = (status: StatusFilter): Intent => ({ type: 'search.filter', patch: { status } });
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
    <div className="screen sessions-screen screen-fill">
      <PageHeading title="セッション"><span className="faint mono sessions-count">{props.allCount} 件</span></PageHeading>
      <div className="sessions-tabs" role="group" aria-label="状態">
        {props.tabs.map((t) => (
          <button key={t.tab} type="button" className="sessions-tab" aria-pressed={t.tab === props.tab} onClick={() => pickTab(t.tab)}>
            {t.label}<span className="sessions-tab-n" data-hot={t.hot ? 'true' : undefined}>{t.count}</span>
          </button>
        ))}
      </div>
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
      <div className="sessions-filters">
        <Listbox label="プロジェクト" value={props.filter.projectId ?? ''} options={[{ value: '', label: 'すべてのプロジェクト' }, ...props.projects.map((p) => ({ value: p.id, label: p.name }))]}
          onChange={(v) => emit({ type: 'search.filter', patch: { projectId: v || undefined } })} faceClassName="listbox-face listbox-pill" minWidth={280} searchPlaceholder="プロジェクトを探す" />
        {/* 帯に無い期間（since:14d など）では、どの帯にも印を付けない。「全期間」に印が付くと、絞っていないように読める。 */}
        <Segmented label="期間" value={period} options={PERIODS}
          onChange={(v) => emit({ type: 'search.filter', patch: { days: v ? Number(v) : undefined } })} />
        {/* 条件をクリアしたときに欄の文字も消えるよう、値が変わったら作り直す。 */}
        <input key={props.filter.file ?? ''} className="input" aria-label="ファイル" placeholder="触ったファイル" defaultValue={props.filter.file ?? ''} onKeyDown={(e) => { if (e.key === 'Enter' && !isComposing(e)) emit({ type: 'search.filter', patch: { file: (e.target as HTMLInputElement).value || undefined } }); }} />
      </div>
      {filtered && (
        <div className="sessions-cond" role="status" aria-label="絞り込みの条件">
          <Icon name="filter" />
          <span className="sessions-cond-text">{props.conditions.map((c, i) => <span key={i}>{i > 0 && ' · '}<b>{c}</b></span>)} で絞り込み中</span>
          <button type="button" className="btn btn-sm sessions-cond-clear" onClick={() => emit({ type: 'search.clear' })}><Icon name="close" />条件をクリア</button>
          <span className="faint mono sessions-cond-count">{count}</span>
        </div>
      )}
      {props.sections
        ? <SessionRows id="session-results" items={props.sections} variant="search" autoFocus moreIntent={moreIntent} badgeIntent={badgeIntent} />
        : <SessionRows id="session-results" rows={props.rows} variant="search" autoFocus loadingMore={props.loadingMore} emptyText={props.mode === 'search' && !props.loading ? '一致するセッションはありません' : undefined} foot={foot} badgeIntent={badgeIntent} />}
    </div>
  );
}
