import { useEffect, useRef, useState, type ReactNode } from 'react';
import { NoteField, useNoteDraft, type NoteTexts } from './NoteEditor.tsx';
import { Icon } from './primitives/Icon.tsx';

/**
 * 読む表示と編集の欄を切り替えるノート（試作 Q3、セッション画面の冒頭の 1 枚と同じ形）。
 * 見出しの行は呼び手が組み（`head`）、その右に「ノートを編集」（空なら「ノートを書く」）のボタンを置く。編集中はボタンを出さない。
 * 欄は、ボタンを押したときだけ開く。⌘Enter（Ctrl+Enter）かボタンで保存して読む表示に戻り、Esc は保存せずに戻って書きかけを捨てる。
 * 保存の失敗は Runtime のトーストが知らせる。本文が変わらなかったときは、開き直すと書いた下書きが残っているので、そのまま保存し直せる。
 */
export function EditableNote(props: { text: string; onSave: (text: string) => void; texts: NoteTexts; head: (button: ReactNode) => ReactNode; mono?: boolean; rows?: number }) {
  const { texts } = props;
  const [editing, setEditing] = useState(false);
  const note = useNoteDraft(props.text, props.onSave);
  const filled = props.text.trim() !== '';
  const button = useRef<HTMLButtonElement>(null);
  // 欄を閉じたら、開いたボタンへフォーカスを戻す（キーボードで続けて操作できるように）。
  const back = useRef(false);
  useEffect(() => {
    if (!editing && back.current) { back.current = false; button.current?.focus(); }
  }, [editing]);
  const close = () => { back.current = true; setEditing(false); };
  const cancel = () => { note.reset(); close(); };
  const open = editing ? null : (
    <button ref={button} type="button" className="btn btn-sm btn-ghost" onClick={() => setEditing(true)}><Icon name="edit" />{filled ? texts.edit : texts.write}</button>
  );
  return (
    <>
      {props.head(open)}
      {editing
        ? <NoteField note={note} texts={texts} rows={props.rows} mono={props.mono} autoFocus onSave={close} onCancel={cancel} />
        : filled && <p className="note-text">{props.text}</p>}
    </>
  );
}
