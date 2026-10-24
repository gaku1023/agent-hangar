import { useLayoutEffect, useRef, type ReactNode } from 'react';
import { Icon } from './Icon.tsx';
import { useT } from './language.tsx';
import { liftIn } from './motionKit.ts';
import { Popover } from './Popover.tsx';

/** 札の幅の上限（px）。短い説明は中身の幅に縮む。 */
const MAX_WIDTH = 440;

/**
 * 見出しの横に置く小さな ⓘ。押すと、隠しておいた説明の札が浮かぶ。
 * もう一度押す、外を押す、Esc で閉じる（開け閉めと焦点の扱いは Popover に任せる）。
 * ボタンと札は aria-expanded と aria-controls で結ぶ。名前は「{label}の説明」で、札も同じ名前で読む。
 * 札は 4px 下から持ち上がって現れる（liftIn）。減らす動きの設定では動かさない。
 */
export function InfoTip(props: { label: string; children: ReactNode; width?: number }) {
  const t = useT();
  const name = t('primitives.infoTip.label', { label: props.label });
  return (
    <Popover label={name} width={props.width ?? MAX_WIDTH} align="start" fit className="info-tip-pop"
      face={(p) => <button type="button" className="info-tip" aria-label={name} {...p}><Icon name="info" /></button>}>
      <Lift>{props.children}</Lift>
    </Popover>
  );
}

/** 札の中身。描かれたとき（開くたび）に、包む札ごと持ち上げる。位置が決まる前の、塗られる前に掛ける。 */
function Lift(props: { children: ReactNode }) {
  const body = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const pop = body.current?.closest<HTMLElement>('.info-tip-pop');
    if (pop) liftIn(pop);
  }, []);
  return <div ref={body} className="info-tip-body">{props.children}</div>;
}
