import { useEmit } from '../intent/chain.tsx';
import type { TabItemProps } from '../presenters/session.ts';
import { Icon } from './primitives/Icon.tsx';

/** タブ 0 が Claude、以降がシェル。並び替えは持たない。 */
export function TabStrip(props: { sessionId: string; tabs: TabItemProps[]; canAdd: boolean }) {
  const emit = useEmit();
  return (
    <div className="tabs" role="tablist">
      {props.tabs.map((t) => (
        <div key={t.id} className={`tab${t.selected ? ' tab-selected' : ''}`} role="tab" aria-selected={t.selected} tabIndex={0}
          onClick={() => emit({ type: 'tab.select', tabId: t.id })} onKeyDown={(e) => { if (e.key === 'Enter') emit({ type: 'tab.select', tabId: t.id }); }}>
          <Icon name={t.kind === 'agent' ? 'agent' : 'shell'} /><span>{t.title}</span>
          {t.closable && <button className="tab-close" aria-label={`${t.title} を閉じる`} onClick={(e) => { e.stopPropagation(); emit({ type: 'tab.close', tabId: t.id }); }}><Icon name="close" /></button>}
        </div>
      ))}
      {props.canAdd && <button className="tab-add" aria-label="シェルタブを追加" onClick={() => emit({ type: 'tab.open', sessionId: props.sessionId, kind: 'shell' })}><Icon name="add" /></button>}
    </div>
  );
}
