import { Fragment, useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { FoldBox } from './FoldBox.tsx';
import { Icon, type IconName } from './Icon.tsx';
import { revealWithin } from './revealWithin.ts';

/**
 * 一覧の 1 行。tone の danger は赤い字（Bypass permissions）、tag は行の右の小さな文字（「前回」）。
 * lead は行の頭の印（icon の代わりに自由な中身を置く。effort の棒など）。
 * separatorBefore は、この行の前に細い線を引く。
 * disabled の行は選べない（押しても Enter でも onPick を呼ばない）。理由は tag に書く。印は動かせるので、読み上げで理由に届く。
 */
/** 一覧の 1 行。badge は名前の横の小札（「ベータ」）、sub は名前の下の小さい説明の 1 行（opencode のモードと自動承認）。 */
export type PickItem = { value: string; label: string; icon?: IconName; lead?: ReactNode; tone?: 'danger'; tag?: string; badge?: string; sub?: string; separatorBefore?: boolean; disabled?: boolean };

/** 一覧の下に畳んでおく行のまとまり（Codex の過去のモデル）。見出しを押すか、印を見出しに置いて Enter で開き閉じする。 */
export type PickMore = { label: string; items: PickItem[] };

/**
 * 小さい縦の一覧（Popover の中に置く、択一の面）。
 * 焦点は一覧の 1 か所が受け、印（data-active）は ↑ ↓ で動かす。端で止まり、回らない。
 * Home と End で端へ、Enter と Space で選ぶ。印を動かしただけでは選ばない。
 * Enter と Space と矢印は外へ伝えない。起動のダイアログが Enter で起動するのを止めるためである。
 * Esc と Tab は扱わず、外（Popover）が閉じるのに使う。
 * 開いた直後の印は、選んでいる値の行にある。Popover が焦点を送れるよう data-autofocus を付ける。
 * more を渡すと、行のあとに開き閉じの見出しと、畳んだ行を置く。見出しも印の止まる 1 行で、Enter と Space で開き閉じする。
 * はじめは畳み、選んでいる値が畳む側にあるときだけ開いておく。開き閉じは FoldBox（growIn、collapseOut）で動く。
 * 見出しから開いたときは、伸び終わってから、開いた行が見えるところまで箱（data-pick-scroll）を滑らかに送る。
 * 一覧を縮めて中で送る箱（data-pick-scroll）の中に置いたときは、印の行がその箱の中に見えるよう送る。
 */
export function PickList(props: { label: string; value: string; items: PickItem[]; onPick: (value: string) => void; className?: string; more?: PickMore }) {
  const uid = useId();
  const optId = (i: number) => `${uid}-opt-${i}`;
  const toggleId = `${uid}-more`;
  const extra = props.more?.items ?? [];
  const head = props.items.length;
  const [open, setOpen] = useState(() => extra.some((i) => i.value === props.value));
  // 印の位置。0..head-1 が上の行、head が見出し、head+1.. が畳んだ行。
  const rows = props.more ? [...props.items, null, ...(open ? extra : [])] : props.items;
  const [active, setActive] = useState(() => Math.max(0, rows.findIndex((i) => i !== null && i.value === props.value)));
  const last = rows.length - 1;
  const at = Math.min(active, last);
  // どの行にも印が無い一覧（モデル、アカウント）は、頭の空きを詰める。
  const plain = [...props.items, ...extra].every((i) => !i.lead && !i.icon);
  const self = useRef<HTMLDivElement>(null);
  const keyed = useRef(false);

  useLayoutEffect(() => {
    if (!keyed.current) return;
    keyed.current = false;
    const box = self.current?.closest<HTMLElement>('[data-pick-scroll]');
    const row = self.current?.querySelector<HTMLElement>('[data-active="true"]');
    if (box && row) revealWithin(box, row);
  }, [at]);

  // 見出しから開いたとき、伸び終わってから、開いた行が見えるところまで送る（見出しは上に残す）。縮めて送る箱の中にないときは何もしない。
  const unfolded = useRef(false);
  const toggle = () => { unfolded.current = !open; setOpen(!open); };
  useEffect(() => {
    if (!open || !unfolded.current) return;
    unfolded.current = false;
    const box = self.current?.closest<HTMLElement>('[data-pick-scroll]');
    const fold = document.getElementById(`${uid}-more-rows`);
    const bar = document.getElementById(toggleId);
    if (!box || !fold || !bar) return;
    let gone = false;
    void Promise.all((fold.getAnimations?.() ?? []).map((a) => a.finished.catch(() => undefined))).then(() => {
      if (gone) return;
      const b = box.getBoundingClientRect();
      const over = fold.getBoundingClientRect().bottom - b.bottom;
      if (over > 0) box.scrollTo({ top: box.scrollTop + Math.min(over, bar.getBoundingClientRect().top - b.top), behavior: 'smooth' });
    });
    return () => { gone = true; };
  }, [open, uid, toggleId]);

  const move = (i: number) => { keyed.current = true; setActive(i); };
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    switch (e.key) {
      case 'ArrowDown': move(Math.min(at + 1, last)); break;
      case 'ArrowUp': move(Math.max(at - 1, 0)); break;
      case 'Home': move(0); break;
      case 'End': move(last); break;
      case 'Enter': case ' ': {
        const item = rows[at];
        if (item === null) toggle();
        else if (item && !item.disabled) props.onPick(item.value);
        break;
      }
      default: return;
    }
    e.preventDefault();
    e.stopPropagation();
  };

  const row = (item: PickItem, i: number) => (
    <Fragment key={item.value}>
      {item.separatorBefore && i > 0 && <div className="pick-sep" aria-hidden="true" />}
      <div id={optId(i)} role="option" className="pick-li" data-sub={item.sub ? 'true' : undefined} aria-selected={item.value === props.value} aria-disabled={item.disabled ? 'true' : undefined} data-active={i === at ? 'true' : undefined} data-danger={item.tone === 'danger' ? 'true' : undefined}
        onMouseMove={() => { if (i !== at) setActive(i); }} onClick={() => { if (!item.disabled) props.onPick(item.value); }}>
        {plain ? null : item.lead ?? (item.icon ? <Icon name={item.icon} /> : <span className="pick-nolead" />)}
        {item.sub || item.badge
          ? <span className="pick-text"><span className="pick-label">{item.label}{item.badge && <span className="tag-beta">{item.badge}</span>}</span>{item.sub && <span className="pick-sub" title={item.sub}>{item.sub}</span>}</span>
          : <span className="pick-label">{item.label}</span>}
        <span className="pick-end">
          {item.tag && <span className="pick-tag">{item.tag}</span>}
          <Icon name="check" />
        </span>
      </div>
    </Fragment>
  );

  return (
    <div ref={self} role="listbox" aria-label={props.label} tabIndex={0} data-autofocus="true" data-plain={plain ? 'true' : undefined} className={`pick-list${props.className ? ` ${props.className}` : ''}`}
      aria-activedescendant={rows.length ? (rows[at] === null ? toggleId : optId(at)) : undefined} onKeyDown={onKeyDown}>
      {props.items.map((item, i) => row(item, i))}
      {props.more && (
        <>
          {/* 押しても焦点は一覧に残す（↑ ↓ を続けて使えるように）。 */}
          <button type="button" tabIndex={-1} id={toggleId} className="pick-more" aria-expanded={open} aria-controls={`${uid}-more-rows`} data-active={at === head ? 'true' : undefined}
            onMouseDown={(e) => e.preventDefault()} onMouseMove={() => { if (at !== head) setActive(head); }} onClick={toggle}>
            <Icon name="chevronDown" />
            <span className="pick-more-label">{props.more.label}</span>
            <span className="pick-more-n" aria-hidden="true">{extra.length}</span>
          </button>
          <FoldBox open={open} id={`${uid}-more-rows`} className="pick-more-rows">
            <div role="group" aria-label={props.more.label} className="pick-more-group">
              {extra.map((item, j) => row(item, head + 1 + j))}
            </div>
          </FoldBox>
        </>
      )}
    </div>
  );
}
