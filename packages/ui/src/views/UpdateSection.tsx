import { useState } from 'react';
import { useEmit } from '../action/chain.tsx';
import type { UpdateNoteRow, UpdateSectionProps } from '../presenters/update.ts';
import { Icon } from './primitives/Icon.tsx';
import { useT } from './primitives/language.tsx';
import { Markdown } from './primitives/Markdown.tsx';
import { SetRow } from './primitives/SetRow.tsx';
import { Switch } from './primitives/Switch.tsx';

/**
 * 設定の「更新」の節（段 5-4、試作の「共通」）。
 * 版の行（最終確認と「更新を確認」）、見つけた版の行（取得、進み、再起動して更新、もう一度試す）、知らせのスイッチの 3 行と、リリースノートの履歴である。
 * 右下の札を閉じた版も、ここからは入れられる。
 * 殻が updater を持たない（ブラウザ）ときは 1 文だけを出す。
 */
export function UpdateSection(props: { update: UpdateSectionProps }) {
  const emit = useEmit();
  const t = useT();
  const u = props.update;
  if (!u.supported) return <section><div className="faint">{u.unsupported}</div></section>;
  const p = u.pending;
  return (
    <>
      <section>
        <SetRow title={u.version.title} desc={u.version.sub}
          control={<button type="button" className="btn btn-sm" disabled={u.version.checkDisabled} onClick={() => emit({ type: 'update.check' })}>{u.version.checkLabel}</button>} />
        {p && (
          <SetRow title={p.title}
            desc={<>
              {p.detail}
              {p.progress && (
                <span className="update-progress">
                  <span className="update-bar" role="progressbar" aria-label={t('update.card.progressLabel')} aria-valuemin={0} aria-valuemax={100} aria-valuenow={p.progress.percent ?? undefined} data-indeterminate={p.progress.percent === null ? 'true' : undefined}>
                    <i style={p.progress.percent === null ? undefined : { width: `${p.progress.percent}%` }} />
                  </span>
                  <span className="notice-sub">{p.progress.label}</span>
                </span>
              )}
            </>}
            control={<>{p.actions.map((a) => <button key={a.label} type="button" className={`btn btn-sm${a.primary ? ' btn-primary' : ''}`} onClick={() => emit(a.action)}>{a.label}</button>)}</>} />
        )}
        <SetRow title={t('update.settings.notifyTitle')} desc={u.notify.desc}
          control={<Switch label={t('update.settings.notifyTitle')} checked={u.notify.on} onChange={(on) => emit({ type: 'update.notify', on })} />} />
      </section>
      {u.notes.length > 0 && (
        <section className="release-notes">
          <h3 className="h2">{u.notesTitle}</h3>
          {/* 開く版が変わったら（更新後の札から読みに来た）、開き閉じを選び直す。 */}
          <NoteList key={u.notes.filter((n) => n.open).map((n) => n.version).join(' ')} notes={u.notes} beforeLabel={u.beforeLabel} />
        </section>
      )}
    </>
  );
}

/**
 * 版ごとのノートの行（試作の A1）。押すと本文を開き閉じする。はじめに開くのは presenter が決めた版である。
 * 開き閉じは画面の中だけの状態で、覚えない。
 */
function NoteList(props: { notes: UpdateNoteRow[]; beforeLabel: string }) {
  const [open, setOpen] = useState(() => new Set(props.notes.filter((n) => n.open).map((n) => n.version)));
  const toggle = (v: string) => setOpen((s) => { const next = new Set(s); if (!next.delete(v)) next.add(v); return next; });
  return (
    <div className="note-list">
      {props.notes.map((n) => {
        const isOpen = open.has(n.version);
        return (
          <div key={n.version} className="note-row" data-open={isOpen || undefined}>
            <button type="button" className="note-head" aria-expanded={isOpen} onClick={() => toggle(n.version)}>
              <span className="note-ver">{n.version}</span>
              {n.tag !== null && <span className="badge" data-tone="ok">{n.tag}</span>}
              {n.hasBefore && <span className="badge" data-tone="warn">{props.beforeLabel}</span>}
              <Icon name="chevron" />
            </button>
            {isOpen && <div className="note-body"><Markdown text={n.body} /></div>}
          </div>
        );
      })}
    </div>
  );
}
