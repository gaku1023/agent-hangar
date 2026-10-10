import { Fragment, type ReactNode } from 'react';

/**
 * 文の中の 1 か所へ、文字ではなく要素（太字、等幅など）を差し込む。
 * 辞書の文は文字列なので、差し込む場所の引数に `SLOT` を渡して引き、`slot()` でその場所を要素に替える。
 * 引数の位置は言語ごとに変わってよい。
 */
export const SLOT = '\u0001';

export function slot(text: string, node: ReactNode): ReactNode {
  const parts = text.split(SLOT);
  return (
    <>
      {parts.map((part, i) => (
        <Fragment key={i}>
          {i > 0 && node}
          {part}
        </Fragment>
      ))}
    </>
  );
}
