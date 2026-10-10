import { useEmit } from '../action/chain.tsx';
import type { UpdateSectionProps } from '../presenters/update.ts';
import { useT } from './primitives/language.tsx';
import { SetRow } from './primitives/SetRow.tsx';
import { Switch } from './primitives/Switch.tsx';

/**
 * 設定の「更新」の節（段 5-4、試作の「共通」）。
 * 版の行（最終確認と「更新を確認」）、見つけた版の行（取得、進み、再起動して更新、もう一度試す）、知らせのスイッチの 3 行である。
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
  );
}
