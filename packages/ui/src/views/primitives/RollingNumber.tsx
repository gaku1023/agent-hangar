import { useEffect, useState } from 'react';

/**
 * 値が変わったとき、古い値を上へ、新しい値を下から上へ 150 ミリ秒で動かす。
 * 桁ごとには分けない。
 * 古い値は回している間だけ置く。
 * 常に置くと同じ文字が 2 つ並び、読み上げも検索も二重になる。
 */
export function RollingNumber(props: { value: number | null; suffix?: string }) {
  const [prev, setPrev] = useState<number | null>(props.value);
  const [rolling, setRolling] = useState(false);
  useEffect(() => {
    if (props.value === prev) return;
    setRolling(true);
    const t = setTimeout(() => { setPrev(props.value); setRolling(false); }, 150);
    return () => clearTimeout(t);
  }, [props.value, prev]);
  const text = (v: number | null) => (v === null ? '未取得' : `${v}${props.suffix ?? ''}`);
  return (
    <span className="roll" data-rolling={rolling ? 'true' : undefined}>
      {rolling && <span className="roll-old" aria-hidden="true">{text(prev)}</span>}
      <span className="roll-new">{text(props.value)}</span>
    </span>
  );
}
