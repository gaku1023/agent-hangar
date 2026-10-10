import { useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from 'react';
import { useEmit } from '../action/chain.tsx';
import type { TabItemProps } from '../presenters/session.ts';
import { Icon } from './primitives/Icon.tsx';
import { useT } from './primitives/language.tsx';
import { useMotionList } from './primitives/useMotionList.ts';

/**
 * タブ 0 が Claude、以降がシェル。並び替えは持たない。
 * キーは tablist の作法に合わせる。
 * タブそのものは Tab で 1 つだけ止まり（roving tabindex）、← → と Home End でタブの間を移り、Enter か Space で選ぶ。
 * 各タブの閉じるボタンは Tab で止めない（tabIndex=-1）。キーボードでは ⌘W で閉じられるからである。
 * 追加と分割のボタンは別の操作なので、Tab の止まり先に残す。
 * 選ぶとフォーカスはターミナルへ移るので、矢印で移るだけでは選ばない（手動の選択）。
 */
export function TabStrip(props: { sessionId: string; tabs: TabItemProps[]; canAdd: boolean; canSplit: boolean; split: boolean; trailing?: ReactNode }) {
  const emit = useEmit();
  const tr = useT();
  // タブの出入り。足したタブは幅も伸ばして隣を押し、閉じたタブは畳んでから外す。
  // セッションが替わる描画は、前のセッションのタブを畳まず入れ替える。
  const { list, ref: tabRef } = useMotionList(props.tabs, (t) => t.id, { enter: 'grow', axis: 'x', scope: props.sessionId });
  const listRef = useRef<HTMLDivElement>(null);
  // 矢印で移った先のタブ。列を離れたら忘れて、次に入ってきたときは選ばれたタブに止まる。
  const [focusId, setFocusId] = useState<string | null>(null);
  const stopId = props.tabs.some((t) => t.id === focusId) ? focusId : props.tabs.find((t) => t.selected)?.id ?? props.tabs[0]?.id;

  const onTabKey = (e: ReactKeyboardEvent, i: number) => {
    // 閉じるボタンの打鍵は、そのボタンのものである。
    if (e.target !== e.currentTarget) return;
    // ⌘← と ⌘→ は戻ると進むの打鍵なので、タブでは使わない。
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const n = props.tabs.length;
    const to = e.key === 'ArrowRight' ? (i + 1) % n : e.key === 'ArrowLeft' ? (i - 1 + n) % n : e.key === 'Home' ? 0 : e.key === 'End' ? n - 1 : null;
    if (to !== null) {
      e.preventDefault();
      listRef.current?.querySelectorAll<HTMLElement>('[role="tab"]')[to]?.focus();
      return;
    }
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); emit({ type: 'tab.select', tabId: props.tabs[i]!.id }); }
  };

  return (
    <div ref={listRef} className="tabs" role="tablist"
      onBlur={(e) => {
        const tab = (e.relatedTarget as HTMLElement | null)?.closest?.('[role="tab"]');
        if (!tab || !e.currentTarget.contains(tab)) setFocusId(null);
      }}>
      {list.map(({ item: t, key, leaving }) => {
        // 畳んで出ているタブは、見た目だけを残す。役も、フォーカスも、クリックも、閉じるボタンも持たせない。
        // 選択の形も持たせない（閉じた時点の選択は、もう次のタブへ移っている）。
        if (leaving) {
          return (
            <div key={key} ref={tabRef(key)} className="tab" role="presentation" aria-hidden="true">
              <Icon name={t.kind === 'agent' ? 'agent' : 'shell'} /><span>{t.title}</span>
            </div>
          );
        }
        const i = props.tabs.indexOf(t);
        return (
          <div key={key} ref={tabRef(key)} className={`tab${t.selected ? ' tab-selected' : ''}`} role="tab" aria-selected={t.selected} tabIndex={t.id === stopId ? 0 : -1}
            onClick={() => emit({ type: 'tab.select', tabId: t.id })} onFocus={() => setFocusId(t.id)} onKeyDown={(e) => onTabKey(e, i)}>
            <Icon name={t.kind === 'agent' ? 'agent' : 'shell'} /><span>{t.title}</span>
            {t.closable && <button className="tab-close" tabIndex={-1} aria-label={tr('terminal.tab.close', { title: t.title })} onClick={(e) => { e.stopPropagation(); emit({ type: 'tab.close', tabId: t.id }); }}><Icon name="close" /></button>}
          </div>
        );
      })}
      {props.canAdd && <button className="tab-add" aria-label={tr('terminal.tab.addShell')} onClick={() => emit({ type: 'tab.open', sessionId: props.sessionId, kind: 'shell' })}><Icon name="add" /></button>}
      {/* 横に並べるのはタブが 2 つ以上あるときだけ押せる。左は選択中のタブ、右は Mediator が選ぶ。 */}
      <button className="btn tab-action" aria-label={tr('terminal.tab.split')} aria-pressed={props.split} disabled={!props.canSplit} title={props.canSplit ? tr('terminal.tab.splitTitle') : tr('terminal.tab.splitNeedsTwo')} onClick={() => emit({ type: 'split.toggle' })}><Icon name="split" /></button>
      {/* 右の欄を閉じている間の、開くボタン（設計書 ②）。帯の右端に寄せる。 */}
      {props.trailing && <span className="tabs-trailing">{props.trailing}</span>}
    </div>
  );
}
