import { useEffect, useState } from 'react';
import { motionMs } from './motion.ts';

/**
 * 値が変わったとき、古い値を上へ、新しい値を下から上へ --dur の長さで動かす（workbench.css の .roll）。
 * 古い値は回している間だけ置く。常に置くと同じ文字が 2 つ並び、読み上げも検索も二重になる。
 * 長さが 0（reduced motion、トークンが読めない環境）のときは回さず、すぐ新しい値だけにする。
 */
export function RollingText(props: { text: string; className?: string }) {
  const [prev, setPrev] = useState(props.text);
  const [rolling, setRolling] = useState(false);
  useEffect(() => {
    if (props.text === prev) return;
    const ms = motionMs('--dur');
    if (!ms) { setPrev(props.text); return; }
    setRolling(true);
    const t = setTimeout(() => { setPrev(props.text); setRolling(false); }, ms);
    return () => clearTimeout(t);
  }, [props.text, prev]);
  return (
    <span className={props.className ? `roll ${props.className}` : 'roll'} data-rolling={rolling ? 'true' : undefined}>
      {rolling && <span className="roll-old" aria-hidden="true">{prev}</span>}
      <span className="roll-new">{props.text}</span>
    </span>
  );
}
