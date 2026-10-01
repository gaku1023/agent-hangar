import { useEmit } from '../intent/chain.tsx';
import type { ProjectCardProps } from '../presenters/projects.ts';
import { Icon } from './primitives/Icon.tsx';
import { StatusSelect } from './primitives/StatusSelect.tsx';

/**
 * プロジェクト一枚分のカード（試作 home-lists の C1）。
 * クリックで project.open、状態の select で project.setStatus を出す。
 * 抜粋は 2 行まで出し、発言から取ったときはその旨を小さく添える。
 * 「ここで始める」は最終活動と数の行の右端に置き、乗せたときとキーボードで届いたときだけ見せる（workbench.css の .card-here）。
 */
export function ProjectCard(props: ProjectCardProps) {
  const emit = useEmit();
  return (
    <div className="card" role="link" tabIndex={0} onClick={() => emit({ type: 'project.open', id: props.id })} onKeyDown={(e) => { if (e.key === 'Enter') emit({ type: 'project.open', id: props.id }); }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span className="card-title" style={{ flex: 1 }}>{props.name}</span>
        <StatusSelect label={`${props.name} の状態`} value={props.status} onChange={(status) => emit({ type: 'project.setStatus', id: props.id, status })} />
      </div>
      <div className="mono faint" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        {props.path ?? 'この PC にパスがありません'}
        {!props.resolved && props.path && (
          <button className="btn" style={{ marginLeft: 8 }} onClick={(e) => { e.stopPropagation(); emit({ type: 'project.resolve.open', id: props.id }); }} onKeyDown={(e) => e.stopPropagation()}><Icon name="warning" />（見つかりません）</button>
        )}
      </div>
      <div className="card-excerpt">{props.excerpt}</div>
      {props.excerptFromPrompt && <div className="card-from"><Icon name="sessions" />最初の発言から</div>}
      {props.memoHead && <div className="faint card-memo">{props.memoHead}</div>}
      <div className="card-meta">
        <span>{props.lastActivity}</span>
        {props.runningCount > 0 && <span>実行中 {props.runningCount}</span>}
        {props.waitingCount > 0 && <span>要対応 {props.waitingCount}</span>}
        {props.openTodoCount > 0 && <span>TODO {props.openTodoCount}</span>}
        <span className="spacer" />
        <button className="btn btn-sm card-here" onClick={(e) => { e.stopPropagation(); emit({ type: 'session.new.open', projectId: props.id }); }} onKeyDown={(e) => e.stopPropagation()}><Icon name="add" />ここで始める</button>
      </div>
    </div>
  );
}
