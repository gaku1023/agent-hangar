import type { CloudUsageProps } from '../presenters/cloudUsage.ts';
import { useT } from './primitives/language.tsx';

/**
 * 設定の「使用量と費用」。上に札、下に全部の枠の棒（今日の枠、区切り、今月の枠）。
 * 試作 docs/superpowers/specs/2026-10-02-cloud-usage/usage-merged.html の左上が正本。
 * props だけで描き、状態を持たない。
 */
export function CloudUsage(props: CloudUsageProps) {
  const t = useT();
  return (
    <section className="cu" aria-label={t('cloudUsage.section.title')}>
      <h4 className="cu-h">{t('cloudUsage.section.title')}</h4>
      <div className="cu-tiles">
        {props.tiles.map((tile) => (
          <div key={tile.key} className="cu-tile" data-tone={tile.tone}>
            <div className="cu-k">{tile.label}</div>
            <div className="cu-v">{tile.value}<small>{tile.sub}</small></div>
          </div>
        ))}
      </div>
      {props.strip && <div className="cu-strip" data-tone={props.strip.tone} role={props.strip.tone === 'stop' ? 'alert' : undefined}>{props.strip.text}</div>}
      <div className="cu-bars">
        {props.bars.map((b, i) => (
          <div key={`${b.when}-${b.label}`} className="cu-row-wrap">
            {i === props.splitAfter && i > 0 && <div className="cu-sep" aria-hidden="true" />}
            <div className="cu-row">
              <span>{b.label}<span className="cu-when">{t(`cloudUsage.when.${b.when}`)}</span></span>
              {b.pct === null ? <span /> : (
                <div className="cu-meter" data-tone={b.tone} role="meter" aria-label={b.label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={b.pct}>
                  <i style={{ width: `${Math.min(100, b.pct)}%` }} />
                </div>
              )}
              <span className="cu-n mono">{b.value}</span>
            </div>
          </div>
        ))}
      </div>
      <div className="cu-legend">
        {props.legend.map((l) => <span key={l}>{l}</span>)}
        <span className="faint">{props.source}</span>
      </div>
      {props.command && <div className="mono faint cu-cmd">{props.command}</div>}
    </section>
  );
}
