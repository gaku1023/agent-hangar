import { createContext, useContext, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { isEnglishText } from '@agent-hangar/shared';
import { Clamp, estimateLines, MSG_LINES, SLACK } from './primitives/Clamp.tsx';
import { Icon } from './primitives/Icon.tsx';
import { useT } from './primitives/language.tsx';
import { Markdown } from './primitives/Markdown.tsx';
import { fadeIn, resizeFrom } from './primitives/motionKit.ts';
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
 * 訳を待つ間は文字の上に薄い光を流し、届いたら高さを滑らせて中身を薄く入れ替える（resizeFrom と fadeIn）。
 * lazy（思考）は自動では訳さない。Clamp の「すべて表示」で開いたとき、または畳まれない短いものは訳すアイコンを押したときに訳す（2026-11-25）。
 * 原文に戻したかは行の開閉と同じ置き場（part 'orig'）に持つ。既定は訳文で、検索や会話を開いたときの跳び先でも訳文のまま見せる。
 */
export function TranslatableMsg(props: { className: string; seq: number; text: string; clamp: boolean; lazy?: boolean }) {
  const t = useT();
  const api = useContext(TranslateContext);
  const want = api !== null && isEnglishText(props.text);
  const [done, setDone] = useState<{ src: string; out: string | null } | null>(() => {
    const hit = want ? api.cached(props.text) : null;
    return hit === null ? null : { src: props.text, out: hit };
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
  const from = useRef<number | null>(null);
  const settled = done !== null && done.src === props.text;
  const ja = settled ? done.out : null;

  useEffect(() => {
    if (!want || !trigger || settled) return;
    let alive = true;
    void api.translate(props.text).then((out) => {
      if (!alive) return;
      if (out !== null && box.current) from.current = box.current.getBoundingClientRect().height;
      setDone({ src: props.text, out });
    });
    return () => { alive = false; };
  }, [api, want, trigger, settled, props.text]);

  const shown = ja !== null && !orig ? ja : props.text;
  useLayoutEffect(() => {
    const h = from.current;
    from.current = null;
    if (h === null || !box.current || !body.current) return;
    resizeFrom(box.current, h);
    fadeIn(body.current, '--dur-fast');
  }, [shown]);

  const toggle = () => {
    if (box.current) from.current = box.current.getBoundingClientRect().height;
    setOrig(!orig);
  };
  const pending = want && trigger && !settled;
  const offer = !!props.lazy && want && !trigger && !clamped;
  const askTranslate = () => { if (opens) opens.set(props.seq, 'go', true); else setLocalGo(true); };
  const content = () => <Markdown text={shown} />;
  return (
    <div ref={box} className={props.className} data-translating={pending ? 'true' : undefined} data-translated={ja !== null ? 'true' : undefined} data-offer={offer ? 'true' : undefined}>
      <div ref={body} className="msg-body">
        {props.clamp ? <Clamp seq={props.seq} part="msg" lines={estimateLines(shown)} shown={MSG_LINES} height>{content}</Clamp> : content()}
      </div>
      {offer && (
        <button type="button" className="msg-translate" aria-pressed={false} aria-label={t('transcript.translate.showTranslation')} title={t('transcript.translate.showTranslation')} onClick={askTranslate}>
          <Icon name="translate" />
        </button>
      )}
      {ja !== null && (
        <button type="button" className="msg-translate" aria-pressed={!orig} aria-label={t(orig ? 'transcript.translate.showTranslation' : 'transcript.translate.showOriginal')} title={t(orig ? 'transcript.translate.showTranslation' : 'transcript.translate.showOriginal')} onClick={toggle}>
          <Icon name="translate" />
        </button>
      )}
    </div>
  );
}
