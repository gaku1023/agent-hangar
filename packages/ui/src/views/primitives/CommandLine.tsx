import { createContext, useContext, useEffect, useRef, useState } from 'react';
import { useEmit } from '../../intent/chain.tsx';
import type { State } from '../../mediator/types.ts';
import { Icon } from './Icon.tsx';

/**
 * 最後にクリップボードへ写せた文（Mediator の copied）。
 * Root が渡し、CopyButton は押した後にこれが進んだのを見てから「コピーしました」を出す。
 */
export const CopiedContext = createContext<State['copied']>(null);

/** 押してから「コピーしました」を出しておく長さ。 */
export const COPIED_MS = 1600;

/**
 * 押すとクリップボードへ写すボタン。
 * 写すのはランタイムの役目なので、ここは clipboard.copy を出す。
 * 「コピーしました」は、押した後にランタイムが写せたと返してから（CopiedContext が進んでから）出す。
 * 写せなかったときはランタイムがトーストで知らせ、ここは何も変えない。
 * label が無ければアイコンだけにし、読み上げの名前は「〜をコピー」にする。
 */
export function CopyButton(props: { text: string; name?: string; label?: string }) {
  const emit = useEmit();
  const done = useContext(CopiedContext);
  // 押したときの知らせの番号。これより後に、この文を写せた知らせが来たら「コピーしました」にする。
  const pressedAt = useRef<number | null>(null);
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (pressedAt.current === null || !done || done.text !== props.text || done.n <= pressedAt.current) return;
    pressedAt.current = null;
    setCopied(true);
  }, [done, props.text]);
  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), COPIED_MS);
    return () => clearTimeout(t);
  }, [copied]);
  return (
    <button type="button" className="copy-btn" data-copied={copied ? 'true' : undefined} aria-label={`${props.name ?? props.text} をコピー`} onClick={() => { pressedAt.current = done?.n ?? 0; emit({ type: 'clipboard.copy', text: props.text }); }}>
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
