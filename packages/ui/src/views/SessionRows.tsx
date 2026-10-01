import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from 'react';
import { useEmit } from '../intent/chain.tsx';
import type { SessionRowProps } from '../presenters/row.ts';
import { Icon } from './primitives/Icon.tsx';
import { RelativeTime } from './primitives/RelativeTime.tsx';
import { StatusDot } from './primitives/StatusDot.tsx';
import { VirtualList } from './primitives/VirtualList.tsx';

/** 本文が消えた会話の印の説明。行ごとに変わらない決まり文句なので、空の一覧の文言と同じく View に置く。 */
const GONE_LABEL = '要約のみ。本文は Claude Code の保持期間で削除されたとみられます';

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

/** 行を開く Intent。検索の結果の行は、抜粋の一致へ跳ぶ先を添える。 */
const openIntent = (r: SessionRowProps) => (r.jump ? { type: 'session.open' as const, id: r.id, seq: r.jump.seq, q: r.jump.q } : { type: 'session.open' as const, id: r.id });

/**
 * いまのフォーカスを一覧が奪ってはいけないか。
 * 入力欄で打っている最中、ターミナルの中、ダイアログの中にあるフォーカスは、その持ち主のものである。
 * モーダルのダイアログが開いているあいだも奪わない。
 * 起動時の未解決ダイアログのようにフォーカスがまだ body にあっても、裏の一覧が取ると j や Enter で裏の画面が動くからである。
 * ただし一覧そのものがそのダイアログの中にあるなら、それは奪うことにならない。
 */
function holdsFocus(el: Element | null, host: HTMLElement | null): boolean {
  const modal = document.querySelector('[aria-modal="true"]');
  if (modal && !(host && modal.contains(host))) return true;
  if (!(el instanceof HTMLElement)) return false;
  const tag = el.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable) return true;
  return !!el.closest('.term-host, [role="dialog"]');
}

/**
 * セッションの一覧。
 * フォーカスとカーソルは 1 つにまとめる（roving tabindex）。
 * Tab で止まる行はカーソルの行 1 つだけで、打鍵でカーソルを動かすとフォーカスもその行へ移り、行にフォーカスが来るとカーソルもそこへ来る。
 * foot は一覧の末尾（最後の行の下）に置くもの。検索の「さらに読み込む」に使う。
 * autoFocus を渡すと、行が初めて並んだときに一度だけ一覧そのものにフォーカスする（画面に入ってすぐ j や ↓ が効くように）。
 * loadingMore は末尾の続きを読み足している最中であることを表す（検索の「さらに読み込む」）。
 * 読み終えたら、読み足した最初の行へフォーカスを返す。押したボタンが読み込みの間 disabled になり、フォーカスが body へ落ちるからである。
 * id は一覧の器に付ける。Mediator の focus の効果が、この id で一覧を探す（runtime/focusSoon.ts の FOCUS_IDS）。
 */
export function SessionRows(props: { rows: SessionRowProps[]; height: number | string; variant: RowVariant; emptyText?: string; autoFocus?: boolean; foot?: ReactNode; id?: string; loadingMore?: boolean }) {
  const emit = useEmit();
  // カーソルは一覧の中だけの状態なので Mediator には置かない。
  // 行の番号ではなくセッションの id で持つ。
  // 行の DOM は id で付いて動くので、番号で持つと並びが変わったときにフォーカスの行とカーソルの行が食い違い、Enter で別の行が開く。
  // null は未選択で、このとき Enter や o や m は何も起こさない。
  // 選んでいた行が一覧から消えたときも未選択に戻る。
  const [cursorId, setCursorId] = useState<string | null>(null);
  const cursor = cursorId === null ? -1 : props.rows.findIndex((r) => r.id === cursorId);
  // 編集中のセッションの id。null なら編集していない。
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState('');

  const hostRef = useRef<HTMLDivElement>(null);
  // 打鍵でカーソルを動かしたときだけ、フォーカスをその行へ運ぶ。
  // 行の中のボタンへ Tab で入ったときもカーソルは動くが、そのときにフォーカスを行へ引き戻してはいけない。
  const byKey = useRef(false);
  const cursorRow = () => hostRef.current?.querySelector<HTMLElement>('[data-cursor="true"]') ?? null;

  // 仮想リストは画面の外の行を描かないので、カーソルが可視範囲を出たら見える位置まで運ぶ。
  // これをしないと、見えていない行が選ばれたまま Enter で開けてしまう。
  useEffect(() => {
    if (cursorId === null) return;
    const el = cursorRow();
    // jsdom のように scrollIntoView を持たない環境では何もしない。
    if (el && typeof el.scrollIntoView === 'function') el.scrollIntoView({ block: 'nearest' });
    if (el && byKey.current) el.focus({ preventScroll: true });
    byKey.current = false;
  }, [cursorId]);

  // 画面に入ったら一覧にフォーカスする。行が後から届く画面もあるので、初めて並んだときに一度だけ当てる。
  // 行はまだ選ばない。最初の j や ↓ で先頭の行に入る。
  const autoPending = useRef(!!props.autoFocus);
  const hasRows = props.rows.length > 0;
  useEffect(() => {
    if (!autoPending.current || !hasRows) return;
    autoPending.current = false;
    if (!holdsFocus(document.activeElement, hostRef.current)) hostRef.current?.focus({ preventScroll: true });
  }, [hasRows]);

  // 読み足しを始めたときの行の数。続きはその後ろに足されるので、読み終えたらこの位置の行が読み足した最初の行になる。
  // 読み足しの間も持っている行は消えない（runtime の search.more）。
  const moreFrom = useRef<number | null>(null);
  const rowsLen = props.rows.length;
  useEffect(() => {
    if (props.loadingMore) { moreFrom.current = rowsLen; return; }
    const from = moreFrom.current;
    moreFrom.current = null;
    if (from === null) return;
    // フォーカスが落ちた（body にある）か、末尾のボタンに残っているときだけ返す。ほかへ移したフォーカスは奪わない。
    const host = hostRef.current;
    const a = document.activeElement;
    const lost = !a || a === document.body || (!!host && host.contains(a) && a !== host && !a.closest('[role="row"]'));
    if (!lost || !host) return;
    const next = props.rows[from];
    if (!next) { host.focus({ preventScroll: true }); return; }
    if (next.id === cursorId) { cursorRow()?.focus({ preventScroll: true }); return; }
    byKey.current = true;
    setCursorId(next.id);
  }, [props.loadingMore]);   // eslint-disable-line react-hooks/exhaustive-deps

  const startEdit = (r: SessionRowProps) => { setEditing(r.id); setDraft(r.memo ?? ''); };
  // Enter と Esc で編集を終えたら、フォーカスを行へ戻す。入力欄が消えると、フォーカスの行き場が無くなるからである。
  const requestFocusBack = useRef(false);
  const endEdit = () => { setEditing(null); requestFocusBack.current = true; };
  useEffect(() => {
    if (editing !== null || !requestFocusBack.current) return;
    requestFocusBack.current = false;
    cursorRow()?.focus({ preventScroll: true });
  }, [editing]);
  const commit = (id: string) => { emit({ type: 'session.setMemo', id, text: draft }); endEdit(); };

  const onKeyDown = (e: ReactKeyboardEvent) => {
    // 編集中の入力欄から上がってきたキーは横取りしない。
    if (editing !== null) return;
    // 行の中のボタンやリンクの打鍵は、その部品のものである。Enter で行まで開くと二重になる。
    if (e.target !== e.currentTarget && (e.target as HTMLElement).getAttribute('role') !== 'row') return;
    // ⌘ や Ctrl の付いた打鍵はアプリ全体のもの（⌘K や ⌘J）なので、一覧では使わない。
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const max = props.rows.length - 1;
    const cur = cursor >= 0 ? props.rows[cursor] : undefined;
    const moveTo = (i: number) => { byKey.current = true; setCursorId(props.rows[i]?.id ?? null); };
    switch (e.key) {
      case 'j': case 'ArrowDown': moveTo(Math.min(max, cursor + 1)); break;
      case 'k': case 'ArrowUp': moveTo(Math.max(0, cursor - 1)); break;
      case 'Enter': if (cur) emit(openIntent(cur)); break;
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
        else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); endEdit(); }
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
      {/* 本文の期限。消えかけは琥珀のチップで先に知らせ、消えた会話は文字の無い印だけにする。
          消えた会話は数百件に上るので、文字を並べると一覧が騒がしくなる。 */}
      <span className="row-when">
        {r.transcript === 'expiring' && <span className="row-soon">まもなく削除</span>}
        {r.transcript === 'gone' && <span className="row-gone" title={GONE_LABEL}><Icon name="transcriptGone" label={GONE_LABEL} /></span>}
        <RelativeTime label={r.when} abs={r.whenAbs} />
      </span>
    </span>
  );

  // Tab で止まる行。まだ選んでいなければ先頭の行にする。
  const tabStop = cursor >= 0 && cursor < props.rows.length ? cursor : 0;
  // 器は Tab の順には入れず（tabIndex=-1）、画面に入ったときのフォーカスの受け皿にだけ使う。
  // 行の打鍵はここへ上がってきて、カーソルの行について 1 度だけ処理する。
  return (
    <div className="rows-host" id={props.id} data-testid="session-rows" ref={hostRef} tabIndex={-1} onKeyDown={onKeyDown}>
      <VirtualList items={props.rows} rowHeight={SESSION_ROW_H} height={props.height} keyOf={(r) => r.id} foot={props.foot} render={(r, i) => (
        <div className="row row-2" role="row" tabIndex={i === tabStop ? 0 : -1} data-cursor={i === cursor ? 'true' : undefined} data-morph-id={r.id}
          onClick={() => emit(openIntent(r))} onFocus={() => setCursorId(r.id)}>
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
