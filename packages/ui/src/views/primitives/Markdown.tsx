import type { ReactNode } from 'react';
import { parseMarkdown, type Block, type Inline } from '../../presenters/markdown.ts';
import { CopyButton } from './CopyButton.tsx';
import { Hl } from './Hl.tsx';
import { Icon } from './Icon.tsx';

/**
 * Claude の書いた Markdown を描く。読み方は presenters/markdown.ts が決める。
 * 文字はどれも Hl を通して React の子として渡すので、HTML は文字のまま出る。
 * 葉を描く順は mdLeaves と同じにする。本文の中の検索がその順で一致を数えるからである。
 */
function inline(nodes: Inline[]): ReactNode[] {
  return nodes.map((n, i) => {
    switch (n.t) {
      case 'text': return <Hl key={i} text={n.text} />;
      case 'code': return <code key={i}><Hl text={n.text} /></code>;
      case 'strong': return <strong key={i}>{inline(n.children)}</strong>;
      case 'em': return <em key={i}>{inline(n.children)}</em>;
      case 'del': return <del key={i}>{inline(n.children)}</del>;
      // 宛先は http と https だけが来る（safeHref）。外で開く既存の経路（PR のリンクと同じ）に乗せる。
      case 'link': return <a key={i} href={n.href} target="_blank" rel="noreferrer noopener" title={n.href}>{inline(n.children)}<Icon name="externalLink" /></a>;
    }
  });
}

/** 囲みのコード。上の帯に言語名とコピーのボタンを置く。中身を差し替えるときは children に渡す。 */
export function CodeBlock(props: { lang: string; text: string; note?: ReactNode; children?: ReactNode }) {
  return (
    <div className="codeblock">
      <div className="codeblock-h">
        {props.lang && <span className="code-lang">{props.lang}</span>}
        {props.note}
        <CopyButton text={props.text} />
      </div>
      {props.children ?? <pre><Hl text={props.text} /></pre>}
    </div>
  );
}

function blocks(list: Block[]): ReactNode[] {
  return list.map((b, i) => {
    switch (b.t) {
      case 'p': return <p key={i}>{inline(b.inl)}</p>;
      case 'h': {
        const Tag = `h${Math.min(Math.max(b.level, 1), 6)}` as 'h1';
        return <Tag key={i}>{inline(b.inl)}</Tag>;
      }
      case 'code': return <CodeBlock key={i} lang={b.lang} text={b.text} />;
      case 'list': {
        const items = b.items.map((it, k) => <li key={k}>{blocks(it)}</li>);
        return b.ordered ? <ol key={i} start={b.start === 1 ? undefined : b.start}>{items}</ol> : <ul key={i}>{items}</ul>;
      }
      case 'table': return (
        // 広い表は横にだけ流す。本文の面の外へはみ出させない。
        <div key={i} className="md-table">
          <table>
            <thead><tr>{b.head.map((c, k) => <th key={k} style={b.align[k] ? { textAlign: b.align[k]! } : undefined}>{inline(c)}</th>)}</tr></thead>
            <tbody>{b.rows.map((r, k) => <tr key={k}>{r.map((c, j) => <td key={j} style={b.align[j] ? { textAlign: b.align[j]! } : undefined}>{inline(c)}</td>)}</tr>)}</tbody>
          </table>
        </div>
      );
      case 'quote': return <blockquote key={i}>{blocks(b.children)}</blockquote>;
      case 'hr': return <hr key={i} />;
    }
  });
}

export function Markdown(props: { text: string }) {
  return <div className="md">{blocks(parseMarkdown(props.text))}</div>;
}
