import { useEmit } from '../intent/chain.tsx';
import type { SessionsProps } from '../presenters/sessions.ts';
import { isComposing } from './ime.ts';
import { SessionRows } from './SessionRows.tsx';
import { Listbox } from './primitives/Listbox.tsx';
import { Segmented } from './primitives/Segmented.tsx';

/**
 * 期間の選択肢。値は今日を含めた日数で、空は絞り込みなし。
 * 「今日」は暦の今日（0 時から）、「7 日」は今日とその前の 6 日である（mediator/screen.ts の periodStart）。
 */
const PERIODS = [{ value: '', label: '全期間' }, { value: '1', label: '今日' }, { value: '7', label: '7 日' }, { value: '30', label: '30 日' }];
/** 一覧の高さ。窓から、ヘッダとその下の隙間、画面の上下の余白、見出し、検索欄、絞り込みの段の分を引く（rows.css の .sessions-*）。 */
const LIST_H = 'calc(100vh - 243px)';
// 帯の名前を「状態」にする。「実行中」という名前の帯の中に「実行中」の項目があると、読み上げで区別しにくいため。
const RUNNING = [{ value: '', label: 'すべて' }, { value: 'running', label: '実行中', lead: <span className="st-dot seg-live" /> }, { value: 'ended', label: '終了' }];

/** セッション横断の一覧と検索。キーワードは Enter で search.query、絞り込みは変えるたびに search.filter を出す。 */
export function SessionsScreen(props: SessionsProps) {
  const emit = useEmit();
  const period = props.filter.days ? String(props.filter.days) : '';
  // サーバが返したのが上位の一部なら、全件の数と並べて、並ぶ行の数と食い違わないようにする。
  const count = props.loading ? '検索しています' : props.shown < props.total ? `上位 ${props.shown} / ${props.total} 件` : `${props.total} 件`;
  const more = props.mode === 'search' && !props.loading && props.shown < props.total;
  const foot = more ? (
    <div className="sessions-more">
      <button type="button" className="btn" disabled={props.loadingMore} onClick={() => emit({ type: 'search.more', offset: props.shown })}>{props.loadingMore ? '読み込んでいます' : 'さらに読み込む'}</button>
    </div>
  ) : undefined;
  return (
    <div className="screen sessions-screen">
      <h1 className="h1 sessions-head">セッション<span className="faint mono sessions-count">{count}</span></h1>
      <div className="sessions-keyword">
        <input className="input" aria-label="キーワード" placeholder="キーワード（空なら全件）" defaultValue={props.text} onKeyDown={(e) => { if (e.key === 'Enter' && !isComposing(e)) emit({ type: 'search.query', text: (e.target as HTMLInputElement).value }); }} />
      </div>
      <div className="sessions-filters">
        <Listbox label="プロジェクト" value={props.filter.projectId ?? ''} options={[{ value: '', label: 'すべてのプロジェクト' }, ...props.projects.map((p) => ({ value: p.id, label: p.name }))]}
          onChange={(v) => emit({ type: 'search.filter', patch: { projectId: v || undefined } })} faceClassName="listbox-face listbox-pill" minWidth={280} searchPlaceholder="プロジェクトを探す" />
        <Segmented label="期間" value={PERIODS.some((p) => p.value === period) ? period : ''} options={PERIODS}
          onChange={(v) => emit({ type: 'search.filter', patch: { days: v ? Number(v) : undefined } })} />
        <Segmented label="状態" value={props.filter.running === undefined ? '' : props.filter.running ? 'running' : 'ended'} options={RUNNING}
          onChange={(v) => emit({ type: 'search.filter', patch: { running: v === '' ? undefined : v === 'running' } })} />
        <input className="input" aria-label="ファイル" placeholder="触ったファイル" defaultValue={props.filter.file ?? ''} onKeyDown={(e) => { if (e.key === 'Enter' && !isComposing(e)) emit({ type: 'search.filter', patch: { file: (e.target as HTMLInputElement).value || undefined } }); }} />
      </div>
      <SessionRows rows={props.rows} height={LIST_H} variant="search" autoFocus emptyText={props.mode === 'search' && !props.loading ? '一致するセッションはありません' : undefined} foot={foot} />
    </div>
  );
}
