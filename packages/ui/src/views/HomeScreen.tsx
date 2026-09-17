import { useEmit } from '../intent/chain.tsx';
import type { HomeProps } from '../presenters/home.ts';
import { ProjectCard } from './ProjectCard.tsx';
import { SessionRows } from './SessionRows.tsx';
import { StatusDot } from './primitives/StatusDot.tsx';

/** Home 画面。実行中の帯は実行中セッションがあるときだけ描く。 */
export function HomeScreen(props: HomeProps) {
  const emit = useEmit();
  return (
    <div className="screen">
      {props.running.length > 0 && (
        <>
          <h2 className="h2" style={{ marginTop: 0 }}>実行中</h2>
          <div className="list">
            {props.running.map((r) => (
              <div key={r.id} className="row" style={{ gridTemplateColumns: '16px 1fr 160px 80px' }} role="row" tabIndex={0} onClick={() => emit({ type: 'session.open', id: r.id })} onKeyDown={(e) => { if (e.key === 'Enter') emit({ type: 'session.open', id: r.id }); }}>
                <StatusDot status={r.live} /><span className="cell">{r.name}</span><span className="cell muted">{r.projectName ?? '未分類'}</span><span className="cell mono cell-right">{r.elapsed}</span>
              </div>
            ))}
          </div>
        </>
      )}
      <h2 className="h2">プロジェクト</h2>
      {props.activeProjects.length === 0 ? <div className="empty">active なプロジェクトはありません。Settings でワークスペースを確かめてください。</div> : <div className="cards">{props.activeProjects.map((c) => <ProjectCard key={c.id} {...c} />)}</div>}
      <h2 className="h2">最近のセッション</h2>
      <SessionRows rows={props.recent} height={Math.min(props.recent.length, 15) * 28 + 28} showProject />
    </div>
  );
}
