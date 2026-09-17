import { useState } from 'react';
import { useEmit } from '../intent/chain.tsx';

type ResolveAction = { kind: 'repoint'; path: string } | { kind: 'archive' } | { kind: 'unlink' };

/** 見つからないプロジェクトの扱いを決めるダイアログ。保持する状態は新しいパスの入力だけ。 */
export function ResolveProjectDialog(props: { projectId: string; name: string; path: string | null; candidates: string[]; onQueryCandidates: (name: string) => void }) {
  const emit = useEmit();
  const [path, setPath] = useState('');
  const resolve = (action: ResolveAction) => emit({ type: 'project.resolve', id: props.projectId, action });
  return (
    <div className="overlay" role="dialog" aria-modal="true" aria-label="プロジェクトの場所を確認">
      <div className="dialog">
        <div><b>{props.name}</b> のディレクトリが見つかりません。</div>
        <div className="mono faint">{props.path ?? '（パスなし）'}</div>
        <div>
          <div className="muted" style={{ marginBottom: 4 }}>ディレクトリを再指定</div>
          {props.candidates.length > 0 && <div className="list" style={{ marginBottom: 8 }}>{props.candidates.map((c) => <div key={c} className="row mono" style={{ gridTemplateColumns: '1fr' }} role="option" aria-selected={c === path} onClick={() => setPath(c)}>{c}</div>)}</div>}
          <div style={{ display: 'flex', gap: 8 }}>
            <input className="input mono" style={{ flex: 1 }} aria-label="新しいパス" value={path} onChange={(e) => { setPath(e.target.value); props.onQueryCandidates(e.target.value.split('/').pop() ?? ''); }} placeholder="/Users/you/workspace/..." />
            <button className="btn btn-primary" disabled={!path} onClick={() => resolve({ kind: 'repoint', path })}>この場所にする</button>
          </div>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button className="btn" onClick={() => resolve({ kind: 'archive' })}>アーカイブにする</button>
          <button className="btn" onClick={() => resolve({ kind: 'unlink' })}>紐づけを削除</button>
          <span className="spacer" />
          <button className="btn" onClick={() => emit({ type: 'overlay.close' })}>あとで</button>
        </div>
      </div>
    </div>
  );
}
