import { useEffect, useLayoutEffect, useRef, useState, type FocusEvent, type KeyboardEvent, type MouseEvent, type PointerEvent as ReactPointerEvent, type ReactNode, type RefObject } from 'react';
import { useEmit } from '../action/chain.tsx';
import type { TodoItemProps, TodoSuggestionProps } from '../presenters/project.ts';
import { isComposing } from './ime.ts';
import { Icon } from './primitives/Icon.tsx';
import { useT } from './primitives/language.tsx';
import { collapseOut, fadeIn, growIn, motionOn, riseIn, slideFrom } from './primitives/motionKit.ts';
import { revealWithin } from './primitives/revealWithin.ts';
import { RollingNumber } from './primitives/RollingNumber.tsx';

/** 完了にした行を、もとの場所に済みの形で残す長さ。押せたことを見せ、押し間違いをその場で戻せるようにする。 */
export const TODO_SETTLE_MS = 1500;
/** 消した場所の「元に戻す」の帯を出しておく長さ。 */
export const TODO_GONE_MS = 6000;
/** 並べ替えを送ってから、サーバの並びが追いつくのを待つ上限。追いつかなければ、手元の並びを捨ててサーバの並びに戻す。 */
const ORDER_HOLD_MS = 3000;

type Pos = { left: number; top: number };
/** 完了にして、もとの場所に残している行。seenDone はサーバの知らせで完了になったのを見届けたか（その後に未完で届いたら、ほかの操作で戻された）。 */
type Settling = { item: TodoItemProps; index: number; seenDone: boolean };
type Gone = { id: string; text: string; list: 'open' | 'done'; index: number; seenGone: boolean };

/**
 * 行の出入りと並びの動き。
 * 描画のたびに行の位置（欄の左上からの相対）を測り、前の位置から今の位置へ滑らせ（FLIP）、新しく入った行はぼかしが晴れながら上がって来る。
 * 欄の外がスクロールしても動かないよう、窓ではなく欄からの位置で比べる。
 * ドラッグを離したときと、畳んで出した行を外すときは、snapshot で今見えている位置（transform を含む）を前の位置にする。
 * そうしないと、前の描画の位置へいったん戻ってから滑り直す。
 */
function useRowMotion(root: RefObject<HTMLElement | null>) {
  const nodes = useRef(new Map<string, HTMLElement>());
  const prev = useRef<Map<string, Pos> | null>(null);
  const forced = useRef<Map<string, Pos> | null>(null);
  const measure = () => {
    const base = root.current?.getBoundingClientRect();
    const m = new Map<string, Pos>();
    for (const [k, el] of nodes.current) {
      const r = el.getBoundingClientRect();
      m.set(k, { left: r.left - (base?.left ?? 0), top: r.top - (base?.top ?? 0) });
    }
    return m;
  };
  useLayoutEffect(() => {
    const now = measure();
    const before = forced.current ?? prev.current;
    if (before) {
      for (const [k, el] of nodes.current) {
        const b = before.get(k);
        if (!b) { if (k.startsWith('gone:')) fadeIn(el); else riseIn(el); continue; }
        slideFrom(el, b, now.get(k)!);
      }
    }
    forced.current = null;
    prev.current = now;
  });
  return {
    nodes,
    ref: (key: string) => (el: HTMLElement | null) => { if (el) nodes.current.set(key, el); else nodes.current.delete(key); },
    snapshot: () => { forced.current = measure(); },
    /** 畳んで出してから then を呼ぶ。動かないとき（reduced motion、要素が無い）はすぐ呼ぶ。 */
    leave: (key: string, then: () => void) => {
      const el = nodes.current.get(key);
      const done = () => { forced.current = measure(); then(); };
      // 動かないときは待たずに呼ぶ。待つと、押した操作が 1 拍遅れて届く。
      if (!el || !motionOn(el)) { then(); return; }
      collapseOut(el).then(done, done);
    },
  };
}

const sameOrder = (a: string[], b: string[]) => a.length === b.length && a.every((x, i) => x === b[i]);

/**
 * プロジェクトの TODO（右の欄）。
 * 未完は position の順に並び、全文を折り返して出す。完了は下の「完了 N」に畳み、Claude の提案は上の「Claude の提案」の節に置く。
 * 行を押すと選び、キーで動かせる（表は keys.ts の todo の群）。文言はダブルクリックか Enter で、その場で直す。
 * 完了にした行は、少しの間もとの場所に済みの形で残してから畳む。消した行は、その場に「元に戻す」の帯を残す。
 * ここで持つのは見た目の途中の状態（選択、編集中の文、残している行、帯、送ったばかりの並び）だけで、TODO の正は props である。
 * 取り消しの積みは Mediator が持つ（mediator/todos.ts）。
 */
export function TodoList(props: { projectId: string; todos: TodoItemProps[]; done: TodoItemProps[]; suggestions: TodoSuggestionProps[] }) {
  const emit = useEmit();
  const t = useT();
  const root = useRef<HTMLDivElement>(null);
  const motion = useRowMotion(root);
  const [sel, setSel] = useState<string | null>(null);
  const [editing, setEditing] = useState<{ id: string; draft: string } | null>(null);
  const editingRef = useRef<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [addText, setAddText] = useState('');
  const [doneOpen, setDoneOpen] = useState(false);
  const [propOpen, setPropOpen] = useState<string | null>(null);
  const [settling, setSettling] = useState<Record<string, Settling>>({});
  const [gone, setGone] = useState<Gone[]>([]);
  const [order, setOrder] = useState<string[] | null>(null);
  const [texts, setTexts] = useState<Record<string, string>>({});
  const timers = useRef(new Set<ReturnType<typeof setTimeout>>());
  const later = (fn: () => void, ms: number) => { const h = setTimeout(() => { timers.current.delete(h); fn(); }, ms); timers.current.add(h); };
  useEffect(() => () => { for (const h of timers.current) clearTimeout(h); }, []);
  const focusAfter = useRef<string | null>(null);

  // ── 並び ──
  const goneIds = new Set(gone.map((g) => g.id));
  const textOf = <T extends { id: string; text: string }>(x: T): T => (texts[x.id] !== undefined ? { ...x, text: texts[x.id]! } : x);
  const rank = (id: string, position: number) => { const i = order ? order.indexOf(id) : -1; return i < 0 ? Number.MAX_SAFE_INTEGER - 1e6 + position : i; };
  // 知らせが届く前の完了は、手元で済みの形にしておく（押した瞬間に満ちるように）。
  const settledLook = (x: TodoItemProps): TodoItemProps => (settling[x.id] && !settling[x.id]!.seenDone ? { ...x, done: true, candidate: null } : x);
  const open: TodoItemProps[] = props.todos.filter((x) => !goneIds.has(x.id)).map(textOf).map(settledLook).sort((a, b) => (order ? rank(a.id, a.position) - rank(b.id, b.position) : a.position - b.position));
  for (const s of Object.values(settling).sort((a, b) => a.index - b.index)) {
    if (open.some((x) => x.id === s.item.id) || goneIds.has(s.item.id)) continue;
    const latest = props.done.find((x) => x.id === s.item.id);
    open.splice(Math.min(s.index, open.length), 0, textOf({ ...(latest ?? s.item), done: true, candidate: null }));
  }
  const done = props.done.filter((x) => !settling[x.id] && !goneIds.has(x.id)).map(textOf);
  const suggestions = props.suggestions.filter((x) => !goneIds.has(x.id)).map(textOf);
  const doneCount = props.done.filter((x) => !settling[x.id]).length;
  const navIds = [...suggestions.map((x) => x.id), ...open.map((x) => x.id), ...(doneOpen ? done.map((x) => x.id) : [])];
  const isSuggestion = (id: string) => suggestions.some((x) => x.id === id);
  const findItem = (id: string) => open.find((x) => x.id === id) ?? done.find((x) => x.id === id);

  // サーバの並びが手元の並びに追いついたら、手元の並びを捨てる。
  useEffect(() => {
    if (!order) return;
    const server = [...props.todos].sort((a, b) => a.position - b.position).map((x) => x.id);
    if (sameOrder(server, order.filter((id) => server.includes(id)))) setOrder(null);
  }, [props.todos, order]);
  // 直した文言は、サーバの知らせで同じ文言が届いたら手元から外す。
  useEffect(() => {
    const all = [...props.todos, ...props.done, ...props.suggestions];
    const left = Object.entries(texts).filter(([id, v]) => all.find((x) => x.id === id)?.text !== v);
    if (left.length !== Object.keys(texts).length) setTexts(Object.fromEntries(left));
  }, [props.todos, props.done, props.suggestions, texts]);
  // 消した帯：サーバの知らせで消えたことを見届け、そのあと ⌘Z などで戻ってきたら帯を外す。
  useEffect(() => {
    const has = (id: string) => props.todos.some((x) => x.id === id) || props.done.some((x) => x.id === id) || props.suggestions.some((x) => x.id === id);
    let changed = false;
    const next = gone.flatMap((g) => {
      if (!g.seenGone && !has(g.id)) { changed = true; return [{ ...g, seenGone: true }]; }
      if (g.seenGone && has(g.id)) { changed = true; return []; }
      return [g];
    });
    if (changed) setGone(next);
  }, [props.todos, props.done, props.suggestions, gone]);
  // 残している行は、完了で届いたら見届けた印を付け、そのあと未完で届いたら（⌘Z やほかの端末で戻された）残すのをやめる。
  useEffect(() => {
    let changed = false;
    const next: Record<string, Settling> = {};
    for (const [id, st] of Object.entries(settling)) {
      if (!st.seenDone && props.done.some((x) => x.id === id)) { next[id] = { ...st, seenDone: true }; changed = true; }
      else if (st.seenDone && props.todos.some((x) => x.id === id)) changed = true;
      else next[id] = st;
    }
    if (changed) setSettling(next);
  }, [props.todos, props.done, settling]);
  const settlingRef = useRef(settling);
  settlingRef.current = settling;
  const goneRef = useRef(gone);
  goneRef.current = gone;
  // キーで選んだ行へフォーカスを移す。
  useLayoutEffect(() => {
    const id = focusAfter.current;
    if (!id) return;
    focusAfter.current = null;
    const el = motion.nodes.current.get(id);
    if (!el) return;
    el.focus({ preventScroll: true });
    const box = el.closest<HTMLElement>('.main');
    if (box) revealWithin(box, el);
  });

  // ── 操作 ──
  const select = (id: string | null, focus = true) => { setSel(id); if (id && focus) focusAfter.current = id; };
  const neighbor = (id: string) => { const i = navIds.indexOf(id); return navIds[i + 1] ?? navIds[i - 1] ?? null; };

  const toggle = (x: TodoItemProps, confirm = false) => {
    emit(confirm ? { type: 'todo.confirm', id: x.id } : { type: 'todo.toggle', id: x.id });
    if (x.done) {
      setSettling((s) => { const { [x.id]: _, ...rest } = s; return rest; });
      return;
    }
    // 完了にした（候補の確定も同じ）。済みの形でその場に残し、少ししてから畳んで下へ送る。
    const index = open.findIndex((o) => o.id === x.id);
    setSettling((s) => ({ ...s, [x.id]: { item: { ...x, done: true, candidate: null }, index, seenDone: false } }));
    setPropOpen((p) => (p === x.id ? null : p));
    const drop = () => setSettling((s) => { const { [x.id]: _, ...rest } = s; return rest; });
    // その間に未完へ戻されていたら、畳まない（畳むと、残っている未完の行まで隠れる）。
    later(() => { if (settlingRef.current[x.id]) motion.leave(x.id, drop); }, TODO_SETTLE_MS);
  };
  const remove = (id: string, text: string) => {
    const inOpen = open.findIndex((x) => x.id === id);
    const list: Gone['list'] = inOpen >= 0 ? 'open' : 'done';
    const index = inOpen >= 0 ? inOpen : done.findIndex((x) => x.id === id);
    emit({ type: 'todo.remove', id });
    if (sel === id) select(neighbor(id));
    setSettling((s) => { const { [id]: _, ...rest } = s; return rest; });
    setGone((g) => [...g.filter((x) => x.id !== id), { id, text, list, index, seenGone: false }]);
    later(() => { if (goneRef.current.some((x) => x.id === id)) motion.leave(`gone:${id}`, () => setGone((g) => g.filter((x) => x.id !== id))); }, TODO_GONE_MS);
  };
  const undoGone = (g: Gone) => {
    emit({ type: 'todo.undo', projectId: props.projectId, todoId: g.id });
    setGone((all) => all.filter((x) => x.id !== g.id));
  };
  const accept = (id: string) => { if (sel === id) select(neighbor(id)); emit({ type: 'todo.accept', id }); };
  const dismiss = (id: string) => {
    if (sel === id) select(neighbor(id));
    motion.leave(id, () => emit({ type: 'todo.dismiss', id }));
  };
  const move = (ids: string[]) => { setOrder(ids); emit({ type: 'todo.move', projectId: props.projectId, ids }); later(() => setOrder((o) => (o === ids ? null : o)), ORDER_HOLD_MS); };
  const movable = () => open.filter((x) => !x.done).map((x) => x.id);
  const moveBy = (id: string, delta: number, toEnd: boolean) => {
    const ids = movable();
    const i = ids.indexOf(id);
    if (i < 0) return;
    const j = toEnd ? (delta < 0 ? 0 : ids.length - 1) : Math.max(0, Math.min(ids.length - 1, i + delta));
    if (i === j) return;
    ids.splice(i, 1);
    ids.splice(j, 0, id);
    move(ids);
  };

  const startEdit = (id: string, text: string) => { editingRef.current = id; setEditing({ id, draft: text }); setSel(id); };
  const endEdit = (commit: boolean) => {
    const e = editing;
    if (!e || editingRef.current !== e.id) return;
    editingRef.current = null;
    setEditing(null);
    focusAfter.current = e.id;
    if (!commit) return;
    const cur = findItem(e.id) ?? suggestions.find((x) => x.id === e.id);
    if (!cur) return;
    const v = e.draft.trim();
    if (!v) { if (isSuggestion(e.id)) dismiss(e.id); else remove(e.id, cur.text); return; }
    if (v === cur.text) return;
    setTexts((m) => ({ ...m, [e.id]: v }));
    emit({ type: 'todo.edit', id: e.id, text: v });
  };

  const openAdd = () => { setAdding(true); setSel(null); };
  const submitAdd = () => {
    const v = addText.trim();
    if (!v) return;
    emit({ type: 'todo.add', projectId: props.projectId, text: v });
    setAddText('');
  };

  // ── キー ──
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const target = e.target as HTMLElement;
    if (target.closest('input, textarea') || isComposing(e)) return;
    const k = e.key;
    const handled = () => { e.preventDefault(); e.stopPropagation(); };
    if ((e.metaKey || e.ctrlKey) && !e.shiftKey && k.toLowerCase() === 'z') { handled(); emit({ type: 'todo.undo', projectId: props.projectId }); return; }
    const id = sel && navIds.includes(sel) ? sel : null;
    if (e.altKey && (k === 'ArrowUp' || k === 'ArrowDown')) { handled(); if (id && !isSuggestion(id)) moveBy(id, k === 'ArrowUp' ? -1 : 1, e.metaKey || e.ctrlKey); return; }
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    if (k === 'ArrowDown' || k === 'j' || k === 'ArrowUp' || k === 'k') {
      handled();
      const d = k === 'ArrowDown' || k === 'j' ? 1 : -1;
      const i = id ? navIds.indexOf(id) : d > 0 ? -1 : navIds.length;
      const n = navIds[Math.max(0, Math.min(navIds.length - 1, i + d))];
      if (n) select(n);
      return;
    }
    if (k === 'a' || k === 'n') { handled(); openAdd(); return; }
    if (k === 'Escape') { if (id) { handled(); setSel(null); } return; }
    if (!id) return;
    const s = suggestions.find((x) => x.id === id);
    if (s) {
      if (k === 'Enter') { handled(); accept(id); }
      else if (k === 'Backspace' || k === 'Delete') { handled(); dismiss(id); }
      else if (k === 'e') { handled(); startEdit(id, s.text); }
      return;
    }
    const x = findItem(id);
    if (!x) return;
    if (k === ' ' || k === 'x') { handled(); toggle(x); }
    else if (k === 'Enter' || k === 'e') { handled(); startEdit(id, x.text); }
    else if (k === 'Backspace' || k === 'Delete') { handled(); remove(id, x.text); }
    else if (k === 'r' && x.candidate) { handled(); emit({ type: 'todo.reject', id }); }
  };

  // ── ドラッグで並べ替え ──
  // 動かすのは DOM の transform だけで、離すまで描き直さない。離したら、見えている位置を前の位置にして並びを送る。
  const drag = useRef<{ id: string; ids: string[]; els: HTMLElement[]; mids: number[]; h: number; from: number; to: number; startY: number; pointer: number } | null>(null);
  const onDragStart = (e: ReactPointerEvent<HTMLElement>, id: string) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const ids = movable();
    const els = ids.map((x) => motion.nodes.current.get(x)).filter((x): x is HTMLElement => !!x);
    const from = ids.indexOf(id);
    if (from < 0 || els.length !== ids.length) return;
    const rects = els.map((el) => el.getBoundingClientRect());
    drag.current = { id, ids, els, mids: rects.map((r) => r.top + r.height / 2), h: rects[from]!.height, from, to: from, startY: e.clientY, pointer: e.pointerId };
    (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
    els[from]!.setAttribute('data-dragging', 'true');
    for (const el of els) el.style.transition = 'transform var(--dur-fast) var(--ease-out)';
    els[from]!.style.transition = 'none';
    setSel(id);
  };
  const onDragMove = (e: ReactPointerEvent<HTMLElement>) => {
    const d = drag.current;
    if (!d || e.pointerId !== d.pointer) return;
    const dy = e.clientY - d.startY;
    const center = d.mids[d.from]! + dy;
    let to = d.from;
    for (let j = 0; j < d.mids.length; j++) {
      if (j < d.from && center < d.mids[j]!) { to = j; break; }
      if (j > d.from && center > d.mids[j]!) to = j;
    }
    d.to = to;
    d.els.forEach((el, j) => {
      if (j === d.from) { el.style.transform = `translateY(${dy}px)`; return; }
      const shift = d.from < to && j > d.from && j <= to ? -d.h : to < d.from && j >= to && j < d.from ? d.h : 0;
      el.style.transform = shift ? `translateY(${shift}px)` : '';
    });
  };
  const onDragEnd = (e: ReactPointerEvent<HTMLElement>, cancel = false) => {
    const d = drag.current;
    if (!d || e.pointerId !== d.pointer) return;
    drag.current = null;
    if (!cancel && d.to !== d.from) motion.snapshot();
    for (const el of d.els) { el.style.transition = cancel || d.to === d.from ? 'transform var(--dur-fast) var(--ease-out)' : 'none'; el.style.transform = ''; el.removeAttribute('data-dragging'); }
    if (cancel || d.to === d.from) return;
    const ids = d.ids.slice();
    ids.splice(d.from, 1);
    ids.splice(d.to, 0, d.id);
    move(ids);
  };

  // ── 描画 ──
  const nth = (text: string, n: number) => t('projectScreen.todo.nth', { text, n });
  const rowProps = (id: string) => ({
    ref: motion.ref(id),
    tabIndex: (sel && navIds.includes(sel) ? sel === id : navIds[0] === id) ? 0 : -1,
    'aria-current': sel === id ? ('true' as const) : undefined,
    onFocus: (e: FocusEvent<HTMLLIElement>) => { if (e.target === e.currentTarget) setSel(id); },
    onClick: (e: MouseEvent<HTMLLIElement>) => { if (!(e.target as HTMLElement).closest('button, a, textarea, input')) setSel(id); },
  });
  const editor = (id: string, label: string) => (
    <textarea className="todo-edit" rows={1} aria-label={t('projectScreen.todo.edit', { name: label })} value={editing!.draft} autoFocus
      ref={(el) => { if (el) { el.style.height = 'auto'; el.style.height = `${el.scrollHeight}px`; } }}
      onFocus={(e) => { const n = e.currentTarget.value.length; e.currentTarget.setSelectionRange(n, n); }}
      // 1 行の TODO なので改行は入れない。貼り付けた改行は空白にする。
      onChange={(e) => setEditing({ id, draft: e.target.value.replace(/\r?\n/g, ' ') })}
      onKeyDown={(e) => {
        if (isComposing(e)) return;
        if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); endEdit(true); }
        else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); endEdit(false); }
      }}
      onBlur={() => endEdit(true)} />
  );

  const todoRow = (x: TodoItemProps, i: number, inDone: boolean) => {
    const label = nth(x.text, i + 1);
    const c = x.candidate;
    const isEditing = editing?.id === x.id;
    const open_ = propOpen === x.id && !!c;
    return (
      <li key={x.id} className="todo-row" data-done={x.done ? 'true' : undefined} data-candidate={c ? 'true' : undefined} {...rowProps(x.id)}>
        {inDone || x.done
          ? <span className="todo-grip" aria-hidden="true" />
          : <span className="todo-grip" data-handle="" aria-hidden="true" title={t('projectScreen.todo.drag', { name: label })}
              onPointerDown={(e) => onDragStart(e, x.id)} onPointerMove={onDragMove} onPointerUp={(e) => onDragEnd(e)} onPointerCancel={(e) => onDragEnd(e, true)}><GripIcon /></span>}
        {/* 押すと緑に満ち、チェックの線が描かれる。候補の間は半分だけ満ちた印にする。 */}
        <button type="button" role="checkbox" tabIndex={-1} className="todo-check" data-candidate={c ? 'true' : undefined} aria-checked={x.done}
          aria-label={c ? t('projectScreen.todo.nthCandidate', { text: x.text, n: i + 1 }) : label} aria-describedby={open_ ? `todo-why-${x.id}` : undefined}
          onClick={() => toggle(x)}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5" /></svg>
        </button>
        {isEditing ? editor(x.id, label) : (
          <>
            <span className="todo-text" onDoubleClick={() => startEdit(x.id, x.text)}><span className="todo-strike">{x.text}</span></span>
            {c
              ? <button type="button" className="todo-chip" aria-expanded={open_} aria-label={t('projectScreen.todo.candidateChipLabel', { name: label })} onClick={() => setPropOpen(open_ ? null : x.id)}>{t('projectScreen.todo.candidateChip')}</button>
              : <button type="button" tabIndex={-1} className="todo-del" aria-label={t('projectScreen.todo.delete', { name: label })} onClick={() => remove(x.id, x.text)}><Icon name="close" /></button>}
          </>
        )}
        {open_ && c && !isEditing && (
          <Grow className="todo-prop">
            <div className="todo-why" id={`todo-why-${x.id}`}>{c.note}</div>
            <div className="todo-src">
              {c.sessionId
                ? <button type="button" className="todo-src-link" onClick={() => emit({ type: 'session.open', id: c.sessionId! })}>{c.sessionName}</button>
                : <span>{c.sessionName}</span>}
              <span> · {c.ago}</span>
            </div>
            <div className="todo-acts">
              <button type="button" className="btn btn-primary" aria-label={t('projectScreen.todo.confirm', { name: label })} onClick={() => toggle(x, true)}>{t('projectScreen.todo.confirmButton')}</button>
              <button type="button" className="btn" aria-label={t('projectScreen.todo.reject', { name: label })} onClick={() => { setPropOpen(null); emit({ type: 'todo.reject', id: x.id }); }}>{t('projectScreen.todo.rejectButton')}</button>
            </div>
          </Grow>
        )}
      </li>
    );
  };
  const goneRow = (g: Gone) => (
    <li key={`gone:${g.id}`} ref={motion.ref(`gone:${g.id}`)} className="todo-gone">
      <span className="todo-gone-text">{t('projectScreen.todo.removed', { text: g.text })}</span>
      <button type="button" className="btn btn-sm" aria-label={t('projectScreen.todo.undoLabel', { text: g.text })} onClick={() => undoGone(g)}>{t('projectScreen.todo.undo')}</button>
    </li>
  );
  /** 消した帯を、消えた行のあった場所へ差し込む。 */
  const withGone = (rows: ReactNode[], list: Gone['list']) => {
    const out = rows.slice();
    for (const g of gone.filter((x) => x.list === list).sort((a, b) => a.index - b.index)) out.splice(Math.min(g.index, out.length), 0, goneRow(g));
    return out;
  };

  const empty = open.length === 0 && done.length === 0 && suggestions.length === 0 && gone.length === 0;
  return (
    <div className="todos" ref={root} onKeyDown={onKeyDown}>
      {suggestions.length > 0 && (
        <div className="todo-sugg" role="group" aria-labelledby="todo-sugg-h">
          <div className="todo-sugg-h">
            <span id="todo-sugg-h"><Icon name="agent" /> {t('projectScreen.todo.suggestions')} <RollingNumber value={suggestions.length} /></span>
            {suggestions.length > 1 && <button type="button" className="todo-link" onClick={() => suggestions.forEach((s) => emit({ type: 'todo.accept', id: s.id }))}>{t('projectScreen.todo.acceptAll')}</button>}
          </div>
          <ul className="todo-list">
            {suggestions.map((s, i) => {
              const label = nth(s.text, i + 1);
              return (
                <li key={s.id} className="todo-row todo-row-sugg" {...rowProps(s.id)}>
                  <span className="todo-grip" aria-hidden="true" />
                  <span className="todo-spark" aria-hidden="true"><Icon name="agent" /></span>
                  {editing?.id === s.id ? editor(s.id, label) : (
                    <>
                      <span className="todo-text" onDoubleClick={() => startEdit(s.id, s.text)}>{s.text}</span>
                      <span className="todo-sugg-acts">
                        <button type="button" tabIndex={-1} className="todo-ok" aria-label={t('projectScreen.todo.accept', { name: label })} onClick={() => accept(s.id)}><Icon name="check" /></button>
                        <button type="button" tabIndex={-1} className="todo-del" aria-label={t('projectScreen.todo.dismiss', { name: label })} onClick={() => dismiss(s.id)}><Icon name="close" /></button>
                      </span>
                    </>
                  )}
                  <div className="todo-sugg-note" id={`todo-sugg-note-${s.id}`}>
                    {s.note && <span>{s.note} · </span>}
                    {s.sessionId
                      ? <button type="button" className="todo-src-link" onClick={() => emit({ type: 'session.open', id: s.sessionId! })}>{s.sessionName}</button>
                      : <span>{s.sessionName}</span>}
                    <span> · {s.ago}</span>
                  </div>
                </li>
              );
            })}
          </ul>
        </div>
      )}
      {empty && <div className="faint todo-empty">{t('projectScreen.todo.empty')}</div>}
      <ul className="todo-list" aria-label={t('projectScreen.todo.listLabel')}>
        {withGone(open.map((x, i) => todoRow(x, i, false)), 'open')}
      </ul>
      {adding ? (
        <div className="todo-add" data-active="true">
          <Icon name="add" />
          {/* 変換中の Enter で足すと、確定と同時に書きかけが消える。 */}
          <input id="todo-input" className="todo-add-input" autoFocus aria-label={t('projectScreen.todo.addLabel')} value={addText}
            onChange={(e) => setAddText(e.target.value)}
            onKeyDown={(e) => {
              if (isComposing(e)) return;
              if (e.key === 'Enter') { e.preventDefault(); submitAdd(); }
              else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); setAdding(false); setAddText(''); }
              else if (e.key === 'ArrowUp' && !addText) { e.preventDefault(); const last = open.at(-1)?.id ?? null; setAdding(false); if (last) select(last); }
            }}
            onBlur={() => { if (!addText.trim()) setAdding(false); }} />
        </div>
      ) : (
        <button type="button" className="todo-add" onClick={openAdd}><Icon name="add" />{t('projectScreen.todo.addRow')}</button>
      )}
      {doneCount > 0 && (
        <>
          <button type="button" className="todo-done-h" aria-expanded={doneOpen} onClick={() => setDoneOpen(!doneOpen)}>
            <Icon name="chevron" />{t('projectScreen.todo.doneSection')} <RollingNumber value={doneCount} />
          </button>
          {doneOpen && (
            <Grow as="ul" className="todo-list todo-list-done">
              {withGone(done.map((x, i) => todoRow(x, i, true)), 'done')}
            </Grow>
          )}
        </>
      )}
    </div>
  );
}

/** 並べ替えの掴みの印（縦 3 段の点）。 */
function GripIcon() {
  return (
    <svg viewBox="0 0 8 14" width="8" height="14" fill="currentColor" aria-hidden="true">
      <circle cx="2" cy="2" r="1.2" /><circle cx="6" cy="2" r="1.2" /><circle cx="2" cy="7" r="1.2" /><circle cx="6" cy="7" r="1.2" /><circle cx="2" cy="12" r="1.2" /><circle cx="6" cy="12" r="1.2" />
    </svg>
  );
}

/** 開いた瞬間に高さを伸ばして入る箱（完了の節、完了の提案の中身）。 */
function Grow(props: { as?: 'div' | 'ul'; className: string; children: ReactNode }) {
  const ref = useRef<HTMLElement | null>(null);
  useLayoutEffect(() => { if (ref.current) growIn(ref.current); }, []);
  const Tag = props.as ?? 'div';
  return <Tag ref={ref as never} className={props.className}>{props.children}</Tag>;
}
