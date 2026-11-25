import { useContext, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { TerminalHost } from '../runtime/terminals.ts';
import { createReplyOverlays, type PlacedReply } from '../runtime/termOverlay.ts';
import { Icon } from './primitives/Icon.tsx';
import { useT } from './primitives/language.tsx';
import { Markdown } from './primitives/Markdown.tsx';
import { fadeIn } from './primitives/motionKit.ts';
import { TranslateContext, type TranslateApi } from './translateMsg.tsx';

/**
 * 動いている会話のターミナルの、英語の返答の上に日本語の訳を重ねる（docs/design.md「英語の返答の翻訳」のターミナルの節、2026-11-25 の試作の A）。
 * 板の付け外しは runtime/termOverlay.ts に任せ、ここは板の中身（訳、待つ間の光、原文に戻すアイコン）を描く。
 * 設定が切（TranslateContext が null）なら板を付けない。
 */
export function TermTranslations(props: { host: TerminalHost; tabId: string; replies: readonly string[] }) {
  const { host, tabId } = props;
  const api = useContext(TranslateContext);
  const [placed, setPlaced] = useState<PlacedReply[]>([]);
  // 原文に戻した返答。板は描き直しのたびに付け直すので、板ではなくここに持つ。
  const [orig, setOrig] = useState<ReadonlySet<string>>(() => new Set());
  const replies = useRef(props.replies);
  replies.current = props.replies;
  const ctl = useRef<ReturnType<typeof createReplyOverlays> | null>(null);

  useEffect(() => {
    if (!api || !host.overlay) return;
    // 端末は親（TerminalPane）の effect で開くので、子のここではまだ開いていないことがある。開いたら付ける。
    let dead = false;
    const open = () => {
      if (dead || ctl.current) return;
      const term = host.overlay?.(tabId);
      if (!term) return;
      ctl.current = createReplyOverlays(term, (list) => { if (!dead) setPlaced(list); });
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

  if (!api) return null;
  const toggle = (text: string) => setOrig((s) => {
    const next = new Set(s);
    if (next.has(text)) next.delete(text); else next.add(text);
    return next;
  });
  return <>{placed.map((p) => p.el && createPortal(<ReplyBoard api={api} text={p.text} orig={orig.has(p.text)} onToggle={() => toggle(p.text)} fontSize={host.fontSize()} />, p.el, p.text))}</>;
}

/** xterm に渡さない操作。板の上の押し下げが tmux のマウスの操作や選択にならないようにする。 */
const SWALLOW = ['mousedown', 'mouseup', 'pointerdown', 'pointerup', 'dblclick'] as const;

/**
 * 1 通分の板。
 * 板の高さは英語の行の範囲と同じで、xterm が決める。日本語の方が短ければ下を空け、収まらなければ板の中で切って下をぼかす。
 * 訳せなかったら何も描かず、英語のまま見せる。
 */
function ReplyBoard(props: { api: TranslateApi; text: string; orig: boolean; onToggle: () => void; fontSize: number }) {
  const t = useT();
  const { api, text } = props;
  // undefined は訳を待っている間、null は訳せなかったこと。
  const [ja, setJa] = useState<string | null | undefined>(() => api.cached(text) ?? undefined);
  useEffect(() => {
    if (ja !== undefined) return;
    let alive = true;
    void api.translate(text).then((out) => { if (alive) setJa(out); });
    return () => { alive = false; };
  }, [api, text, ja]);

  const board = useRef<HTMLDivElement>(null);
  const body = useRef<HTMLDivElement>(null);
  const btn = useRef<HTMLButtonElement>(null);
  const shown = typeof ja === 'string' && !props.orig;
  // 訳が届いたときと、原文から訳へ戻したときだけ薄く入れる。描き直しで付け直した板は、そのまま出す。
  const wasShown = useRef(shown);
  const [over, setOver] = useState(false);
  useLayoutEffect(() => {
    if (shown && !wasShown.current && board.current) fadeIn(board.current, '--dur-fast');
    wasShown.current = shown;
    const b = body.current;
    setOver(b !== null && b.scrollHeight > b.clientHeight + 1);
  }, [shown, ja]);

  // React の押下の扱いは根で受けるので、xterm の要素を通る前に止められない。板のボタンは DOM で直に受ける。
  const onToggle = useRef(props.onToggle);
  onToggle.current = props.onToggle;
  const ready = typeof ja === 'string';
  useEffect(() => {
    const b = btn.current;
    if (!b) return;
    const stop = (e: Event) => { e.stopPropagation(); };
    const click = (e: Event) => { e.stopPropagation(); e.preventDefault(); onToggle.current(); };
    for (const k of SWALLOW) b.addEventListener(k, stop);
    b.addEventListener('click', click);
    return () => { for (const k of SWALLOW) b.removeEventListener(k, stop); b.removeEventListener('click', click); };
  }, [ready]);

  if (ja === null) return null;
  const label = t(props.orig ? 'transcript.translate.showTranslation' : 'transcript.translate.showOriginal');
  return (
    <div className="term-tr" data-translating={ja === undefined ? 'true' : undefined} data-orig={props.orig ? 'true' : undefined} data-clipped={over ? 'true' : undefined} style={{ fontSize: `${props.fontSize}px` }}>
      {shown && (
        <div ref={board} className="term-tr-board">
          <div ref={body} className="term-tr-body"><Markdown text={ja} /></div>
        </div>
      )}
      {ready && (
        <button ref={btn} type="button" className="term-tr-toggle" aria-pressed={!props.orig} aria-label={label} title={label}>
          <Icon name="translate" />
        </button>
      )}
    </div>
  );
}
