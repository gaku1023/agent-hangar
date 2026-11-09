import { useEffect, useState, type Ref } from 'react';
import type { HeldChoiceDto } from '@agent-hangar/shared';
import { useEmit } from '../action/chain.tsx';
import type { HeldEventsCardProps } from '../presenters/heldEvents.ts';
import { Icon } from './primitives/Icon.tsx';
import { useT } from './primitives/language.tsx';

type Mode = HeldChoiceDto['mode'];
const MODES: { mode: Mode; key: 'schedules.event.held.latest' | 'schedules.event.held.all' | 'schedules.event.held.skip' }[] = [
  { mode: 'latest', key: 'schedules.event.held.latest' },
  { mode: 'all', key: 'schedules.event.held.all' },
  { mode: 'skip', key: 'schedules.event.held.skip' },
];

/** ToastStack が札ごとに渡す、出入りの動きの印（ref と、出る間の aria-hidden と inert）。 */
export type CardAttrs = { ref: Ref<HTMLDivElement>; 'aria-hidden'?: boolean; inert?: boolean };

/** 送ってから、押せる状態に戻すまでの時間。送れて札が消えるなら、戻す前に札ごと消える。 */
const SENT_MS = 2000;

/**
 * 閉じている間に溜まったイベントの札（#563 の C4 と C6）。右下に積み、モーダルにはしない（起動も画面も遮らない）。
 * 畳んだ形は「すべて実行」と「選ぶ」の 2 つだけで、すべて実行は結び付けごとに最新の 1 件を流す。
 * 「選ぶ」で結び付けごとに畳んだ群が開き、最新のみ、すべて、実行しないを選んで送る（既定は最新のみ）。
 * 流したあとは山が空になって札が消える。送れなかったときはエラーのトーストが出て札は残る。
 * 選びはこの札の中だけで持つ。山が読み直されても、すでに選んだ結び付けの選びは残す。
 * 送っている間は流す押しを無効にし、二重に送らない。送れずに札が残ったときのために、短い時間のあとで押せるように戻す。
 */
export function HeldEventsCard(props: { card: HeldEventsCardProps; attrs: CardAttrs }) {
  const emit = useEmit();
  const t = useT();
  const c = props.card;
  const [open, setOpen] = useState(false);
  const [picked, setPicked] = useState<Record<string, Mode>>({});
  const [sent, setSent] = useState(false);
  useEffect(() => {
    if (!sent) return undefined;
    const id = setTimeout(() => setSent(false), SENT_MS);
    return () => clearTimeout(id);
  }, [sent]);
  const modeOf = (id: string): Mode => picked[id] ?? 'latest';
  const run = (modeFor: (id: string) => Mode) => { if (sent) return; setSent(true); emit({ type: 'heldEvents.run', choices: c.groups.map((g) => ({ bindingId: g.bindingId, mode: modeFor(g.bindingId) })) }); };
  return (
    <div className="toast notice held-card" data-kind="held-events" role="status" {...props.attrs}>
      <button type="button" className="notice-head held-head" aria-expanded={open} onClick={() => setOpen(!open)}>
        <Icon name="bolt" />
        <span className="notice-label">{c.head}</span>
        <Icon name={open ? 'chevronDown' : 'chevronUp'} />
      </button>
      <div className="notice-body">
        {open && (
          <div className="held-groups">
            {c.groups.map((g) => (
              <div key={g.bindingId} className="held-group" role="group" aria-label={g.label} data-mode={modeOf(g.bindingId)}>
                <div className="held-group-head">
                  <b className="held-group-name">{g.label}</b>
                  <span className="held-count">{g.count}</span>
                  <span className="held-modes">
                    {MODES.map((m) => (
                      <button key={m.mode} type="button" className="chip held-chip" aria-pressed={modeOf(g.bindingId) === m.mode} onClick={() => setPicked({ ...picked, [g.bindingId]: m.mode })}>{t(m.key)}</button>
                    ))}
                  </span>
                </div>
                <ul className="held-items">
                  {g.items.map((it, i) => <li key={i} className="held-item" data-used={usedOf(modeOf(g.bindingId), i, g.items.length) ? undefined : 'false'}><span>{it.text}</span><span className="held-at">{it.at}</span></li>)}
                </ul>
              </div>
            ))}
          </div>
        )}
        <div className="notice-acts held-acts">
          {open
            ? <button type="button" className="btn btn-sm btn-primary" disabled={sent} onClick={() => run(modeOf)}>{t('schedules.action.run')}</button>
            : <>
              <button type="button" className="btn btn-sm" disabled={sent} onClick={() => setOpen(true)}>{t('schedules.event.held.choose')}</button>
              <button type="button" className="btn btn-sm btn-primary" disabled={sent} onClick={() => run(() => 'latest')}>{t('schedules.event.held.runAll')}</button>
            </>}
        </div>
      </div>
    </div>
  );
}

/** その行が流れるか。最新のみは最後の 1 件、すべては全部、実行しないは 1 件も流れない。薄く消して見せる。 */
const usedOf = (mode: Mode, i: number, n: number): boolean => mode === 'all' || (mode === 'latest' && i === n - 1);
