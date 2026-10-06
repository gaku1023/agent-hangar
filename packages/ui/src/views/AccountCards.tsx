import { useRef, type KeyboardEvent } from 'react';
import type { AccountView } from '../presenters/accounts.ts';
import { isPickableAccount } from '../presenters/newSession.ts';
import { AccountMeters } from './primitives/AccountMeters.tsx';

/**
 * 新規セッションのダイアログで、どのアカウントで起こすかを選ぶ横並びの札。
 * アカウントごとに 1 枚の札（radio）で、中身は AccountMeters（色の点、名前、プラン、メール、計器、注記）。
 * 枠が戻る時刻は計器の右に添えない。注記が言うからである。
 * 未ログインとログインの途中の札は aria-disabled で選べない。理由は札の中身（メールの行）が言う。
 * 矢印キーは選べる隣の札へ移して選び、端では反対の端へ回る（Segmented と同じ操作）。
 * 色は AccountMeters が描く。ここでは色を扱わない。
 */
export function AccountCards(props: { label: string; value: string; options: AccountView[]; onChange: (id: string) => void }) {
  const box = useRef<HTMLDivElement>(null);
  const checked = props.options.findIndex((a) => a.id === props.value);
  // 選んでいる札が無いとき（一覧に無い値）は、最初の札を tab の入口にする。
  const entry = Math.max(checked, 0);

  const pick = (a: AccountView) => {
    if (!isPickableAccount(a) || a.id === props.value) return;
    props.onChange(a.id);
  };

  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    // ⌘← は戻る、などの大域のキー。選び直しに奪わない。
    if (e.altKey || e.metaKey || e.ctrlKey) return;
    const step = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 0;
    if (!step) return;
    e.preventDefault();
    const n = props.options.length;
    for (let i = 1; i < n; i += 1) {
      const next = (((entry + step * i) % n) + n) % n;
      const a = props.options[next]!;
      if (!isPickableAccount(a)) continue;
      props.onChange(a.id);
      box.current?.querySelectorAll<HTMLButtonElement>('[role="radio"]')[next]?.focus();
      return;
    }
  };

  return (
    <div ref={box} className="account-choices" role="radiogroup" aria-label={props.label} onKeyDown={onKey}>
      {props.options.map((a, i) => (
        <button key={a.id} type="button" role="radio" className="account-card" aria-checked={a.id === props.value} aria-disabled={isPickableAccount(a) ? undefined : 'true'} tabIndex={i === entry ? 0 : -1} onClick={() => pick(a)}>
          <AccountMeters account={a} showResets={false} />
        </button>
      ))}
    </div>
  );
}
