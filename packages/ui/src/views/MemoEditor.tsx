import { useEffect, useState } from 'react';
import { useEmit } from '../intent/chain.tsx';
import { Icon } from './primitives/Icon.tsx';
import { useT } from './primitives/language.tsx';

/**
 * プロジェクトの Markdown ノート。
 * 下書きを持つ唯一の View である。
 * 外部で更新されたときは下書きを捨てず、知らせるだけにする。
 */
export function MemoEditor(props: { projectId: string; markdown: string; updatedAt: number }) {
  const emit = useEmit();
  const t = useT();
  const [draft, setDraft] = useState(props.markdown);
  const [base, setBase] = useState({ markdown: props.markdown, updatedAt: props.updatedAt });
  const dirty = draft !== base.markdown;
  // base.markdown は「最後に自分が知っているサーバの中身」である。
  // 保存したらそれを base に入れるので、自分の保存が戻ってきたときは中身が base と一致する。
  // 時刻だけを見ると自分の保存を外部の更新と誤報するので、中身が違うことも条件に入れる。
  const external = props.updatedAt > base.updatedAt && props.markdown !== base.markdown && dirty;
  useEffect(() => {
    if (props.updatedAt <= base.updatedAt) return;
    // 中身が base と同じなら自分の保存が戻ってきただけである。下書きは残し、時刻だけを進める。
    if (props.markdown === base.markdown) { setBase({ markdown: props.markdown, updatedAt: props.updatedAt }); return; }
    // 下書きがあるなら黙って捨てない。external が知らせ、読み込むボタンに任せる。
    if (draft !== base.markdown) return;
    setBase({ markdown: props.markdown, updatedAt: props.updatedAt });
    setDraft(props.markdown);
  }, [props.markdown, props.updatedAt]); // eslint-disable-line react-hooks/exhaustive-deps
  const save = () => { emit({ type: 'memo.save', projectId: props.projectId, markdown: draft }); setBase({ markdown: draft, updatedAt: props.updatedAt }); };
  const reload = () => { setBase({ markdown: props.markdown, updatedAt: props.updatedAt }); setDraft(props.markdown); };
  // 空のノートは 1 行に畳む。8 行分の空の欄と押せない保存が、右の欄の中身（TODO、アーティファクト）より場所を取らないようにする。
  // 書き始めたら、空に戻しても開いたままにする（打っている途中で欄が消えないように）。
  const [opened, setOpened] = useState(false);
  const open = opened || draft !== '' || props.markdown !== '';
  if (!open) return <button type="button" className="btn memo-open" onClick={() => setOpened(true)}><Icon name="add" />{t('projectScreen.note.edit')}</button>;
  return (
    <div className="memo field">
      <textarea className="input mono memo-area" aria-label={t('projectScreen.note.label')} rows={8} autoFocus={opened && props.markdown === ''} value={draft} onChange={(e) => setDraft(e.target.value)} />
      <div className="memo-foot">
        {external && <><span className="faint">{t('projectScreen.note.external')}</span><button className="btn" onClick={reload}>{t('projectScreen.note.reload')}</button></>}
        <span className="spacer" />
        <button className="btn btn-primary" disabled={!dirty} onClick={save}>{t('projectScreen.note.save')}</button>
      </div>
    </div>
  );
}
