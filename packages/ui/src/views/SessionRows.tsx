import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { useEmit } from '../intent/chain.tsx';
import type { SessionRowProps } from '../presenters/row.ts';
import { Icon } from './primitives/Icon.tsx';
import { RelativeTime } from './primitives/RelativeTime.tsx';
import { StatusDot } from './primitives/StatusDot.tsx';
import { VirtualList } from './primitives/VirtualList.tsx';

/** 2 段の行の高さ。tokens.css の --session-row-h と同じ値にする（styles/rows.test.ts が突き合わせる）。 */
export const SESSION_ROW_H = 56;

/**
 * 一覧の役目。右端と 2 段目に何を出すかがこれで決まる。
 * recent は Home の最近（右は時刻だけ）。
 * project はプロジェクト詳細（右にモデル、変更、PR、コストと時刻。2 段目にメモ）。
 * search は Sessions（1 段目にプロジェクト名、2 段目に一致箇所の抜粋）。
 */
export type RowVariant = 'recent' | 'project' | 'search';

/** 行が無いときに出す文言。emptyText で差し替えられる。 */
const DEFAULT_EMPTY_TEXT = 'セッションはまだありません';

export function SessionRows(props: { rows: SessionRowProps[]; height: number | string; variant: RowVariant; emptyText?: string }) {
  const emit = useEmit();
  // カーソルは一覧の中だけの状態なので Mediator には置かない。
  // -1 は未選択で、このとき Enter や o や m は何も起こさない。
  const [cursor, setCursor] = useState(-1);
  // 編集中のセッションの id。null なら編集していない。
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState('');

  const hostRef = useRef<HTMLDivElement>(null);

  // 仮想リストは画面の外の行を描かないので、カーソルが可視範囲を出たら見える位置まで運ぶ。
  // これをしないと、見えていない行が選ばれたまま Enter で開けてしまう。
  useEffect(() => {
    if (cursor < 0) return;
    const el = hostRef.current?.querySelector('[data-cursor="true"]');
    // jsdom のように scrollIntoView を持たない環境では何もしない。
    if (el && typeof el.scrollIntoView === 'function') el.scrollIntoView({ block: 'nearest' });
  }, [cursor]);

  const startEdit = (r: SessionRowProps) => { setEditing(r.id); setDraft(r.memo ?? ''); };
  const commit = (id: string) => { emit({ type: 'session.setMemo', id, text: draft }); setEditing(null); };

  const onKeyDown = (e: ReactKeyboardEvent) => {
    // 編集中の入力欄から上がってきたキーは横取りしない。
    if (editing !== null) return;
    const max = props.rows.length - 1;
    const cur = props.rows[cursor];
    switch (e.key) {
      case 'j': setCursor((c) => Math.min(max, c + 1)); break;
      case 'k': setCursor((c) => Math.max(0, c - 1)); break;
      case 'Enter': if (cur) emit({ type: 'session.open', id: cur.id }); break;
      case 'o': if (cur?.runId) emit({ type: 'session.openTerminalApp', runId: cur.runId }); break;
      case 'e': if (cur) emit({ type: 'session.openEditor', sessionId: cur.id }); break;
      case 'm': if (cur) startEdit(cur); break;
      default: return;
    }
    e.preventDefault();
  };

  if (props.rows.length === 0) return <div className="list"><div className="empty">{props.emptyText ?? DEFAULT_EMPTY_TEXT}</div></div>;

  const memoEditor = (r: SessionRowProps) => (
    <input className="input memo-input" autoFocus aria-label={`${r.name} のメモ`} value={draft} onChange={(e) => setDraft(e.target.value)} onClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        // 入力欄のキーは行にも一覧にも渡さない。
        if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); commit(r.id); }
        else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); setEditing(null); }
        else e.stopPropagation();
      }}
      onBlur={() => setEditing(null)} />
  );

  // 2 段目。検索は一致箇所の抜粋を、ほかは要約の 1 文を出す。プロジェクト詳細はその後ろにメモと鉛筆を置く。
  const sub = (r: SessionRowProps) => {
    if (editing === r.id) return <span className="row-sub">{memoEditor(r)}</span>;
    const excerpt = props.variant === 'search' && r.excerpt && r.excerpt.length > 0 ? r.excerpt : null;
    return (
      <span className="row-sub">
        <span className={excerpt ? 'row-text mono' : 'row-text'}>{excerpt ? excerpt.map((s, i) => (s.hit ? <mark key={i} className="hit">{s.text}</mark> : <span key={i}>{s.text}</span>)) : r.oneLiner}</span>
        {props.variant === 'project' && r.memo && <span className="row-memo">✎ {r.memo}</span>}
        {props.variant === 'project' && <button type="button" className="btn memo-pencil" aria-label={`${r.name} のメモを編集`} onClick={(e) => { e.stopPropagation(); startEdit(r); }}><Icon name="edit" /></button>}
      </span>
    );
  };

  // 右端。プロジェクト詳細はモデル、変更、PR、コストの小さな 1 行を時刻の上に置く。ほかは時刻だけ。
  const side = (r: SessionRowProps) => (
    <span className="row-side">
      {props.variant === 'project' && (
        <span className="row-meta">
          {r.model && <span className="mono">{r.model}{r.effort ? ` · ${r.effort}` : ''}</span>}
          {r.filesChanged > 0 && <span>変更 {r.filesChanged}</span>}
          {r.prUrl && <a href={r.prUrl} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()}>PR</a>}
          {r.cost && <span className="mono">{r.cost}</span>}
        </span>
      )}
      <RelativeTime label={r.when} abs={r.whenAbs} />
    </span>
  );

  return (
    <div className="rows-host" data-testid="session-rows" ref={hostRef} tabIndex={0} onKeyDown={onKeyDown}>
      <VirtualList items={props.rows} rowHeight={SESSION_ROW_H} height={props.height} keyOf={(r) => r.id} render={(r, i) => (
        <div className="row row-2" role="row" tabIndex={0} data-cursor={i === cursor ? 'true' : undefined} data-morph-id={r.id}
          onClick={() => emit({ type: 'session.open', id: r.id })} onKeyDown={(e) => { if (e.key === 'Enter') emit({ type: 'session.open', id: r.id }); }}>
          <StatusDot status={r.live} />
          <span className="row-main">
            <span className="row-name">{r.name}{props.variant === 'search' && <span className="row-proj">{r.projectName ?? '未分類'}</span>}</span>
            {sub(r)}
          </span>
          {side(r)}
        </div>
      )} />
    </div>
  );
}
