import { useEffect, useState, type KeyboardEvent } from 'react';
import type { Translate } from '@agent-hangar/shared';
import { isComposing } from './ime.ts';
import { useT } from './primitives/language.tsx';

/** ノートの欄が出す文。セッションとプロジェクトで言い回しが違う（placeholder と、読む表示のボタン）ので、呼び手が辞書から組んで渡す。 */
export type NoteTexts = { label: string; placeholder: string; save: string; external: string; reload: string; write: string; edit: string };

export const sessionNoteTexts = (t: Translate): NoteTexts => ({
  label: t('session.note.label'), placeholder: t('session.note.placeholder'), save: t('session.note.save'), external: t('session.note.external'),
  reload: t('session.note.reload'), write: t('session.note.write'), edit: t('session.note.edit'),
});
export const projectNoteTexts = (t: Translate): NoteTexts => ({
  label: t('projectScreen.note.label'), placeholder: t('projectScreen.note.placeholder'), save: t('projectScreen.note.save'), external: t('projectScreen.note.external'),
  reload: t('projectScreen.note.reload'), write: t('projectScreen.note.write'), edit: t('projectScreen.note.edit'),
});

/**
 * ノートの下書き。
 * 下書きは自分で持ち、保存で `onSave` を呼ぶ。保存しても下書きは消さない（保存が通らなかったとき、書いたものが残っているように）。
 * seen は、最後に「サーバの本文に追いついた」ときの本文である。外から（MCP や別の PC から）本文が変わったとき、
 * 下書きを触っていなければ（draft が seen のまま）そのまま追い、触っていれば黙って捨てず、external で知らせて reload に任せる。
 * 自分の保存が戻ってきただけ（本文が最後に保存した文と同じ）のときは、外の更新と見なさない。
 */
export function useNoteDraft(text: string, onSave: (text: string) => void) {
  const [draft, setDraft] = useState(text);
  const [seen, setSeen] = useState(text);
  const [saved, setSaved] = useState<string | null>(null);
  useEffect(() => {
    if (text === seen) return;
    if (draft === seen) { setDraft(text); setSeen(text); return; }
    if (text === saved) setSeen(text);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [text]);
  const dirty = draft !== text;
  const external = dirty && draft !== seen && text !== seen && text !== saved;
  return {
    draft, setDraft, dirty, external,
    save: () => { if (!dirty) return; setSaved(draft); onSave(draft); },
    /** サーバの本文に取り替える。「読み込む」と、編集をやめるときに使う。 */
    reset: () => { setDraft(text); setSeen(text); },
  };
}
export type NoteDraft = ReturnType<typeof useNoteDraft>;

/**
 * ノートの入力欄と足元（外の更新の知らせ、保存）。
 * 保存は ⌘Enter（Ctrl+Enter）かボタン。onCancel があれば Esc で編集をやめる（日本語入力の変換中は何もしない）。
 */
export function NoteField(props: { note: NoteDraft; texts: NoteTexts; onCancel?: () => void; onSave?: () => void; rows?: number; autoFocus?: boolean; mono?: boolean }) {
  const { note, texts } = props;
  const save = () => { if (!note.dirty) return; note.save(); props.onSave?.(); };
  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && !isComposing(e)) { e.preventDefault(); save(); return; }
    if (e.key === 'Escape' && props.onCancel && !isComposing(e)) { e.preventDefault(); e.stopPropagation(); props.onCancel(); }
  };
  return (
    <div className="note-editor">
      <textarea className={`input note-area${props.mono ? ' mono' : ''}`} aria-label={texts.label} placeholder={texts.placeholder} rows={props.rows ?? 4} data-autofocus="" autoFocus={props.autoFocus}
        value={note.draft} onChange={(e) => note.setDraft(e.target.value)} onKeyDown={onKeyDown} />
      <div className="note-foot">
        {note.external && <><span className="faint">{texts.external}</span><button type="button" className="btn btn-sm" onClick={note.reset}>{texts.reload}</button></>}
        <span className="spacer" />
        <button type="button" className="btn btn-sm btn-primary" disabled={!note.dirty} onClick={save}>{texts.save}</button>
      </div>
    </div>
  );
}

/**
 * セッションのノートの編集欄。実行中は帯の「ノート」の札のポップオーバーの中で使う（Esc はポップオーバーが閉じる）。
 * 読む表示と切り替えるものは `EditableNote`。
 */
export function NoteEditor(props: { text: string; onSave: (text: string) => void; rows?: number; autoFocus?: boolean }) {
  const t = useT();
  const note = useNoteDraft(props.text, props.onSave);
  return <NoteField note={note} texts={sessionNoteTexts(t)} rows={props.rows} autoFocus={props.autoFocus} />;
}
