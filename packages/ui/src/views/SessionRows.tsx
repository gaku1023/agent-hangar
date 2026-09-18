import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { useEmit } from '../intent/chain.tsx';
import type { SessionRowProps } from '../presenters/row.ts';
import { Icon } from './primitives/Icon.tsx';
import { RelativeTime } from './primitives/RelativeTime.tsx';
import { StatusDot } from './primitives/StatusDot.tsx';
import { VirtualList } from './primitives/VirtualList.tsx';

const cols = (showProject: boolean) => `16px minmax(160px, 1.2fr) minmax(200px, 2fr) ${showProject ? '120px ' : ''}72px 110px 48px 32px 64px minmax(120px, 1fr) 80px`;

/** 行が無いときに出す文言。emptyText で差し替えられる。 */
const DEFAULT_EMPTY_TEXT = 'セッションはまだありません';

export function SessionRows(props: { rows: SessionRowProps[]; height: number | string; showProject: boolean; showSnippets?: boolean; emptyText?: string }) {
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
  const style = { gridTemplateColumns: cols(props.showProject) };
  const head = (
    <div className="row row-head" style={style} role="row">
      <span /><span>名前</span><span>要約</span>{props.showProject && <span>プロジェクト</span>}<span>状態</span><span>モデル</span><span className="cell-right">変更</span><span>PR</span><span className="cell-right">コスト</span><span>メモ</span><span className="cell-right">最終活動</span>
    </div>
  );
  const rowHeight = (r: SessionRowProps) => 28 + (props.showSnippets ? (r.snippets?.length ?? 0) * 20 : 0);
  return (
    <div className="rows-host" data-testid="session-rows" ref={hostRef} tabIndex={0} onKeyDown={onKeyDown}>
      <VirtualList items={props.rows} rowHeight={(r) => rowHeight(r)} height={props.height} keyOf={(r) => r.id} head={head} render={(r, i) => (
        <div style={{ height: rowHeight(r) }}>
          <div className="row" style={style} role="row" tabIndex={0} data-cursor={i === cursor ? 'true' : undefined}
            onClick={() => emit({ type: 'session.open', id: r.id })} onKeyDown={(e) => { if (e.key === 'Enter') emit({ type: 'session.open', id: r.id }); }}>
            <StatusDot status={r.live} />
            <span className="cell">{r.name}</span>
            <span className="cell muted">{r.oneLiner}</span>
            {props.showProject && <span className="cell muted">{r.projectName ?? '未分類'}</span>}
            <span className="cell muted">{r.stateLabel}</span>
            <span className="cell mono">{r.model}{r.effort ? ` · ${r.effort}` : ''}</span>
            <span className="cell mono cell-right">{r.filesChanged || ''}</span>
            <span className="cell">{r.prUrl ? <a href={r.prUrl} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()}>PR</a> : ''}</span>
            <span className="cell mono cell-right">{r.cost}</span>
            <span className="cell memo-cell" onClick={(e) => e.stopPropagation()}>
              {editing === r.id
                ? <input className="input memo-input" autoFocus aria-label={`${r.name} のメモ`} value={draft} onChange={(e) => setDraft(e.target.value)}
                    onKeyDown={(e) => {
                      // 入力欄のキーは行にも一覧にも渡さない。
                      if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); commit(r.id); }
                      else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); setEditing(null); }
                      else e.stopPropagation();
                    }}
                    onBlur={() => setEditing(null)} />
                : <><span className="muted">{r.memo ?? ''}</span><button type="button" className="btn memo-pencil" aria-label={`${r.name} のメモを編集`} onClick={() => startEdit(r)}><Icon name="edit" /></button></>}
            </span>
            <span className="cell cell-right"><RelativeTime label={r.when} abs={r.whenAbs} /></span>
          </div>
          {props.showSnippets && r.snippets?.map((s) => <div key={s.seq} className="mono faint" style={{ height: 20, padding: '0 12px 0 40px', overflow: 'hidden', whiteSpace: 'nowrap', textOverflow: 'ellipsis' }}>{s.text}</div>)}
        </div>
      )} />
    </div>
  );
}
