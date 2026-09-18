import { useCallback, useEffect, useLayoutEffect, useReducer, useRef, useState, type ReactNode } from 'react';
import { useEmit } from '../intent/chain.tsx';
import type { TranscriptItem } from '../presenters/session.ts';
import { Fold } from './primitives/Fold.tsx';
import { Icon } from './primitives/Icon.tsx';

function ToolItem({ sessionId, item }: { sessionId: string; item: Extract<TranscriptItem, { kind: 'tool' }> }) {
  const emit = useEmit();
  return (
    <div className={`tool ${item.result?.isError ? 'tool-error' : ''}`}>
      <Fold summary={<><Icon name="tool" /><span className="mono">{item.summary}</span><span className="faint mono" style={{ marginLeft: 'auto' }}>{item.when}</span></>}>
        <div className="tool-body mono">{item.inputJson}</div>
        {item.result && <div className="tool-body mono" style={{ marginTop: 4 }}>{item.result.text || '（出力なし）'}</div>}
      </Fold>
      {item.subagent && <div className="sub"><button className="btn" onClick={() => emit({ type: 'transcript.selectAgent', sessionId, agentId: item.subagent!.agentId })}><Icon name="subagent" />サブエージェント {item.subagent.agentId} を見る</button></div>}
    </div>
  );
}

function renderItem(sessionId: string, it: TranscriptItem): ReactNode {
  switch (it.kind) {
    case 'user': return <div className="msg msg-user" style={{ maxHeight: '60vh', overflow: 'auto' }}>{it.text}</div>;
    case 'assistant': return <div className="msg msg-assistant" style={{ maxHeight: '60vh', overflow: 'auto' }}>{it.text}</div>;
    case 'thinking': return <div className="msg msg-thinking">{it.text}</div>;
    case 'system': return <div className="msg msg-system">{it.text}</div>;
    case 'tool': return <ToolItem sessionId={sessionId} item={it} />;
    case 'meta': return <div className="msg msg-system mono">{it.name} {it.json}</div>;
  }
}

/** 行と行の間隔。.tr の gap ではなく行の器の下余白で持つので、測った高さにそのまま含まれる。 */
const GAP = 8;
/** 窓の上下に余分に描く高さ。速く飛ばしても白い帯が見えないだけの厚みを取る。 */
const OVERSCAN = 600;
/** まだ器の高さを測れていないときに使う仮の高さ。0 にすると 1 行も描かれない。 */
const FALLBACK_VIEWPORT = 800;
/** 本文は 60vh で頭打ちになるので、見積もりもそのあたりで止める。 */
const ROW_MAX = 420;

/** 測る前の高さの見積もり。ツールは畳んだ 1 行、本文は 80 字で折り返した行数から当てる。 */
function estimateRow(it: TranscriptItem): number {
  if (it.kind === 'tool') return GAP + 28 + (it.subagent ? 32 : 0);
  const text = it.kind === 'meta' ? `${it.name} ${it.json}` : it.text;
  let lines = 0;
  for (const line of text.split('\n')) lines += Math.max(1, Math.ceil(line.length / 80));
  return GAP + Math.min(28 + lines * 20, ROW_MAX);
}

/**
 * 累積の高さ（offsets[i] が i 行目の上端、末尾が全体の高さ）から、
 * from 以上 to 未満に重なる行の範囲を返す。行が無いときは last が first より小さくなる。
 */
export function rowWindow(offsets: number[], from: number, to: number): { first: number; last: number } {
  const n = offsets.length - 1;
  if (n <= 0) return { first: 0, last: -1 };
  let lo = 0;
  let hi = n - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (offsets[mid]! <= from) lo = mid; else hi = mid - 1;
  }
  let last = lo;
  while (last + 1 < n && offsets[last + 1]! < to) last++;
  return { first: lo, last };
}

export function Transcript(props: { sessionId: string; items: TranscriptItem[]; hasMore: boolean; loading: boolean; follow: boolean; live: boolean; remaining: number }) {
  const emit = useEmit();
  const endRef = useRef<HTMLDivElement>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  const rowsRef = useRef<HTMLDivElement>(null);
  // 描いてある行の実体と、測れた高さ。高さは seq で覚えるので、行が増えても測り直しにならない。
  const rowEls = useRef(new Map<number, HTMLDivElement>());
  const measured = useRef(new Map<number, number>());
  const [, remeasured] = useReducer((n: number) => n + 1, 0);
  // 器のスクロール位置と高さ。これが変わったときだけ窓を引き直す。
  const [box, setBox] = useState({ top: 0, height: 0, rowsTop: 0 });
  // 追従を切っている間に届いた新着の件数だけを、この View の局所状態として持つ。
  const [unseen, setUnseen] = useState(0);
  // 行は seq の順に並んでいるので、いちばん新しい seq は末尾から取れる。
  const n = props.items.length;
  const maxSeq = n > 0 ? props.items[n - 1]!.seq : null;
  // 追うのをやめた時点で見えていた最大の seq。新着はこれより新しい行だけを数える。
  const seenMax = useRef<number | null>(maxSeq);
  // 見ている行の目印（その行の seq と、器の上端からその行の上端までのずれ）。
  // 利用者がスクロールしたときだけ取り直し、それ以外の理由で位置が動いたらこの行へ戻す。
  const anchor = useRef<{ seq: number; delta: number } | null>(null);

  const measureBox = useCallback(() => {
    const el = boxRef.current;
    if (!el) return;
    const rowsTop = rowsRef.current ? rowsRef.current.offsetTop - el.offsetTop : 0;
    setBox((b) => (b.top === el.scrollTop && b.height === el.clientHeight && b.rowsTop === rowsTop ? b : { top: el.scrollTop, height: el.clientHeight, rowsTop }));
  }, []);

  useLayoutEffect(() => {
    measureBox();
    // 開いた直後は窓が末尾に張り付いているので、上端から滑らかに動かすと窓の外の空白だけが流れて見える。
    // 最初の 1 回は跳ばして下端に着ける。
    const el = boxRef.current;
    if (props.follow && el) el.scrollTop = el.scrollHeight;
  }, [measureBox]);
  useEffect(() => {
    const onResize = () => measureBox();
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [measureBox]);

  useEffect(() => {
    if (!props.follow) {
      // 件数の増分では数えない。過去へ遡って行が増えた分まで新着に混ざるからである。
      const base = seenMax.current;
      if (base === null) { seenMax.current = maxSeq; setUnseen(0); return; }
      let added = 0;
      for (const it of props.items) if (it.seq > base) added++;
      setUnseen(added);
      return;
    }
    seenMax.current = maxSeq;
    if (props.follow) {
      // 末尾まで 1 画面より離れているときに滑らかに動かすと、窓の外の空白を延々と流すことになる。
      // その距離なら跳ばし、すぐ近くのときだけ滑らかに寄せる。jsdom には scrollIntoView が無いので、存在するときだけ呼ぶ。
      const el = boxRef.current;
      if (el && el.scrollHeight - el.scrollTop - el.clientHeight > el.clientHeight) el.scrollTop = el.scrollHeight;
      else endRef.current?.scrollIntoView?.({ behavior: 'smooth', block: 'end' });
    }
  }, [maxSeq, n, props.follow]);

  useEffect(() => { if (props.follow) setUnseen(0); }, [props.follow]);

  // 追従中の自動スクロール（smooth）は途中で何度も scroll を発火し、その間は末尾に居ない。
  // それで追従を切らないよう、切るのは scrollTop が前回より減ったとき、つまり利用者が上へ戻したときだけにする。
  const lastScrollTop = useRef(0);
  const onScroll = () => {
    const el = boxRef.current; if (!el) return;
    measureBox();
    const scrolledUp = el.scrollTop < lastScrollTop.current;
    lastScrollTop.current = el.scrollTop;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
    // 上へ戻したら追うのをやめる。終了したセッションこそ読み返す対象なので、ここで live は見ない。
    // 追っている間は窓が末尾に張り付くので、切れないままだと遡っても窓の外の空白しか出ない。
    if (!atBottom && props.follow && scrolledUp) emit({ type: 'transcript.follow', sessionId: props.sessionId, follow: false });
    // 末尾に着いたら追うのに戻すのは、新着が届くセッションだけでよい。live を見るのはこちらだけである。
    if (atBottom && !props.follow && props.live) emit({ type: 'transcript.follow', sessionId: props.sessionId, follow: true });
    // いま器の上端に掛かっている行を目印にする。描いてある内容はこの描画の offsets と一致している。
    const top = Math.max(el.scrollTop - box.rowsTop, 0);
    const at = rowWindow(offsets, top, top).first;
    anchor.current = n > 0 && at < n ? { seq: props.items[at]!.seq, delta: top - offsets[at]! } : null;
  };

  // 高さは描くたびに積み直す。5,000 行でも足し算 5,000 回で、描画そのものより十分に軽い。
  const offsets = new Array<number>(n + 1);
  offsets[0] = 0;
  for (let i = 0; i < n; i++) {
    const it = props.items[i]!;
    offsets[i + 1] = offsets[i]! + (measured.current.get(it.seq) ?? estimateRow(it));
  }
  const total = offsets[n]!;
  const vh = box.height > 0 ? box.height : FALLBACK_VIEWPORT;
  // 追っている間は、測った高さのずれでスクロール位置が遅れても末尾を外さないよう、窓を下端に張り付ける。
  const viewTop = props.follow ? Math.max(total - vh, 0) : Math.max(box.top - box.rowsTop, 0);
  const { first, last } = rowWindow(offsets, viewTop - OVERSCAN, viewTop + vh + OVERSCAN);

  // 窓の外の高さは器の上下の余白で持つ。行を足しても前の行の高さは変わらないので、
  // 続きを読み込んでも上端の余白は動かず、見ている行がその場に留まる。
  const padTop = offsets[first] ?? 0;
  const padBottom = Math.max(total - (offsets[last + 1] ?? 0), 0);

  // この描画で実際に使った行の上端と高さ。測り直したあとに、どれだけ位置がずれたかを出すために控える。
  const drawn = props.items.slice(first, last + 1);
  const usedRows = new Map<number, { top: number; height: number }>();
  for (let i = 0; i < drawn.length; i++) {
    const idx = first + i;
    usedRows.set(drawn[i]!.seq, { top: offsets[idx]!, height: offsets[idx + 1]! - offsets[idx]! });
  }

  // 行が前に入ったか、並びか器の位置が変わったか。目印を当て直すのはこのときと、高さを測り直したときだけでよい。
  const firstSeq = n > 0 ? props.items[0]!.seq : null;
  const layoutKey = `${n}:${firstSeq}:${maxSeq}:${box.rowsTop}`;
  const lastLayoutKey = useRef(layoutKey);

  useLayoutEffect(() => {
    let changed = false;
    // 見ている位置より上にある行の高さが変わった分。この差だけスクロール位置をずらせば、見ている行は動かない。
    for (const [seq, el] of rowEls.current) {
      const h = el.offsetHeight;
      // jsdom では高さが 0 になる。そのときは見積もりのままにして、測れた行だけを覚える。
      if (h <= 0) continue;
      const used = usedRows.get(seq);
      if (!used || Math.abs(used.height - h) < 1) continue;
      measured.current.set(seq, h);
      changed = true;
    }
    const shifted = lastLayoutKey.current !== layoutKey;
    lastLayoutKey.current = layoutKey;
    const el = boxRef.current;
    if (!el) { if (changed) remeasured(); return; }
    let moved = false;
    if (props.follow) {
      // 測り直しで全体の高さが動くので、追っている間はその場で下端へ寄せ直す。
      if (changed) { el.scrollTop = el.scrollHeight; moved = true; }
    } else if (changed || shifted) {
      // 目印の行の上端を、いま分かっている高さで出し直して、そこへ戻す。
      // 前に入った行の見積もりの誤差も、窓の中の行の測り直しも、まとめてここで吸収する。
      const a = anchor.current;
      const idx = a ? props.items.findIndex((it) => it.seq === a.seq) : -1;
      if (a && idx >= 0) {
        let top = 0;
        for (let i = 0; i < idx; i++) top += measured.current.get(props.items[i]!.seq) ?? estimateRow(props.items[i]!);
        const rowsTop = rowsRef.current ? rowsRef.current.offsetTop - el.offsetTop : box.rowsTop;
        const want = Math.max(top + a.delta + rowsTop, 0);
        if (Math.abs(el.scrollTop - want) >= 1) { el.scrollTop = want; moved = true; }
      }
    }
    // scrollTop を書き換えても scroll は同じ間に届かないので、ここで測り直して窓を合わせる。
    if (moved) { lastScrollTop.current = el.scrollTop; measureBox(); }
    if (changed) remeasured();
  });

  const setRowEl = (seq: number) => (el: HTMLDivElement | null) => {
    if (el) rowEls.current.set(seq, el); else rowEls.current.delete(seq);
  };

  return (
    <div ref={boxRef} className="tr" onScroll={onScroll}>
      {n === 0 && !props.loading && <div className="empty">本文がありません</div>}
      {/* 押すと過去が前に入るので、ボタンは一覧の上に置く。窓の外にあるので仮想化の対象にしない。 */}
      {props.hasMore && <button className="btn" style={{ alignSelf: 'center' }} disabled={props.loading} onClick={() => emit({ type: 'transcript.loadMore', sessionId: props.sessionId })}>{props.loading ? '読み込んでいます' : `古い行を読み込む（残り ${props.remaining} 件）`}</button>}
      <div ref={rowsRef} className="tr-rows" style={{ paddingTop: padTop, paddingBottom: padBottom }}>
        {drawn.map((it) => (
          <div key={it.seq} className="tr-row" data-seq={it.seq} ref={setRowEl(it.seq)}>{renderItem(props.sessionId, it)}</div>
        ))}
      </div>
      {props.live && !props.follow && unseen > 0 && <button className="btn btn-primary new-banner" onClick={() => emit({ type: 'transcript.follow', sessionId: props.sessionId, follow: true })}>新着 {unseen} 件</button>}
      <div ref={endRef} />
    </div>
  );
}
