import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { useEmit } from '../action/chain.tsx';
import type { PaletteIcon, PaletteItem, PaletteProps } from '../presenters/palette.ts';
import { isComposing } from './ime.ts';
import { Icon, type IconName } from './primitives/Icon.tsx';
import { useT } from './primitives/language.tsx';
import { motionEase, motionMs } from './primitives/motion.ts';
import { StatusDot } from './primitives/StatusDot.tsx';

/** presenter の絵の名前から Icon の名前へ。 */
const ICON: Record<PaletteIcon, IconName> = {
  home: 'home', projects: 'projects', settings: 'settings', next: 'nextWaiting', sidebar: 'sidebar', keys: 'command', add: 'add', scratch: 'scratch', rebuild: 'rebuild', fulltext: 'fullText',
  // 設定の節。設定の画面の目次と同じ絵にする（views/SettingsScreen.tsx の SECTION_ICON）。
  general: 'general', cloud: 'cloud', integrations: 'link', summary: 'permissionAuto', tools: 'tool', info: 'info', retention: 'retention',
};

/** 名前の中の、打った語にそのまま一致する部分を印で囲む。部分列でしか当たらないときは囲まない。 */
function highlight(label: string, query: string): ReactNode {
  const q = query.trim().toLowerCase();
  const at = q ? label.toLowerCase().indexOf(q) : -1;
  if (at < 0) return label;
  return <>{label.slice(0, at)}<mark>{label.slice(at, at + q.length)}</mark>{label.slice(at + q.length)}</>;
}

function Lead(props: { item: PaletteItem }) {
  const l = props.item.lead;
  if (l.kind === 'dot') return <StatusDot status={l.live} aside={l.aside} />;
  return <Icon name={ICON[l.icon]} />;
}

/**
 * コマンドパレット。
 * 入力の文字は Root が持ち、選択位置だけをここに持つ。
 * どちらもダイアログの外へ出ない一時の値なので、Mediator の状態にはしない。
 * 開いた時点のフォーカスもここで当てる。palette.open は focus の効果を出さない。
 * 行は群ごとに見出しを付けて 1 列に並べ、↑↓ は群をまたいで送る。
 */
export function CommandPalette(props: PaletteProps & { onQuery: (q: string) => void }) {
  const emit = useEmit();
  const t = useT();
  const input = useRef<HTMLInputElement>(null);
  const box = useRef<HTMLDivElement>(null);
  const [index, setIndex] = useState(0);
  const items = props.sections.flatMap((s) => s.items);

  useEffect(() => { input.current?.focus(); }, []);
  // 開くときは、ヘッダーの「移動・操作」の錠剤からガラスが広がる。
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

  const runItem = (item: PaletteItem | undefined) => {
    if (item) emit({ type: 'palette.run', command: { id: item.id, label: item.label } });
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); byKey.current = true; setIndex((i) => Math.min(items.length - 1, i + 1)); return; }
    if (e.key === 'ArrowUp') { e.preventDefault(); byKey.current = true; setIndex((i) => Math.max(0, i - 1)); return; }
    if (e.key === 'Escape') { e.preventDefault(); emit({ type: 'palette.close' }); return; }
    // 変換中の Enter は確定のための打鍵なので、実行に使わない。
    if (e.key !== 'Enter' || isComposing(e)) return;
    e.preventDefault();
    // ⌘↵ は、どの行を選んでいても、ホームの欄へ渡す行を実行する。
    if (e.metaKey || e.ctrlKey) { runItem(items.find((x) => x.kind === 'search')); return; }
    runItem(items[index]);
  };

  let at = 0;
  return (
    <div className="overlay" onClick={() => emit({ type: 'palette.close' })}>
      {/* 器は読み上げに対してダイアログである。
          器と入力欄には別の名前を付ける。同じ名前だと、名前で引いたときに 2 つ見つかって区別できない。 */}
      <div ref={box} className="dialog palette" role="dialog" aria-modal="true" aria-label={t('palette.dialog.label')} onClick={(e) => e.stopPropagation()}>
        {/* 入力欄と一覧は combobox と listbox の組で結ぶ。
            選択位置は DOM のフォーカスではなく aria-activedescendant で伝えるので、打鍵は入力欄に残る。 */}
        <input
          ref={input}
          id="palette-input"
          className="input palette-input"
          aria-label={t('palette.input.label')}
          role="combobox"
          aria-expanded
          aria-controls="palette-list"
          aria-activedescendant={items[index] ? `palette-opt-${index}` : undefined}
          placeholder={t('palette.input.placeholder')}
          value={props.query}
          onChange={(e) => props.onQuery(e.target.value)}
          onKeyDown={onKeyDown}
        />
        {props.noMatch && <div className="palette-empty">{t('palette.empty.noMatch')}</div>}
        {items.length === 0 && <div className="empty">{t('palette.empty.noItems')}</div>}
        <div id="palette-list" className="palette-list" role="listbox" aria-label={t('palette.list.label')}>
          {props.sections.map((s) => (
            <div key={s.title} className="palette-section" role="group" aria-label={s.title}>
              {/* 群の名前は器の aria-label が読み上げるので、見出しは目で見る分だけにする。 */}
              <div className="palette-group" aria-hidden="true">
                {s.title}
                {s.count !== null && <span className="palette-count">{s.count}</span>}
                {s.limit && <span className="palette-limit">{s.limit}</span>}
              </div>
              {s.items.map((item) => {
                const i = at++;
                return (
                  <div
                    key={item.id}
                    id={`palette-opt-${i}`}
                    className="palette-item"
                    role="option"
                    aria-selected={i === index}
                    data-active={i === index ? 'true' : undefined}
                    data-kind={item.kind}
                    onMouseEnter={() => { byKey.current = false; setIndex(i); }}
                    onClick={() => runItem(item)}
                  >
                    <Lead item={item} />
                    <span className="palette-label">{highlight(item.label, props.query)}</span>
                    {item.sub && <span className="palette-sub">{item.sub}</span>}
                    <span className="palette-meta">
                      {item.meta && <span className="palette-when">{item.meta}</span>}
                      {item.keys && <kbd className="palette-keys">{item.keys}</kbd>}
                      {item.kind !== 'search' && <span className="palette-ret"><kbd>↵</kbd>{item.kind === 'command' ? '' : ` ${t('palette.hint.open')}`}</span>}
                    </span>
                  </div>
                );
              })}
            </div>
          ))}
        </div>
        <div className="palette-foot" aria-hidden="true">
          <span><kbd>↑</kbd><kbd>↓</kbd> {t('palette.foot.select')}</span>
          <span><kbd>↵</kbd> {t('palette.foot.open')}</span>
          <span><kbd>esc</kbd> {t('palette.foot.close')}</span>
          <span className="palette-foot-end">{t('palette.foot.transcript')}</span>
        </div>
      </div>
    </div>
  );
}
