import { useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { useEmit } from '../intent/chain.tsx';
import type { TabItemProps } from '../presenters/session.ts';
import { Icon } from './primitives/Icon.tsx';

/**
 * タブ 0 が Claude、以降がシェル。並び替えは持たない。
 * キーは tablist の作法に合わせる。
 * Tab で止まるのは 1 つのタブだけ（roving tabindex）で、← → と Home End でタブの間を移り、Enter か Space で選ぶ。
 * 選ぶとフォーカスはターミナルへ移るので、矢印で移るだけでは選ばない（手動の選択）。
 */
export function TabStrip(props: { sessionId: string; tabs: TabItemProps[]; canAdd: boolean; canSplit: boolean; split: boolean }) {
  const emit = useEmit();
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
      {props.tabs.map((t, i) => (
        <div key={t.id} className={`tab${t.selected ? ' tab-selected' : ''}`} role="tab" aria-selected={t.selected} tabIndex={t.id === stopId ? 0 : -1}
          onClick={() => emit({ type: 'tab.select', tabId: t.id })} onFocus={() => setFocusId(t.id)} onKeyDown={(e) => onTabKey(e, i)}>
          <Icon name={t.kind === 'agent' ? 'agent' : 'shell'} /><span>{t.title}</span>
          {t.closable && <button className="tab-close" aria-label={`${t.title} を閉じる`} onClick={(e) => { e.stopPropagation(); emit({ type: 'tab.close', tabId: t.id }); }}><Icon name="close" /></button>}
        </div>
      ))}
      {props.canAdd && <button className="tab-add" aria-label="シェルタブを追加" onClick={() => emit({ type: 'tab.open', sessionId: props.sessionId, kind: 'shell' })}><Icon name="add" /></button>}
      {/* 横に並べるのはタブが 2 つ以上あるときだけ押せる。左は選択中のタブ、右は Mediator が選ぶ。 */}
      <button className="btn tab-action" aria-label="横に並べる" aria-pressed={props.split} disabled={!props.canSplit} title={props.canSplit ? '横に並べる（⌘\\）' : 'タブが 2 つ必要です'} onClick={() => emit({ type: 'split.toggle' })}><Icon name="split" /></button>
    </div>
  );
}
