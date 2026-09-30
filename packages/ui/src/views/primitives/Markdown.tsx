import type { ReactNode } from 'react';

/**
 * Claude の返答によく出る Markdown だけを読む。囲みのコード、見出し、太字、インラインのコード。
 * 箇条書きや表は、pre-wrap の地の文のままでも崩れずに読めるので手を付けない。
 * HTML は解釈しない。文字列を React の子として渡すだけなので、タグは文字のまま出る。
 */
export type MdBlock = { kind: 'text' | 'code' | 'heading'; text: string };

const FENCE = /^\s*```/;
const HEADING = /^#{1,6}\s+(.*)$/;

export function parseBlocks(text: string): MdBlock[] {
  const blocks: MdBlock[] = [];
  let buf: string[] = [];
  // 行で割って積むので、塊の境目にあった改行は地の文に残らない。境目の間は塊の縁の余白で取る。
  const flush = () => {
    if (buf.length > 0) blocks.push({ kind: 'text', text: buf.join('\n') });
    buf = [];
  };
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (FENCE.test(line)) {
      flush();
      const code: string[] = [];
      // 書きかけの返答では閉じの ``` がまだ来ていない。そのときは末尾までをコードにする。
      for (i++; i < lines.length && !FENCE.test(lines[i]!); i++) code.push(lines[i]!);
      blocks.push({ kind: 'code', text: code.join('\n') });
      continue;
    }
    const h = HEADING.exec(line);
    if (h) { flush(); blocks.push({ kind: 'heading', text: h[1]! }); continue; }
    buf.push(line);
  }
  flush();
  return blocks;
}

const INLINE = /(`[^`\n]+`)|(\*\*[^*\n]+?\*\*)/g;

function inline(text: string): ReactNode[] {
  const out: ReactNode[] = [];
  let at = 0;
  for (const m of text.matchAll(INLINE)) {
    if (m.index > at) out.push(text.slice(at, m.index));
    out.push(m[1] ? <code key={m.index}>{m[1].slice(1, -1)}</code> : <strong key={m.index}>{m[2]!.slice(2, -2)}</strong>);
    at = m.index + m[0].length;
  }
  if (at < text.length) out.push(text.slice(at));
  return out;
}

export function Markdown(props: { text: string }) {
  return (
    <>
      {parseBlocks(props.text).map((b, i) => {
        if (b.kind === 'code') return <pre key={i} className="md-code">{b.text}</pre>;
        if (b.kind === 'heading') return <div key={i} className="md-heading">{inline(b.text)}</div>;
        return <div key={i}>{inline(b.text)}</div>;
      })}
    </>
  );
}
