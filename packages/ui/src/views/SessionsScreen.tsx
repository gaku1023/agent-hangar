import { useEmit } from '../intent/chain.tsx';
import type { SessionsProps } from '../presenters/sessions.ts';
import { isComposing } from './ime.ts';
import { SessionRows } from './SessionRows.tsx';

const DAY = 86_400_000;
/** 期間の選択肢。値は「今から何日前まで」を表し、空は絞り込みなし。 */
const PERIODS = [{ v: '', label: 'すべて' }, { v: '1', label: '今日' }, { v: '7', label: '7 日' }, { v: '30', label: '30 日' }];

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
        <select className="select" aria-label="プロジェクト" value={props.filter.projectId ?? ''} onChange={(e) => emit({ type: 'search.filter', patch: { projectId: e.target.value || undefined } })}>
          <option value="">すべてのプロジェクト</option>{props.projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
        <select className="select" aria-label="期間" value={PERIODS.some((p) => p.v === period) ? period : ''} onChange={(e) => emit({ type: 'search.filter', patch: { since: e.target.value ? Date.now() - Number(e.target.value) * DAY : undefined } })}>
          {PERIODS.map((p) => <option key={p.v} value={p.v}>{p.label}</option>)}
        </select>
        <select className="select" aria-label="実行中" value={props.filter.running === undefined ? '' : props.filter.running ? 'running' : 'ended'} onChange={(e) => emit({ type: 'search.filter', patch: { running: e.target.value === '' ? undefined : e.target.value === 'running' } })}>
          <option value="">実行中と終了</option><option value="running">実行中</option><option value="ended">終了</option>
        </select>
        <input className="input" aria-label="ファイル" placeholder="触ったファイル" defaultValue={props.filter.file ?? ''} onKeyDown={(e) => { if (e.key === 'Enter' && !isComposing(e)) emit({ type: 'search.filter', patch: { file: (e.target as HTMLInputElement).value || undefined } }); }} />
        <span className="spacer" />
        <span className="faint mono">{props.loading ? '検索しています' : `${props.total} 件`}</span>
      </div>
      <SessionRows rows={props.rows} height="calc(100vh - 180px)" showProject showSnippets={props.mode === 'search'} emptyText={props.mode === 'search' && !props.loading ? '一致するセッションはありません' : undefined} />
    </div>
  );
}
