import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from 'react';
import { useEmit } from '../intent/chain.tsx';
import type { TurnJumpStatus } from '../mediator/types.ts';
import type { TranscriptItem, TurnRowProps } from '../presenters/session.ts';
import { jumpWindow } from '../presenters/turns.ts';
import { Icon } from './primitives/Icon.tsx';
import { collapseOut, growIn, motionOn } from './primitives/motionKit.ts';
import { revealWithin } from './primitives/revealWithin.ts';
import { RollingText } from './primitives/RollingText.tsx';
import { useMotionList } from './primitives/useMotionList.ts';
import { renderItem } from './Transcript.tsx';

export type TurnIndexProps = {
  sessionId: string;
  /** 生きている run。あれば、開いたターンへ左の Claude のタブも跳ばす。 */
  runId: string | null;
  rows: TurnRowProps[];
  /** 会話の最初の指示まで読み込んでいるか。先頭から数えてよいかがこれで決まる。 */
  complete: boolean;
  openItems: TranscriptItem[];
  turnJump: { seq: number; status: TurnJumpStatus } | null;
  hasMore: boolean; loading: boolean; remaining: number;
  agentId: string | null;
  /** 見出しの行の先頭に置くもの。右欄を畳むボタンが入る。 */
  lead?: ReactNode;
};

/** 跳ばした結果の言い方。着いたときと待っている間は何も言わない。 */
const JUMP_NOTE: Partial<Record<TurnJumpStatus, string>> = {
  notFound: 'ターミナルでは見つかりませんでした',
  mode: 'ターミナルの表示を切り替えられませんでした',
  failed: 'ターミナルを動かせませんでした',
};

/** 1 行目だけを行に出す。全文は title で読める。 */
const firstLine = (s: string) => s.split('\n').find((l) => l.trim() !== '') ?? '';

/**
 * 実行中のセッションの右欄。利用者の指示を 1 行ずつ並べた目次で、押したターンだけ中身を開く。
 * 会話の全文は左のターミナルと重なるので流さない。開いたターンへは左のターミナルも跳ぶ。
 * キーでは ↑ ↓ と k j で行を移り、Enter で開く。
 * Tab で止まる行は 1 つだけにする（roving tabindex）。既定は開いている行、無ければいちばん新しい指示である。
 */
export function TurnIndex(props: TurnIndexProps) {
  const emit = useEmit();
  const listRef = useRef<HTMLDivElement>(null);
  const openRef = useRef<HTMLDivElement | null>(null);
  const openSeq = props.rows.find((r) => r.open)?.seq ?? null;
  const lastSeq = props.rows.length > 0 ? props.rows[props.rows.length - 1]!.seq : null;

  // 同じ seq が別のものを指す範囲。セッションとサブエージェントが替わる描画は、切り替えとして動かさない。
  const scope = `${props.sessionId}:${props.agentId ?? ''}`;
  // 行の出入り。古いものの読み込み（先頭への足し）は動かさない。
  // 並びの滑りは使わない（新しい指示は末尾に足すだけで、残りの行は動かない）。
  const { list: entries, ref: rowRef } = useMotionList(props.rows, (r) => String(r.seq), { enter: 'rise', flip: false, ignorePrepended: true, scope });

  // 何も開いていない間は末尾（いちばん新しい指示）を見せ続ける。新しい指示が来たら下へついていく。
  // 初回と動かない環境ではすぐ、そのあとは滑らかに追う。
  const followed = useRef(false);
  useLayoutEffect(() => {
    const el = listRef.current;
    if (!el || openSeq !== null) return;
    const smooth = followed.current && motionOn(el) && typeof el.scrollTo === 'function';
    if (smooth) el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
    else el.scrollTop = el.scrollHeight;
    if (props.rows.length > 0) followed.current = true;
  }, [lastSeq, openSeq]);

  // 閉じたターンの中身の控え。畳んで出る動きの間だけ描く。
  // 控えは毎回の描画の後で更新する（中身は開いたあとに読み込まれて届くので、開いた瞬間の値では足りない）。
  type OpenBody = { seq: number; items: TranscriptItem[] };
  const lastOpen = useRef<OpenBody | null>(null);
  const [closing, setClosing] = useState<OpenBody | null>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const closingRef = useRef<HTMLDivElement>(null);
  const lastScope = useRef(scope);
  const prevRows = useRef(0);
  // 伸びて入る動き。開いたターンの寄せは、これが終わったあとの大きさで行う。
  const growing = useRef<Animation | null>(null);
  useLayoutEffect(() => {
    growing.current = null;
    // セッションやサブエージェントが替わったら、前の控えは捨てる（別のものの中身を畳まない）。
    if (lastScope.current !== scope) {
      lastScope.current = scope;
      lastOpen.current = null;
      setClosing(null);
      return;
    }
    const was = lastOpen.current;
    if (was && was.seq !== openSeq && motionOn()) setClosing(was);
    // 最初の描画で開いていたターンと、空から埋まった描画で開いていたターンは、新しい出来事ではないので伸ばさない。
    if (prevRows.current > 0 && openSeq !== null && was?.seq !== openSeq && bodyRef.current) growing.current = growIn(bodyRef.current);
  }, [openSeq, scope]);
  useLayoutEffect(() => {
    lastOpen.current = openSeq === null ? null : { seq: openSeq, items: props.openItems };
    prevRows.current = props.rows.length;
  });
  useLayoutEffect(() => {
    if (!closing) return;
    // 描く先の行が無い（消えた、開き直した）なら、畳むものが無いので控えを捨てる。
    if (!closingRef.current) { setClosing(null); return; }
    let alive = true;
    void collapseOut(closingRef.current).then(() => { if (alive) setClosing(null); });
    return () => { alive = false; };
  }, [closing]);

  // 開いたターンは中身ごと見える位置へ寄せる。動かすのは目次の一覧だけにする。
  // scrollIntoView は WebKit で外側の箱（アプリ全体）までずらし、手で戻せなくなる。
  // 伸びて入る間は、伸び切ったあとの大きさで寄せる（伸びる前に測ると、中身が下へはみ出す）。
  useEffect(() => {
    const list = listRef.current;
    const item = openSeq === null ? null : openRef.current;
    if (!list || !item) return;
    const grow = growing.current;
    growing.current = null;
    if (!grow) { revealWithin(list, item); return; }
    let alive = true;
    void grow.finished.then(() => { if (alive) revealWithin(list, item); }, () => {});
    return () => { alive = false; };
  }, [openSeq]);

  const open = (i: number) => {
    const row = props.rows[i]!;
    const jump = props.runId && !row.open ? jumpWindow(props.rows.map((r) => r.head), i, props.complete) : null;
    emit({ type: 'turn.open', sessionId: props.sessionId, seq: row.seq, runId: jump ? props.runId : null, jump });
  };
  const note = props.turnJump && props.turnJump.seq === openSeq ? JUMP_NOTE[props.turnJump.status] : undefined;

  // 最後にフォーカスした行。キーで移った先を、次に Tab で戻ってきたときの止まり先にする。
  const [focusSeq, setFocusSeq] = useState<number | null>(null);
  const stopSeq = props.rows.some((r) => r.seq === focusSeq) ? focusSeq : openSeq ?? lastSeq;
  const onRowKey = (e: ReactKeyboardEvent, i: number) => {
    // ⌘ の付いた打鍵はアプリ全体のもの（⌘← で戻るなど）なので、目次では使わない。
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const to = e.key === 'ArrowDown' || e.key === 'j' ? i + 1 : e.key === 'ArrowUp' || e.key === 'k' ? i - 1 : null;
    if (to !== null) {
      // 端で止まっても、矢印で一覧がスクロールしないように既定の動きは止める。
      e.preventDefault();
      // 畳んで出る途中の行（disabled）は飛ばす。
      const rowsNow = [...(listRef.current?.querySelectorAll<HTMLElement>('.turn-row:not(:disabled)') ?? [])];
      rowsNow[rowsNow.indexOf(e.currentTarget as HTMLElement) + (to - i)]?.focus();
      return;
    }
    // ボタンの既定の Enter はクリックを起こす。ここで開いて既定を止め、二重に出さない。
    if (e.key === 'Enter') { e.preventDefault(); open(i); }
  };

  return (
    <div className="turns">
      <div className="turns-head">
        {props.lead}
        <span className="faint">ターン <RollingText text={`${props.rows.length}${props.hasMore ? '+' : ''}`} /></span>
        {props.agentId && <><span className="faint">・サブエージェント {props.agentId}</span><button className="btn btn-sm" onClick={() => emit({ type: 'transcript.selectAgent', sessionId: props.sessionId, agentId: null })}>主線に戻る</button></>}
      </div>
      <div ref={listRef} className="turns-list">
        {props.hasMore && <button className="btn turns-more" disabled={props.loading} onClick={() => emit({ type: 'transcript.loadMore', sessionId: props.sessionId })}>{props.loading ? '読み込んでいます' : `古いターンを読み込む（残り ${props.remaining} 件）`}</button>}
        {props.rows.length === 0 && !props.loading && <div className="empty">まだ指示がありません</div>}
        {entries.map(({ item: r, key, leaving }) => {
          const i = props.rows.indexOf(r);
          const isOpen = r.open && !leaving;
          const bodyItems = (items: TranscriptItem[]) => items.filter((it) => it.seq !== r.seq).map((it) => <div key={it.seq} className="tr-row">{renderItem(props.sessionId, it)}</div>);
          return (
            <div key={key} ref={(el) => { rowRef(key)(el); if (isOpen) openRef.current = el; }} className="turn" data-open={isOpen ? 'true' : undefined} aria-hidden={leaving ? 'true' : undefined}>
              <button className="turn-row" aria-expanded={isOpen} title={r.text} tabIndex={!leaving && r.seq === stopSeq ? 0 : -1} disabled={leaving}
                onClick={() => open(i)} onFocus={() => setFocusSeq(r.seq)} onKeyDown={(e) => onRowKey(e, i)}>
                <span className="turn-when mono">{r.when}</span>
                <span className="turn-text">{firstLine(r.text)}</span>
                {r.tools > 0 && <span className="turn-tools mono">{r.tools}</span>}
              </button>
              {r.band.length > 0 && <div className="turn-band" aria-hidden="true">{r.band.map((k, j) => <i key={j} data-k={k} />)}</div>}
              {isOpen && (
                <div ref={bodyRef} className="turn-body">
                  {note && <div className="turn-note">{note}</div>}
                  {/* 指示そのものは行に出ているので、中身は返答から並べる。 */}
                  {bodyItems(props.openItems)}
                </div>
              )}
              {!isOpen && closing?.seq === r.seq && (
                <div ref={closingRef} className="turn-body" aria-hidden="true">{bodyItems(closing.items)}</div>
              )}
            </div>
          );
        })}
      </div>
      <div className="turns-foot">
        <button className="btn" onClick={() => { emit({ type: 'turn.latest', sessionId: props.sessionId, runId: props.runId }); const el = listRef.current; if (el) el.scrollTop = el.scrollHeight; }}><Icon name="latest" />最新へ</button>
      </div>
    </div>
  );
}
