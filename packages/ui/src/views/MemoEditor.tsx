import { useEffect, useState } from 'react';
import { useEmit } from '../intent/chain.tsx';

/**
 * プロジェクトの Markdown メモ。
 * 下書きを持つ唯一の View である。
 * 外部で更新されたときは下書きを捨てず、知らせるだけにする。
 */
export function MemoEditor(props: { projectId: string; markdown: string; updatedAt: number }) {
  const emit = useEmit();
  const [draft, setDraft] = useState(props.markdown);
  const [base, setBase] = useState({ markdown: props.markdown, updatedAt: props.updatedAt });
  const dirty = draft !== base.markdown;
  const external = props.updatedAt > base.updatedAt && dirty;
  useEffect(() => {
    if (props.updatedAt <= base.updatedAt || draft !== base.markdown) return;
    setBase({ markdown: props.markdown, updatedAt: props.updatedAt });
    setDraft(props.markdown);
  }, [props.markdown, props.updatedAt]); // eslint-disable-line react-hooks/exhaustive-deps
  const save = () => { emit({ type: 'memo.save', projectId: props.projectId, markdown: draft }); setBase({ markdown: draft, updatedAt: props.updatedAt }); };
  const reload = () => { setBase({ markdown: props.markdown, updatedAt: props.updatedAt }); setDraft(props.markdown); };
  return (
    <div className="memo field">
      <textarea className="input mono memo-area" aria-label="メモ" rows={8} value={draft} onChange={(e) => setDraft(e.target.value)} />
      <div className="memo-foot">
        {external && <><span className="faint">外部で更新されました</span><button className="btn" onClick={reload}>読み込む</button></>}
        <span className="spacer" />
        <button className="btn btn-primary" disabled={!dirty} onClick={save}>保存</button>
      </div>
    </div>
  );
}
