import { useEffect, useState } from 'react';
import { useEmit } from '../../intent/chain.tsx';
import { Icon } from './Icon.tsx';

/** 押してから「コピーしました」を出しておく長さ。 */
export const COPIED_MS = 1600;

/**
 * 押すとクリップボードへ写すボタン。
 * 写すのはランタイムの役目なので、ここは clipboard.copy を出して、押したことだけを短く見せる。
 * label が無ければアイコンだけにし、読み上げの名前は「〜をコピー」にする。
 */
export function CopyButton(props: { text: string; name?: string; label?: string }) {
  const emit = useEmit();
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), COPIED_MS);
    return () => clearTimeout(t);
  }, [copied]);
  return (
    <button type="button" className="copy-btn" data-copied={copied ? 'true' : undefined} aria-label={`${props.name ?? props.text} をコピー`} onClick={() => { emit({ type: 'clipboard.copy', text: props.text }); setCopied(true); }}>
      <Icon name={copied ? 'check' : 'copy'} />
      {props.label !== undefined && <span>{copied ? 'コピーしました' : props.label}</span>}
    </button>
  );
}

/** ターミナルで打つコマンドの行（設定の D1）。薄い地のコードと、右端のコピー。 */
export function CommandLine(props: { command: string }) {
  return (
    <div className="cmd-line">
      <code>{props.command}</code>
      <CopyButton text={props.command} label="コピー" />
    </div>
  );
}
