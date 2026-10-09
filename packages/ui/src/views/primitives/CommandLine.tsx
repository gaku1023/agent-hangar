import { createContext, useContext, useEffect, useRef, useState } from 'react';
import { useEmit } from '../../intent/chain.tsx';
import type { State } from '../../mediator/types.ts';
import { Icon } from './Icon.tsx';
import { useT } from './language.tsx';

/**
 * 最後にクリップボードへ写せた文（Mediator の copied）。
 * Root が渡し、CopyButton は押した後にこれが進んだのを見てから「コピーしました」を出す。
 */
export const CopiedContext = createContext<State['copied']>(null);

/** 押してから「コピーしました」を出しておく長さ。 */
export const COPIED_MS = 1600;

/**
 * 文をクリップボードへ写す操作の状態。
 * 写すのはランタイムの役目なので、press は clipboard.copy を出す。
 * copied は、押した後にランタイムが写せたと返してから（CopiedContext が進んでから）真になり、COPIED_MS のあいだ続く。
 * 写せなかったときはランタイムがトーストで知らせ、ここは何も変えない。
 */
export function useCopy(text: string): { copied: boolean; press: () => void } {
  const emit = useEmit();
  const done = useContext(CopiedContext);
  // 押したときの知らせの番号。これより後に、この文を写せた知らせが来たら「コピーしました」にする。
  const pressedAt = useRef<number | null>(null);
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (pressedAt.current === null || !done || done.text !== text || done.n <= pressedAt.current) return;
    pressedAt.current = null;
    setCopied(true);
  }, [done, text]);
  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), COPIED_MS);
    return () => clearTimeout(t);
  }, [copied]);
  return { copied, press: () => { pressedAt.current = done?.n ?? 0; emit({ type: 'clipboard.copy', text }); } };
}

/**
 * 押すとクリップボードへ写すボタン（状態は useCopy）。
 * label が無ければアイコンだけにし、読み上げの名前は「〜をコピー」にする。
 * ariaLabel は読み上げの名前をそのまま決める。見えている文がコピーの語でないとき（報告用に写す）に使う。
 */
export function CopyButton(props: { text: string; name?: string; label?: string; ariaLabel?: string }) {
  const t = useT();
  const { copied, press } = useCopy(props.text);
  return (
    <button type="button" className="copy-btn" data-copied={copied ? 'true' : undefined} aria-label={props.ariaLabel ?? t('primitives.commandLine.copyLabel', { name: props.name ?? props.text })} onClick={press}>
      <Icon name={copied ? 'check' : 'copy'} />
      {props.label !== undefined && <span>{copied ? t('common.button.copied') : props.label}</span>}
    </button>
  );
}

/** ターミナルで打つコマンドの行（設定の D1）。薄い地のコードと、右端のコピー。 */
export function CommandLine(props: { command: string }) {
  const t = useT();
  return (
    <div className="cmd-line">
      <code>{props.command}</code>
      <CopyButton text={props.command} label={t('common.button.copy')} />
    </div>
  );
}
