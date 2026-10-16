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
          {/* 開く版が変わったら（更新後の札から読みに来た）、開き閉じを選び直す。 */}
          <NoteList key={u.notes.filter((n) => n.open).map((n) => n.version).join(' ')} title={u.notesTitle} notes={u.notes} beforeLabel={u.beforeLabel} />
        </section>
      )}
    </>
  );
}

/**
 * 版ごとのノートの行（試作の A1）。押すと本文を開き閉じする。はじめに開くのは presenter が決めた版である。
 * 見出しの右端の文字のボタン（試作の D1）は、開いている版が 1 つでもあれば「すべて閉じる」、全部畳んでいれば「すべて開く」になる。
 * 開いている版の行は、本文をスクロールしているあいだ一覧の上に貼り付く（試作の V1）。どの版を読んでいるかが分かり、押せばそのまま閉じられる。
 * 開き閉じは画面の中だけの状態で、覚えない。
 */
function NoteList(props: { title: string; notes: UpdateNoteRow[]; beforeLabel: string }) {
  const t = useT();
  const [open, setOpen] = useState(() => new Set(props.notes.filter((n) => n.open).map((n) => n.version)));
  const toggle = (v: string) => setOpen((s) => { const next = new Set(s); if (!next.delete(v)) next.add(v); return next; });
  const anyOpen = open.size > 0;
  return (
    <>
    <div className="note-list-head">
      <h3 className="h2">{props.title}</h3>
      <button type="button" className="btn-link note-all" onClick={() => setOpen(anyOpen ? new Set() : new Set(props.notes.map((n) => n.version)))}>
        {anyOpen ? t('update.notes.collapseAll') : t('update.notes.expandAll')}
      </button>
    </div>
    <div className="note-list">
      {props.notes.map((n) => {
        const isOpen = open.has(n.version);
        return (
          <div key={n.version} className="note-row" data-open={isOpen || undefined}>
            <button type="button" className="note-head" aria-expanded={isOpen} onClick={() => toggle(n.version)}>
              <span className="note-ver">{n.version}</span>
              {n.tag !== null && <span className="badge" data-tone="ok">{n.tag}</span>}
              {n.before !== null && <span className="badge" data-tone="warn">{props.beforeLabel}</span>}
              {n.count !== null && <span className="note-count">{n.count}</span>}
              <Icon name="chevron" />
            </button>
            {isOpen && <NoteBody note={n} beforeLabel={props.beforeLabel} />}
          </div>
        );
      })}
    </div>
    </>
  );
}

/**
 * 開いた版の中身（試作の L1）。「更新の前に」の注意と要点の箇条だけを出し、本文は「全文を読む」で出す。
 * 要点を拾えない版（前書きだけなど）は、はじめから本文を出す。
 */
function NoteBody(props: { note: UpdateNoteRow; beforeLabel: string }) {
  const t = useT();
  const n = props.note;
  const [full, setFull] = useState(n.points.length === 0);
  return (
    <div className="note-body">
      {!full && (
        <>
          {n.before !== null && <div className="note-before"><strong>{props.beforeLabel}</strong>{n.before}</div>}
          <ul className="note-points">{n.points.map((p) => <li key={p}>{p}</li>)}</ul>
        </>
      )}
      {full && <Markdown text={n.body} />}
      {n.points.length > 0 && (
        <button type="button" className="btn-link note-full" onClick={() => setFull(!full)}>{full ? t('update.notes.pointsOnly') : t('update.notes.readFull')}</button>
      )}
    </div>
  );
}
