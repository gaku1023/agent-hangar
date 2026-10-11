import { useLayoutEffect, useRef, type ReactNode } from 'react';
import { collapseOut, growIn, motionOn, shapeNow } from './motionKit.ts';
import { usePresence } from './usePresence.ts';

/**
 * 開く・折りたたむ箱（プロジェクト画面の右パネルの節の中身、アーティファクトの「すべて表示」で増える分）。
 * 開くときは growIn で高さを 0 から伸ばし、閉じるときは collapseOut で薄れながら畳んでから隠す。下の要素は押されて滑る。
 * 畳む途中で開き直したときは、0 へ跳ばずに、そのときの高さと薄さから伸び直す。
 * はじめの描画では動かさない。reduced motion（長さ 0）と Web Animations の無い環境では、その描画のうちに切り替える。
 * keep が真なら、閉じても中身を外さず hidden で隠す（TODO の欄の選びや書きかけを、折りたたみの間も残すため）。
 * 偽なら閉じ終わったら外す。onClosed は、閉じ終わって隠れた（外れた）ときに 1 度呼ぶ。
 */
export function FoldBox(props: { open: boolean; keep?: boolean; id?: string; className: string; onClosed?: () => void; children: ReactNode }) {
  const { open, keep = false } = props;
  const wasOpen = useRef(open);
  const box = useRef<HTMLDivElement | null>(null);
  // 畳む途中で開き直したときの、そのときの形。下の usePresence が畳む動きを取り消すと形が戻ってしまうので、
  // それより先に（同じ部品の layout effect は書いた順に走る）読んでおく。
  const resume = useRef<Keyframe | null>(null);
  useLayoutEffect(() => {
    const el = box.current;
    resume.current = open && !wasOpen.current && el && el.getAnimations?.().some((a) => a.playState === 'running') ? shapeNow(el) : null;
  }, [open]);
  // 閉じた形で描き始めた箱（keep で隠したまま置くもの）は、もう隠れているので畳まない。
  const { mounted, leaving, ref } = usePresence<HTMLDivElement>(open, (el) => (!el.hidden && motionOn(el) ? collapseOut(el) : null));
  // 開いたとき。閉じる動き（最後の形を残す）が箱に残っていれば取り消してから伸ばす。usePresence の取り消しは出る途中のものだけなので、隠し終えた箱の残りはここで消す。
  useLayoutEffect(() => {
    const el = ref.current;
    if (open && !wasOpen.current && el) {
      el.getAnimations?.().forEach((a) => a.cancel());
      growIn(el, 'y', resume.current ?? undefined);
    }
    resume.current = null;
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
    <div ref={(el) => { box.current = el; ref.current = el; }} id={props.id} className={props.className} hidden={!mounted} data-leaving={leaving ? 'true' : undefined}>
      {props.children}
    </div>
  );
}
