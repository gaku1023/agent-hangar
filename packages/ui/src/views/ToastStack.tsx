import { useEmit } from '../intent/chain.tsx';
import type { Toast } from '../mediator/types.ts';

/** 画面右下に積むトースト。クリックで toast.dismiss を出し、時間切れの削除は Root が担う。 */
export function ToastStack(props: { toasts: Toast[] }) {
  const emit = useEmit();
  return <div className="toasts">{props.toasts.map((t) => <div key={t.id} className="toast" data-level={t.level} role="status" onClick={() => emit({ type: 'toast.dismiss', id: t.id })}>{t.message}</div>)}</div>;
}
