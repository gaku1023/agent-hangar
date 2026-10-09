import { useEffect, useLayoutEffect, useRef, useState, type FocusEvent as ReactFocusEvent, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent as ReactMouseEvent, type ReactNode } from 'react';
import type { Intent, SessionStatus, StatusFilter } from '@agent-hangar/shared';
import { useEmit, type Emit } from '../intent/chain.tsx';
import { ACTIVE_LABEL, CANDIDATE_SOURCE_LABEL, candidateLabel, candidateShortLabel, prNumberOf, returnOnLabel, returnOnRowLabel, STATUS_LABEL, type SessionRowProps } from '../presenters/row.ts';
import type { ListItem, SectionId } from '../presenters/sections.ts';
import { Icon } from './primitives/Icon.tsx';
import { useT } from './primitives/language.tsx';
import { MenuButton, type MenuCloseHow, type MenuItem } from './primitives/MenuButton.tsx';
import { RelativeTime } from './primitives/RelativeTime.tsx';
import { StatusDot } from './primitives/StatusDot.tsx';
import { VirtualList } from './primitives/VirtualList.tsx';

/** 本文が消えた会話の印の説明。行ごとに変わらない決まり文句なので、空の一覧の文言と同じく View に置く。 */
const GONE_LABEL = '要約のみ。本文は Claude Code の保持期間で削除されたとみられます';
/** 会話の中で利用者が選んだ状態（set_by が conversation）の札の注記。hangar は会話での承認を確かめられないので、後から分かるようにする。 */
const CONVERSATION_NOTE = '会話で承認';
/**
 * 動きの語。入力待ちと実行中だけを語にし、止まっているものは点だけにする。
 * 休みは実行中に数える（shared の liveFilterOf と同じ）。細かい区別は点が読み上げるので、語は読み上げに重ねない。
 */
const LIVE_WORD = { waiting: '入力待ち', busy: '実行中', idle: '実行中' } as const;

/**
 * 行の中の操作の器のクリックを止める。止めないと、押したときに行も開く。
 * メニューは document.body への portal に描くが、React のイベントは portal の中からも React の木を伝ってここへ上がるので、項目のクリックもここで止まる。
 */
const stopClick = (e: ReactMouseEvent) => e.stopPropagation();

/** 「⋯」の 4 択（A2）。打鍵の印は試作 rest.html の A2 のとおり。付いている状態と、外すものの無い「Active に戻す」は理由を添えて押せなくする。 */
function stateItems(r: SessionRowProps, emit: Emit): MenuItem[] {
  const set = (status: SessionStatus | null) => () => emit({ type: 'session.state.set', id: r.id, status });
  return [
    { key: 'paused', label: 'Paused にする…', kbd: 'p', onSelect: () => emit({ type: 'session.pause.open', id: r.id, from: 'menu' }) },
    { key: 'done', label: 'Done にする', kbd: 'd', disabled: r.state === 'done' ? 'すでに Done です' : null, onSelect: set('done') },
    { key: 'archived', label: 'Archived にする', kbd: 'a', disabled: r.state === 'archived' ? 'すでに Archived です' : null, onSelect: set('archived') },
    { key: 'active', label: 'Active に戻す', kbd: 'u', disabled: r.state === null && r.candidate === null ? 'すでに Active です' : null, onSelect: set(null) },
  ];
}

/**
 * 提案の札（Q3 の枠だけの札）と、押すと開くポップ（Q1）。
 * ポップの頭に根拠の一文、出どころ、時刻を置き、項目は 確定・日を変える（Paused のみ）・却下。打鍵の印は Q1 の試作のとおり y と n。
 * onClose は閉じたときにフォーカスを行へ戻すために呼び側から受ける（札は確定・却下で消えるので）。
 */
function candidatePop(r: SessionRowProps, emit: Emit, onClose: (how: MenuCloseHow) => void) {
  const c = r.candidate!;
  const items: MenuItem[] = [
    { key: 'confirm', label: '確定', kbd: 'y', onSelect: () => emit({ type: 'session.state.confirm', id: r.id }) },
    ...(c.status === 'paused' ? [{ key: 'date', label: '日を変える', kbd: 'c', onSelect: () => emit({ type: 'session.pause.open', id: r.id, from: 'candidate' }) }] : []),
    { key: 'reject', label: '却下', kbd: 'n', onSelect: () => emit({ type: 'session.state.reject', id: r.id }) },
  ];
  const head = (
    <>
      <b className="menu-head-q">{c.status === 'done' ? 'Done にしますか' : `Paused · ${c.returnOn ? returnOnLabel(c.returnOn, null, c.returnTime) : '日付なし'} にしますか`}</b>
      <span>{c.note ?? '根拠は書かれていません'}</span>
      <small>出どころ：{CANDIDATE_SOURCE_LABEL[c.source]} · {c.ago}</small>
    </>
  );
  return <MenuButton label={`${r.name} への Claude の提案`} face={candidateShortLabel(c)} title={candidateLabel(c)} faceClassName="row-cand" items={items} head={head} minWidth={260} onClose={onClose} />;
}

/** 2 段の行の高さ。tokens.css の --session-row-h と同じ値にする（styles/rows.test.ts が突き合わせる）。 */
export const SESSION_ROW_H = 56;
/** 節の見出しの高さ。tokens.css の --section-head-h と同じ値にする（styles/rows.test.ts が突き合わせる）。 */
export const SECTION_HEAD_H = 32;

/** 見出しの件数の書き方。「1,221」のように桁を区切る。 */
const countLabel = (n: number) => n.toLocaleString('en-US');

/** 行だけを並べる（Home の一覧、検索の結果）か、節の見出しを挟んで並べる（プロジェクト画面。段 4 の PR 10 で平らにする）か。 */
type RowsSource = { rows: SessionRowProps[]; items?: never } | { items: ListItem[]; rows?: never };

/**
 * 一覧の役目。右端と 2 段目に何を出すかがこれで決まる。
 * recent は 1 段目の名前の右にプロジェクト名、右は時刻だけの形（以前は Home の最近が使っていた）。
 * project はプロジェクト詳細（右にモデル、変更、PR、コストと時刻。2 段目にメモ。プロジェクト名は見出しにあるので出さない）。
 * search は Home の一覧（1 段目にプロジェクト名、2 段目に一致箇所の抜粋か要約、2 段目の右端に PR の番号とノートの印）。
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
 * autoFocus を渡すと、行が初めて並んだときに一度だけ一覧そのものにフォーカスする（画面に入ってすぐ j や ↓ が効くように）。
 * page はいま見せているページの番号（ページ送りのある一覧）。変わったら一覧を先頭までスクロールし直す。
 * id は一覧の器に付ける。Mediator の focus の効果が、この id で一覧を探す（runtime/focusSoon.ts の FOCUS_IDS）。
 * items を渡すと、行のあいだに節の見出しを挟む（P3 と ★）。見出しは行ではないので、カーソルとフォーカスは見出しを飛ばす。
 * moreIntent は見出しの右端のボタン（「ほか N 件 ▸」「この節だけ見る ▸」）の Intent で、null ならボタンを出さない。
 * badgeIntent を渡すと、行の状態の札がそのタブへ移るボタンになる（Home の ★）。
 * statusColumn が偽なら、点の右の状態の列（F1）を畳む。状態がどれも同じ一覧（Done のタブなど）で使う。
 */
export function SessionRows(props: RowsSource & { /** 一覧の高さ。省くと器（.screen-fill など）から受け取る。 */ height?: number | string; variant: RowVariant; emptyText?: string; autoFocus?: boolean; id?: string; page?: number; statusColumn?: boolean; moreIntent?: (target: SectionId) => Intent | null; badgeIntent?: (status: StatusFilter) => Intent }) {
  const emit = useEmit();
  const t = useT();
  const statusColumn = props.statusColumn ?? true;
  const items: ListItem[] = props.items ?? (props.rows ?? []).map((row) => ({ kind: 'row' as const, row }));
  // カーソルと打鍵は行だけを渡り歩き、見出しは飛ばす。
  const rows = items.flatMap((it) => (it.kind === 'row' ? [it.row] : []));
  // カーソルは一覧の中だけの状態なので Mediator には置かない。
  // 行の番号ではなくセッションの id で持つ。
  // 行の DOM は id で付いて動くので、番号で持つと並びが変わったときにフォーカスの行とカーソルの行が食い違い、Enter で別の行が開く。
  // null は未選択で、このとき Enter や o や m は何も起こさない。
  // 選んでいた行が一覧から消えたときも未選択に戻る。
  const [cursorId, setCursorId] = useState<string | null>(null);
  const cursor = cursorId === null ? -1 : rows.findIndex((r) => r.id === cursorId);
  // 編集中のセッションの id。null なら編集していない。
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState('');

  const hostRef = useRef<HTMLDivElement>(null);
  // 打鍵でカーソルを動かしたときだけ、フォーカスをその行へ運ぶ。
  // 行の中のボタンへ Tab で入ったときもカーソルは動くが、そのときにフォーカスを行へ引き戻してはいけない。
  const byKey = useRef(false);
  // 打鍵 . で開いた「⋯」の行の id。閉じたら（項目を選んでも Esc でも）フォーカスをその行へ戻す。
  // 戻さないと、フォーカスは「⋯」のボタンに残り、一覧は行以外から来た打鍵を捨てるので j・Enter・2 回目の . が効かなくなる。
  const menuFromKey = useRef<string | null>(null);
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
  const hasRows = rows.length > 0;
  useEffect(() => {
    if (!autoPending.current || !hasRows) return;
    autoPending.current = false;
    if (!holdsFocus(document.activeElement, hostRef.current)) hostRef.current?.focus({ preventScroll: true });
  }, [hasRows]);

  // ページを移ったら先頭の行から見せる。行の DOM は入れ替わるので、カーソルは消えた行と同じく未選択に戻る。
  const firstPage = useRef(true);
  useEffect(() => {
    if (firstPage.current) { firstPage.current = false; return; }
    const scroller = hostRef.current?.querySelector('.list-scroll');
    if (scroller) scroller.scrollTop = 0;
  }, [props.page]);

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

  // 「⋯」が閉じた。打鍵で開いたものを選んで閉じた・Esc で閉じたときは、フォーカスを行へ戻す。外を押した・Tab はそれぞれの行き先に任せる。
  const menuClosed = (id: string, how: MenuCloseHow) => {
    const fromKey = menuFromKey.current === id;
    menuFromKey.current = null;
    if (fromKey && (how === 'select' || how === 'escape')) cursorRow()?.focus({ preventScroll: true });
  };

  // 提案のポップが閉じた。項目を選んだときは、開き方を問わずフォーカスを札の行へ戻す。
  // 確定・却下で candidate が消えると札がアンマウントされ、戻さないとフォーカスが body へ落ちて j・Enter・. が効かなくなる。
  // 閉じた直後のフォーカスは MenuButton が札へ戻してあるので、その札の行を取る（カーソルの行とは限らない）。
  const candidateClosed = (id: string, how: MenuCloseHow) => {
    if (how === 'select') (document.activeElement as HTMLElement | null)?.closest<HTMLElement>('[role="row"]')?.focus({ preventScroll: true });
    else menuClosed(id, how);
  };

  // 一覧の中で最後にフォーカスを持っていた要素（裁定 2B）。
  // 行が別の節へ移る、畳んだ節へ入る、タブから外れると、その行の DOM は消えるか並び替えで付け直され、フォーカスは body に落ちる。
  // ダイアログを閉じたときも、開いた元の行が消えていれば Dialog はフォーカスを返せない。
  // 一覧の打鍵は器が受けるので、body に落ちたままでは j・Enter・. が効かない。描き直しのたびに確かめて拾い直す。
  const lastInside = useRef<HTMLElement | null>(null);
  const onHostFocus = (e: ReactFocusEvent) => { lastInside.current = e.target as HTMLElement; };
  // 利用者が何も無いところを押してフォーカスを外したとき（行き先が無く、要素は残っている）は、奪い返さないよう忘れる。
  // 一覧の外の欄（検索欄など）へ移ったときも忘れる。そこから先の blur は一覧の React の木の外で起き、ここへは届かないからである。
  // モーダルのダイアログ（Paused の入力など）へ移ったときだけは覚えておき、閉じて body に落ちたら拾う。
  // 「⋯」のメニューの項目は portal で器の外に描くが、そのフォーカスは React の木を通って onHostFocus へ上がり、覚え直される。
  const onHostBlur = (e: ReactFocusEvent) => {
    const to = e.relatedTarget as Element | null;
    const leftQuietly = to === null && (e.target as HTMLElement).isConnected;
    const leftOutside = to !== null && !hostRef.current?.contains(to) && !to.closest('[aria-modal="true"]');
    if (leftQuietly || leftOutside) lastInside.current = null;
  };
  useLayoutEffect(() => {
    const last = lastInside.current;
    const host = hostRef.current;
    if (!last || !host) return;
    const a = document.activeElement;
    if (a && a !== document.body) return;
    // モーダルのダイアログが開いている間は、フォーカスはダイアログのものである（holdsFocus と同じ）。
    if (document.querySelector('[aria-modal="true"]')) return;
    // 行がまだ一覧にあれば（並び替えで付け直された行など）そこへ戻す。同じ描き直しの中の並び替えは React がフォーカスを戻すので、これは取りこぼしの受けである。
    // 消えた行の代わりはカーソルの行で、それも描いていなければ器にする。
    // 器に戻したときは、カーソルの行が一覧に残っていればその行のまま、消えていれば未選択のまま、次の j で動き出す。
    const target = last.isConnected && host.contains(last) ? last : cursorRow() ?? host;
    target.focus({ preventScroll: true });
  });

  const onKeyDown = (e: ReactKeyboardEvent) => {
    // 編集中の入力欄から上がってきたキーは横取りしない。
    if (editing !== null) return;
    // 行の中のボタンやリンクの打鍵は、その部品のものである。Enter で行まで開くと二重になる。
    if (e.target !== e.currentTarget && (e.target as HTMLElement).getAttribute('role') !== 'row') return;
    // ⌘ や Ctrl の付いた打鍵はアプリ全体のもの（⌘K や ⌘J）なので、一覧では使わない。
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const max = rows.length - 1;
    const cur = cursor >= 0 ? rows[cursor] : undefined;
    const moveTo = (i: number) => { byKey.current = true; setCursorId(rows[i]?.id ?? null); };
    switch (e.key) {
      case 'j': case 'ArrowDown': moveTo(Math.min(max, cursor + 1)); break;
      case 'k': case 'ArrowUp': moveTo(Math.max(0, cursor - 1)); break;
      case 'Enter': if (cur) emit(openIntent(cur)); break;
      case 'o': if (cur?.runId) emit({ type: 'session.openTerminalApp', runId: cur.runId }); break;
      case 'e': if (cur) emit({ type: 'session.openEditor', sessionId: cur.id }); break;
      case 'm': if (cur) startEdit(cur); break;
      // 状態の 4 択。カーソルの行の「⋯」を押したのと同じにする（見えていなくても押せる）。
      case '.': if (cur) { cursorRow()?.querySelector<HTMLButtonElement>('.row-more button')?.click(); menuFromKey.current = cur.id; } break;
      default: return;
    }
    e.preventDefault();
  };

  if (items.length === 0) return <div className="list"><div className="empty">{props.emptyText ?? DEFAULT_EMPTY_TEXT}</div></div>;

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

  // 2 段目。頭に要約の見立ての札を置き（B1）、検索は一致箇所の抜粋を、ほかは要約の 1 文を出す。プロジェクト詳細はその後ろにメモと鉛筆を置く。
  const sub = (r: SessionRowProps) => {
    if (editing === r.id) return <span className="row-sub">{memoEditor(r)}</span>;
    const excerpt = props.variant === 'search' && r.excerpt && r.excerpt.length > 0 ? r.excerpt : null;
    return (
      <span className="row-sub">
        {/* 頭は要約の見立て。Paused の戻る日は右端の時刻の列へ移した（F1）。 */}
        {r.summaryState && <span className="row-state" data-tone={r.summaryState.tone ?? undefined}>{r.summaryState.label}</span>}
        <span className={excerpt ? 'row-text mono' : 'row-text'}>{excerpt ? excerpt.map((s, i) => (s.hit ? <mark key={i} className="hit">{s.text}</mark> : <span key={i}>{s.text}</span>)) : r.oneLiner}</span>
        {props.variant === 'search' && (r.prUrl || r.memo) && (
          // 2 段目の右端。PR の番号とノートの印（設計書 2.2）。PR は外のブラウザで開くリンクで、行は開かない。
          <span className="row-marks">
            {r.prUrl && <a className="row-pr" href={r.prUrl} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()}>{prNumberOf(r.prUrl) ? t('row.mark.pr', { n: prNumberOf(r.prUrl)! }) : t('row.mark.prPlain')}</a>}
            {r.memo && <span className="row-note"><Icon name="note" label={t('row.mark.note')} /></span>}
          </span>
        )}
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
          {r.filesChanged > 0 && <span className="num">変更 {r.filesChanged}</span>}
          {r.prUrl && <a href={r.prUrl} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()}>PR</a>}
          {r.cost && <span className="mono">{r.cost}</span>}
        </span>
      )}
      {/* 本文の期限の印、動きの語、「⋯」を時刻の左に並べる。状態と提案の札は左の状態の列にある（F1）。
          消えかけは琥珀のチップで先に知らせ、消えた会話は文字の無い印だけにする。消えた会話は数百件に上るので、文字を並べると一覧が騒がしくなる。 */}
      <span className="row-when">
        {r.transcript === 'expiring' && <span className="row-soon">まもなく削除</span>}
        {r.transcript === 'gone' && <span className="row-gone" title={GONE_LABEL}><Icon name="transcriptGone" label={GONE_LABEL} /></span>}
        {r.live && <span className="row-live" data-live={r.live === 'waiting' ? 'waiting' : 'busy'} aria-hidden="true">{LIVE_WORD[r.live]}</span>}
        <span className="row-act row-more" onClick={stopClick}>
          <MenuButton label={`${r.name} の状態`} items={stateItems(r, emit)} faceClassName="btn btn-icon row-more-btn" minWidth={220} onClose={(how) => menuClosed(r.id, how)} />
        </span>
        {time(r)}
      </span>
    </span>
  );

  // 時刻の列（F1）。幅を決めて右に寄せ、行ごとに位置がずれないようにする。
  // Paused の行は戻る日を出す（その行にとって意味のある日だから）。今日と過ぎたものと、戻る日が無いもの（日付なし）は塗る。
  // 時刻つきは時刻も出し、当日でも時刻の前は塗らない（塗るかどうかは presenters/row.ts の returnDue が決める）。
  // 最後の活動はポインタを乗せると読める。
  const time = (r: SessionRowProps) => (
    <span className="row-time">
      {r.state === 'paused'
        ? <span className="row-return" data-due={r.returnDue ? 'true' : undefined} title={`${r.returnTime ? `戻る時刻 ${returnOnLabel(r.returnOn, r.overdueDays, r.returnTime)}` : '戻る日'} · 最後の活動 ${r.when}`}>{returnOnRowLabel(r.returnOn, r.overdueDays, r.returnTime, r.returnPastMin)}</span>
        : <RelativeTime label={r.when} abs={r.whenAbs} />}
    </span>
  );

  // 状態の列（F1）。状態の語の札（Active・Paused・Done・Archived）を同じ幅で置き、どの行も空にしない。
  // 状態の無い行は Active の札で、Claude の提案があればその札を代わりに置く。動いているかどうかは札に出さず、点と右の語が言う。
  // 状態と提案の両方を持つ行は無い（状態を正とし、提案は無いものとする。presenters/row.ts）。
  const status = (r: SessionRowProps) => (
    <span className="row-status">
      {r.state
        ? badge(r.state, STATUS_LABEL[r.state], <span className="row-sq" data-s={r.state} title={r.setBy === 'conversation' ? CONVERSATION_NOTE : undefined}>{STATUS_LABEL[r.state]}</span>)
        : r.candidate
          ? <span className="row-act" onClick={stopClick}>{candidatePop(r, emit, (how) => candidateClosed(r.id, how))}</span>
          : badge('active', ACTIVE_LABEL, <span className="row-sq" data-s="active">{ACTIVE_LABEL}</span>)}
    </span>
  );

  // 行の状態の札（Done・Archived の四角の札と、Paused の戻る日の札）。Sessions ではそのタブへ移るボタンにする（★ の E）。
  // 行が開かないよう、クリックは行へ渡さない。Enter はボタンのものなので、行の打鍵（onKeyDown）は横取りしない。
  const badge = (status: StatusFilter, label: string, node: ReactNode) => (props.badgeIntent ? (
    <button type="button" className="badge-link" aria-label={`${label} のセッションだけを見る`} onClick={(e) => { e.stopPropagation(); emit(props.badgeIntent!(status)); }}>{node}</button>
  ) : node);

  // 節の見出し。行ではないので、カーソルもフォーカスも止まらない。
  const head = (h: Extract<ListItem, { kind: 'head' }>) => {
    const intent = h.more && props.moreIntent ? props.moreIntent(h.more.target) : null;
    return (
      <div className="row-head" role="heading" aria-level={2} data-section={h.id}>
        <span>{h.label}</span><span className="row-head-count">{countLabel(h.count)}</span>
        {intent && <button type="button" className="row-head-more" onClick={() => emit(intent)}>{h.more!.label}</button>}
      </div>
    );
  };

  // Tab で止まる行。まだ選んでいなければ先頭の行にする。見出しには止まらない。
  const tabStopId = (cursor >= 0 ? rows[cursor] : rows[0])?.id ?? null;
  const cursorRowId = cursor >= 0 ? rows[cursor]!.id : null;
  const rowEl = (r: SessionRowProps) => (
    <div className="row row-2" role="row" tabIndex={r.id === tabStopId ? 0 : -1} data-cursor={r.id === cursorRowId ? 'true' : undefined} data-archived={r.state === 'archived' ? 'true' : undefined} data-morph-id={r.id}
      onClick={() => emit(openIntent(r))} onFocus={() => setCursorId(r.id)}>
      <StatusDot status={r.live} aside={r.aside} />
      {statusColumn && status(r)}
      <span className="row-main">
        <span className="row-name">{r.name}{props.variant !== 'project' && <span className="row-proj">{r.projectName ?? '未分類'}</span>}</span>
        {sub(r)}
      </span>
      {side(r)}
    </div>
  );
  // 器は Tab の順には入れず（tabIndex=-1）、画面に入ったときのフォーカスの受け皿にだけ使う。
  // 行の打鍵はここへ上がってきて、カーソルの行について 1 度だけ処理する。
  return (
    <div className="rows-host" id={props.id} data-testid="session-rows" data-status-col={String(statusColumn)} ref={hostRef} tabIndex={-1} onKeyDown={onKeyDown} onFocus={onHostFocus} onBlur={onHostBlur}>
      <VirtualList items={items} rowHeight={(it) => (it.kind === 'head' ? SECTION_HEAD_H : SESSION_ROW_H)} height={props.height} keyOf={(it) => (it.kind === 'head' ? `head:${it.id}` : it.row.id)}
        render={(it) => (it.kind === 'head' ? head(it) : rowEl(it.row))} />
    </div>
  );
}
