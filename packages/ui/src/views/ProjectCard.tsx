import { useEmit } from '../intent/chain.tsx';
import type { ProjectCardProps } from '../presenters/projects.ts';
import { Icon } from './primitives/Icon.tsx';
import { StatusSelect } from './primitives/StatusSelect.tsx';

/**
 * プロジェクト一枚分のカード（試作 home-lists の C1）。
 * クリックで project.open、状態の select で project.setStatus を出す。
 * 抜粋は 2 行まで出し、発言から取ったときはその旨を title に持つ。
 * 「ここで始める」は最終活動と数の行の右端に置き、乗せたときとキーボードで届いたときだけ見せる（workbench.css の .card-here）。
 * 状態の札は、Active のあいだは同じ扱いにする（.card-status）。節の見出しが Active と言っているのに全部の札に同じ語が並ぶと、名前の幅を食うだけになる。
 * パスは、ワークスペース直下なら出さない（presenters/projects.ts の cardPathLabel）。見つからないときは、直す入口を出すために必ず出す。
 */
export function ProjectCard(props: ProjectCardProps) {
  const emit = useEmit();
  const unresolved = !props.resolved && props.path !== null;
  return (
    <div className="card" role="link" tabIndex={0} onClick={() => emit({ type: 'project.open', id: props.id })} onKeyDown={(e) => { if (e.key === 'Enter') emit({ type: 'project.open', id: props.id }); }}>
      <div className="card-top">
        <span className="card-title">{props.name}</span>
        <span className="card-status" data-quiet={props.status === 'active' ? 'true' : undefined}>
          <StatusSelect label={`${props.name} の状態`} value={props.status} onChange={(status) => emit({ type: 'project.setStatus', id: props.id, status })} />
        </span>
      </div>
      {(props.pathLabel !== null || unresolved) && (
        <div className="card-where">
          {/* 頭を省略して末尾を残す（.card-path の direction）。bdi が無いと、記号で始まるパスの並びが崩れる。 */}
          <span className="card-path mono faint" title={props.path ?? undefined}><bdi>{props.pathLabel ?? props.name}</bdi></span>
          {unresolved && (
            <button className="btn" onClick={(e) => { e.stopPropagation(); emit({ type: 'project.resolve.open', id: props.id }); }} onKeyDown={(e) => e.stopPropagation()}><Icon name="warning" />（見つかりません）</button>
          )}
        </div>
      )}
      <div className="card-excerpt" title={props.excerptFromPrompt ? '最初の発言から' : undefined}>{props.excerpt}</div>
      {props.memoHead && <div className="faint card-memo">{props.memoHead}</div>}
      <div className="card-meta">
        <span>{props.lastActivity}</span>
        {props.runningCount > 0 && <span>実行中 {props.runningCount}</span>}
        {props.waitingCount > 0 && <span>要対応 {props.waitingCount}</span>}
        {props.openTodoCount > 0 && <span>TODO {props.openTodoCount}</span>}
        <button className="btn btn-sm card-here" onClick={(e) => { e.stopPropagation(); emit({ type: 'session.new.open', projectId: props.id }); }} onKeyDown={(e) => e.stopPropagation()}><Icon name="add" />ここで始める</button>
      </div>
    </div>
  );
}
