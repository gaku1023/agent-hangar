import { useContext, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { TerminalHost } from '../runtime/terminals.ts';
import { createReplyRewrites, type PlacedReply, type ReplyState } from '../runtime/termRewrite.ts';
import { Icon } from './primitives/Icon.tsx';
import { useT } from './primitives/language.tsx';
import { TranslateContext } from './translateMsg.tsx';

/**
 * 動いている会話のターミナルの、英語の返答のマスを日本語の訳で上書きする（docs/design.md「英語の返答の翻訳」のターミナルの節）。
 * 上書きは runtime/termRewrite.ts に任せ、ここは返答ごとの「原文に戻す」アイコンを描く。
 * 設定が切（TranslateContext が null）なら何もしない。
 */
export function TermTranslations(props: { host: TerminalHost; tabId: string; replies: readonly string[] }) {
  const { host, tabId } = props;
  const api = useContext(TranslateContext);
  const [placed, setPlaced] = useState<PlacedReply[]>([]);
  // 原文に戻した返答。描き直しで上書きし直しても保つよう、ここに持つ。
  const [orig, setOrig] = useState<ReadonlySet<string>>(() => new Set());
  const replies = useRef(props.replies);
  replies.current = props.replies;
  const origRef = useRef(orig);
  origRef.current = orig;
  const ctl = useRef<ReturnType<typeof createReplyRewrites> | null>(null);

  useEffect(() => {
    if (!api || !host.rewrite) return;
    // 端末は親（TerminalPane）の effect で開くので、子のここではまだ開いていないことがある。開いたら付ける。
    let dead = false;
    const open = () => {
      if (dead || ctl.current) return;
      const term = host.rewrite?.(tabId);
      if (!term) return;
      ctl.current = createReplyRewrites(term, api, (list) => { if (!dead) setPlaced(list); });      ctl.current.setOriginal(origRef.current);
      ctl.current.setReplies(replies.current);
    };
    open();
    queueMicrotask(open);
    const unsubscribe = host.subscribe(open);
    return () => {
      dead = true;
      unsubscribe();
      ctl.current?.dispose();
      ctl.current = null;
      setPlaced([]);
    };
  }, [api, host, tabId]);

  useEffect(() => { ctl.current?.setReplies(props.replies); }, [props.replies]);
  useEffect(() => { ctl.current?.setOriginal(orig); }, [orig]);

  if (!api) return null;
  const toggle = (text: string) => setOrig((s) => {
    const next = new Set(s);
    if (next.has(text)) next.delete(text); else next.add(text);
    return next;
  });
  return <>{placed.map((p) => p.el && createPortal(<ReplyToggle state={p.state} onToggle={() => toggle(p.text)} />, p.el, p.text))}</>;
}

/** xterm に渡さない操作。アイコンの押し下げが tmux のマウスの操作や選択にならないようにする。 */
const SWALLOW = ['mousedown', 'mouseup', 'pointerdown', 'pointerup', 'dblclick'] as const;

/**
 * 返答の頭の行の右端に置く、原文と訳を切り替えるアイコン。
 * 訳を待つ間は薄く脈打ち、押せない。
 */
function ReplyToggle(props: { state: ReplyState; onToggle: () => void }) {
  const t = useT();
  const btn = useRef<HTMLButtonElement>(null);
  // React の押下の扱いは根で受けるので、xterm の要素を通る前に止められない。DOM で直に受ける。
  const onToggle = useRef(props.onToggle);
  onToggle.current = props.onToggle;
  const ready = props.state !== 'wait';
  useEffect(() => {
    const b = btn.current;
    if (!b) return;
    const stop = (e: Event) => { e.stopPropagation(); };
    const click = (e: Event) => { e.stopPropagation(); e.preventDefault(); if (ready) onToggle.current(); };
    for (const k of SWALLOW) b.addEventListener(k, stop);
    b.addEventListener('click', click);
    return () => { for (const k of SWALLOW) b.removeEventListener(k, stop); b.removeEventListener('click', click); };
  }, [ready]);
  const label = t(props.state === 'orig' ? 'transcript.translate.showTranslation' : 'transcript.translate.showOriginal');
  return (
    <button ref={btn} type="button" className="term-tr-toggle" data-state={props.state} disabled={!ready} aria-pressed={props.state === 'ja'} aria-label={label} title={label}>
      <Icon name="translate" />
    </button>
  );
}
