import { useEffect, useRef, useState } from 'react';
import { Icon } from './Icon.tsx';

/** 写したことを見せておく長さ。 */
const DONE_MS = 1600;

/** 押すと text をクリップボードへ写す小さなボタン。写せたら少しの間「コピーしました」にする。 */
export function CopyButton(props: { text: string; className?: string }) {
  const [done, setDone] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  const copy = (e: { stopPropagation(): void }) => {
    // ツールの行の中にあるので、押しても行を開閉させない。
    e.stopPropagation();
    const clip = typeof navigator !== 'undefined' ? navigator.clipboard : undefined;
    if (!clip) return;
    clip.writeText(props.text).then(() => {
      setDone(true);
      clearTimeout(timer.current);
      timer.current = setTimeout(() => setDone(false), DONE_MS);
    }).catch(() => {});
  };
  return (
    <button type="button" className={`copy-btn ${props.className ?? ''}`} data-done={done ? 'true' : undefined} onClick={copy}>
      <Icon name={done ? 'check' : 'copy'} /><span>{done ? 'コピーしました' : 'コピー'}</span>
    </button>
  );
}
