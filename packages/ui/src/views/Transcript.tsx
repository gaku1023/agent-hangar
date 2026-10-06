import { useCallback, useEffect, useLayoutEffect, useMemo, useReducer, useRef, useState, type ReactNode } from 'react';
import { useEmit } from '../intent/chain.tsx';
import type { JumpState } from '../mediator/types.ts';
import type { TranscriptFind } from '../presenters/find.ts';
import type { TranscriptItem } from '../presenters/session.ts';
import { Clamp, estimateLines, MSG_LINES } from './primitives/Clamp.tsx';
import { createGlide, type Glide } from './primitives/glide.ts';
import { Hl, MarkProvider, type Marking } from './primitives/Hl.tsx';
import { Icon } from './primitives/Icon.tsx';
import { isComposing } from './ime.ts';
import { Markdown } from './primitives/Markdown.tsx';
import { ToolItem } from './ToolItem.tsx';
import { HitsContext, OpenContext, type OpenStore } from './transcriptOpen.tsx';

export type { TranscriptFind };

/**
 * 本文の 1 行。
 * 利用者の指示は打ったとおりに右寄せの吹き出しで見せ、Claude の返答は吹き出しをやめて地の文の Markdown にする（M2）。
 * 長いものは入れ子のスクロールにせず、高さで切って下端をぼかす（F1）。
 */
export function renderItem(sessionId: string, it: TranscriptItem): ReactNode {
  switch (it.kind) {
    case 'user': return <div className="msg msg-user"><Clamp seq={it.seq} part="msg" lines={estimateLines(it.text, 60)} shown={MSG_LINES} tone="accent" height>{() => <Hl text={it.text} />}</Clamp></div>;
    case 'assistant': return <div className="msg msg-assistant"><Clamp seq={it.seq} part="msg" lines={estimateLines(it.text)} shown={MSG_LINES} height>{() => <Markdown text={it.text} />}</Clamp></div>;
    case 'thinking': return <div className="msg msg-thinking"><Clamp seq={it.seq} part="msg" lines={estimateLines(it.text)} shown={MSG_LINES} height>{() => <Markdown text={it.text} />}</Clamp></div>;
    case 'system': return <div className="msg msg-system"><Hl text={it.text} /></div>;
    case 'tool': return <ToolItem sessionId={sessionId} item={it} />;
    case 'meta': return <div className="msg msg-system mono"><Hl text={`${it.name} ${it.json}`} /></div>;
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

/**
 * 本文の中の検索の欄（S1）。本文の面の右上に浮くガラスで、件数、前へ・次へ、大文字小文字、閉じるを並べる。
 * 語は打つたびに送る。日本語の変換中は送らず、確定したときに送る。
 */
function FindBar(props: { sessionId: string; find: TranscriptFind; topSeq: () => number | null }) {
  const emit = useEmit();
  const f = props.find;
  const inputRef = useRef<HTMLInputElement>(null);
  const [draft, setDraft] = useState(f.query);
  const composing = useRef(false);
  // ⌘F を押すたびに（開いたままでも）欄へ戻り、語を選び直す。
  useEffect(() => { inputRef.current?.focus(); inputRef.current?.select(); }, [f.n]);
  const send = (query: string, caseSensitive: boolean) => emit({ type: 'transcript.findQuery', sessionId: props.sessionId, query, caseSensitive, from: props.topSeq() });
  const step = (delta: number) => emit({ type: 'transcript.findStep', sessionId: props.sessionId, delta });
  const close = () => emit({ type: 'transcript.find', sessionId: props.sessionId, open: false });
  const count = f.query === '' ? '' : f.total === 0 ? '0 件' : `${f.current + 1} / ${f.total}`;
  return (
    <div className="tr-find" role="search">
      <span className="tr-find-in">
        <Icon name="search" />
        <input ref={inputRef} type="search" aria-label="本文の中を探す" placeholder="本文の中を探す" value={draft} spellCheck={false}
          onChange={(e) => { setDraft(e.target.value); if (!composing.current) send(e.target.value, f.caseSensitive); }}
          onCompositionStart={() => { composing.current = true; }}
          onCompositionEnd={(e) => { composing.current = false; send(e.currentTarget.value, f.caseSensitive); }}
          onKeyDown={(e) => {
            if (isComposing(e)) return;
            if (e.key === 'Enter') { e.preventDefault(); step(e.shiftKey ? -1 : 1); }
            else if (e.key === 'Escape') { e.preventDefault(); close(); }
          }} />
        <button type="button" className="tr-find-opt" aria-label="大文字と小文字を区別" title="大文字と小文字を区別" aria-pressed={f.caseSensitive} onClick={() => send(draft, !f.caseSensitive)}><Icon name="matchCase" /></button>
      </span>
      <span className="tr-find-count mono" aria-live="polite">{count}</span>
      <button type="button" className="tr-find-btn" aria-label="前の一致（⇧⏎）" title="前の一致（⇧⏎）" disabled={f.total === 0} onClick={() => step(-1)}><Icon name="prev" /></button>
      <button type="button" className="tr-find-btn" aria-label="次の一致（⏎）" title="次の一致（⏎）" disabled={f.total === 0} onClick={() => step(1)}><Icon name="next" /></button>
      <button type="button" className="tr-find-btn" aria-label="閉じる（esc）" title="閉じる（esc）" onClick={close}><Icon name="close" /></button>
    </div>
  );
}

export function Transcript(props: { sessionId: string; items: TranscriptItem[]; hasMore: boolean; loading: boolean; follow: boolean; live: boolean; remaining: number; find?: TranscriptFind | null; jump?: JumpState | null; hasNewer?: boolean }) {
  const emit = useEmit();
  const boxRef = useRef<HTMLDivElement>(null);
  // 新着を追う寄せ。ブラウザの滑らかなスクロールは使わない（primitives/glide.ts）。
  // 位置を一気に書き換える所はすべて jumpTo を通し、寄せている途中ならそれを止めてから書き換える。
  const glide = useRef<Glide | null>(null);
  const jumpTo = (el: HTMLElement, top: number) => { glide.current?.stop(); el.scrollTop = top; };
  useEffect(() => () => glide.current?.stop(), []);
  const rowsRef = useRef<HTMLDivElement>(null);
  // 描いてある行の実体と、測れた高さ。高さは seq で覚えるので、行が増えても測り直しにならない。
  const rowEls = useRef(new Map<number, HTMLDivElement>());
  const measured = useRef(new Map<number, number>());
  const [, remeasured] = useReducer((n: number) => n + 1, 0);
  // 器のスクロール位置と高さ。これが変わったときだけ窓を引き直す。
  const [box, setBox] = useState({ top: 0, height: 0, rowsTop: 0 });
  // 行の中で開いたもの（ツールの中身、畳んだ長い本文）。行は窓の外へ出ると DOM から外れるので、ここで覚える。
  const opened = useRef(new Map<string, boolean>());
  const revealed = useRef(new Set<number>());
  const [, reopened] = useReducer((n: number) => n + 1, 0);
  const openStore = useMemo<OpenStore>(() => ({
    get: (seq, part) => opened.current.get(`${seq}:${part}`),
    set: (seq, part, open) => { opened.current.set(`${seq}:${part}`, open); reopened(); },
    revealed: (seq) => revealed.current.has(seq),
  }), []);
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
    if (props.follow && el) jumpTo(el, el.scrollHeight);
  }, [measureBox]);
  useEffect(() => {
    const onResize = () => measureBox();
    window.addEventListener('resize', onResize);
    // 箱の高さは窓の残りで決まる（session.css）。
    // 帯の出入りや右欄の開け閉めでも変わるので、箱そのものも見張る。
    const el = boxRef.current;
    const ro = el && typeof ResizeObserver !== 'undefined' ? new ResizeObserver(onResize) : null;
    if (el) ro?.observe(el);
    return () => { window.removeEventListener('resize', onResize); ro?.disconnect(); };
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
      // その距離なら跳ばし、すぐ近くのときだけ滑らかに寄せる。
      const el = boxRef.current;
      if (!el) return;
      if (el.scrollHeight - el.scrollTop - el.clientHeight > el.clientHeight) jumpTo(el, el.scrollHeight);
      else (glide.current ??= createGlide(el)).toBottom();
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
    // 検索の結果から真ん中の頁だけを読んだときは、その後ろをまだ持っていないので、末尾に着いても追うのに戻さない。
    if (atBottom && !props.follow && props.live && !props.hasNewer) emit({ type: 'transcript.follow', sessionId: props.sessionId, follow: true });
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
      if (changed) { jumpTo(el, el.scrollHeight); moved = true; }
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
        if (Math.abs(el.scrollTop - want) >= 1) { jumpTo(el, want); moved = true; }
      }
    }
    // scrollTop を書き換えても scroll は同じ間に届かないので、ここで測り直して窓を合わせる。
    if (moved) { lastScrollTop.current = el.scrollTop; measureBox(); }
    if (changed) remeasured();
  });

  const setRowEl = (seq: number) => (el: HTMLDivElement | null) => {
    if (el) rowEls.current.set(seq, el); else rowEls.current.delete(seq);
  };

  // この描画の offsets と器の位置。跳ぶ処理と、検索の欄が「いま見ている行」を引くときに使う。
  const layout = useRef({ offsets, rowsTop: box.rowsTop });
  layout.current = { offsets, rowsTop: box.rowsTop };
  const topSeq = useCallback((): number | null => {
    const el = boxRef.current;
    const { offsets: o, rowsTop } = layout.current;
    if (!el || n === 0) return null;
    const top = Math.max(el.scrollTop - rowsTop, 0);
    return props.items[rowWindow(o, top, top).first]?.seq ?? null;
  }, [n, props.items]);

  /**
   * seq の行を器の上から 3 分の 1 のあたりへ送る。追っていたらやめる。
   * 目印もその行に取り直す。取り直さないと、次に高さを測り直したときに前の目印へ引き戻される。
   */
  const scrollToSeq = useCallback((seq: number) => {
    const el = boxRef.current;
    const idx = props.items.findIndex((it) => it.seq === seq);
    if (!el || idx < 0) return;
    const { offsets: o, rowsTop } = layout.current;
    const lead = Math.round(el.clientHeight / 3);
    jumpTo(el, Math.max(o[idx]! + rowsTop - lead, 0));
    lastScrollTop.current = el.scrollTop;
    anchor.current = { seq, delta: Math.max(el.scrollTop - rowsTop, 0) - o[idx]! };
    if (props.follow) emit({ type: 'transcript.follow', sessionId: props.sessionId, follow: false });
    measureBox();
  }, [props.items, props.follow, props.sessionId, emit, measureBox]);

  // 本文の中の検索。今の一致が変わったら、その行の畳んだものを開き、行まで送る。
  const find = props.find && props.find.query !== '' ? props.find : null;
  const findKey = find && find.seq !== null ? `${find.query}|${find.caseSensitive}|${find.from}|${find.step}|${find.n}` : null;
  const lastFindKey = useRef<string | null>(null);
  // 送った後、行が描かれたら今の一致の印まで細かく寄せる。
  const pendingMark = useRef(false);
  useLayoutEffect(() => {
    if (findKey === lastFindKey.current) return;
    lastFindKey.current = findKey;
    if (!find || find.seq === null) return;
    const seq = find.seq;
    // その行で利用者が畳んだものも、一致を見せるために開き直す。
    for (const k of [...opened.current.keys()]) if (k.startsWith(`${seq}:`)) opened.current.delete(k);
    revealed.current.add(seq);
    scrollToSeq(seq);
    pendingMark.current = true;
    reopened();
  });
  // 今の一致の印だけを濃くする。印は描くたびに作り直されるので、毎回付け直す。
  useLayoutEffect(() => {
    const el = boxRef.current;
    if (!el) return;
    for (const m of el.querySelectorAll('mark.cur')) m.classList.remove('cur');
    if (!find || find.seq === null) return;
    const row = rowEls.current.get(find.seq);
    if (!row) return;
    const marks = row.querySelectorAll('mark.hit');
    const m = marks[Math.min(find.ordinal, marks.length - 1)];
    if (!m) return;
    m.classList.add('cur');
    if (!pendingMark.current) return;
    pendingMark.current = false;
    // 行の中の深い所にある一致は、行の頭へ送っただけでは見えないことがある。印そのものを器の 3 分の 1 へ寄せる。
    const r = m.getBoundingClientRect();
    if (r.height <= 0) return;
    const b = el.getBoundingClientRect();
    const d = r.top - b.top - el.clientHeight / 3;
    if (Math.abs(d) < 1) return;
    jumpTo(el, Math.max(el.scrollTop + d, 0));
    lastScrollTop.current = el.scrollTop;
    measureBox();
  });

  // 検索の結果から開いたとき（J1）。一致した行へ跳び、その行の地を淡い黄から薄れさせ、語の印を残す。
  // 抜粋の seq の行が描く行に無ければ（ツールの結果など）、その後ろの最初の行へ跳ぶ。
  const jumpTarget = props.jump ? props.items.find((it) => it.seq >= props.jump!.seq)?.seq ?? null : null;
  const lastJump = useRef<string | null>(null);
  const [flashSeq, setFlashSeq] = useState<number | null>(null);
  useLayoutEffect(() => {
    const j = props.jump;
    if (!j || jumpTarget === null) return;
    const key = `${j.seq}|${j.query}|${j.n}`;
    if (lastJump.current === key) return;
    lastJump.current = key;
    revealed.current.add(jumpTarget);
    scrollToSeq(jumpTarget);
    setFlashSeq(jumpTarget);
  });
  // 光らせるのは 1 度だけ。消し終えたら外す。外さないと、窓の外へ出て戻るたびに光り直す。
  // 光る行は窓の出入りで作り直されるので、行ではなく器で animationend を受ける。
  useEffect(() => {
    const el = boxRef.current;
    if (!el) return;
    const done = (e: Event) => { if ((e.target as Element | null)?.closest?.('.tr-flash')) setFlashSeq(null); };
    el.addEventListener('animationend', done);
    return () => el.removeEventListener('animationend', done);
  }, []);
  const jumpMark: Marking | null = props.jump && props.jump.query ? { query: props.jump.query } : null;
  const marking: Marking | null = find ? { query: find.query, literal: true, caseSensitive: find.caseSensitive } : null;

  // スクロールバーの脇の一致の印。行の上端の位置を、全体の高さに対する割合で置く。
  const ticks = find && find.ticks.length > 0 && total > 0
    ? find.ticks.map((seq) => { const idx = props.items.findIndex((it) => it.seq === seq); return { seq, top: idx < 0 ? 0 : (offsets[idx]! / total) * 100 }; })
    : null;

  return (
    <OpenContext.Provider value={openStore}>
    <HitsContext.Provider value={find ? find.hits : null}>
    <MarkProvider value={marking}>
    <div className="tr-wrap">
      {props.find && <FindBar sessionId={props.sessionId} find={props.find} topSeq={topSeq} />}
      {ticks && <div className="tr-ticks" aria-hidden="true">{ticks.map((t) => <i key={t.seq} style={{ top: `${t.top}%` }} data-cur={t.seq === find!.seq ? 'true' : undefined} />)}</div>}
      <div ref={boxRef} className="tr" onScroll={onScroll}>
        {n === 0 && !props.loading && <div className="empty">本文がありません</div>}
        {/* 押すと過去が前に入るので、ボタンは一覧の上に置く。窓の外にあるので仮想化の対象にしない。 */}
        {props.hasMore && <button className="btn" style={{ alignSelf: 'center' }} disabled={props.loading} onClick={() => emit({ type: 'transcript.loadMore', sessionId: props.sessionId })}>{props.loading ? '読み込んでいます' : `古い行を読み込む（残り ${props.remaining} 件）`}</button>}
        <div ref={rowsRef} className="tr-rows" style={{ paddingTop: padTop, paddingBottom: padBottom }}>
          {drawn.map((it) => (
            <div key={it.seq} className={it.seq === flashSeq ? 'tr-row tr-flash' : 'tr-row'} data-seq={it.seq} ref={setRowEl(it.seq)}>
              {!marking && it.seq === jumpTarget && jumpMark ? <MarkProvider value={jumpMark}>{renderItem(props.sessionId, it)}</MarkProvider> : renderItem(props.sessionId, it)}
            </div>
          ))}
        </div>
        {/* 検索の結果から真ん中の頁だけを読んで開いたときは、後ろ（新しい側）を読み足すボタンを一覧の下に置く。 */}
        {props.hasNewer && <button className="btn" style={{ alignSelf: 'center' }} disabled={props.loading} onClick={() => emit({ type: 'transcript.loadNewer', sessionId: props.sessionId })}>{props.loading ? '読み込んでいます' : '新しい行を読み込む'}</button>}
        {props.live && !props.follow && unseen > 0 && <button className="btn btn-primary new-banner" onClick={() => emit({ type: 'transcript.follow', sessionId: props.sessionId, follow: true })}>新着 {unseen} 件</button>}
      </div>
    </div>
    </MarkProvider>
    </HitsContext.Provider>
    </OpenContext.Provider>
  );
}
