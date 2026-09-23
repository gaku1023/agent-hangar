import { forwardRef } from 'react';
import { Icon } from './primitives/Icon.tsx';

/**
 * スワイプの進み具合を画面端に出す丸。
 * ブラウザの手勢と同じで、払うほど端から出てきて、動いた時点で消える。
 *
 * 毎打鍵で React を回すと画面ごと描き直しになるので、中身は Root が DOM を直に触って変える。
 * ここは器と見た目だけを持つ。
 */
export const SwipeHint = forwardRef<HTMLDivElement>(function SwipeHint(_props, ref) {
  return (
    <div className="swipe-hint" ref={ref} data-testid="swipe-hint" aria-hidden="true">
      <Icon name="chevron" />
    </div>
  );
});
