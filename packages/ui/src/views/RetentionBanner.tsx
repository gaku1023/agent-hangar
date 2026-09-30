import { useEmit } from '../intent/chain.tsx';
import type { RetentionBannerProps } from '../presenters/shell.ts';
import { Icon } from './primitives/Icon.tsx';

/**
 * Claude Code の保持期間が既定の 30 日のままのあいだだけ降りてくる帯。
 * 接続の帯と同じ形で、色だけを警告の琥珀にする。文言はすべて presenter が組み立てる。
 */
export function RetentionBanner(props: RetentionBannerProps) {
  const emit = useEmit();
  if (!props.visible) return null;
  return (
    <div className="retention-banner" role="status" aria-label="会話の保持期間">
      <Icon name="retention" />
      <b>{props.title}</b>
      <span className="retention-detail">{props.detail}</span>
      <button className="btn btn-sm" onClick={() => emit({ type: 'retention.dismiss' })}>このままでよい</button>
      <button className="btn btn-sm btn-primary" onClick={() => emit({ type: 'retention.edit', days: props.extendTo, from: 'banner' })}>保持期間を延ばす…</button>
    </div>
  );
}
