import { useEffect, useRef, useState } from 'react';
import { useEmit } from '../action/chain.tsx';
import type { ArtifactCardProps } from '../presenters/project.ts';
import { isComposing } from './ime.ts';
import { FoldBox } from './primitives/FoldBox.tsx';
import { Icon } from './primitives/Icon.tsx';
import { useT } from './primitives/language.tsx';
import { useEditorLabels } from './primitives/editorName.tsx';
import { motionOn } from './primitives/motionKit.ts';

/** 1 枚のカード。クリックはサーバ側の `open <url>` で既定のブラウザに開く。 */
function ArtifactCard(props: { a: ArtifactCardProps }) {
  const emit = useEmit();
  const t = useT();
  const editorLabels = useEditorLabels();
  const { a } = props;
  return (
    <div className="card artifact" role="link" tabIndex={0} onClick={() => emit({ type: 'artifact.open', id: a.id })} onKeyDown={(e) => { if (e.key === 'Enter') emit({ type: 'artifact.open', id: a.id }); }}>
      <div className="artifact-head">
        <span className="artifact-favicon" aria-hidden="true">{a.favicon}</span>
        <span className="card-title">{a.title}</span>
      </div>
      {a.description && <div className="muted artifact-desc">{a.description}</div>}
      <div className="faint artifact-foot">
        <span>{a.lastPublished}</span>
        <span>{t('projectScreen.artifact.versions', { n: a.versionCount })}</span>
        <span className="spacer" />
        {a.canOpenEditor && <button className="btn" onClick={(e) => { e.stopPropagation(); emit({ type: 'artifact.openEditor', id: a.id }); }} onKeyDown={(e) => e.stopPropagation()}><Icon name="openEditor" />{editorLabels.open}</button>}
      </div>
    </div>
  );
}

/**
 * 箱を囲むスクロールの箱（右パネル）が、節（.rail-panel）の上端より下までスクロールしていたら、節の上端まで戻す。
 * 「少なく表示」で増えた分が畳まれたあと、見ていた所が空になって見出しを見失わないためである。上にいれば動かさない。
 */
function revealSectionTop(from: HTMLElement): void {
  const scroller = from.closest<HTMLElement>('.rail');
  if (!scroller) return;
  const section = from.closest<HTMLElement>('.rail-panel') ?? from;
  const top = section.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop;
  if (scroller.scrollTop <= top) return;
  if (typeof scroller.scrollTo === 'function' && motionOn(scroller)) scroller.scrollTo({ top, behavior: 'smooth' });
  else scroller.scrollTop = top;
}

/**
 * アーティファクトのカード。並びは新しい順（presenters/project.ts）。
 * limit があれば、新しい方から limit 件だけを出し、残りは並びの末尾の「すべて表示（N 件）」で広げる。
 * 広げた分は節の中でスクロールさせず、右パネル全体のスクロールに任せる。広げた状態は覚えない（開き直すと limit 件に戻る）。
 */
export function ArtifactCards(props: { projectId: string | null; artifacts: ArtifactCardProps[]; canAdd: boolean; addError?: { url: string; message: string } | null; limit?: number }) {
  const emit = useEmit();
  const t = useT();
  const [url, setUrl] = useState('');
  const [showAll, setShowAll] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  // 送った直後に欄は空にする。断られたら、入れた URL を欄へ戻す（消えたままにしない）。そのあいだに別の URL を打っていたら、それを残す。
  const { addError } = props;
  useEffect(() => { if (addError) setUrl((cur) => (cur === '' ? addError.url : cur)); }, [addError]);
  const add = () => { if (!url.trim() || !props.projectId) return; emit({ type: 'artifact.add', projectId: props.projectId, url }); setUrl(''); };
  const limit = props.limit ?? Infinity;
  const head = props.artifacts.slice(0, limit);
  const rest = props.artifacts.slice(limit);
  return (
    <div ref={root} className="artifacts">
      {/* 足す欄があるときは、空であることを別の行で言わない。 */}
      {props.artifacts.length === 0 && !(props.canAdd && props.projectId) && <div className="faint">{t('projectScreen.artifact.empty')}</div>}
      {head.map((a) => <ArtifactCard key={a.id} a={a} />)}
      {rest.length > 0 && (
        <>
          <FoldBox open={showAll} className="artifacts-more" onClosed={() => { if (root.current) revealSectionTop(root.current); }}>
            {rest.map((a) => <ArtifactCard key={a.id} a={a} />)}
          </FoldBox>
          <button type="button" className="artifacts-all" aria-expanded={showAll} onClick={() => setShowAll(!showAll)}>
            {showAll ? t('projectScreen.artifact.showLess') : t('projectScreen.artifact.showAll', { n: props.artifacts.length })}<Icon name="chevron" />
          </button>
        </>
      )}
      {props.canAdd && props.projectId && (
        <>
          <div className="rail-add">
            <input className="input mono" aria-label={t('projectScreen.artifact.urlLabel')} placeholder="https://claude.ai/code/artifact/..." value={url} onChange={(e) => setUrl(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && !isComposing(e)) add(); }} />
            <button className="btn" onClick={add}><Icon name="add" />{t('projectScreen.artifact.addButton')}</button>
          </div>
          {addError && <div className="error" role="alert">{addError.message}</div>}
        </>
      )}
    </div>
  );
}
