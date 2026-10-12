import { EDITOR_NAMES, editorNameOf, type SettingsDto, type Translate, type UiAction } from '@agent-hangar/shared';
import type { Store } from '../store/store.ts';

/**
 * エディタの選択（0.5.0）の見せ方。
 * ボタンの文は「<名前> で開く」で、押す前にどのアプリが開くかが分かる（試作の 1-2 の A）。任意のコマンドは「エディタで開く」。
 */

/** 選んでいるエディタの名前。任意のコマンドと、設定が届く前は null。設定が届く前は VS Code（既定）として言う。 */
export function editorName(settings: Partial<Pick<SettingsDto, 'editor'>> | null): string | null {
  return editorNameOf(settings?.editor?.id ?? 'vscode');
}

/** 「<名前> で開く」。任意のコマンドは「エディタで開く」。 */
export function openLabel(t: Translate, settings: Partial<Pick<SettingsDto, 'editor'>> | null): string {
  const name = editorName(settings);
  return name === null ? t('editor.open.generic') : t('editor.open.named', { name });
}

/** 「<対象> を <名前> で開く」（読み上げと title）。 */
export function openForLabel(t: Translate, settings: Partial<Pick<SettingsDto, 'editor'>> | null, target: string): string {
  const name = editorName(settings);
  return name === null ? t('editor.open.genericFor', { target }) : t('editor.open.namedFor', { target, name });
}

/** 「<対象> の N 行目を <名前> で開く」（差分の行から）。 */
export function openAtLabel(t: Translate, settings: Partial<Pick<SettingsDto, 'editor'>> | null, target: string, line: number): string {
  const name = editorName(settings);
  return name === null ? t('editor.open.genericAt', { target, line }) : t('editor.open.namedAt', { target, name, line });
}

/**
 * エディタが見つからないときの面（試作の 1-3 の B）。押した瞬間にサーバが探し直し、見つからなければ 409 で断る。
 * 面は理由と次の手（設定でエディタを選ぶ、今回はほかの見つかっているエディタで開く、再確認）を並べる。
 * n は同じ断りをもう一度受けたことに気付くための回数で、View は閉じた n を覚えて、新しい断りだけを出す。
 */
export type EditorMissingProps = {
  n: number; title: string; lastPath: string | null;
  choices: { key: string; label: string; icon: 'settings' | 'openEditor' | 'recheck'; send: UiAction }[];
};

export function presentEditorMissing(store: Pick<Store, 'editorMissing'>, t: Translate): EditorMissingProps | null {
  const m = store.editorMissing;
  if (!m) return null;
  // 「今回は」は 2 つまで。多いと面が長くなる。
  const others = m.others.slice(0, 2).map((id) => ({ key: `once:${id}`, label: t('editor.missing.once', { name: EDITOR_NAMES[id] }), icon: 'openEditor' as const, send: { ...m.retry, once: id } as UiAction }));
  const { once: _drop, ...retry } = m.retry as typeof m.retry & { once?: unknown };
  return {
    n: m.n, title: m.error, lastPath: m.lastPath,
    choices: [
      { key: 'settings', label: t('editor.missing.settings'), icon: 'settings', send: { type: 'nav.go', to: { name: 'settings', at: 'editor' } } },
      ...others,
      { key: 'recheck', label: t('editor.missing.recheck'), icon: 'recheck', send: retry as UiAction },
    ],
  };
}
