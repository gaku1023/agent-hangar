import type { KeyboardEvent } from 'react';

/**
 * 日本語入力の変換を確定する Enter かどうかを返す。
 * 変換中の Enter で検索を走らせると、確定と同時に画面が作り直されて入力が消える。
 * 古い環境では isComposing が無く keyCode が 229 になるので、その両方を見る。
 */
export function isComposing(e: KeyboardEvent<HTMLElement>): boolean {
  return (e.nativeEvent as unknown as { isComposing?: boolean }).isComposing === true || e.keyCode === 229;
}
