import type { ProjectStatus } from '@agent-hangar/shared';
import { useEmit } from '../intent/chain.tsx';
import type { ProjectCardProps } from '../presenters/projects.ts';

const STATUSES: ProjectStatus[] = ['active', 'paused', 'done', 'archived'];

/** プロジェクト一枚分のカード。クリックで project.open、ステータスの select で project.setStatus を出す。 */
export function ProjectCard(props: ProjectCardProps) {
  const emit = useEmit();
  return (
    <div className="card" role="link" tabIndex={0} onClick={() => emit({ type: 'project.open', id: props.id })} onKeyDown={(e) => { if (e.key === 'Enter') emit({ type: 'project.open', id: props.id }); }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span className="card-title" style={{ flex: 1 }}>{props.name}</span>
        <select className="select" aria-label={`${props.name} のステータス`} value={props.status} onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()} onChange={(e) => emit({ type: 'project.setStatus', id: props.id, status: e.target.value as ProjectStatus })}>
          {STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}
        </select>
      </div>
      <div className="mono faint" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        {props.path ?? 'この端末にパスがありません'}
        {!props.resolved && props.path && (
          <button className="btn" style={{ marginLeft: 8 }} onClick={(e) => { e.stopPropagation(); emit({ type: 'project.resolve.open', id: props.id }); }} onKeyDown={(e) => e.stopPropagation()}>（見つかりません）</button>
        )}
      </div>
      <div className="muted" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{props.lastOneLiner ?? 'セッションはまだありません'}</div>
      <div className="faint" style={{ display: 'flex', gap: 12 }}>
        <span>{props.lastActivity}</span>
        {props.runningCount > 0 && <span>実行中 {props.runningCount}</span>}
        {props.openTodoCount > 0 && <span>TODO {props.openTodoCount}</span>}
      </div>
    </div>
  );
}
