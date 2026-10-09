import { Fragment, useId, useState, type KeyboardEvent, type ReactNode } from 'react';
import { Icon, type IconName } from './Icon.tsx';

/**
 * 一覧の 1 行。tone の danger は赤い字（Bypass permissions）、tag は行の右の小さな文字（「前回」）。
 * lead は行の頭の印（icon の代わりに自由な中身を置く。effort の棒など）。
 * separatorBefore は、この行の前に細い線を引く。
 */
export type PickItem = { value: string; label: string; icon?: IconName; lead?: ReactNode; tone?: 'danger'; tag?: string; separatorBefore?: boolean };

/**
 * 小さい縦の一覧（Popover の中に置く、択一の面）。
 * 焦点は一覧の 1 か所が受け、印（data-active）は ↑ ↓ で動かす。端で止まり、回らない。
 * Home と End で端へ、Enter と Space で選ぶ。印を動かしただけでは選ばない。
 * Enter と Space と矢印は外へ伝えない。起動のダイアログが Enter で起動するのを止めるためである。
 * Esc と Tab は扱わず、外（Popover）が閉じるのに使う。
 * 開いた直後の印は、選んでいる値の行にある。Popover が焦点を送れるよう data-autofocus を付ける。
 */
export function PickList(props: { label: string; value: string; items: PickItem[]; onPick: (value: string) => void; className?: string }) {
  const uid = useId();
  const optId = (i: number) => `${uid}-opt-${i}`;
  const [active, setActive] = useState(() => Math.max(0, props.items.findIndex((i) => i.value === props.value)));
  const last = props.items.length - 1;
  // どの行にも印が無い一覧（モデル、アカウント）は、頭の空きを詰める。
  const plain = props.items.every((i) => !i.lead && !i.icon);

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    switch (e.key) {
      case 'ArrowDown': setActive((a) => Math.min(a + 1, last)); break;
      case 'ArrowUp': setActive((a) => Math.max(a - 1, 0)); break;
      case 'Home': setActive(0); break;
      case 'End': setActive(last); break;
      case 'Enter': case ' ': { const item = props.items[active]; if (item) props.onPick(item.value); break; }
      default: return;
    }
    e.preventDefault();
    e.stopPropagation();
  };

  return (
    <div role="listbox" aria-label={props.label} tabIndex={0} data-autofocus="true" data-plain={plain ? 'true' : undefined} className={`pick-list${props.className ? ` ${props.className}` : ''}`}
      aria-activedescendant={props.items.length ? optId(Math.min(active, last)) : undefined} onKeyDown={onKeyDown}>
      {props.items.map((item, i) => (
        <Fragment key={item.value}>
          {item.separatorBefore && i > 0 && <div className="pick-sep" aria-hidden="true" />}
          <div id={optId(i)} role="option" className="pick-li" aria-selected={item.value === props.value} data-active={i === active ? 'true' : undefined} data-danger={item.tone === 'danger' ? 'true' : undefined}
            onMouseMove={() => { if (i !== active) setActive(i); }} onClick={() => props.onPick(item.value)}>
            {plain ? null : item.lead ?? (item.icon ? <Icon name={item.icon} /> : <span className="pick-nolead" />)}
            <span className="pick-label">{item.label}</span>
            <span className="pick-end">
              {item.tag && <span className="pick-tag">{item.tag}</span>}
              <Icon name="check" />
            </span>
          </div>
        </Fragment>
      ))}
    </div>
  );
}
