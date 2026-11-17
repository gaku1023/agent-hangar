import { useState, type KeyboardEvent } from 'react';
import { useEmit } from '../action/chain.tsx';
import type { ProjectProps } from '../presenters/project.ts';
import { Icon } from './primitives/Icon.tsx';
import { FoldBox } from './primitives/FoldBox.tsx';
import { useT } from './primitives/language.tsx';
import { RelativeTime } from './primitives/RelativeTime.tsx';

const fmt = (n: number) => n.toLocaleString('en-US');

/**
 * 一覧の末尾に畳んだ、非対話の会話（claude -p など）のまとまり。件数と端末の記号だけの 1 行で、押すと行が開く。
 * 数千件ありうるので、開いたときに 1 頁だけ読み、残りは末尾の 1 行で頁ごとに足す。畳んだままなら行は 1 つも描かない。
 * 開閉は FoldBox（growIn と collapseOut）。行は背を低く、等幅の字で、淡い地に左の罫を付ける（rows.css の .headless-*）。
 */
export function HeadlessFold(props: { projectId: string; headless: NonNullable<ProjectProps['headless']> }) {
  const emit = useEmit();
  const t = useT();
  const [open, setOpen] = useState(false);
  const { total, rows, remaining } = props.headless;
  const load = (offset: number) => emit({ type: 'project.headless.load', projectId: props.projectId, offset });
  const toggle = () => {
    // 開くときに、まだ 1 頁も読んでいなければ読む。
    if (!open && rows.length === 0) load(0);
    setOpen(!open);
  };
  const onKey = (id: string) => (e: KeyboardEvent) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); emit({ type: 'session.open', id }); } };
  return (
    <div className="headless-fold">
      <button type="button" className="headless-toggle" aria-expanded={open} aria-label={t('list.headless.fold', { n: fmt(total) })} onClick={toggle}>
        <Icon name="openTerminal" /><span className="num">{fmt(total)}</span><Icon name="chevronDown" />
      </button>
      <FoldBox open={open} className="headless-grp">
        {rows.map((r) => (
          <div key={r.id} className="headless-row" role="row" tabIndex={0} onClick={() => emit({ type: 'session.open', id: r.id })} onKeyDown={onKey(r.id)}>
            <Icon name="openTerminal" />
            <span className="headless-name">{r.name}</span>
            <span className="headless-when"><RelativeTime label={r.when} abs={r.whenAbs} /></span>
          </div>
        ))}
        {remaining > 0 && (
          <button type="button" className="headless-more" aria-label={t('list.headless.more', { n: fmt(remaining) })} onClick={() => load(rows.length)}>
            <Icon name="openTerminal" /><span className="num">{fmt(remaining)}</span><Icon name="chevronDown" />
          </button>
        )}
      </FoldBox>
    </div>
  );
}
