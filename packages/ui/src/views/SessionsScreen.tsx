import type { LiveFilter } from '@agent-hangar/shared';
import { useEmit } from '../intent/chain.tsx';
import type { SessionsProps } from '../presenters/sessions.ts';
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
/** 一覧の高さ。窓から、ヘッダとその下の隙間、画面の上下の余白、見出し（.page-head の 77px）、検索欄（34px）、絞り込みの段の分を引く（rows.css の .sessions-*）。
 * 条件の行が出ている間は、その分（28px）も引く。 */
const LIST_H = 'calc(100vh - 249px)';
const LIST_H_COND = 'calc(100vh - 277px)';
/** サーバが 1 度に返す件数（server/src/search/search.ts の既定）。続きもこの件数ずつ読む。 */
const PAGE = 50;
// 帯の名前を「状態」にする。「実行中」という名前の帯の中に「実行中」の項目があると、読み上げで区別しにくいため。
// 入力待ちは実行中に含めない（shared の liveFilterOf）。
// 答えが要るものを先に選べるよう、すべての次に置く。
const LIVE = [{ value: '', label: 'すべて' }, { value: 'waiting', label: '入力待ち', lead: <span className="st-dot seg-waiting" /> }, { value: 'running', label: '実行中', lead: <span className="st-dot seg-live" /> }, { value: 'ended', label: '終了' }];

/**
 * セッション横断の一覧と検索。
 * 上の欄が全文検索の本体で、Enter で search.query を出す（パレットの「全文検索」の行もここへ来る）。
 * 絞り込みは変えるたびに search.filter を出す。
 * 条件が 1 つでも効いていれば、欄と絞り込みの下に条件の行を出し、効いている条件、「条件をクリア」、件数を並べる（D1）。
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
  return (
    <div className="screen sessions-screen">
      <PageHeading title="セッション"><span className="faint mono sessions-count">{props.allCount} 件</span></PageHeading>
      <div className="sessions-keyword">
        <Icon name="fullText" />
        <input aria-label="キーワード" placeholder="キーワード（空なら全件）" defaultValue={props.text} onKeyDown={(e) => { if (e.key === 'Enter' && !isComposing(e)) emit({ type: 'search.query', text: (e.target as HTMLInputElement).value }); }} />
        {/* 探すのは会話の本文である（server/src/search/search.ts は event_fts の本文だけを引く）。 */}
        <span className="sessions-keyword-tag">本文</span>
        {props.text && <button type="button" className="btn btn-sm sessions-keyword-clear" aria-label="キーワードを消す" onClick={() => emit({ type: 'search.query', text: '' })}><Icon name="close" /></button>}
      </div>
      <div className="sessions-filters">
        <Listbox label="プロジェクト" value={props.filter.projectId ?? ''} options={[{ value: '', label: 'すべてのプロジェクト' }, ...props.projects.map((p) => ({ value: p.id, label: p.name }))]}
          onChange={(v) => emit({ type: 'search.filter', patch: { projectId: v || undefined } })} faceClassName="listbox-face listbox-pill" minWidth={280} searchPlaceholder="プロジェクトを探す" />
        <Segmented label="期間" value={PERIODS.some((p) => p.value === period) ? period : ''} options={PERIODS}
          onChange={(v) => emit({ type: 'search.filter', patch: { days: v ? Number(v) : undefined } })} />
        <Segmented label="状態" value={props.filter.live ?? ''} options={LIVE}
          onChange={(v) => emit({ type: 'search.filter', patch: { live: v === '' ? undefined : v as LiveFilter } })} />
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
      <SessionRows id="session-results" rows={props.rows} height={filtered ? LIST_H_COND : LIST_H} variant="search" autoFocus loadingMore={props.loadingMore} emptyText={props.mode === 'search' && !props.loading ? '一致するセッションはありません' : undefined} foot={foot} />
    </div>
  );
}
