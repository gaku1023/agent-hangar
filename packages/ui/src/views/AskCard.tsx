import { useLayoutEffect, useRef, useState } from 'react';
import { askTextValid } from '@agent-hangar/shared';
import type { AskCardModel } from '../presenters/peerChat.ts';
import { isComposing } from './ime.ts';
import { Icon } from './primitives/Icon.tsx';
import { useT } from './primitives/language.tsx';
import { collapseOut, growIn } from './primitives/motionKit.ts';
import { usePresence } from './primitives/usePresence.ts';

/**
 * 許可と質問の札の部品（peer chat の列、本文の真上の帯、ホームの行で共用する）。
 * 選択肢は縦 1 列のボタンで、label の下に description を置く。key が数字の選択肢だけ番号を振る。
 * 答えるとキーを onAnswer へ渡す。複数選択（multi）は、選んでから「選んだものを送る」で 1 度に送る。
 * 自由入力（allowText）は、他の答えを書いて「答える」で送る。
 * - header は問いの上に出す。secret の欄は伏せ字（password）にする。
 * - 数の欄（textKind）は、数として合わない、または min・max の外のときは送れない。
 * - 答えを送ってから札が閉じるまでの間（pending）は、同じ札へ 2 度送らない。受け付けない設定の PC（locked）では押せない。
 * - 答えられない札（hostOnly が非 null）は、選択肢を出さない。onOpenTerminal があれば「ターミナルを開く」ボタン、無ければ案内の一行にする
 *   （ほかの PC の会話では、元の PC の端末をこの PC から開けない）。
 * - 答えると選択肢が collapseOut で閉じ、答えの記録が growIn で開く。
 */
export function AskCard(props: { row: AskCardModel; onAnswer: (askId: string, keys: string[], text?: string) => void; onOpenTerminal?: () => void }) {
  const t = useT();
  const { row } = props;
  const [picked, setPicked] = useState<string[]>([]);
  const [text, setText] = useState('');
  const done = row.answered !== null;
  const off = row.pending || row.locked || done;
  const textOk = askTextValid({ textKind: row.textKind ?? undefined, min: row.min ?? undefined, max: row.max ?? undefined }, text);
  const answer = (keys: string[], free?: string) => { if (off) return; props.onAnswer(row.askId, keys, free); };
  const toggle = (key: string) => setPicked((p) => (p.includes(key) ? p.filter((k) => k !== key) : [...p, key]));

  // 選択肢は答えると畳んで外す。答えの記録は、開いたままの札が閉じたときだけ伸ばして入れる（最初から閉じている札は動かさない）。
  const body = usePresence<HTMLDivElement>(!done, (el) => collapseOut(el));
  const rec = useRef<HTMLSpanElement>(null);
  const born = useRef(done);
  useLayoutEffect(() => {
    if (done && !born.current && rec.current) growIn(rec.current);
    born.current = done;
  }, [done]);

  const invalid = row.textKind !== null && text.trim() !== '' && !textOk;
  return (
    <div className="pchat-ask" role="group" aria-label={row.title} data-done={done ? 'true' : undefined}>
      <div className="pchat-ask-head"><span className="pchat-dot" data-tone="waiting" aria-hidden="true" />{row.title}</div>
      {row.header && <div className="pchat-ask-header">{row.header}</div>}
      {row.input && <pre className="pchat-ask-input">{row.input}</pre>}
      {done && <span ref={rec} className="pchat-ans pchat-in"><Icon name="check" />{row.answered}</span>}
      {body.mounted && (
        <div ref={body.ref} className="pchat-ask-body">
          {row.hostOnly !== null ? (
            props.onOpenTerminal
              ? <div className="pchat-ask-acts"><button type="button" className="btn btn-primary" disabled={row.locked} onClick={props.onOpenTerminal}>{t('peerChat.ask.openTerminal')}</button></div>
              : <p className="pchat-ask-hostonly">{row.hostOnly}</p>
          ) : (
            <>
              {row.options.length > 0 && (
                <div className="pchat-ask-acts" role="group" aria-label={t('peerChat.ask.answerLabel')}>
                  {row.options.map((o) => (
                    <button key={o.key} type="button" className="pchat-opt" aria-pressed={row.multi ? picked.includes(o.key) : undefined} disabled={off}
                      onClick={() => (row.multi ? toggle(o.key) : answer([o.key]))}>
                      <span className="pchat-opt-label">{row.multi || !/^\d+$/.test(o.key) ? '' : `${o.key}. `}{o.label}</span>
                      {o.description && <span className="pchat-opt-desc">{o.description}</span>}
                    </button>
                  ))}
                </div>
              )}
              {row.multi && <div className="pchat-ask-acts"><button type="button" className="btn btn-primary" disabled={off || picked.length === 0} onClick={() => answer(picked)}>{t('peerChat.ask.multiSend')}</button></div>}
              {row.allowText && (
                <div className="pchat-ask-text">
                  <input type={row.secret ? 'password' : 'text'} autoComplete={row.secret ? 'off' : undefined} inputMode={row.textKind === 'integer' ? 'numeric' : row.textKind === 'number' ? 'decimal' : undefined}
                    value={text} placeholder={t('peerChat.ask.textPlaceholder')} aria-label={t('peerChat.ask.textPlaceholder')} aria-invalid={invalid ? 'true' : undefined} disabled={off} onChange={(e) => setText(e.target.value)}
                    onKeyDown={(e) => { if (e.key === 'Enter' && !isComposing(e) && textOk) answer(picked, text.trim()); }} />
                  <button type="button" className="btn" disabled={off || !textOk} onClick={() => answer(picked, text.trim())}>{t('peerChat.ask.textSend')}</button>
                </div>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}
