import { createContext, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { isEnglishText } from '@agent-hangar/shared';
import { splitBlocks } from '../runtime/termRewrite.ts';
import { Clamp, estimateLines, MSG_LINES, SLACK } from './primitives/Clamp.tsx';
import { Icon } from './primitives/Icon.tsx';
import { useT } from './primitives/language.tsx';
import { Markdown } from './primitives/Markdown.tsx';
import { fadeIn, resizeFrom, riseIn } from './primitives/motionKit.ts';
import { OpenContext, useOpen } from './transcriptOpen.tsx';

/**
 * AI の英語の返答と思考を、表示する側で日本語にする（docs/design.md「英語の返答の翻訳」）。
 * 画面は fetch を呼ばないので、Root が api をつないで Context で配る。設定が切のときは Root が null を配り、何も訳さない。
 */
export type TranslateApi = {
  /** 覚えている訳。無ければ null（まだ訳していない）。 */
  cached(text: string): string | null;
  /** 訳す。訳せなければ（plamo-translate が無い、失敗）null。 */
  translate(text: string): Promise<string | null>;
};

export const TranslateContext = createContext<TranslateApi | null>(null);

/**
 * 返答か思考の 1 通。英語なら訳文に置き換えて見せ、右上の切り替えで原文に戻す（2026-11-25 の試作の A）。
 * 訳は段落ごとに頼み（ターミナルと同じ runtime/termRewrite.ts の splitBlocks。訳の覚えも共有する）、届いた段落から訳文にする（2026-11-26 の試作の「段落ずつ」）。
 * 訳を待つ段落は文字の上に薄い光を流し、届いた段落は高さを滑らせながら、ぼかしから --dur-reveal でゆっくり浮かび上がる（resizeFrom と riseIn）。
 * 初めから覚えていた段落は動かさずに訳文で出す。
 * lazy（思考）は自動では訳さない。Clamp の「すべて表示」で開いたとき、または畳まれない短いものは訳すアイコンを押したときに訳す（2026-11-25）。
 * 原文に戻したかは行の開閉と同じ置き場（part 'orig'）に持つ。既定は訳文で、検索や会話を開いたときの跳び先でも訳文のまま見せる。
 */
export function TranslatableMsg(props: { className: string; seq: number; text: string; clamp: boolean; lazy?: boolean }) {
  const t = useT();
  const api = useContext(TranslateContext);
  const want = api !== null && isEnglishText(props.text);
  const blocks = useMemo(() => (want ? splitBlocks(props.text) : []), [want, props.text]);
  // 段落ごとの訳。null は訳せなかったこと。無ければまだ届いていない。
  const [outs, setOuts] = useState<ReadonlyMap<string, string | null>>(() => {
    const m = new Map<string, string | null>();
    if (api) for (const b of blocks) { const hit = api.cached(b); if (hit !== null) m.set(b, hit); }
    return m;
  });
  // 原文に戻したかは行の開閉と同じ置き場に持つ（窓から外れて戻っても保つ）。useOpen は使わない。useOpen は検索や会話を開いたときの跳び先（revealed）で開いた扱いになり、最新の返答が原文のまま出てしまう。
  const opens = useContext(OpenContext);
  const [localOrig, setLocalOrig] = useState(false);
  const orig = opens ? (opens.get(props.seq, 'orig') ?? false) : localOrig;
  const setOrig = (v: boolean) => { if (opens) opens.set(props.seq, 'orig', v); else setLocalOrig(v); };
  // 思考は開いたときか、訳すアイコンを押したときに訳す。押したかも同じ置き場（part 'go'）に持つ。
  const [localGo, setLocalGo] = useState(false);
  const go = opens ? (opens.get(props.seq, 'go') ?? false) : localGo;
  const [msgOpen] = useOpen(props.seq, 'msg');
  const clamped = props.clamp && estimateLines(props.text) > MSG_LINES + SLACK;
  const trigger = !props.lazy || go || (clamped && msgOpen);
  const box = useRef<HTMLDivElement>(null);
  const body = useRef<HTMLDivElement>(null);
  const blockEls = useRef(new Map<number, HTMLDivElement>());
  /** 入れ替える前の高さ。入れ替えた後の描画で、ここから滑らせる。 */
  const from = useRef<number | null>(null);
  /** 届いたばかりの段落。描いた後に浮かび上がらせる。 */
  const fresh = useRef(new Set<string>());

  const missing = blocks.filter((b) => !outs.has(b));
  const missingKey = missing.join('\u0000');
  useEffect(() => {
    if (!api || !want || !trigger || missing.length === 0) return;
    let alive = true;
    // 翻訳は後から頼んだものを先に訳す（後入れ先出し）。下の段落から頼み、上の段落から届くようにする。
    for (const b of [...missing].reverse()) {
      void api.translate(b).then((out) => {
        if (!alive) return;
        if (out !== null) {
          if (from.current === null && box.current) from.current = box.current.getBoundingClientRect().height;
          fresh.current.add(b);
        }
        setOuts((m) => new Map(m).set(b, out));
      });
    }
    return () => { alive = false; };
    // missingKey が missing の中身を表す。
  }, [api, want, trigger, missingKey]);

  const anyJa = blocks.some((b) => (outs.get(b) ?? null) !== null);
  const split = anyJa && !orig;
  const shownOf = (b: string) => (split ? outs.get(b) ?? b : b);
  const shown = split ? blocks.map(shownOf).join('\n\n') : props.text;
  useLayoutEffect(() => {
    const h = from.current;
    from.current = null;
    const arrived = [...fresh.current];
    fresh.current.clear();
    if (h !== null && box.current) resizeFrom(box.current, h);
    if (arrived.length > 0 && split) {
      blocks.forEach((b, i) => { const el = blockEls.current.get(i); if (el && arrived.includes(b)) riseIn(el, 0, '--dur-reveal'); });
    } else if (h !== null && body.current) fadeIn(body.current, '--dur-fast');
  }, [shown]);

  const toggle = () => {
    if (box.current) from.current = box.current.getBoundingClientRect().height;
    setOrig(!orig);
  };
  const pending = want && trigger && missing.length > 0;
  const offer = !!props.lazy && want && !trigger && !clamped;
  const askTranslate = () => { if (opens) opens.set(props.seq, 'go', true); else setLocalGo(true); };
  const content = () => split ? (
    <div className="msg-blocks">
      {blocks.map((b, i) => (
        <div key={i} ref={(el) => { if (el) blockEls.current.set(i, el); else blockEls.current.delete(i); }} className="msg-block" data-translating={outs.has(b) ? undefined : 'true'}>
          <Markdown text={shownOf(b)} />
        </div>
      ))}
    </div>
  ) : <Markdown text={shown} />;
  return (
    <div ref={box} className={props.className} data-translating={pending ? 'true' : undefined} data-split={split ? 'true' : undefined} data-translated={anyJa ? 'true' : undefined} data-offer={offer ? 'true' : undefined}>
      <div ref={body} className="msg-body">
        {props.clamp ? <Clamp seq={props.seq} part="msg" lines={estimateLines(shown)} shown={MSG_LINES} height>{content}</Clamp> : content()}
      </div>
      {offer && (
        <button type="button" className="msg-translate" aria-pressed={false} aria-label={t('transcript.translate.showTranslation')} title={t('transcript.translate.showTranslation')} onClick={askTranslate}>
          <Icon name="translate" />
        </button>
      )}
      {anyJa && (
        <button type="button" className="msg-translate" aria-pressed={!orig} aria-label={t(orig ? 'transcript.translate.showTranslation' : 'transcript.translate.showOriginal')} title={t(orig ? 'transcript.translate.showTranslation' : 'transcript.translate.showOriginal')} onClick={toggle}>
          <Icon name="translate" />
        </button>
      )}
    </div>
  );
}
