import { Fragment, type ReactNode } from 'react';
import { useEmit } from '../action/chain.tsx';
import type { DiffLine } from '../presenters/diff.ts';
import { safeHref } from '../presenters/markdown.ts';
import type { TranscriptItem } from '../presenters/session.ts';
import type { ToolBody } from '../presenters/tools.ts';
import { Clamp, headLines, OUT_LINES } from './primitives/Clamp.tsx';
import { CopyButton } from './primitives/CopyButton.tsx';
import { Hl } from './primitives/Hl.tsx';
import { Icon } from './primitives/Icon.tsx';
import { useT } from './primitives/language.tsx';
import { CodeBlock } from './primitives/Markdown.tsx';
import { useHits, useOpen } from './transcriptOpen.tsx';

type ToolItemProps = Extract<TranscriptItem, { kind: 'tool' }>;

/** 差分を切る行数。出力より長めに見せる。 */
const DIFF_LINES = 24;
const lineCount = (s: string) => (s === '' ? 0 : s.split('\n').length);

/**
 * 文字の葉を印の部品に渡す順は presenters/tools.ts の toolLeaves と同じにする。
 * 本文の中の検索は、その順でデータから一致を数え、ここで描いた印の何番目かへ跳ぶからである。
 */
function OutText(props: { seq: number; part: string; text: string; tone?: 'surface' | 'term'; className: string; pre?: boolean }) {
  return (
    <Clamp seq={props.seq} part={props.part} lines={lineCount(props.text)} shown={OUT_LINES} tone={props.tone}>
      {(open) => (props.pre ? <pre className={props.className}><Hl text={headLines(props.text, open)} /></pre> : <div className={props.className}><Hl text={headLines(props.text, open)} /></div>)}
    </Clamp>
  );
}

function DiffView(props: { seq: number; body: Extract<ToolBody, { kind: 'diff' }> }) {
  const t = useT();
  // 見出しと行を 1 本の並びにして、畳んだときは先頭から DIFF_LINES 行だけを描く。
  const rows: ({ kind: 'head'; text: string } | { kind: 'line'; line: DiffLine })[] = [];
  for (const h of props.body.hunks) {
    if (h.header) rows.push({ kind: 'head', text: h.header });
    for (const line of h.lines) rows.push({ kind: 'line', line });
  }
  return (
    <Clamp seq={props.seq} part="diff" lines={rows.length} shown={DIFF_LINES}>
      {(open) => (
        <div className="tdiff">
          {(open ? rows : rows.slice(0, DIFF_LINES)).map((r, i) => {
            if (r.kind === 'head') return <div key={i} className="hunk">{r.text}</div>;
            const l = r.line;
            if (l.t === 'gap') return <div key={i} className="dgap">{t('transcript.diff.gap', { n: l.count })}</div>;
            return (
              <div key={i} className="dl" data-t={l.t}>
                <span className="n">{l.old ?? ''}</span><span className="n">{l.new ?? ''}</span>
                <span className="s">{l.t === 'add' ? '+' : l.t === 'del' ? '−' : ''}</span>
                <span className="x"><Hl text={l.text} /></span>
              </div>
            );
          })}
        </div>
      )}
    </Clamp>
  );
}

function CodeView(props: { seq: number; body: Extract<ToolBody, { kind: 'code' }> }) {
  const lines = props.body.text.split('\n');
  return (
    <CodeBlock lang={props.body.lang} text={props.body.text} note={<span className="code-note">{props.body.note}</span>}>
      <Clamp seq={props.seq} part="code" lines={lines.length} shown={OUT_LINES}>
        {(open) => <pre>{(open ? lines : lines.slice(0, OUT_LINES)).map((l, i) => <span key={i} className="cl"><span className="ln">{i + 1}</span><Hl text={l} />{'\n'}</span>)}</pre>}
      </Clamp>
    </CodeBlock>
  );
}

function BashView(props: { seq: number; body: Extract<ToolBody, { kind: 'bash' }>; answered: boolean }) {
  const t = useT();
  const b = props.body;
  const n = lineCount(b.output);
  const status = b.exit !== null ? t('transcript.bash.exitCode', { code: b.exit }) : b.failed ? t('transcript.bash.failed') : props.answered ? '' : t('transcript.bash.noResult');
  return (
    <div className="bash">
      <div className="cmd"><span className="pr">$</span><span className="c"><Hl text={b.command} /></span><CopyButton text={b.command} /></div>
      {b.output === '' ? <div className="out out-empty">{t('transcript.bash.noOutput')}</div> : <OutText seq={props.seq} part="out" text={b.output} tone="term" className="out" />}
      <div className="foot">{status && <span data-tone={b.failed ? 'ng' : 'ok'}>{status}</span>}{n > 0 && <span>{t('transcript.bash.lines', { n })}</span>}</div>
    </div>
  );
}

function ArgsView(props: { seq: number; body: Extract<ToolBody, { kind: 'args' }> }) {
  if (props.body.rows.length === 0) return null;
  return (
    <dl className="tool-args">
      {props.body.rows.map((r, i) => (
        <Fragment key={i}>
          <dt>{r.key}</dt>
          <dd><OutText seq={props.seq} part={`arg:${i}`} text={r.value} className="arg-v" /></dd>
        </Fragment>
      ))}
    </dl>
  );
}

function Body(props: { item: ToolItemProps }): ReactNode {
  const t = useT();
  const b = props.item.view.body;
  const seq = props.item.seq;
  switch (b.kind) {
    case 'diff': return <DiffView seq={seq} body={b} />;
    case 'code': return <CodeView seq={seq} body={b} />;
    case 'bash': return <BashView seq={seq} body={b} answered={props.item.result !== null} />;
    case 'read': return <div className="tool-read"><span className="mono">{b.path}</span>{b.range && <span className="range">{b.range}</span>}</div>;
    case 'fetch': {
      const href = safeHref(b.url);
      return (
        <div className="tool-web">
          <div className="u">{href ? <a href={href} target="_blank" rel="noreferrer noopener"><Hl text={b.url} /></a> : <span className="mono"><Hl text={b.url} /></span>}</div>
          {b.prompt && <div className="q"><b>{t('transcript.fetch.prompt')}</b><span><Hl text={b.prompt} /></span></div>}
          {b.text !== null && <OutText seq={seq} part="fetch" text={b.text} className="r" />}
        </div>
      );
    }
    case 'search': return (
      <div className="tool-web">
        <div className="u"><Icon name="search" /><b>{b.query}</b>{b.links.length > 0 && <span className="faint">{t('transcript.search.results', { n: b.links.length })}</span>}</div>
        {b.links.length > 0 && (
          <ul className="tool-links">
            {b.links.map((l, i) => <li key={i}><a href={l.url} target="_blank" rel="noreferrer noopener"><Hl text={l.title} /></a><span className="dom">{l.domain}</span></li>)}
          </ul>
        )}
      </div>
    );
    case 'args': return <ArgsView seq={seq} body={b} />;
  }
}

/** ツールの 1 行（T1）。押すと下に中身を開く。札の色は手の種類（K1、色は live-explainer の色帯に合わせる）。 */
export function ToolItem({ sessionId, item }: { sessionId: string; item: ToolItemProps }) {
  const emit = useEmit();
  const t = useT();
  const [open, setOpen] = useOpen(item.seq, 'tool');
  const hits = useHits(item.seq);
  const v = item.view;
  const title = v.head.dim ? `${v.head.main} · ${v.head.dim}` : v.head.main;
  return (
    <div className="tool" data-open={open ? 'true' : undefined} data-failed={v.step === 'fail' ? 'true' : undefined}>
      <button type="button" className="trow" aria-expanded={open} title={title} onClick={() => setOpen(!open)}>
        <span className="chev"><Icon name="chevron" /></span>
        <span className="badge" data-k={v.step}>{item.name}</span>
        <span className="tool-sum mono"><Hl text={v.head.main} />{v.head.dim && <span className="d"> · <Hl text={v.head.dim} /></span>}</span>
        {!open && hits > 0 && <span className="hitcount">{t('transcript.tool.hits', { n: hits })}</span>}
        {v.head.meta.length > 0 && <span className="meta">{v.head.meta.map((m, i) => <span key={i} data-tone={m.tone}>{m.text}</span>)}</span>}
        <span className="when">{item.when}</span>
      </button>
      {open && (
        <div className="tbody">
          <Body item={item} />
          {v.result !== null && (
            <div className="tool-result" data-failed={v.step === 'fail' ? 'true' : undefined}>
              <div className="tool-label">{t('transcript.tool.result')}</div>
              <OutText seq={item.seq} part="result" text={v.result} className="tool-result-text" pre />
            </div>
          )}
          {item.raw && (
            <div className="tool-raw">
              <div className="tool-label">{t('transcript.tool.raw')}</div>
              <pre>{item.raw.input}</pre>
              {item.raw.result !== null && <pre>{item.raw.result}</pre>}
            </div>
          )}
        </div>
      )}
      {item.subagent && <div className="sub"><button className="btn btn-sm" onClick={() => emit({ type: 'transcript.selectAgent', sessionId, agentId: item.subagent!.agentId })}><Icon name="subagent" /><span className="btn-label">{t('transcript.tool.viewSubagent', { id: item.subagent.agentId })}</span></button></div>}
    </div>
  );
}
