import type { LiveStatus } from '@agent-hangar/shared';
const LABEL: Record<LiveStatus, string> = { busy: '作業中', idle: '待機', waiting: '入力待ち' };
export function StatusDot(props: { status: LiveStatus | null; title?: string }) {
  return <span className="dot" data-status={props.status ?? 'ended'} title={props.title ?? (props.status ? LABEL[props.status] : '終了')} aria-label={props.status ? LABEL[props.status] : '終了'} />;
}
