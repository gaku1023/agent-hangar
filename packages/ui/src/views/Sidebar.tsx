import { formatRoute } from '@agent-hangar/shared';
import { useEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type MouseEvent, type PointerEvent } from 'react';
import { flushSync } from 'react-dom';
import { useEmit } from '../action/chain.tsx';
import type { NavItem, SideLiveProps, SideLiveRow } from '../presenters/shell.ts';
import { Icon, type IconName } from './primitives/Icon.tsx';
import { useT } from './primitives/language.tsx';
import { ariaKeyShortcuts, keyLabel } from '../keys.ts';
import type { MenuAnchor, MenuCloseHow } from './primitives/MenuButton.tsx';
import { SessionMenuPop } from './sessionMenu.tsx';
import { StatusDot } from './primitives/StatusDot.tsx';
import { motionMs } from './primitives/motion.ts';

/** 画面の名前からナビのアイコンへの対応。見た目の話なので Presenter ではなくここに置く。 */
const NAV_ICON: Record<string, IconName> = { home: 'home', projects: 'projects', settings: 'settings' };

/**
 * 項目に添える入力待ちの数。
 * 開いた帯では項目の右端の錠剤、畳んだ帯ではアイコンの右上の丸になる（base.css の .nav-count）。
 * 見えるのは数字だけなので、読み上げには何の数かを添える。
 */
function NavCount(props: { n: number }) {
  const t = useT();
  return <span className="nav-count"><span aria-hidden="true">{props.n}</span><span className="sr-only">{t('sidebar.count.waiting', { n: props.n })}</span></span>;
}

/** 行を別の行の前か後ろへ移した後の並び。移す先が無ければ元のまま返す。 */
export function moveId(ids: string[], id: string, target: string, before: boolean): string[] {
  if (id === target || !ids.includes(id)) return ids;
  const rest = ids.filter((x) => x !== id);
  const at = rest.indexOf(target);
  if (at < 0) return ids;
  rest.splice(before ? at : at + 1, 0, id);
  return rest;
}

/** 行を 1 つ上か下へずらした後の並び。端ではそのまま返す。 */
export function nudgeId(ids: string[], id: string, delta: -1 | 1): string[] {
  const i = ids.indexOf(id);
  const j = i + delta;
  if (i < 0 || j < 0 || j >= ids.length) return ids;
  const out = [...ids];
  [out[i], out[j]] = [out[j]!, out[i]!];
  return out;
}

/**
 * 押してからこれだけ（px）動いたら、押したのではなく並べ替えとみなす。
 * これより手前で離せば、ただのクリックとして行を開く。
 */
const DRAG_SLOP = 4;

/** 浮いた行が、両端の席より先へ出られる幅（px）。端に当たったことを、止まる手応えで見せる。 */
const DRAG_OVERSHOOT = 8;

/** 押し下げてから離すまでの、ポインタの記録。active はしきいを越えて並べ替えに入ったかどうか。 */
type Press = { id: string; pointer: number; x: number; y: number; active: boolean; cancelled: boolean };

/**
 * 並べ替えの途中の形（5A）。席の添字は持たず、行の id で持つ。途中で一覧の行が増えたり消えたりしても、指す行を取り違えないためである。
 * held はポインタに付いている間で、from0 は掴んだときの席、pointerDy は押した点からのポインタの縦のずれである。
 * settle は離して空いた席へ収まる間（取り消しなら元の席へ戻る間）で、target の行の前（before）か後ろへ入る。target が null なら元の席へ戻る。
 * pitch は行の間隔（開いた帯 30px、畳んだ帯 26px）。
 */
type Sort =
  | { phase: 'held'; id: string; from0: number; pointerDy: number; pitch: number }
  | { phase: 'settle'; id: string; target: string | null; before: boolean; pitch: number };

/** いまの行の並びでの、並べ替えの席。from は掴んだ行の席、to は入る席、dy は浮いた行の縦のずれ。掴んだ行か指した行が無ければ null。 */
type SortAt = { from: number; to: number; dy: number; pitch: number };

/** 掴んだ行の縦のずれから、入る席を決める。両端の先へは出さない。 */
function sortSlot(from: number, n: number, pitch: number, rawDy: number): { to: number; dy: number } {
  const dy = Math.max(-from * pitch - DRAG_OVERSHOOT, Math.min((n - 1 - from) * pitch + DRAG_OVERSHOOT, rawDy));
  const to = Math.max(0, Math.min(n - 1, Math.round(from + dy / pitch)));
  return { to, dy };
}

/**
 * 並べ替えの途中の形を、いまの行の並び（rowIds）の席へ引き直す。描くたびに呼ぶ。
 * 掴んでいる間に前の行が消えたり増えたりすると、掴んだ行の席が動くので、その分だけずれを足してポインタに付いたままにする。
 */
function sortAt(s: Sort, rowIds: string[]): SortAt | null {
  const from = rowIds.indexOf(s.id);
  if (from < 0) return null;
  if (s.phase === 'held') return { from, ...sortSlot(from, rowIds.length, s.pitch, s.pointerDy + (s.from0 - from) * s.pitch), pitch: s.pitch };
  if (s.target === null) return { from, to: from, dy: 0, pitch: s.pitch };
  if (!rowIds.includes(s.target)) return null;
  const to = moveId(rowIds, s.id, s.target, s.before).indexOf(s.id);
  return { from, to, dy: (to - from) * s.pitch, pitch: s.pitch };
}

/** 並べ替えの途中で、席 j の行をずらす幅。掴んだ行が通り過ぎた行は、行の間隔だけ逆へよける。 */
function shiftOf(a: SortAt, j: number): number {
  if (j === a.from) return a.dy;
  if (a.from < a.to && j > a.from && j <= a.to) return -a.pitch;
  if (a.from > a.to && j >= a.to && j < a.from) return a.pitch;
  return 0;
}

/**
 * 「実行中」の節。
 * 行を押すとそのセッションへ移る。行を掴んで上下に動かすと並べ替えられ、並びは端末が覚える（sidebar.order）。
 * 掴んで動かすのは、HTML のドラッグ（draggable と dragover と drop）ではなく、ポインタのイベントで作る。
 * デスクトップのアプリ（Tauri）は、Finder からファイルを落とすために窓のドラッグを殻で受けており、窓の中のドラッグでも dragover と drop が画面へ届かないからである。
 * 押してから DRAG_SLOP を越えて動いたら並べ替えに入り、離したあとの click では行を開かない。
 * 並べ替えの間は、掴んだ行が浮いてポインタに付き（data-lift）、ほかの行は入る場所に合わせて滑ってよける（5A、base.css）。
 * 離すと空いた席へ収まってから並びを確定する。Esc とポインタの取り消しでは、同じ動きで元の席へ戻る。
 * 確定は離したときに指した行の id で行い、途中で掴んだ行か指した行が一覧から消えたら、並べ替えを捨てる。
 * 並べ替えの間は、⌥↑↓、.、右クリックを受けない。
 * キーボードでは、行に焦点があるときに ⌥↑ と ⌥↓ で 1 つずつ動かす。
 * 動かすのは行だけで、見出しは動かない。並べ替えの途中の形は、ここだけで持つ。
 * 畳んだ帯では点だけを縦に並べ、名前は title に持つ（base.css）。
 * 行を右クリックするか、行に焦点があるときに . を押すと、その行のセッションのメニュー（1A）を出す。中身は一覧の行の「⋯」と同じである（views/sessionMenu.tsx）。
 * メニューは節に 1 つだけ持ち、開いている行には印（data-menu）を付けて、どの行のものかを見せる。
 */
function LiveSection(props: { live: SideLiveProps }) {
  const emit = useEmit();
  const t = useT();
  const [sort, setSortState] = useState<Sort | null>(null);
  // 開いているメニュー。at は吊るす相手で、右クリックなら押した点、打鍵なら行の矩形。
  const [menu, setMenu] = useState<{ id: string; at: MenuAnchor } | null>(null);
  const list = useRef<HTMLUListElement>(null);
  // 押し下げの記録と、並べ替えの途中の形の写し。ポインタのイベントの間で、描き直しを待たずに読むため ref にも持つ。
  const press = useRef<Press | null>(null);
  const sortNow = useRef<Sort | null>(null);
  const setSort = (next: Sort | null) => { sortNow.current = next; setSortState(next); };
  // 収まりを待つ予約。並びの確定は、ここから最新の行で組み立てる（待つ間に行が増減しても、古い並びで上書きしない）。
  const settleTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const liveNow = useRef(props.live);
  // 窓の Esc から呼ぶ、いまの描画の settle。
  const settleRef = useRef<(cancel: boolean) => void>(() => {});
  liveNow.current = props.live;
  useEffect(() => () => { if (settleTimer.current) clearTimeout(settleTimer.current); }, []);
  // 並べ替えで離した直後の click を 1 回だけ飲み込む。
  const swallowClick = useRef(false);
  // 開いている間に行が消えたら（ほかの場所で止めた、Claude が自分で終わった）、開いていたことも忘れる。同じ行がまた現れたときに、勝手に開き直さないためである。
  const gone = menu !== null && !props.live.rows.some((r) => r.id === menu.id);
  useEffect(() => { if (gone) setMenu(null); }, [gone]);
  // いまの行の並びでの席。描くたびに id から引き直す。
  const rowIds = props.live.rows.map((r) => r.id);
  const at = sort ? sortAt(sort, rowIds) : null;
  // 並べ替えの途中で掴んだ行か指した行が消えたら、並べ替えごとやめる。
  const sortGone = sort !== null && at === null;
  useEffect(() => {
    if (!sortGone) return;
    if (settleTimer.current) clearTimeout(settleTimer.current);
    settleTimer.current = null;
    press.current = null;
    setSort(null);
  }, [sortGone]);
  // 並べ替えの途中の Esc は、並べ替えをやめて元の席へ戻す。離すまでの記録は残し、離したあとの click を飲み込む。
  // 窓で受けるのは、WebKit（Safari と Tauri の殻）がリンクを押しても焦点を移さず、行が Esc を受け取らないからである。
  const holding = sort?.phase === 'held';
  useEffect(() => {
    if (!holding) return;
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key !== 'Escape' || !press.current?.active) return;
      // ほかの Esc の受け手（ダイアログの殻、ポップオーバー、Root の overlay.close、後から窓に付いた捕捉）へは届かせない。
      // 届くと、並べ替えを取り消したのと同じ打鍵で、ダイアログを閉じたり画面を戻したりしてしまう。
      e.preventDefault();
      e.stopImmediatePropagation();
      press.current.cancelled = true;
      settleRef.current(true);
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [holding]);
  const { live } = props;
  if (live.count === 0) return null;
  const menuRow = menu ? live.rows.find((r) => r.id === menu.id) ?? null : null;
  const closeMenu = (how: MenuCloseHow) => {
    const id = menu?.id;
    setMenu(null);
    // 外を押したときは、押した先にフォーカスを任せる。ほかは行へ戻す（止めて行が消えたら、戻す先は無い）。
    if (how !== 'outside' && id) list.current?.querySelector<HTMLElement>(`[data-id="${CSS.escape(id)}"]`)?.focus();
  };
  /**
   * 浮いた行を、空いた席（取り消しなら元の席）へ --dur-fast で収め、収まってから並びを確定する。
   * 確定（sidebar.order）と浮きを外すのを 1 回の描画にまとめ、行が入れ替わる前後でちらつかせない。
   * reduced motion では長さが 0 なので、待たずにその場で確定する。
   */
  const settle = (cancel: boolean) => {
    const s = sortNow.current;
    if (!s || s.phase !== 'held') return;
    // 入る先は、離したこの時点で指している行の id として持つ。収まる間に行が増減しても、別の行の前後へ入れないためである。
    const rows = liveNow.current.rows.map((r) => r.id);
    const a = sortAt(s, rows);
    if (!a) { setSort(null); return; }
    const moved = !cancel && a.to !== a.from;
    const next: Sort = { phase: 'settle', id: s.id, target: moved ? rows[a.to] ?? null : null, before: a.to < a.from, pitch: s.pitch };
    setSort(next);
    const finish = () => {
      settleTimer.current = null;
      if (sortNow.current !== next) return;
      const cur = liveNow.current;
      const { target } = next;
      const ids = target && cur.ids.includes(next.id) && cur.ids.includes(target) ? moveId(cur.ids, next.id, target, next.before) : cur.ids;
      flushSync(() => {
        if (ids !== cur.ids) emit({ type: 'sidebar.order', ids });
        setSort(null);
      });
    };
    const ms = motionMs('--dur-fast');
    if (ms > 0) settleTimer.current = setTimeout(finish, ms);
    else finish();
  };
  settleRef.current = settle;
  const onPointerDown = (e: PointerEvent, r: SideLiveRow) => {
    // 右ボタンと control を押しながらの押し下げは、メニューを出すためのものなので掴まない。
    if (e.button !== 0 || e.ctrlKey || e.isPrimary === false) return;
    // 収まる途中の行は、収まりきるまで掴み直さない。
    if (sortNow.current) return;
    press.current = { id: r.id, pointer: e.pointerId, x: e.clientX, y: e.clientY, active: false, cancelled: false };
  };
  const onPointerMove = (e: PointerEvent) => {
    const p = press.current;
    if (!p || p.cancelled || e.pointerId !== p.pointer) return;
    if (!p.active) {
      if (Math.hypot(e.clientX - p.x, e.clientY - p.y) < DRAG_SLOP) return;
      const from = live.rows.findIndex((r) => r.id === p.id);
      if (from < 0) return;
      p.active = true;
      // 掴んだ行の外へ出ても動きと離したことを受け取れるよう、ポインタをこの行に捕まえる。
      try { e.currentTarget.setPointerCapture?.(e.pointerId); } catch { /* 捕まえられなくても、行の上にいる間は動く */ }
      // 行の間隔は、並んだ行の上端の差で測る。開いた帯と畳んだ帯で行の高さが違うからである。
      const boxes = [...list.current?.querySelectorAll<HTMLElement>('.side-live-row') ?? []].map((el) => el.getBoundingClientRect());
      const first = boxes[0];
      const last = boxes[boxes.length - 1];
      const pitch = boxes.length > 1 && first && last ? (last.top - first.top) / (boxes.length - 1) : first?.height ?? 0;
      sortNow.current = { phase: 'held', id: p.id, from0: from, pointerDy: 0, pitch: pitch > 0 ? pitch : 30 };
    }
    const s = sortNow.current;
    if (!s || s.phase !== 'held') return;
    const next: Sort = { ...s, pointerDy: e.clientY - p.y };
    // 席もずれも変わらなければ描き直さない（両端の先で止まっている間など）。掴んだ最初の動きは、まだ描いていないので描く。
    const was = sortAt(s, rowIds);
    const now = sortAt(next, rowIds);
    if (sort && was && now && was.to === now.to && was.dy === now.dy) { sortNow.current = next; return; }
    setSort(next);
  };
  const onPointerUp = (e: PointerEvent) => {
    const p = press.current;
    if (!p || e.pointerId !== p.pointer) return;
    press.current = null;
    if (!p.active) return;
    swallowClick.current = true;
    // click が来なかったとき（行の外で離した、など）に、次の押し下げまで飲み込みを残さない。
    setTimeout(() => { swallowClick.current = false; }, 0);
    if (p.cancelled) return;
    settle(false);
  };
  const onPointerCancel = (e: PointerEvent) => {
    if (press.current?.pointer !== e.pointerId) return;
    press.current = null;
    settle(true);
  };
  const onClick = (e: MouseEvent, r: SideLiveRow) => {
    e.preventDefault();
    if (swallowClick.current) { swallowClick.current = false; return; }
    emit({ type: 'session.open', id: r.id });
  };
  const onKeyDown = (e: KeyboardEvent, r: SideLiveRow) => {
    // 並べ替えの間は、並びもメニューも動かさない。
    if (sortNow.current) return;
    // . は一覧の行の「⋯」と同じ打鍵。修飾の付いたものはアプリ全体の打鍵なので取らない。
    if (e.key === '.' && !e.metaKey && !e.ctrlKey && !e.altKey) {
      e.preventDefault();
      const box = e.currentTarget.getBoundingClientRect();
      setMenu({ id: r.id, at: { top: box.top, bottom: box.bottom, left: box.left, width: box.width } });
      return;
    }
    if (!e.altKey || (e.key !== 'ArrowUp' && e.key !== 'ArrowDown')) return;
    e.preventDefault();
    const ids = nudgeId(live.ids, r.id, e.key === 'ArrowUp' ? -1 : 1);
    if (ids !== live.ids) emit({ type: 'sidebar.order', ids });
  };
  return (
    <section className="side-live" aria-label={t('sidebar.live.label')}>
      <h2 className="side-live-h">{t('sidebar.live.title')}<span className="side-live-n">{live.count}</span></h2>
      <ul className="side-live-list" ref={list} data-sorting={at ? 'true' : undefined}>
        {live.rows.map((r, j) => {
          const shift = at ? shiftOf(at, j) : 0;
          const lift = at && sort?.id === r.id ? sort.phase : undefined;
          // 浮いた行には、元の席でも 0 を明示して持たせる（戻る動きの行き先が 0 であるため）。
          const style: CSSProperties | undefined = lift || shift ? { translate: `0 ${shift}px` } : undefined;
          return (
          <li key={r.id}>
            <a className="side-live-row" href={formatRoute({ name: 'session', id: r.id })} draggable={false} aria-current={r.current ? 'page' : undefined} data-id={r.id} data-menu={menu?.id === r.id ? 'true' : undefined}
              data-live={r.live ?? undefined} data-lift={lift} style={style}
              title={r.overlap ?? (r.waited ? t('sidebar.live.rowTitle', { name: r.name, waited: r.waited }) : r.name)}
              onClick={(e) => onClick(e, r)} onKeyDown={(e) => onKeyDown(e, r)}
              onContextMenu={(e) => { e.preventDefault(); if (sortNow.current) return; setMenu({ id: r.id, at: { top: e.clientY, bottom: e.clientY, left: e.clientX, width: 0 } }); }}
              onPointerDown={(e) => onPointerDown(e, r)} onPointerMove={onPointerMove} onPointerUp={onPointerUp} onPointerCancel={onPointerCancel}>
              <StatusDot status={r.live} aside={r.aside} reason={r.reason} /><span className="side-live-name">{r.name}</span>{r.overlap && <span className="side-live-overlap" role="img" aria-label={r.overlap} title={r.overlap}><Icon name="warning" /></span>}{r.waited && <span className="side-live-wait num" data-reason={r.reason ?? undefined}>{r.waited}</span>}
            </a>
          </li>
          );
        })}
      </ul>
      {menuRow && menu && <SessionMenuPop key={menuRow.id} menu={menuRow.menu} at={menu.at} onClose={closeMenu} />}
      {live.more > 0 && <a className="side-live-more" href={formatRoute(HOME)} onClick={(e) => { e.preventDefault(); emit({ type: 'nav.go', to: HOME }); }}>{t('sidebar.live.more', { n: live.more })}</a>}
    </section>
  );
}

/** 「ほか N 件」の行き先。ホームの実行中と要対応に全部が並ぶ。 */
const HOME = { name: 'home' } as const;

/**
 * サイドバー。上から「ホーム」「プロジェクト」の 2 項目、「実行中」の節、下端の「設定」の順に置く（設計書 2.1）。
 * 設定は foot で受け取り、残りの高さの底に寄せる。
 */
export function Sidebar(props: { nav: NavItem[]; foot: NavItem[]; collapsed: boolean; live: SideLiveProps }) {
  const emit = useEmit();
  const t = useT();
  const item = (n: NavItem) => (
    <a key={n.label} className="nav-item" href={formatRoute(n.route)} aria-current={n.current ? 'page' : undefined} onClick={(e) => { e.preventDefault(); emit({ type: 'nav.go', to: n.route }); }}>{NAV_ICON[n.route.name] && <Icon name={NAV_ICON[n.route.name]!} />}<span className="nav-label">{n.label}</span>{n.count > 0 && <NavCount n={n.count} />}</a>
  );
  const toggle = (
    <button className="btn sidebar-toggle" aria-controls="sidebar" aria-expanded={!props.collapsed} aria-keyshortcuts={ariaKeyShortcuts('sidebar.toggle')} aria-label={props.collapsed ? t('sidebar.toggle.open') : t('sidebar.toggle.close')} onClick={() => emit({ type: 'sidebar.toggle' })}><Icon name="sidebar" /><span className="toggle-tip" aria-hidden="true">{props.collapsed ? t('sidebar.toggle.tipOpen') : t('sidebar.toggle.tipClose')}<kbd>{keyLabel('⌘B')}</kbd></span></button>
  );
  const [first, ...rest] = props.nav;
  return (
    <nav id="sidebar" className="sidebar" aria-label={t('sidebar.nav.label')}>
      {/* ロゴはヘッダへ移した。開閉のボタンは、開いた帯では最初の項目（ホーム）の行の右端に、畳んだ帯では帯の一番上に置く（base.css の .nav-row）。開閉の間は、その 2 か所を滑って移る。
          2 つの形は CSS だけで作り、DOM の組み立ては変えない。開閉の動きは、開閉の印だけを一瞬戻して前の形を測るからである（sidebarMotion.ts）。 */}
      <div className="nav-row">{first && item(first)}{toggle}</div>
      {rest.map(item)}
      <LiveSection live={props.live} />
      {props.foot.length > 0 && <div className="side-foot">{props.foot.map(item)}</div>}
    </nav>
  );
}
