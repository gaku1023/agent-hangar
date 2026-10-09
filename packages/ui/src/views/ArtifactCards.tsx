import { useState } from 'react';
import { useEmit } from '../intent/chain.tsx';
import type { ArtifactCardProps } from '../presenters/project.ts';
import { isComposing } from './ime.ts';
import { Icon } from './primitives/Icon.tsx';
import { useT } from './primitives/language.tsx';

/** アーティファクトのカード。クリックはサーバ側の `open <url>` で既定のブラウザに開く。 */
export function ArtifactCards(props: { projectId: string | null; artifacts: ArtifactCardProps[]; canAdd: boolean }) {
  const emit = useEmit();
  const t = useT();
  const [url, setUrl] = useState('');
  const add = () => { if (!url.trim() || !props.projectId) return; emit({ type: 'artifact.add', projectId: props.projectId, url }); setUrl(''); };
  return (
    <div className="artifacts">
      {/* 足す欄があるときは、空であることを別の行で言わない。 */}
      {props.artifacts.length === 0 && !(props.canAdd && props.projectId) && <div className="faint">{t('projectScreen.artifact.empty')}</div>}
      {props.artifacts.map((a) => (
        <div key={a.id} className="card artifact" role="link" tabIndex={0} onClick={() => emit({ type: 'artifact.open', id: a.id })} onKeyDown={(e) => { if (e.key === 'Enter') emit({ type: 'artifact.open', id: a.id }); }}>
          <div className="artifact-head">
            <span className="artifact-favicon" aria-hidden="true">{a.favicon}</span>
            <span className="card-title">{a.title}</span>
          </div>
          {a.description && <div className="muted artifact-desc">{a.description}</div>}
          <div className="faint artifact-foot">
            <span>{a.lastPublished}</span>
            <span>{t('projectScreen.artifact.versions', { n: a.versionCount })}</span>
            <span className="spacer" />
            {a.canOpenEditor && <button className="btn" onClick={(e) => { e.stopPropagation(); emit({ type: 'artifact.openEditor', id: a.id }); }} onKeyDown={(e) => e.stopPropagation()}><Icon name="openEditor" />{t('projectScreen.artifact.openEditor')}</button>}
          </div>
        </div>
      ))}
      {props.canAdd && props.projectId && (
        <div className="rail-add">
          <input className="input mono" aria-label={t('projectScreen.artifact.urlLabel')} placeholder="https://claude.ai/code/artifact/..." value={url} onChange={(e) => setUrl(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && !isComposing(e)) add(); }} />
          <button className="btn" onClick={add}><Icon name="add" />{t('projectScreen.artifact.addButton')}</button>
        </div>
      )}
    </div>
  );
}
