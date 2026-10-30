import { formatRoute } from '@agent-hangar/shared';
import { useLayoutEffect, useRef } from 'react';
import { useEmit } from '../action/chain.tsx';
import type { SpawnedChild } from '../presenters/session.ts';
import { growIn } from './primitives/motionKit.ts';
import { Icon } from './primitives/Icon.tsx';
import { StatusDot } from './primitives/StatusDot.tsx';

function useGoSession() {
  const emit = useEmit();
  return (id: string) => ({
    href: formatRoute({ name: 'session', id }),
    onClick: (e: { preventDefault: () => void }) => { e.preventDefault(); emit({ type: 'nav.go', to: { name: 'session', id } }); },
  });
}

/** 子の画面の見出しの上に出す、起動元のセッションへ戻るリンク（頭に戻る向きの線画）。 */
export function SpawnedFrom(props: { from: { id: string; name: string } | null | undefined }) {
  const go = useGoSession();
  if (!props.from) return null;
  return (
    <a className="spawned-from" title={props.from.name} {...go(props.from.id)}>
      <Icon name="reset" /><span>{props.from.name}</span>
    </a>
  );
}

/**
 * 起動元の画面の見出しの下に出す、起こしたセッションの札の列。子が無ければ何も描かない。
 * 溢れたら横に詰めて切り、高さは増やさない。新しく生まれた札は growIn（横）で出る。
 * 最初の 1 枚が生まれたときは、列ごと growIn（縦）で伸びる。セッションを替えた描画と最初の描画では動かさない。
 */
export function SpawnedPills(props: { sessionId: string; kids: SpawnedChild[] | undefined }) {
  const go = useGoSession();
  const kids = props.kids ?? [];
  const rowRef = useRef<HTMLDivElement>(null);
  const seen = useRef<{ sid: string; ids: Set<string> } | null>(null);
  useLayoutEffect(() => {
    const prev = seen.current;
    seen.current = { sid: props.sessionId, ids: new Set(kids.map((k) => k.id)) };
    const row = rowRef.current;
    if (!prev || prev.sid !== props.sessionId || !row) return;
    if (prev.ids.size === 0) { growIn(row, 'y'); return; }
    for (const k of kids) {
      if (prev.ids.has(k.id)) continue;
      const el = row.querySelector<HTMLElement>(`[data-spawned="${k.id.replace(/["\\]/g, '\\$&')}"]`);
      if (el) growIn(el, 'x');
    }
  });
  if (kids.length === 0) return null;
  return (
    <div ref={rowRef} className="spawned-row">
      {kids.map((k) => (
        <a key={k.id} className="spawned-pill" data-spawned={k.id} title={k.name} {...go(k.id)}>
          <StatusDot status={k.live} aside={k.aside} reason={k.reason} /><span>{k.name}</span>
        </a>
      ))}
    </div>
  );
}
