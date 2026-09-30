import { useEmit } from '../intent/chain.tsx';
import type { SessionsProps } from '../presenters/sessions.ts';
import { isComposing } from './ime.ts';
import { SessionRows } from './SessionRows.tsx';
import { Listbox } from './primitives/Listbox.tsx';
import { Segmented } from './primitives/Segmented.tsx';

const DAY = 86_400_000;
/** 期間の選択肢。値は「今から何日前まで」を表し、空は絞り込みなし。 */
const PERIODS = [{ value: '', label: '全期間' }, { value: '1', label: '今日' }, { value: '7', label: '7 日' }, { value: '30', label: '30 日' }];
// 帯の名前を「状態」にする。「実行中」という名前の帯の中に「実行中」の項目があると、読み上げで区別しにくいため。
const RUNNING = [{ value: '', label: 'すべて' }, { value: 'running', label: '実行中', lead: <span className="st-dot seg-live" /> }, { value: 'ended', label: '終了' }];

/** セッション横断の一覧と検索。キーワードは Enter で search.query、絞り込みは変えるたびに search.filter を出す。 */
export function SessionsScreen(props: SessionsProps) {
  const emit = useEmit();
  const period = props.filter.since ? String(Math.round((Date.now() - props.filter.since) / DAY)) : '';
  return (
    <div className="screen">
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 8 }}>
        <input className="input" style={{ flex: 1 }} aria-label="キーワード" placeholder="キーワード（空なら全件）" defaultValue={props.text} onKeyDown={(e) => { if (e.key === 'Enter' && !isComposing(e)) emit({ type: 'search.query', text: (e.target as HTMLInputElement).value }); }} />
      </div>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 12 }}>
        <Listbox label="プロジェクト" value={props.filter.projectId ?? ''} options={[{ value: '', label: 'すべてのプロジェクト' }, ...props.projects.map((p) => ({ value: p.id, label: p.name }))]}
          onChange={(v) => emit({ type: 'search.filter', patch: { projectId: v || undefined } })} faceClassName="listbox-face listbox-pill" minWidth={280} searchPlaceholder="プロジェクトを探す" />
        <Segmented label="期間" value={PERIODS.some((p) => p.value === period) ? period : ''} options={PERIODS}
          onChange={(v) => emit({ type: 'search.filter', patch: { since: v ? Date.now() - Number(v) * DAY : undefined } })} />
        <Segmented label="状態" value={props.filter.running === undefined ? '' : props.filter.running ? 'running' : 'ended'} options={RUNNING}
          onChange={(v) => emit({ type: 'search.filter', patch: { running: v === '' ? undefined : v === 'running' } })} />
        <input className="input" aria-label="ファイル" placeholder="触ったファイル" defaultValue={props.filter.file ?? ''} onKeyDown={(e) => { if (e.key === 'Enter' && !isComposing(e)) emit({ type: 'search.filter', patch: { file: (e.target as HTMLInputElement).value || undefined } }); }} />
        <span className="spacer" />
        <span className="faint mono">{props.loading ? '検索しています' : `${props.total} 件`}</span>
      </div>
      <SessionRows rows={props.rows} height="calc(100vh - 180px)" variant="search" emptyText={props.mode === 'search' && !props.loading ? '一致するセッションはありません' : undefined} />
    </div>
  );
}
