import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react';
import { useEmit } from '../intent/chain.tsx';
import type { PaletteProps } from '../presenters/palette.ts';
import { isComposing } from './ime.ts';
import { motionEase, motionMs } from './primitives/motion.ts';

const KIND_LABEL = { command: 'コマンド', project: 'プロジェクト', session: 'セッション' } as const;

/**
 * コマンドパレット。
 * 入力の文字は Root が持ち、選択位置だけをここに持つ。
 * どちらもダイアログの外へ出ない一時の値なので、Mediator の状態にはしない。
 * 開いた時点のフォーカスもここで当てる。palette.open は focus の効果を出さない。
 */
export function CommandPalette(props: PaletteProps & { onQuery: (q: string) => void }) {
  const emit = useEmit();
  const input = useRef<HTMLInputElement>(null);
  const box = useRef<HTMLDivElement>(null);
  const [index, setIndex] = useState(0);

  useEffect(() => { input.current?.focus(); }, []);
  // 開くときは、ヘッダの検索欄の錠剤からガラスが広がる。
  // 閉じて錠剤へ戻る動きは、器が消えた後なので runtime/present.ts が View Transitions で受け持つ。
  // 描画を遅らせない Web Animations で開くので、入力欄はこの描画でフォーカスを持ち、打った文字を落とさない。
  useLayoutEffect(() => {
    const el = box.current;
    if (!el || typeof el.animate !== 'function') return;
    const a = el.getBoundingClientRect();
    const pill = document.getElementById('global-search')?.getBoundingClientRect();
    const from = pill && a.width > 0 && a.height > 0
      ? `translate(${pill.left - a.left}px, ${pill.top - a.top}px) scale(${pill.width / a.width}, ${pill.height / a.height})`
      : 'scale(0.96)';
    el.animate([{ transform: from, opacity: 0.4 }, { transform: 'none', opacity: 1 }], { duration: motionMs('--dur'), easing: motionEase('--ease-out') });
  }, []);
  // 入力が変わると並びが変わるので、選択を先頭に戻す。
  useEffect(() => { setIndex(0); }, [props.query]);
  // 矢印で動かした選択は、一覧の見える位置へ寄せる。
  // マウスで乗せたときは寄せない。端の行に乗せただけで一覧が動き、指の下の行が入れ替わってしまうからである。
  const byKey = useRef(false);
  useEffect(() => {
    if (!byKey.current) return;
    byKey.current = false;
    // jsdom のように scrollIntoView を持たない環境では何もしない。
    document.getElementById(`palette-opt-${index}`)?.scrollIntoView?.({ block: 'nearest' });
  }, [index]);

  const run = (i: number) => {
    const item = props.items[i];
    if (item) emit({ type: 'palette.run', command: { id: item.id, label: item.label } });
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); byKey.current = true; setIndex((i) => Math.min(props.items.length - 1, i + 1)); return; }
    if (e.key === 'ArrowUp') { e.preventDefault(); byKey.current = true; setIndex((i) => Math.max(0, i - 1)); return; }
    if (e.key === 'Escape') { e.preventDefault(); emit({ type: 'palette.close' }); return; }
    // 変換中の Enter は確定のための打鍵なので、実行に使わない。
    if (e.key !== 'Enter' || isComposing(e)) return;
    e.preventDefault();
    run(index);
  };

  return (
    <div className="overlay" onClick={() => emit({ type: 'palette.close' })}>
      {/* 器は読み上げに対してダイアログである。
          器と入力欄には別の名前を付ける。同じ名前だと、名前で引いたときに 2 つ見つかって区別できない。 */}
      <div ref={box} className="dialog palette" role="dialog" aria-modal="true" aria-label="コマンドパレット" onClick={(e) => e.stopPropagation()}>
        {/* 入力欄と一覧は combobox と listbox の組で結ぶ。
            選択位置は DOM のフォーカスではなく aria-activedescendant で伝えるので、打鍵は入力欄に残る。 */}
        <input
          ref={input}
          id="palette-input"
          className="input palette-input"
          aria-label="コマンドを検索"
          role="combobox"
          aria-expanded
          aria-controls="palette-list"
          aria-activedescendant={props.items[index] ? `palette-opt-${index}` : undefined}
          placeholder="セッション、プロジェクト、コマンド"
          value={props.query}
          onChange={(e) => props.onQuery(e.target.value)}
          onKeyDown={onKeyDown}
        />
        {props.items.length === 0 && <div className="empty">一致する項目がありません</div>}
        <ul id="palette-list" className="palette-list" role="listbox">
          {props.items.map((item, i) => (
            <li
              key={item.id}
              id={`palette-opt-${i}`}
              className="palette-item"
              role="option"
              aria-selected={i === index}
              data-active={i === index ? 'true' : undefined}
              onMouseEnter={() => { byKey.current = false; setIndex(i); }}
              onClick={() => run(i)}
            >
              <span className="palette-kind faint">{KIND_LABEL[item.kind]}</span>
              <span className="palette-label">{item.label}</span>
              <span className="palette-hint faint mono">{item.hint}</span>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
