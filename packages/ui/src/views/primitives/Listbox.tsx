import { Fragment, useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { isComposing } from '../ime.ts';
import { Icon } from './Icon.tsx';
import { arrangeSections, highlight, place, SEARCH_MIN, type ListboxAction, type ListboxGroup, type ListboxOption, type Placement } from './listboxModel.ts';

export type ListboxProps = {
  label: string;
  value: string | null;
  options: ListboxOption[];
  onChange: (value: string) => void;
  groups?: ListboxGroup[];
  placeholder?: string;
  searchPlaceholder?: string;
  minWidth?: number;
  align?: 'start' | 'end';
  name?: string;
  id?: string;
  showSubInFace?: boolean;
  faceClassName?: string;
  faceProps?: Record<`data-${string}`, string>;
  renderFace?: (selected: ListboxOption | undefined) => ReactNode;
  /** 一覧の下端に固定で置く操作。行の続きとして矢印キーで辿れる。選ぶと onAction を呼び、onChange は呼ばない。 */
  actions?: (query: string) => ListboxAction[];
  onAction?: (value: string, query: string) => void;
};

/**
 * ガラスの一覧。素の select の代わりに、閉じた顔と、開いたときのガラスの面を自前で描く。
 * 面は document.body への portal に描く。一覧やカードの overflow: hidden で切られないようにするため。
 * portal の中の出来事も React の木では呼び出し側の子として泡立つので、扱ったキーは stopPropagation で止める。
 * 止めないと、起動ダイアログの Enter（起動）と Esc（閉じる）が同時に走る。
 */
export function Listbox(props: ListboxProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const [pos, setPos] = useState<Placement | null>(null);
  const [scrolled, setScrolled] = useState(false);
  const face = useRef<HTMLButtonElement>(null);
  const pop = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const uid = useId();
  const listId = `${uid}-list`;
  const faceValueId = `${uid}-value`;
  const optId = (i: number) => `${uid}-opt-${i}`;
  // 操作があるときは件数によらず検索欄を出す。操作は打った語を使う（「『語』を新しいフォルダとして作る」）ので、打つ欄が要る。
  const searchable = props.options.length >= SEARCH_MIN || !!props.actions;
  const sections = arrangeSections(props.options, props.groups, query);
  const items = sections.flatMap((s) => s.items);
  const acts = open && props.actions ? props.actions(query) : [];
  const total = items.length + acts.length;
  // 開いている間に選択肢が減ると、選ばれかけの行が範囲の外に出る。いちばん近い行に寄せる。
  // 一致する行が無いときは、最初の操作に印を置く。打って Enter で作れるようにするためである。
  const current = total ? Math.min(items.length === 0 && acts.length ? Math.max(active, 0) : active, total - 1) : -1;
  const selected = props.options.find((o) => o.value === props.value);

  const show = () => {
    const start = arrangeSections(props.options, props.groups, '').flatMap((s) => s.items).findIndex((i) => i.option.value === props.value);
    setQuery('');
    setScrolled(false);
    setActive(Math.max(start, 0));
    setOpen(true);
  };
  const hide = (refocus: boolean) => {
    setOpen(false);
    setPos(null);
    if (refocus) face.current?.focus();
  };
  const choose = (o: ListboxOption) => {
    hide(true);
    if (o.value !== props.value) props.onChange(o.value);
  };

  const reposition = useCallback(() => {
    if (!face.current || !pop.current) return;
    const r = face.current.getBoundingClientRect();
    setPos(place({ top: r.top, bottom: r.bottom, left: r.left, width: r.width }, pop.current.offsetHeight, { width: window.innerWidth, height: window.innerHeight }, { minWidth: props.minWidth, align: props.align }));
  }, [props.minWidth, props.align]);

  // 描いた直後、塗る前に位置を決める。検索で行の数が変わると高さも変わるので、そのたびに計り直す。
  useLayoutEffect(() => { if (open) reposition(); }, [open, reposition, items.length]);

  // 位置が決まって面が見えてから、開くたびに一度だけフォーカスを送る。
  // visibility: hidden の要素にはブラウザがフォーカスを当てないため、位置を決める前に送ると空振りする。
  const ready = open && pos !== null;
  useLayoutEffect(() => {
    if (ready) (searchable ? input.current : list.current)?.focus();
    // 置き直しで pos が変わってもフォーカスは奪い返さない。ready が立った時点だけで送る。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready]);

  useEffect(() => {
    if (!open) return;
    // 面の外を押したら閉じる。フォーカスは押した先に任せ、顔へは戻さない。
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (pop.current?.contains(t) || face.current?.contains(t)) return;
      hide(false);
    };
    document.addEventListener('mousedown', onDown);
    window.addEventListener('resize', reposition);
    window.addEventListener('scroll', reposition, true);
    return () => {
      document.removeEventListener('mousedown', onDown);
      window.removeEventListener('resize', reposition);
      window.removeEventListener('scroll', reposition, true);
    };
    // hide は毎回作り直されるが、state の setter と ref しか使わないため依存に入れない。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, reposition]);

  useEffect(() => {
    if (open && current >= 0) document.getElementById(optId(current))?.scrollIntoView?.({ block: 'nearest' });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, current]);

  const onFaceKey = (e: KeyboardEvent<HTMLButtonElement>) => {
    if (e.key !== 'ArrowDown' && e.key !== 'Enter') return;
    e.preventDefault();
    e.stopPropagation();
    if (!open) show();
  };

  const onPopKey = (e: KeyboardEvent<HTMLElement>) => {
    if (isComposing(e)) {
      // 変換の確定と取り消しの打鍵は IME に任せるが、外側（起動ダイアログの Esc で閉じる）へは漏らさない。
      if (e.key === 'Enter' || e.key === 'Escape') e.stopPropagation();
      return;
    }
    const n = total;
    const inInput = e.target === input.current;
    switch (e.key) {
      case 'ArrowDown': if (n) setActive((current + 1) % n); break;
      case 'ArrowUp': if (n) setActive((current - 1 + n) % n); break;
      // 検索欄の Home と End は、文字の先頭と末尾へ動かす打鍵として残す。
      case 'Home': if (inInput) return; setActive(0); break;
      case 'End': if (inInput) return; setActive(Math.max(n - 1, 0)); break;
      case 'Enter': {
        const hit = items[current];
        if (hit) { choose(hit.option); break; }
        const act = acts[current - items.length];
        if (act) { hide(true); props.onAction?.(act.value, query); }
        break;
      }
      case 'Escape': case 'Tab': hide(true); break;
      default: return;
    }
    e.preventDefault();
    e.stopPropagation();
  };

  const marks = (text: string) => highlight(text, query).map((s, i) => s.hit ? <mark key={i}>{s.text}</mark> : <Fragment key={i}>{s.text}</Fragment>);
  const activeId = current >= 0 ? optId(current) : undefined;

  const option = ({ option: o, index }: { option: ListboxOption; index: number }) => (
    <div key={o.value} id={optId(index)} role="option" aria-selected={o.value === props.value} aria-label={o.label} aria-describedby={o.sub ? `${optId(index)}-sub` : undefined}
      className="listbox-opt" data-active={index === current ? 'true' : undefined} data-danger={o.danger ? 'true' : undefined}
      onMouseMove={() => { if (index !== current) setActive(index); }} onClick={() => choose(o)}>
      {o.status ? <span className="st-dot" data-status={o.status} aria-hidden="true" /> : o.icon ? <Icon name={o.icon} /> : null}
      <span className="listbox-opt-main">
        <b>{marks(o.label)}</b>
        {o.sub && <small id={`${optId(index)}-sub`} data-kind={o.subKind ?? 'path'}>{o.subKind === 'prose' ? o.sub : marks(o.sub)}</small>}
      </span>
      {o.tag && <span className="listbox-tag">{o.tag}</span>}
      {o.meta && <span className="listbox-meta">{o.meta}</span>}
      <span className="listbox-check" aria-hidden="true"><Icon name="check" /></span>
    </div>
  );

  const defaultFace = (
    <>
      {selected ? (
        <span id={faceValueId} className="listbox-face-value">
          {selected.status ? <span className="st-dot" data-status={selected.status} aria-hidden="true" /> : selected.icon ? <Icon name={selected.icon} /> : null}
          <span className="listbox-face-label">{selected.label}</span>
          {props.showSubInFace && (selected.faceSub ?? selected.sub) && <span className="listbox-face-sub">{selected.faceSub ?? selected.sub}</span>}
        </span>
      ) : <span id={faceValueId} className="listbox-face-placeholder">{props.placeholder ?? '選んでください'}</span>}
      <Icon name="chevronDown" />
    </>
  );

  const style = pos ? { left: pos.left, width: pos.width, top: pos.top, bottom: pos.bottom } : { visibility: 'hidden' as const };

  return (
    <>
      <button ref={face} type="button" id={props.id} className={props.faceClassName ?? 'listbox-face'} {...props.faceProps}
        aria-label={props.label} aria-describedby={faceValueId} aria-haspopup="listbox" aria-expanded={open} aria-controls={open ? listId : undefined}
        onClick={() => (open ? hide(false) : show())} onKeyDown={onFaceKey}>
        {props.renderFace ? props.renderFace(selected) : defaultFace}
      </button>
      {/* aria-label が顔の中身を上書きするため、renderFace の顔では選んだ値を顔の外の隠し要素で読み上げさせる。 */}
      {props.renderFace && <span id={faceValueId} hidden>{selected?.label ?? props.placeholder ?? '選んでください'}</span>}
      {props.name && <input type="hidden" name={props.name} value={props.value ?? ''} />}
      {open && createPortal(
        <div ref={pop} className="listbox-pop" style={style} data-up={pos?.up ? 'true' : undefined} data-scrolled={scrolled ? 'true' : undefined} onKeyDown={onPopKey}>
          {searchable && (
            <div className="listbox-search">
              <Icon name="search" />
              <input ref={input} role="combobox" aria-label={props.searchPlaceholder ?? `${props.label}を探す`} placeholder={props.searchPlaceholder ?? `${props.label}を探す`}
                aria-expanded="true" aria-controls={listId} aria-autocomplete="list" aria-activedescendant={activeId}
                value={query} onChange={(e) => { setQuery(e.target.value); setActive(0); }} />
            </div>
          )}
          {/* listbox は、スクロールする行と、動かない操作の両方を包む。操作も option なので、listbox の中に置かないと ARIA の所有関係が切れる。 */}
          <div ref={list} id={listId} role="listbox" aria-label={props.label} className="listbox-body" tabIndex={searchable ? undefined : -1}
            aria-activedescendant={searchable ? undefined : activeId}>
            <div className="listbox-rows" onScroll={(e) => setScrolled(e.currentTarget.scrollTop > 0)}>
              {sections.map((s, si) => s.title === null
                ? <Fragment key={`s${si}`}>{s.items.map(option)}</Fragment>
                : (
                  <div key={`s${si}`} role="group" aria-labelledby={`${uid}-g${si}`}>
                    <div id={`${uid}-g${si}`} className="listbox-group-title">{s.title}</div>
                    {s.items.map(option)}
                  </div>
                ))}
              {!items.length && <div className="listbox-empty">一致するものはありません</div>}
            </div>
            {acts.length > 0 && (
              <div className="listbox-acts" role="group">
                {acts.map((a, j) => {
                  const index = items.length + j;
                  return (
                    <div key={a.value} id={optId(index)} role="option" aria-selected="false" aria-label={a.label} className="listbox-act" data-active={index === current ? 'true' : undefined}
                      onMouseMove={() => { if (index !== current) setActive(index); }} onClick={() => { hide(true); props.onAction?.(a.value, query); }}>
                      <Icon name={a.icon} /><span className="listbox-act-label">{a.label}</span>{a.sub && <small>{a.sub}</small>}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
          {searchable && (
            <div className="listbox-keys" aria-hidden="true">
              <span><kbd>↑</kbd><kbd>↓</kbd> 移動</span><span><kbd>Enter</kbd> 決める</span><span><kbd>Esc</kbd> 閉じる</span>
            </div>
          )}
        </div>,
        document.body,
      )}
    </>
  );
}
