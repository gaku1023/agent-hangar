import { useLayoutEffect, useRef, type ReactNode } from 'react';
import { collapseOut, growIn, motionOn } from './motionKit.ts';
import { usePresence } from './usePresence.ts';

/**
 * 開く・折りたたむ箱（プロジェクト画面の右パネルの節の中身、アーティファクトの「すべて表示」で増える分）。
 * 開くときは growIn で高さを 0 から伸ばし、閉じるときは collapseOut で薄れながら畳んでから隠す。下の要素は押されて滑る。
 * はじめの描画では動かさない。reduced motion（長さ 0）と Web Animations の無い環境では、その描画のうちに切り替える。
 * keep が真なら、閉じても中身を外さず hidden で隠す（TODO の欄の選びや書きかけを、折りたたみの間も残すため）。
 * 偽なら閉じ終わったら外す。onClosed は、閉じ終わって隠れた（外れた）ときに 1 度呼ぶ。
 */
export function FoldBox(props: { open: boolean; keep?: boolean; id?: string; className: string; onClosed?: () => void; children: ReactNode }) {
  const { open, keep = false } = props;
  const { mounted, leaving, ref } = usePresence<HTMLDivElement>(open, (el) => (motionOn(el) ? collapseOut(el) : null));
  const wasOpen = useRef(open);
  // 開いたとき。閉じる動き（最後の形を残す）が箱に残っていれば取り消してから伸ばす。usePresence の取り消しは出る途中のものだけなので、隠し終えた箱の残りはここで消す。
  useLayoutEffect(() => {
    const el = ref.current;
    if (open && !wasOpen.current && el) {
      el.getAnimations?.().forEach((a) => a.cancel());
      growIn(el);
    }
    wasOpen.current = open;
  }, [open, ref]);
  const wasMounted = useRef(mounted);
  const onClosed = useRef(props.onClosed);
  onClosed.current = props.onClosed;
  useLayoutEffect(() => {
    if (wasMounted.current && !mounted) onClosed.current?.();
    wasMounted.current = mounted;
  }, [mounted]);
  if (!mounted && !keep) return null;
  return (
    <div ref={ref} id={props.id} className={props.className} hidden={!mounted} data-leaving={leaving ? 'true' : undefined}>
      {props.children}
    </div>
  );
}
