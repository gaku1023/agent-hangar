import { useEffect, useLayoutEffect, useRef, type ReactNode } from 'react';
import { useEmit } from '../intent/chain.tsx';
import type { TurnJumpStatus } from '../mediator/types.ts';
import type { TranscriptItem, TurnRowProps } from '../presenters/session.ts';
import { jumpWindow } from '../presenters/turns.ts';
import { Icon } from './primitives/Icon.tsx';
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
  mode: 'ターミナルを transcript に切り替えられませんでした',
  failed: 'ターミナルを動かせませんでした',
};

/** 1 行目だけを行に出す。全文は title で読める。 */
const firstLine = (s: string) => s.split('\n').find((l) => l.trim() !== '') ?? '';

/**
 * 実行中のセッションの右欄。利用者の指示を 1 行ずつ並べた目次で、押したターンだけ中身を開く。
 * 会話の全文は左のターミナルと重なるので流さない。開いたターンへは左のターミナルも跳ぶ。
 */
export function TurnIndex(props: TurnIndexProps) {
  const emit = useEmit();
  const listRef = useRef<HTMLDivElement>(null);
  const openRef = useRef<HTMLDivElement>(null);
  const openSeq = props.rows.find((r) => r.open)?.seq ?? null;
  const lastSeq = props.rows.length > 0 ? props.rows[props.rows.length - 1]!.seq : null;

  // 何も開いていない間は末尾（いちばん新しい指示）を見せ続ける。新しい指示が来たら下へついていく。
  useLayoutEffect(() => {
    const el = listRef.current;
    if (el && openSeq === null) el.scrollTop = el.scrollHeight;
  }, [lastSeq, openSeq]);
  // 開いたターンは中身ごと見える位置へ寄せる。jsdom には scrollIntoView が無いので、あるときだけ呼ぶ。
  useEffect(() => { openRef.current?.scrollIntoView?.({ block: 'nearest' }); }, [openSeq]);

  const open = (i: number) => {
    const row = props.rows[i]!;
    const jump = props.runId && !row.open ? jumpWindow(props.rows.map((r) => r.head), i, props.complete) : null;
    emit({ type: 'turn.open', sessionId: props.sessionId, seq: row.seq, runId: jump ? props.runId : null, jump });
  };
  const note = props.turnJump && props.turnJump.seq === openSeq ? JUMP_NOTE[props.turnJump.status] : undefined;

  return (
    <div className="turns">
      <div className="turns-head">
        {props.lead}
        <span className="faint">ターン {props.rows.length}{props.hasMore ? '+' : ''}</span>
        {props.agentId && <><span className="faint">・サブエージェント {props.agentId}</span><button className="btn btn-sm" onClick={() => emit({ type: 'transcript.selectAgent', sessionId: props.sessionId, agentId: null })}>主線に戻る</button></>}
      </div>
      <div ref={listRef} className="turns-list">
        {props.hasMore && <button className="btn turns-more" disabled={props.loading} onClick={() => emit({ type: 'transcript.loadMore', sessionId: props.sessionId })}>{props.loading ? '読み込んでいます' : `古いターンを読み込む（残り ${props.remaining} 件）`}</button>}
        {props.rows.length === 0 && !props.loading && <div className="empty">まだ指示がありません</div>}
        {props.rows.map((r, i) => (
          <div key={r.seq} ref={r.open ? openRef : undefined} className="turn" data-open={r.open ? 'true' : undefined}>
            <button className="turn-row" aria-expanded={r.open} title={r.text} onClick={() => open(i)}>
              <span className="turn-when mono">{r.when}</span>
              <span className="turn-text">{firstLine(r.text)}</span>
              {r.tools > 0 && <span className="turn-tools mono">{r.tools}</span>}
            </button>
            {r.band.length > 0 && <div className="turn-band" aria-hidden="true">{r.band.map((k, i) => <i key={i} data-k={k} />)}</div>}
            {r.open && (
              <div className="turn-body">
                {note && <div className="turn-note">{note}</div>}
                {/* 指示そのものは行に出ているので、中身は返答から並べる。 */}
                {props.openItems.filter((it) => it.seq !== r.seq).map((it) => <div key={it.seq} className="tr-row">{renderItem(props.sessionId, it)}</div>)}
              </div>
            )}
          </div>
        ))}
      </div>
      <div className="turns-foot">
        <button className="btn" onClick={() => { emit({ type: 'turn.latest', sessionId: props.sessionId, runId: props.runId }); const el = listRef.current; if (el) el.scrollTop = el.scrollHeight; }}><Icon name="latest" />最新へ</button>
      </div>
    </div>
  );
}
