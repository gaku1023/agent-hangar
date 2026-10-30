import { formatRoute } from '@agent-hangar/shared';
import { useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type MouseEvent, type PointerEvent, type ReactNode } from 'react';
import { flushSync } from 'react-dom';
import { useEmit } from '../action/chain.tsx';
import type { NavItem, SideLiveGroup, SideLiveProps, SideLiveRow } from '../presenters/shell.ts';
import { AgentIcon } from './primitives/AgentIcon.tsx';
import { Icon, type IconName } from './primitives/Icon.tsx';
import { useT } from './primitives/language.tsx';
import { ariaKeyShortcuts, keyLabel } from '../keys.ts';
import type { MenuAnchor, MenuCloseHow } from './primitives/MenuButton.tsx';
import { SessionMenuPop } from './sessionMenu.tsx';
import { StatusDot } from './primitives/StatusDot.tsx';
import { FoldBox } from './primitives/FoldBox.tsx';
import { CountBubble } from './primitives/CountBubble.tsx';
import { motionMs } from './primitives/motion.ts';
import { hangIn, hangOut } from './primitives/motionKit.ts';
import { useMotionList } from './primitives/useMotionList.ts';
import { paneDrag } from './paneDrag.ts';
import { spawnFoldKey } from '../presenters/spawnTree.ts';

/** 画面の名前からナビのアイコンへの対応。見た目の話なので Presenter ではなくここに置く。 */
const NAV_ICON: Record<string, IconName> = { home: 'home', projects: 'projects', settings: 'settings' };

/**
 * 項目に添える入力待ちの数。
 * 開いた帯では項目の右端の錠剤、畳んだ帯ではアイコンの右上の丸になる（base.css の .nav-count）。
 * 数は入力待ちに未読の合計を足したもので、0 から増えたら伸びて出て、増えたら跳ね、0 に戻ったら畳んで消える（CountBubble）。
 * 見えるのは数字だけなので、読み上げには何の数かを添える。
 */
function NavCount(props: { n: number; waiting?: number; unread?: number }) {
  const t = useT();
  // 内訳があれば入力待ちと未読を分けて言う。無ければ、数を入力待ちの数と読む。
  const waiting = props.waiting ?? (props.unread === undefined ? props.n : 0);
  const unread = props.unread ?? 0;
  const sr = `${waiting > 0 ? t('sidebar.count.waiting', { n: waiting }) : ''}${unread > 0 ? t('sidebar.count.unread', { n: unread }) : ''}`;
  return <CountBubble n={props.n} sr={sr} className="nav-count" />;
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

/** 並べ替えで行を指す id。薄い起動元は rep（動いている最初の子孫）を使う。 */
const sidOf = (r: SideLiveRow): string => r.rep ?? r.id;

/** 深さの付いた平らな行を、起動元の下に子を持つ木にする。 */
type RowNode = { row: SideLiveRow; kids: RowNode[] };
function treeOf(rows: SideLiveRow[]): RowNode[] {
  const roots: RowNode[] = [];
  const stack: RowNode[] = [];
  for (const row of rows) {
    const d = Math.min(row.depth ?? 0, stack.length);
    const node: RowNode = { row, kids: [] };
    if (d === 0) roots.push(node); else stack[d - 1]!.kids.push(node);
    stack.length = d;
    stack.push(node);
  }
  return roots;
}

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
 * 「実行中」の 1 つのグループの行の一覧。並べ替えはこの一覧の中だけで行い、sidebar.order にはこのグループの行の並びを渡す（覚えた並びの、その行の席だけが入れ替わる）。
 * 行を押すとそのセッションへ移る。行を掴んで上下に動かすと並べ替えられ、並びは端末が覚える（sidebar.order）。
 * 掴んで動かすのは、HTML のドラッグ（draggable と dragover と drop）ではなく、ポインタのイベントで作る。
 * デスクトップのアプリ（Tauri）は、Finder からファイルを落とすために窓のドラッグを殻で受けており、窓の中のドラッグでも dragover と drop が画面へ届かないからである。
 * 押してから DRAG_SLOP を越えて動いたら並べ替えに入り、離したあとの click では行を開かない。
 * 並べ替えの間は、掴んだ行が浮いてポインタに付き（data-lift）、ほかの行は入る場所に合わせて滑ってよける（5A、base.css）。
 * 離すと空いた席へ収まってから並びを確定する。Esc とポインタの取り消しでは、同じ動きで元の席へ戻る。
 * 確定は離したときに指した行の id で行い、途中で掴んだ行か指した行が一覧から消えたら、並べ替えを捨てる。
 * 並べ替えの間は、⌥↑↓、.、右クリックを受けない。
 * キーボードでは、行に焦点があるときに ⌥↑ と ⌥↓ で 1 つずつ動かす。
 * 動かすのは行だけで、グループの見出しは動かない。並べ替えの途中の形は、ここだけで持つ。グループを動かしている間（blocked）は行を掴まない。
 * 畳んだ帯では点だけを縦に並べ、名前は title に持つ（base.css）。
 * 行を右クリックするか、行に焦点があるときに . を押すと、その行のセッションのメニュー（1A）を出す。中身は一覧の行の「⋯」と同じである（views/sessionMenu.tsx）。
 * メニューそのものは節（LiveSection）が 1 つだけ持ち、開いている行には印（data-menu）を付けて、どの行のものかを見せる。
 */
/** 行の箱（li）の高さを伸ばし、中の行を倒す。 */
const faceOf = (li: HTMLElement) => (li.firstElementChild as HTMLElement | null) ?? li;
const ROW_MOTION = { enter: (li: HTMLElement) => hangIn(li, faceOf(li)), exit: (li: HTMLElement) => hangOut(li, faceOf(li)), flip: false } as const;
/** 行の出入りの 1 つ分。leaving の行は元の位置に残り、畳んで出てから落ちる。 */
type MotionSlot = { key: string; ref: (el: HTMLElement | null) => void; leaving: boolean };
/**
 * 根の行と、起動元の下の子の列のそれぞれで、行の出入り（ROW_MOTION）を付ける。
 * フックを入れ子の列ごとに持つため、部品に分けた。
 */
function MotionNodes(props: { nodes: RowNode[]; render: (node: RowNode, m: MotionSlot) => ReactNode }) {
  const motion = useMotionList(props.nodes, (n) => n.row.id, ROW_MOTION);
  return <>{motion.list.map(({ item, key, leaving }) => props.render(item, { key, ref: motion.ref(key), leaving }))}</>;
}
const GROUP_MOTION = { enter: (g: HTMLElement) => hangIn(g), exit: (g: HTMLElement) => hangOut(g), flip: false, enterFromEmpty: true, exitWhenEmpty: true } as const;

function RowList(props: { rows: SideLiveRow[]; menuId: string | null; openMenu: (id: string, at: MenuAnchor) => void; blocked: boolean }) {
  const emit = useEmit();
  const t = useT();
  const [sort, setSortState] = useState<Sort | null>(null);
  const setMenu = (m: { id: string; at: MenuAnchor }) => props.openMenu(m.id, m.at);
  const baseId = useId();
  const list = useRef<HTMLUListElement>(null);
  // 押し下げの記録と、並べ替えの途中の形の写し。ポインタのイベントの間で、描き直しを待たずに読むため ref にも持つ。
  const press = useRef<Press | null>(null);
  const sortNow = useRef<Sort | null>(null);
  // 掴んだ行が本体の側（サイドバーの外）にいる間は、並べ替えでなく画面の分割の落とし先を指している（paneDrag）。
  const overBody = useRef(false);
  const [paneOn, setPaneOn] = useState(false);
  const setOverBody = (on: boolean) => { overBody.current = on; setPaneOn(on); };
  const setSort = (next: Sort | null) => { sortNow.current = next; setSortState(next); };
  // 収まりを待つ予約。並びの確定は、ここから最新の行で組み立てる（待つ間に行が増減しても、古い並びで上書きしない）。
  const settleTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // 並べ替えるのは根の行だけで、子は起動元に付いて動く。薄い起動元は、動いている最初の子孫の id（rep）で並びに載る。
  const tops = props.rows.filter((r) => !r.depth);
  const shapedLive = { rows: tops, ids: tops.map(sidOf) };
  const liveNow = useRef(shapedLive);
  // 窓の Esc から呼ぶ、いまの描画の settle。
  const settleRef = useRef<(cancel: boolean) => void>(() => {});
  liveNow.current = shapedLive;
  useEffect(() => () => { if (settleTimer.current) clearTimeout(settleTimer.current); }, []);
  // 並べ替えで離した直後の click を 1 回だけ飲み込む。
  const swallowClick = useRef(false);
  // いまの行の並びでの席。描くたびに id から引き直す。
  const rowIds = shapedLive.ids;
  const at = sort ? sortAt(sort, rowIds) : null;
  // 並べ替えの途中で掴んだ行か指した行が消えたら、並べ替えごとやめる。
  const sortGone = sort !== null && at === null;
  useEffect(() => {
    if (!sortGone) return;
    if (settleTimer.current) clearTimeout(settleTimer.current);
    settleTimer.current = null;
    press.current = null;
    if (overBody.current) { paneDrag.cancel(); setOverBody(false); }
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
      if (overBody.current) { paneDrag.cancel(); setOverBody(false); }
      settleRef.current(true);
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [holding]);
  const live = shapedLive;
  /**
   * 浮いた行を、空いた席（取り消しなら元の席）へ --dur-fast で収め、収まってから並びを確定する。
   * 確定（sidebar.order）と浮きを外すのを 1 回の描画にまとめ、行が入れ替わる前後でちらつかせない。
   * reduced motion では長さが 0 なので、待たずにその場で確定する。
   */
  const settle = (cancel: boolean) => {
    const s = sortNow.current;
    if (!s || s.phase !== 'held') return;
    // 入る先は、離したこの時点で指している行の id として持つ。収まる間に行が増減しても、別の行の前後へ入れないためである。
    const rows = liveNow.current.rows.map(sidOf);
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
    // 開閉の席（子を持つ行の丸の席）を押したときは掴まない。
    if ((e.target as HTMLElement).closest?.('.side-live-seat button')) return;
    // 収まる途中の行は、収まりきるまで掴み直さない。グループを動かしている間も掴まない。
    if (sortNow.current || props.blocked) return;
    press.current = { id: sidOf(r), pointer: e.pointerId, x: e.clientX, y: e.clientY, active: false, cancelled: false };
  };
  const onPointerMove = (e: PointerEvent) => {
    const p = press.current;
    if (!p || p.cancelled || e.pointerId !== p.pointer) return;
    if (!p.active) {
      if (Math.hypot(e.clientX - p.x, e.clientY - p.y) < DRAG_SLOP) return;
      const from = live.rows.findIndex((r) => sidOf(r) === p.id);
      if (from < 0) return;
      p.active = true;
      // 掴んだ行の外へ出ても動きと離したことを受け取れるよう、ポインタをこの行に捕まえる。
      try { e.currentTarget.setPointerCapture?.(e.pointerId); } catch { /* 捕まえられなくても、行の上にいる間は動く */ }
      // 行の間隔は、並んだ行の上端の差で測る。開いた帯と畳んだ帯で行の高さが違うからである。
      const boxes = [...list.current?.querySelectorAll<HTMLElement>(':scope > li:not([data-leaving]) > .side-live-row') ?? []].map((el) => el.getBoundingClientRect());
      const first = boxes[0];
      const last = boxes[boxes.length - 1];
      const pitch = boxes.length > 1 && first && last ? (last.top - first.top) / (boxes.length - 1) : first?.height ?? 0;
      sortNow.current = { phase: 'held', id: p.id, from0: from, pointerDy: 0, pitch: pitch > 0 ? pitch : 30 };
    }
    const s = sortNow.current;
    if (!s || s.phase !== 'held') return;
    // 本体の側（サイドバーの右端より外）に出たら、並べ替えをやめて落とし先を指す。サイドバーへ戻したら並べ替えに戻る。
    const side = list.current?.closest('nav')?.getBoundingClientRect();
    if (side && side.width > 0 && e.clientX > side.right) {
      const row = live.rows.find((r) => sidOf(r) === p.id);
      if (!overBody.current) setOverBody(true);
      paneDrag.move({ kind: 'session', sessionId: row?.id ?? p.id, name: row?.name ?? '', live: row?.live ?? null }, e.clientX, e.clientY);
      // 席に残して並べ替えのずれは 0 に戻す。
      if (!sort || s.pointerDy !== 0) setSort({ ...s, pointerDy: 0 });
      return;
    }
    if (overBody.current) { paneDrag.cancel(); setOverBody(false); }
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
    if (overBody.current) {
      // 本体の上で離した：落とせる所なら pane.open を出し、並びは変えない（元の席へ収める）。
      const hit = paneDrag.finish();
      setOverBody(false);
      if (hit) emit({ type: 'pane.open', sessionId: live.rows.find((r) => sidOf(r) === p.id)?.id ?? p.id, target: hit.target, side: hit.side });
      settle(true);
      return;
    }
    settle(false);
  };
  const onPointerCancel = (e: PointerEvent) => {
    if (press.current?.pointer !== e.pointerId) return;
    press.current = null;
    if (overBody.current) { paneDrag.cancel(); setOverBody(false); }
    settle(true);
  };
  const onClick = (e: MouseEvent, r: SideLiveRow) => {
    e.preventDefault();
    if (swallowClick.current) { swallowClick.current = false; return; }
    // ⌥クリック（ほかは Alt+クリック）は、操作中のペインの右に分割して開く。
    emit(e.altKey ? { type: 'pane.open', sessionId: r.id, target: null, side: 'right' } : { type: 'session.open', id: r.id });
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
    // → で子の列を開き、← で畳む（子を持つ行だけ）。
    if (r.nest && !e.altKey && !e.metaKey && !e.ctrlKey && (e.key === 'ArrowRight' || e.key === 'ArrowLeft') && r.nest.open === (e.key === 'ArrowLeft')) {
      e.preventDefault();
      emit({ type: 'sidebar.fold', key: spawnFoldKey(r.id), open: e.key === 'ArrowRight' });
      return;
    }
    if (!e.altKey || (e.key !== 'ArrowUp' && e.key !== 'ArrowDown')) return;
    e.preventDefault();
    const ids = nudgeId(live.ids, sidOf(r), e.key === 'ArrowUp' ? -1 : 1);
    if (ids !== live.ids) emit({ type: 'sidebar.order', ids });
  };
  const nodeEl = (node: RowNode, top: number | null, m: MotionSlot) => {
    const r = node.row;
    const nest = r.nest;
    const shift = top !== null && at && !m.leaving ? shiftOf(at, top) : 0;
    const lift = top !== null && at && sort?.id === sidOf(r) ? sort.phase : undefined;
    // 浮いた行には、元の席でも 0 を明示して持たせる（戻る動きの行き先が 0 であるため）。
    const style: CSSProperties | undefined = lift || shift ? { translate: `0 ${shift}px` } : undefined;
    // 子の列を持つ行は、列ごと動かすので、ずらしは行ではなく li に掛ける。
    const withKids = node.kids.length > 0;
    const body = `${baseId}-${r.id}`;
    const waitingKids = nest && !nest.open ? nest.dots.filter((d) => d.live === 'waiting').length : 0;
    return (
      <li key={m.key} ref={m.ref} className="side-live-item" data-leaving={m.leaving ? 'true' : undefined} inert={m.leaving || undefined} data-lift={withKids ? lift : undefined} style={withKids ? style : undefined}>
        <a className="side-live-row" href={formatRoute({ name: 'session', id: r.id })} draggable={false} aria-current={r.current ? 'page' : undefined} data-id={r.id} data-menu={props.menuId === r.id ? 'true' : undefined}
          data-live={r.live ?? undefined} data-dim={r.dim ? 'true' : undefined} data-unread={(r.unread ?? 0) > 0 ? 'true' : undefined} data-lift={lift} data-pane-drag={paneOn && sort?.id === sidOf(r) ? 'true' : undefined} style={withKids ? undefined : style}
          title={r.overlap ?? (r.waited ? t('sidebar.live.rowTitle', { name: r.name, waited: r.waited }) : r.name)}
          onClick={(e) => onClick(e, r)} onKeyDown={(e) => onKeyDown(e, r)}
          onContextMenu={(e) => { e.preventDefault(); if (sortNow.current) return; setMenu({ id: r.id, at: { top: e.clientY, bottom: e.clientY, left: e.clientX, width: 0 } }); }}
          onPointerDown={(e) => onPointerDown(e, r)} onPointerMove={onPointerMove} onPointerUp={onPointerUp} onPointerCancel={onPointerCancel}>
          {/* 子を持つ行は、乗せたとき（と焦点のあるとき）だけ、丸の席が開閉の印に替わる。押すと子の列を開閉し、行の他の所は今まで通りセッションへ移る。 */}
          <span className="side-live-seat" data-fold={nest ? 'true' : undefined}>
            <StatusDot status={r.live} aside={r.aside} reason={r.reason} />
            {nest && (
              <button type="button" className="side-live-fold" aria-expanded={nest.open} aria-controls={body} aria-label={t('sidebar.live.nest', { name: r.name })}
                onClick={(e) => { e.preventDefault(); e.stopPropagation(); emit({ type: 'sidebar.fold', key: spawnFoldKey(r.id), open: !nest.open }); }}>
                <Icon name="chevron" />
              </button>
            )}
          </span>
          <span className="side-live-name">{r.name}</span>
          {nest && !nest.open && (
            <span className="side-live-kidots" aria-hidden="true">{nest.dots.map((d, k) => <i key={k} className="dot side-live-kidot" data-status={d.live ?? 'ended'} data-aside={d.aside && d.live === 'busy' ? 'true' : undefined} />)}</span>
          )}
          {waitingKids > 0 && <span className="sr-only">{t('sidebar.count.waiting', { n: waitingKids })}</span>}
          <CountBubble n={r.unread ?? 0} sr={t('sidebar.count.unread', { n: r.unread ?? 0 })} className="side-live-unread" />{r.agent !== undefined && <span className="side-live-agent" data-agent={r.agent ?? 'none'}>{r.agent && <AgentIcon kind={r.agent} />}</span>}{r.overlap && <span className="side-live-overlap" role="img" aria-label={r.overlap} title={r.overlap}><Icon name="warning" /></span>}{r.waited && <span className="side-live-wait num" data-reason={r.reason ?? undefined}>{r.waited}</span>}
        </a>
        {withKids && nest && (
          <FoldBox open={nest.open} keep id={body} className="side-live-kids">
            <ul className="side-live-list side-live-nest"><MotionNodes nodes={node.kids} render={(k, km) => nodeEl(k, null, km)} /></ul>
          </FoldBox>
        )}
      </li>
    );
  };
  const roots = treeOf(props.rows);
  return (
      <ul className="side-live-list" ref={list} data-sorting={at ? 'true' : undefined}>
        <MotionNodes nodes={roots} render={(node, m) => nodeEl(node, m.leaving ? null : roots.indexOf(node), m)} />
      </ul>
  );
}

/**
 * グループを並べ替える途中の形。行の並べ替え（Sort）と同じく、held はポインタに付いている間、settle は離して空いた席（取り消しなら元の席）へ収まる間である。
 * boxes は掴んだときに測ったグループの上端と高さ。グループの高さはまちまちなので、行のように 1 つの間隔では足りない。
 */
type GroupBox = { top: number; height: number };
type GroupSort =
  | { phase: 'held'; key: string; from: number; dy: number; boxes: GroupBox[] }
  | { phase: 'settle'; key: string; from: number; to: number; boxes: GroupBox[] };

/** グループの間のすき間。測った最初の 2 つの差から読む。1 つしか無ければ 0。 */
const groupGap = (boxes: GroupBox[]) => (boxes.length > 1 ? boxes[1]!.top - boxes[0]!.top - boxes[0]!.height : 0);

/**
 * 掴んだグループの縦のずれから、入る席と浮いたグループのずれを決める。両端の先へは DRAG_OVERSHOOT までしか出さない。収まる間は、入る席までのずれを返す。
 * 下へ動かすときは掴んだグループの下の端、上へ動かすときは上の端が、相手の真ん中を越えたら、相手を越えたとみなす。
 * 真ん中同士で比べると、行の多い背の高いグループは、端まで動かしても低いグループの真ん中に届かず、下へ動かせなかった（2026-10-24）。
 */
function groupSlot(g: GroupSort): { to: number; dy: number } {
  const { boxes, from } = g;
  const gap = groupGap(boxes);
  if (g.phase === 'settle') {
    const passed = (g.to > from ? boxes.slice(from + 1, g.to + 1) : boxes.slice(g.to, from)).reduce((n, b) => n + b.height + gap, 0);
    return { to: g.to, dy: g.to > from ? passed : -passed };
  }
  const me = boxes[from]!;
  const first = boxes[0]!;
  const last = boxes[boxes.length - 1]!;
  const dy = Math.max(first.top - me.top - DRAG_OVERSHOOT, Math.min(last.top + last.height - (me.top + me.height) + DRAG_OVERSHOOT, g.dy));
  const top = me.top + dy;
  const bottom = top + me.height;
  const mid = (b: GroupBox) => b.top + b.height / 2;
  const down = boxes.filter((b, j) => j > from && mid(b) < bottom).length;
  const up = boxes.filter((b, j) => j < from && mid(b) > top).length;
  return { to: from + down - up, dy };
}

/** 並べ替えの途中で、席 j のグループをずらす幅。掴んだグループが通り過ぎたグループは、掴んだグループの高さ分だけ逆へよける。 */
function groupShift(g: GroupSort, j: number): number {
  const { to, dy } = groupSlot(g);
  if (j === g.from) return dy;
  const span = g.boxes[g.from]!.height + groupGap(g.boxes);
  if (g.from < to && j > g.from && j <= to) return -span;
  if (g.from > to && j >= to && j < g.from) return span;
  return 0;
}

/**
 * 「実行中」の節。行をプロジェクトごとのグループに分けて並べる。
 * 見出しを押すとそのグループを畳み、もう一度押すと開く（sidebar.fold）。開き閉じは FoldBox で伸び縮みさせる。
 * 畳んだグループに入力待ちがあれば、見出しに待ちの印を付ける。畳んでも待っていることを見落とさないためである。
 * 見出しを掴んで上下に動かすと、グループごと並べ替えられる。行と同じく浮いてポインタに付き、ほかのグループはその高さ分よける。
 * 見出しに焦点があるときは ⌥↑ と ⌥↓ でグループを 1 つずつ動かす。グループの順は別に持たず、つないだ並びを sidebar.order で覚え直す。
 * 行の並べ替えはグループの中だけで行う（RowList）。行のプロジェクトは並べ替えでは変わらないからである。
 * 見出し（実行中）は動かさず、グループの並び（.side-live-scroll）だけを、設定の上までの高さでスクロールさせる。
 * 行のメニューは節に 1 つだけ持ち、開いている行には印（data-menu）を付ける。
 */
function LiveSection(props: { live: SideLiveProps }) {
  const emit = useEmit();
  const t = useT();
  const baseId = useId();
  // 開いているメニュー。at は吊るす相手で、右クリックなら押した点、打鍵なら行の矩形。
  const [menu, setMenu] = useState<{ id: string; at: MenuAnchor } | null>(null);
  const scroll = useRef<HTMLDivElement>(null);
  const [gsort, setGsortState] = useState<GroupSort | null>(null);
  const gsortNow = useRef<GroupSort | null>(null);
  const setGsort = (next: GroupSort | null) => { gsortNow.current = next; setGsortState(next); };
  const gpress = useRef<{ key: string; pointer: number; y: number; active: boolean } | null>(null);
  const gswallow = useRef(false);
  const gtimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const liveNow = useRef(props.live);
  liveNow.current = props.live;
  useEffect(() => () => { if (gtimer.current) clearTimeout(gtimer.current); }, []);
  // 一覧の底を薄れさせて、まだ下へ続くことを見せる。底まで来たら（続きが無ければ）外す。
  const [atEnd, setAtEnd] = useState(true);
  const measureEnd = () => { const el = scroll.current; if (el) setAtEnd(el.scrollTop + el.clientHeight >= el.scrollHeight - 1); };
  useLayoutEffect(measureEnd);
  // 開いている間に行が消えたら（ほかの場所で止めた、Claude が自分で終わった）、開いていたことも忘れる。同じ行がまた現れたときに、勝手に開き直さないためである。
  const gone = menu !== null && !props.live.rows.some((r) => r.id === menu.id);
  useEffect(() => { if (gone) setMenu(null); }, [gone]);
  const { live } = props;
  // 最後の行が消えたあとも、グループが畳み終わるまでは描く。
  const groupMotion = useMotionList(live.groups, (g) => g.key, GROUP_MOTION);
  if (live.count === 0 && groupMotion.list.length === 0) return null;
  const menuRow = menu ? live.rows.find((r) => r.id === menu.id) ?? null : null;
  const closeMenu = (how: MenuCloseHow) => {
    const id = menu?.id;
    setMenu(null);
    // 外を押したときは、押した先にフォーカスを任せる。ほかは行へ戻す（止めて行が消えたら、戻す先は無い）。
    if (how !== 'outside' && id) scroll.current?.querySelector<HTMLElement>(`[data-id="${CSS.escape(id)}"]`)?.focus();
  };
  /** グループをこの順に並べた並びを覚える。いまの並びと同じなら何もしない。 */
  const order = (groups: SideLiveGroup[]) => {
    const ids = groups.flatMap((g) => g.rows.filter((r) => !r.dim).map((r) => r.id));
    if (ids.some((id, i) => id !== liveNow.current.ids[i])) emit({ type: 'sidebar.order', ids });
  };
  /** 浮いたグループを空いた席（取り消しなら元の席）へ --dur-fast で収め、収まってからグループの順を確定する。行の settle と同じ組み立てである。 */
  const gsettle = (cancel: boolean) => {
    const g = gsortNow.current;
    if (!g || g.phase !== 'held') return;
    const next: GroupSort = { phase: 'settle', key: g.key, from: g.from, to: cancel ? g.from : groupSlot(g).to, boxes: g.boxes };
    setGsort(next);
    const finish = () => {
      gtimer.current = null;
      if (gsortNow.current !== next) return;
      // 確定は最新のグループで組み立てる。収まる間にグループが増減しても、掴んだグループを入る席へ移すだけにする。
      const groups = [...liveNow.current.groups];
      const from = groups.findIndex((x) => x.key === next.key);
      flushSync(() => {
        if (from >= 0 && next.to !== from) {
          const [moved] = groups.splice(from, 1);
          groups.splice(Math.min(next.to, groups.length), 0, moved!);
          order(groups);
        }
        setGsort(null);
      });
    };
    const ms = motionMs('--dur-fast');
    if (ms > 0) gtimer.current = setTimeout(finish, ms);
    else finish();
  };
  const onHeadDown = (e: PointerEvent, key: string) => {
    if (e.button !== 0 || e.ctrlKey || e.isPrimary === false || gsortNow.current) return;
    gpress.current = { key, pointer: e.pointerId, y: e.clientY, active: false };
  };
  const onHeadMove = (e: PointerEvent) => {
    const p = gpress.current;
    if (!p || e.pointerId !== p.pointer) return;
    if (!p.active) {
      if (Math.abs(e.clientY - p.y) < DRAG_SLOP) return;
      const els = [...scroll.current?.querySelectorAll<HTMLElement>('[data-group]:not([data-leaving])') ?? []];
      const from = els.findIndex((el) => el.dataset.group === p.key);
      if (from < 0) return;
      p.active = true;
      try { e.currentTarget.setPointerCapture?.(e.pointerId); } catch { /* 捕まえられなくても、見出しの上にいる間は動く */ }
      gsortNow.current = { phase: 'held', key: p.key, from, dy: 0, boxes: els.map((el) => { const r = el.getBoundingClientRect(); return { top: r.top, height: r.height }; }) };
    }
    const g = gsortNow.current;
    if (!g || g.phase !== 'held') return;
    setGsort({ ...g, dy: e.clientY - p.y });
  };
  const onHeadUp = (e: PointerEvent) => {
    const p = gpress.current;
    if (!p || e.pointerId !== p.pointer) return;
    gpress.current = null;
    if (!p.active) return;
    // 離した直後の click で畳まない。click が来なかったときに、次の押し下げまで飲み込みを残さない。
    gswallow.current = true;
    setTimeout(() => { gswallow.current = false; }, 0);
    gsettle(false);
  };
  const onHeadCancel = (e: PointerEvent) => {
    if (gpress.current?.pointer !== e.pointerId) return;
    gpress.current = null;
    gsettle(true);
  };
  const onHeadClick = (g: SideLiveGroup) => {
    if (gswallow.current) { gswallow.current = false; return; }
    emit({ type: 'sidebar.fold', key: g.key, open: !g.open });
  };
  const onHeadKey = (e: KeyboardEvent, g: SideLiveGroup) => {
    if (gsortNow.current || !e.altKey || (e.key !== 'ArrowUp' && e.key !== 'ArrowDown')) return;
    e.preventDefault();
    const keys = nudgeId(live.groups.map((x) => x.key), g.key, e.key === 'ArrowUp' ? -1 : 1);
    order(keys.map((k) => live.groups.find((x) => x.key === k)!));
  };
  return (
    <section className="side-live" aria-label={t('sidebar.live.label')}>
      <div className="side-live-scroll" ref={scroll} onScroll={measureEnd} data-end={atEnd ? 'true' : undefined} data-sorting={gsort ? 'true' : undefined}>
        {groupMotion.list.map(({ item: g, key, leaving }) => {
          const i = live.groups.indexOf(g);
          const shift = gsort && !leaving ? groupShift(gsort, i) : 0;
          const lift = gsort?.key === g.key ? gsort.phase : undefined;
          const style: CSSProperties | undefined = lift || shift ? { translate: `0 ${shift}px` } : undefined;
          const body = `${baseId}-g${key}`;
          return (
            <div key={key} ref={groupMotion.ref(key)} className="side-live-grp" data-group={g.key} data-lift={lift} data-leaving={leaving ? 'true' : undefined} inert={leaving || undefined} style={style}>
              <button type="button" className="side-live-grp-h" aria-expanded={g.open} aria-controls={body} data-waiting={!g.open && g.waiting > 0 ? 'true' : undefined}
                onClick={() => onHeadClick(g)} onKeyDown={(e) => onHeadKey(e, g)}
                onPointerDown={(e) => onHeadDown(e, g.key)} onPointerMove={onHeadMove} onPointerUp={onHeadUp} onPointerCancel={onHeadCancel}>
                <span className="side-live-grp-chev" aria-hidden="true"><Icon name="chevron" /></span>
                <span className="side-live-grp-name">{g.name}</span>
                <span className="side-live-grp-dot" aria-hidden="true" />
                {!g.open && g.waiting > 0 && <span className="sr-only">{t('sidebar.count.waiting', { n: g.waiting })}</span>}
              </button>
              <FoldBox open={g.open} keep id={body} className="side-live-grp-body">
                <RowList rows={g.rows} menuId={menu?.id ?? null} openMenu={(id, at) => setMenu({ id, at })} blocked={gsort !== null} />
              </FoldBox>
            </div>
          );
        })}
      </div>
      {menuRow && menu && <SessionMenuPop key={menuRow.id} menu={menuRow.menu} at={menu.at} onClose={closeMenu} />}
    </section>
  );
}

/**
 * サイドバー。上から「ホーム」「プロジェクト」の 2 項目、「実行中」の節、下端の「設定」の順に置く（設計書 2.1）。
 * 設定は foot で受け取り、残りの高さの底に寄せる。
 */
export function Sidebar(props: { nav: NavItem[]; foot: NavItem[]; collapsed: boolean; live: SideLiveProps }) {
  const emit = useEmit();
  const t = useT();
  const item = (n: NavItem) => (
    <a key={n.label} className="nav-item" href={formatRoute(n.route)} aria-current={n.current ? 'page' : undefined} onClick={(e) => { e.preventDefault(); emit({ type: 'nav.go', to: n.route }); }}>{NAV_ICON[n.route.name] && <Icon name={NAV_ICON[n.route.name]!} />}<span className="nav-label">{n.label}</span><NavCount n={n.count} waiting={n.waiting} unread={n.unread} /></a>
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
