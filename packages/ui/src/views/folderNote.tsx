import type { ReactNode } from 'react';
import type { FolderInspectDto } from '@agent-hangar/shared';
import type { FolderInspectState } from '../store/folderInspect.ts';

/**
 * 文の中の最初の word を太字にする（その場の 1 行で、包むプロジェクトや結び付く先の名前を目立たせる）。
 * 言語ごとに語順が違うので、文は辞書の 1 つの鍵のまま引き、名前の場所はここで探す。見つからなければ文のまま返す。
 */
export function boldFirst(text: string, word: string): ReactNode {
  const at = word ? text.indexOf(word) : -1;
  if (at < 0) return text;
  return <>{text.slice(0, at)}<b className="muted">{word}</b>{text.slice(at + word.length)}</>;
}

/**
 * 選んだフォルダの事前の問い合わせのうち、そのフォルダについての答えだけを取り出す（0.6.2）。
 * ほかのフォルダの答え、読んでいる間、読めなかったときは data が null である。loading は読んでいる間か。
 */
export function inspectOf(inspect: FolderInspectState | null | undefined, path: string | null): { data: FolderInspectDto | null; loading: boolean } {
  if (!inspect || path === null || inspect.path !== path) return { data: null, loading: false };
  return { data: inspect.status === 'ready' ? inspect.data : null, loading: inspect.status === 'loading' };
}
