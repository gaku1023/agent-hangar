import { createContext, useContext, type ReactNode } from 'react';
import { editorNameOf } from '@agent-hangar/shared';
import { useT } from './language.tsx';

/**
 * 選んでいるエディタの名前（「<名前> で開く」の名前）。Root が設定（`SettingsDto.editor`）から 1 か所で決めて流す。
 * 任意のコマンドは null で、ボタンは「エディタで開く」と言う。頂点の無いところでは既定の VS Code になる。
 */
export const EditorNameContext = createContext<string | null>(editorNameOf('vscode'));

export function EditorNameRoot(props: { name: string | null; children: ReactNode }) {
  return <EditorNameContext.Provider value={props.name}>{props.children}</EditorNameContext.Provider>;
}

/** View が自分の持つ「<名前> で開く」のボタンの文を引く。データから作る文は Presenter が presenters/editor.ts で引く。 */
export function useEditorLabels(): { open: string; openFor: (target: string) => string } {
  const t = useT();
  const name = useContext(EditorNameContext);
  return {
    open: name === null ? t('editor.open.generic') : t('editor.open.named', { name }),
    openFor: (target) => (name === null ? t('editor.open.genericFor', { target }) : t('editor.open.namedFor', { target, name })),
  };
}
