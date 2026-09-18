import { useEffect, useRef, useState } from 'react';
import { useEmit } from '../intent/chain.tsx';
import type { TranscriptItem } from '../presenters/session.ts';
import { Fold } from './primitives/Fold.tsx';

function ToolItem({ sessionId, item }: { sessionId: string; item: Extract<TranscriptItem, { kind: 'tool' }> }) {
  const emit = useEmit();
  return (
    <div className={`tool ${item.result?.isError ? 'tool-error' : ''}`}>
      <Fold summary={<><span className="mono">{item.summary}</span><span className="faint mono" style={{ marginLeft: 'auto' }}>{item.when}</span></>}>
        <div className="tool-body mono">{item.inputJson}</div>
        {item.result && <div className="tool-body mono" style={{ marginTop: 4 }}>{item.result.text || '（出力なし）'}</div>}
      </Fold>
      {item.subagent && <div className="sub"><button className="btn" onClick={() => emit({ type: 'transcript.selectAgent', sessionId, agentId: item.subagent!.agentId })}>サブエージェント {item.subagent.agentId} を見る</button></div>}
    </div>
  );
}

export function Transcript(props: { sessionId: string; items: TranscriptItem[]; hasMore: boolean; loading: boolean; follow: boolean; live: boolean; remaining: number }) {
  const emit = useEmit();
  const endRef = useRef<HTMLDivElement>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  // 追従を切っている間に増えた件数だけを、この View の局所状態として持つ。
  const [unseen, setUnseen] = useState(0);
  const lastCount = useRef(props.items.length);

  useEffect(() => {
    const added = props.items.length - lastCount.current;
    lastCount.current = props.items.length;
    // jsdom には scrollIntoView が無いので、存在するときだけ呼ぶ。
    if (props.follow) endRef.current?.scrollIntoView?.({ behavior: 'smooth', block: 'end' });
    else if (added > 0) setUnseen((n) => n + added);
  }, [props.items.length, props.follow]);

  useEffect(() => { if (props.follow) setUnseen(0); }, [props.follow]);

  // 追従中の自動スクロール（smooth）は途中で何度も scroll を発火し、その間は末尾に居ない。
  // それで追従を切らないよう、切るのは scrollTop が前回より減ったとき、つまり利用者が上へ戻したときだけにする。
  const lastScrollTop = useRef(0);
  const onScroll = () => {
    const el = boxRef.current; if (!el || !props.live) return;
    const scrolledUp = el.scrollTop < lastScrollTop.current;
    lastScrollTop.current = el.scrollTop;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
    if (!atBottom && props.follow && scrolledUp) emit({ type: 'transcript.follow', sessionId: props.sessionId, follow: false });
    if (atBottom && !props.follow) emit({ type: 'transcript.follow', sessionId: props.sessionId, follow: true });
  };

  return (
    <div ref={boxRef} className="tr" onScroll={onScroll}>
      {props.items.length === 0 && !props.loading && <div className="empty">本文がありません</div>}
      {props.items.map((it) => {
        switch (it.kind) {
          case 'user': return <div key={it.seq} className="msg msg-user" style={{ maxHeight: '60vh', overflow: 'auto' }}>{it.text}</div>;
          case 'assistant': return <div key={it.seq} className="msg msg-assistant" style={{ maxHeight: '60vh', overflow: 'auto' }}>{it.text}</div>;
          case 'thinking': return <div key={it.seq} className="msg msg-thinking">{it.text}</div>;
          case 'system': return <div key={it.seq} className="msg msg-system">{it.text}</div>;
          case 'tool': return <ToolItem key={it.seq} sessionId={props.sessionId} item={it} />;
          case 'meta': return <div key={it.seq} className="msg msg-system mono">{it.name} {it.json}</div>;
        }
      })}
      {props.hasMore && <button className="btn" style={{ alignSelf: 'center' }} disabled={props.loading} onClick={() => emit({ type: 'transcript.loadMore', sessionId: props.sessionId })}>{props.loading ? '読み込んでいます' : `続きを読み込む（残り ${props.remaining} 件）`}</button>}
      {props.live && !props.follow && unseen > 0 && <button className="btn btn-primary new-banner" onClick={() => emit({ type: 'transcript.follow', sessionId: props.sessionId, follow: true })}>新着 {unseen} 件</button>}
      <div ref={endRef} />
    </div>
  );
}
