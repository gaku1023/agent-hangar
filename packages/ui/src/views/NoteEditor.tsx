import { useEffect, useState, type KeyboardEvent } from 'react';
import { useEmit } from '../intent/chain.tsx';
import { isComposing } from './ime.ts';
import { useT } from './primitives/language.tsx';

/**
 * セッションのノートの編集欄。実行中は帯の「ノート」の札のポップオーバーの中、終わった後は冒頭の 1 枚の中で使う。
 * 下書きは自分で持つ。保存は ⌘Enter（Ctrl+Enter）かボタンで、`session.setMemo` を出す。
 * 外で（MCP や別の PC から）書き換えられたときは、書きかけの下書きを黙って捨てず、知らせて「読み込む」に任せる。書きかけが無ければ、そのまま追う。
 */
export function NoteEditor(props: { sessionId: string; text: string; rows?: number; autoFocus?: boolean }) {
  const t = useT();
  const emit = useEmit();
  const [draft, setDraft] = useState(props.text);
  // 最後に自分が知っているサーバの中身。保存したらそれを入れるので、自分の保存が戻ってきても外の更新とは見なさない。
  const [base, setBase] = useState(props.text);
  const dirty = draft !== base;
  const external = props.text !== base && dirty;
  useEffect(() => {
    if (props.text === base || dirty) return;
    setBase(props.text);
    setDraft(props.text);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.text]);
  const save = () => {
    if (!dirty) return;
    emit({ type: 'session.setMemo', id: props.sessionId, text: draft });
    setBase(draft);
  };
  const reload = () => { setBase(props.text); setDraft(props.text); };
  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && !isComposing(e)) { e.preventDefault(); save(); }
  };
  return (
    <div className="note-editor">
      <textarea className="input note-area" aria-label={t('session.note.label')} placeholder={t('session.note.placeholder')} rows={props.rows ?? 4} data-autofocus="" autoFocus={props.autoFocus}
        value={draft} onChange={(e) => setDraft(e.target.value)} onKeyDown={onKeyDown} />
      <div className="note-foot">
        {external && <><span className="faint">{t('session.note.external')}</span><button type="button" className="btn btn-sm" onClick={reload}>{t('session.note.reload')}</button></>}
        <span className="spacer" />
        <button type="button" className="btn btn-sm btn-primary" disabled={!dirty} onClick={save}>{t('session.note.save')}</button>
      </div>
    </div>
  );
}
