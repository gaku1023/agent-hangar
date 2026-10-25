import { Fragment, useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent, type RefObject } from 'react';
import type { OpencodeModelOption, OpencodeProviderOption } from '@agent-hangar/shared';
import { presentModelPicker, type ModelRow, type ModelTag } from '../presenters/modelPicker.ts';
import { isComposing } from './ime.ts';
import { FoldBox } from './primitives/FoldBox.tsx';
import { Icon } from './primitives/Icon.tsx';
import { useT } from './primitives/language.tsx';
import { highlight } from './primitives/listboxModel.ts';
import { growIn, staggerIn } from './primitives/motionKit.ts';
import { Popover } from './primitives/Popover.tsx';
import { revealWithin } from './primitives/revealWithin.ts';

/** デフォルトの行の値。モデルの ID（`provider/model`）とは重ならない。 */
const DEFAULT_ROW = ':default';
/** 開いたときに浮き上がらせる行の数。多いと最後の行が遅れて見える。 */
const RISE_ROWS = 10;
/** 小窓の幅（試作の W1）。窓が狭ければ place() が縁に収める。 */
const WIDTH = 520;
/** 一覧の高さの上限と、札の下に開くために要る最低の高さ。下にこれだけ入らなければ、place() が札の上に開く。 */
const BODY_MAX = 360;
const BODY_MIN = 200;
/** 札と小窓の間と、窓の下端に残す余白の和。 */
const BELOW_MARGIN = 16;

export type OpencodeModelPickerProps = {
  /** 札の名前（「モデル」）。小窓と一覧の名前にも使う。 */
  label: string;
  /** 選んでいるモデル。空はデフォルト。 */
  value: string;
  models: OpencodeModelOption[];
  providers: OpencodeProviderOption[];
  defaultModel: string | null;
  pricesAt: number | null;
  fetchedAt: number;
  /** 前回のモデルが一覧から消えてデフォルトに戻したこと。札に data-reset で持つ。 */
  reset: boolean;
  /** 再読み込みの途中。 */
  reloading: boolean;
  onChange: (value: string) => void;
  onReload: () => void;
  /** 「プロバイダーを管理…」。小窓は閉じてから呼ぶ。 */
  onManage: () => void;
  /** 札に足す data- 属性（エージェントの切り替えの動きが使う data-agent-only）。 */
  faceProps?: Record<`data-${string}`, string>;
};

/**
 * opencode のモデルの小窓（試作 model-picker.html の W1・L2・D1。docs/design.md「opencode のモデルの小窓」）。
 * 「モデル」の札の下に、幅 520px の小窓を開く。選ぶだけの面で、プロバイダーの接続は設定で行う。
 * 並びはプロバイダーごとのまとまりで、見出しに費用の型と接続の状態を出し、見出しを押すと畳める（growIn と collapseOut）。畳んだまとまりは、小窓を閉じても覚えている。
 * 絞り込む間は、畳んだまとまりも開いて合う行を見せる。
 * 行は札だけの簡潔な形で、ツール呼び出しに対応しない行は薄くして選べない。矢印キーは選べる行だけを辿る。
 * 開くときは面が listbox-in で現れ、上の行から --stagger ずつ浮き上がる（staggerIn）。再読み込みで増えた行は growIn で伸びて入る。
 */
export function OpencodeModelPicker(props: OpencodeModelPickerProps) {
  const t = useT();
  const [closed, setClosed] = useState<ReadonlySet<string>>(() => new Set());
  const valueId = useId();
  const anchor = useRef<HTMLButtonElement | null>(null);
  const chosen = props.models.find((m) => m.id === props.value);
  const toggle = (key: string) => {
    const next = new Set(closed);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    setClosed(next);
  };
  return (
    <Popover label={props.label} width={WIDTH} align="start" className="launch-pop mpk-pop"
      face={(p) => (
        <button type="button" {...p} ref={(el) => { p.ref.current = el; anchor.current = el; }} className="set-chip" data-tone={props.value ? 'default' : 'muted'} {...props.faceProps} {...(props.reset ? { 'data-reset': 'true' } : {})}
          aria-label={props.label} aria-describedby={valueId}>
          <span className="set-chip-name">{props.label}</span>
          <span className="set-chip-value" id={valueId}>{chosen?.label ?? (props.value || t('launch.value.default'))}</span>
          <Icon name="chevronDown" />
        </button>
      )}>
      {({ close }) => <PickerBody {...props} anchor={anchor} closed={closed} onToggle={toggle} close={close} />}
    </Popover>
  );
}

function Tag(props: { tag: ModelTag }) {
  return <span className="mpk-tag" data-tone={props.tag.tone}>{props.tag.label}</span>;
}

function PickerBody(props: OpencodeModelPickerProps & { anchor: RefObject<HTMLButtonElement | null>; closed: ReadonlySet<string>; onToggle: (key: string) => void; close: () => void }) {
  const t = useT();
  const [query, setQuery] = useState('');
  const body = useRef<HTMLDivElement>(null);
  const uid = useId();
  const view = presentModelPicker(t, {
    models: props.models, providers: props.providers, defaultModel: props.defaultModel, pricesAt: props.pricesAt, fetchedAt: props.fetchedAt,
    selected: props.value, query, now: Date.now(),
  });
  // 絞り込む間は、畳んだまとまりも開いて合う行を見せる（畳んだことは覚えたままで、消すと戻る）。
  const filtering = query.trim() !== '';
  const isOpen = (key: string) => filtering || !props.closed.has(key);
  // 矢印キーで辿る行。デフォルトの行と、開いているまとまりの選べる行だけ。
  const selectable = [
    ...(view.def ? [DEFAULT_ROW] : []),
    ...view.groups.flatMap((g) => (isOpen(g.key) ? g.rows.filter((r) => !r.disabled).map((r) => r.id) : [])),
  ];
  const [active, setActive] = useState<string>(props.value || DEFAULT_ROW);
  const current = selectable.includes(active) ? active : selectable[0] ?? null;
  const allIds = [DEFAULT_ROW, ...view.groups.flatMap((g) => g.rows.map((r) => r.id))];
  const optId = (v: string) => `${uid}-opt-${allIds.indexOf(v)}`;

  const pick = (v: string) => {
    props.close();
    props.onChange(v === DEFAULT_ROW ? '' : v);
  };

  // 札の下に開く（試作の W1）。下の空きに収まるよう一覧の高さを縮め、BODY_MIN も入らないときだけ縮めずに place() へ任せる（札の上に開く）。
  // Popover が位置を決める（親の layout effect）より先に走るので、縮めた高さで位置が決まる。
  useLayoutEffect(() => {
    const face = props.anchor.current;
    const list = body.current;
    const pop = list?.closest<HTMLElement>('.mpk-pop');
    if (!face || !list || !pop) return;
    const room = window.innerHeight - face.getBoundingClientRect().bottom - BELOW_MARGIN - (pop.offsetHeight - list.offsetHeight);
    if (room >= BODY_MIN) list.style.maxHeight = `${Math.min(room, BODY_MAX)}px`;
    // 開いたときに 1 度だけ測る。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 開いたとき、上の行から浮き上がらせる。
  useLayoutEffect(() => {
    const rows = body.current?.querySelectorAll<HTMLElement>('.mpk-grp-h, .mpk-row');
    if (rows) staggerIn([...rows].slice(0, RISE_ROWS));
  }, []);

  // 再読み込みで増えた行は、伸びて入る。はじめの描画と絞り込みでは動かさない。
  const known = useRef<Set<string> | null>(null);
  useLayoutEffect(() => {
    const ids = props.models.map((m) => m.id);
    const before = known.current;
    known.current = new Set(ids);
    if (!before) return;
    for (const id of ids) {
      if (before.has(id)) continue;
      const el = document.getElementById(optId(id));
      if (el) growIn(el);
    }
    // optId は描画ごとに作るが、中身は allIds だけで決まる。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.models]);

  useEffect(() => {
    if (current === null || !body.current) return;
    const el = document.getElementById(optId(current));
    if (el) revealWithin(body.current, el);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current]);

  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (isComposing(e)) {
      if (e.key === 'Enter' || e.key === 'Escape') e.stopPropagation();
      return;
    }
    const n = selectable.length;
    const at = current === null ? -1 : selectable.indexOf(current);
    switch (e.key) {
      case 'ArrowDown': if (n) setActive(selectable[(at + 1) % n]!); break;
      case 'ArrowUp': if (n) setActive(selectable[(at - 1 + n) % n]!); break;
      case 'Enter': if (current !== null) pick(current); break;
      default: return;
    }
    e.preventDefault();
    e.stopPropagation();
  };

  const marks = (text: string) => highlight(text, query.trim()).map((s, i) => (s.hit ? <mark key={i}>{s.text}</mark> : <Fragment key={i}>{s.text}</Fragment>));
  const row = (r: ModelRow) => (
    <div key={r.id} id={optId(r.id)} role="option" aria-selected={r.selected} aria-disabled={r.disabled ? 'true' : undefined} aria-label={r.name} title={r.note ?? undefined}
      className="mpk-row" data-active={r.id === current ? 'true' : undefined}
      onMouseMove={() => { if (!r.disabled && r.id !== current) setActive(r.id); }} onClick={() => { if (!r.disabled) pick(r.id); }}>
      <span className="mpk-chk" aria-hidden="true"><Icon name="check" /></span>
      <span className="mpk-main">
        <span className="mpk-name">{marks(r.name)}</span>
        <span className="mpk-tags">{r.tags.map((tag, i) => <Tag key={i} tag={tag} />)}</span>
      </span>
      <span className="mpk-price"><b>{r.price.main}</b>{r.price.sub && <small>{r.price.sub}</small>}</span>
    </div>
  );

  return (
    <>
      <div className="pick-head">{props.label}</div>
      <div className="listbox-search mpk-search">
        <Icon name="search" />
        <input role="combobox" data-autofocus="true" aria-label={t('launch.model.search')} placeholder={t('launch.model.search')}
          aria-expanded="true" aria-controls={`${uid}-list`} aria-autocomplete="list" aria-activedescendant={current !== null ? optId(current) : undefined}
          value={query} onChange={(e) => setQuery(e.target.value)} onKeyDown={onKey} />
      </div>
      <div ref={body} id={`${uid}-list`} role="listbox" aria-label={props.label} className="mpk-body">
        {view.def && (
          <div role="group" aria-labelledby={`${uid}-def`}>
            <div id={`${uid}-def`} className="mpk-sec">{t('launch.model.defaultGroup')}</div>
            <div id={optId(DEFAULT_ROW)} role="option" aria-selected={view.def.selected} aria-label={t('launch.value.default')}
              className="mpk-row" data-active={current === DEFAULT_ROW ? 'true' : undefined}
              onMouseMove={() => { if (current !== DEFAULT_ROW) setActive(DEFAULT_ROW); }} onClick={() => pick(DEFAULT_ROW)}>
              <span className="mpk-chk" aria-hidden="true"><Icon name="check" /></span>
              <span className="mpk-main">
                <span className="mpk-name">{t('launch.value.default')}</span>
                {view.def.sub && <span className="mpk-sub">{view.def.sub}</span>}
              </span>
            </div>
          </div>
        )}
        {view.groups.map((g) => {
          const open = isOpen(g.key);
          const head = `${uid}-g-${g.key}`;
          return (
            <div key={g.key} role="group" aria-labelledby={head} className="mpk-grp">
              <div className="mpk-grp-h">
                <button type="button" id={head} className="mpk-grp-toggle" aria-expanded={open} aria-label={g.name} onClick={() => { if (!filtering) props.onToggle(g.key); }}>
                  <Icon name="chevronDown" />
                  <span>{g.name}</span>
                </button>
                <Tag tag={g.kind} />
                <span className="mpk-grp-st">{g.status}</span>
              </div>
              <FoldBox open={open} className="mpk-grp-body">
                {g.rows.map(row)}
                {g.reload && (
                  <div className="mpk-gfoot">
                    <span>{t('launch.model.lmstudioNote')}</span>
                    <button type="button" className="mpk-link" disabled={props.reloading} onClick={props.onReload}>{t(props.reloading ? 'launch.model.reloading' : 'launch.model.reload')}</button>
                  </div>
                )}
              </FoldBox>
            </div>
          );
        })}
        {view.empty && <div className="mpk-empty">{t('common.empty.noMatch')}</div>}
      </div>
      <button type="button" className="mpk-manage" onClick={() => { props.close(); props.onManage(); }}>{t('launch.model.manage')}</button>
      <div className="mpk-foot">{view.footer}</div>
    </>
  );
}
