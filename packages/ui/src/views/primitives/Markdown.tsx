import { createContext, useContext, type MouseEvent, type ReactNode } from 'react';
import { useEmit } from '../../action/chain.tsx';
import { parseMarkdown, type Block, type Inline } from '../../presenters/markdown.ts';
import { presentSessionChip } from '../../presenters/sessionLink.ts';
import { hangarActionOf, hangarLinkOf } from '../../runtime/hangarLink.ts';
import type { Store } from '../../store/store.ts';
import { StatusDot } from './StatusDot.tsx';
import { useT } from './language.tsx';
import { CopyButton } from './CopyButton.tsx';
import { Hl } from './Hl.tsx';
import { Icon } from './Icon.tsx';

/**
 * Claude の書いた Markdown を描く。読み方は presenters/markdown.ts が決める。
 * 文字はどれも Hl を通して React の子として渡すので、HTML は文字のまま出る。
 * 葉を描く順は mdLeaves と同じにする。本文の中の検索がその順で一致を数えるからである。
 */
/**
 * 本文の hangar の会話へのリンクを札で描くための、ストアと、いま見ている会話。
 * 無い（文脈の外で描く）ときは、札にせずふつうのリンクのまま描く。値が変わると、札だけが描き直される（Markdown そのものは文脈を読まない）。
 */
export const SessionLinkContext = createContext<{ store: Store; viewingId: string | null } | null>(null);

/**
 * 本文のリンク。hangar 自身のリンク（runtime/hangarLink.ts）は、アプリの中で、いまのペインでその会話（プロジェクト）を開く。
 * 会話のリンクで、その会話がこの PC で分かるなら札（状態の丸と題。見ている会話と違うときだけ、プロジェクト名と PC の名前を薄い字で添える）にする。
 * 分からない会話は、ふつうのリンクのまま。ふつうの外へのリンクは、外で開く既存の経路（PR のリンクと同じ）に乗せる。
 * 文書の click が先に開いていたら（defaultPrevented）、ここでは重ねて開かない。
 */
function MdLink(props: { href: string; children: ReactNode }) {
  const emit = useEmit();
  const t = useT();
  const ctx = useContext(SessionLinkContext);
  const link = hangarLinkOf(props.href);
  if (!link) return <a href={props.href} target="_blank" rel="noreferrer noopener" title={props.href}>{props.children}<Icon name="externalLink" /></a>;
  const open = (e: MouseEvent) => {
    if (e.defaultPrevented) return;
    e.preventDefault();
    emit(hangarActionOf(link));
  };
  const chip = link.kind === 'session' && ctx ? presentSessionChip(ctx.store, t, link.id, ctx.viewingId) : null;
  if (!chip) return <a href={props.href} target="_blank" rel="noreferrer noopener" title={props.href} onClick={open}>{props.children}</a>;
  return (
    <a className="sess-chip" href={props.href} target="_blank" rel="noreferrer noopener" onClick={open}>
      <StatusDot status={chip.live} aside={chip.aside} reason={chip.reason} />
      <span className="sess-chip-name"><Hl text={chip.name} /></span>
      {chip.project !== null && <span className="sess-chip-meta">{chip.project}</span>}
      {chip.device !== null && <span className="sess-chip-meta">{chip.device}</span>}
    </a>
  );
}

function inline(nodes: Inline[]): ReactNode[] {
  return nodes.map((n, i) => {
    switch (n.t) {
      case 'text': return <Hl key={i} text={n.text} />;
      case 'code': return <code key={i}><Hl text={n.text} /></code>;
      case 'strong': return <strong key={i}>{inline(n.children)}</strong>;
      case 'em': return <em key={i}>{inline(n.children)}</em>;
      case 'br': return <br key={i} />;
      case 'del': return <del key={i}>{inline(n.children)}</del>;
      // 宛先は http と https、hangar://session/… と hangar://project/… だけが来る（safeHref）。
      case 'link': return <MdLink key={i} href={n.href}>{inline(n.children)}</MdLink>;
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
