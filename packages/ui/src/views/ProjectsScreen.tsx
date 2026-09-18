import type { ProjectsProps } from '../presenters/projects.ts';
import { ProjectCard } from './ProjectCard.tsx';
import { ProjectStatusDot } from './primitives/StatusSelect.tsx';

/** Projects 画面。絞り込みとアーカイブ表示は画面内だけの一時状態なので Root が useState で持ち、props で受け取る。 */
export function ProjectsScreen(props: ProjectsProps & { filter: string; showArchived: boolean; onFilter: (s: string) => void; onShowArchived: (b: boolean) => void }) {
  return (
    <div className="screen">
      <div style={{ display: 'flex', gap: 12, alignItems: 'center', marginBottom: 12 }}>
        <h1 className="h1" style={{ margin: 0 }}>Projects</h1>
        <input className="input" placeholder="名前で絞る" value={props.filter} onChange={(e) => props.onFilter(e.target.value)} aria-label="名前で絞る" />
        <span className="spacer" />
        <button className="btn" onClick={() => props.onShowArchived(!props.showArchived)}>{props.showArchived ? 'アーカイブを隠す' : `アーカイブを表示（${props.archivedCount}）`}</button>
      </div>
      {props.sections.map((s) => (
        <section key={s.status}>
          <div className="section-head"><h2 className="h2"><ProjectStatusDot status={s.status} />{s.label}</h2><span className="faint">{s.cards.length}</span></div>
          {s.cards.length === 0 ? <div className="faint" style={{ padding: '4px 0 8px' }}>なし</div> : <div className="cards">{s.cards.map((c) => <ProjectCard key={c.id} {...c} />)}</div>}
        </section>
      ))}
    </div>
  );
}
