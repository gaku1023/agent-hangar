import { useState } from 'react';
import type { PeerChatRow } from '../presenters/peerChat.ts';
import { isComposing } from './ime.ts';
import { Icon } from './primitives/Icon.tsx';
import { useT } from './primitives/language.tsx';

type AskRow = Extract<PeerChatRow, { kind: 'ask' }>;

/**
 * 会話の中の許可と質問の札（試作の 3A）。
 * 選択肢は番号つきのボタンで、答えるとキーを元の PC へ送る。
 * 複数選択（multi）は、選んでから「選んだものを送る」で 1 度に送る。自由入力（allowText）は、他の答えを書いて「答える」で送る。
 * どちらかの PC で答えると answered が付き、札は閉じて答えの行（「Mac で許可」）に変わる。
 * 答えを送ってから札が閉じるまでの間（row.pending）は、同じ札へ 2 度送らない。断られたら store が pending を外すので、また押せる。
 * 受け付けない設定の PC（row.locked）では、選択肢を押せない。
 */
export function PeerChatCard(props: { row: AskRow; onAnswer: (askId: string, keys: string[], text?: string) => void }) {
  const t = useT();
  const { row } = props;
  const [picked, setPicked] = useState<string[]>([]);
  const [text, setText] = useState('');
  const done = row.answered !== null;
  const off = row.pending || row.locked;
  const answer = (keys: string[], free?: string) => { if (off || done) return; props.onAnswer(row.askId, keys, free); };
  const toggle = (key: string) => setPicked((p) => (p.includes(key) ? p.filter((k) => k !== key) : [...p, key]));
  return (
    <div className="pchat-ask" role="group" aria-label={row.title} data-done={done ? 'true' : undefined}>
      <div className="pchat-ask-head"><span className="pchat-dot" data-tone="waiting" aria-hidden="true" />{row.title}</div>
      {row.input && <pre className="pchat-ask-input">{row.input}</pre>}
      {done ? (
        <span className="pchat-ans pchat-in"><Icon name="check" />{row.answered}</span>
      ) : (
        <>
          <div className="pchat-ask-acts" role="group" aria-label={t('peerChat.ask.answerLabel')}>
            {row.options.map((o) => (
              <button key={o.key} type="button" className="btn pchat-opt" data-primary={!row.multi && o.key === row.options[0]?.key ? 'true' : undefined} aria-pressed={row.multi ? picked.includes(o.key) : undefined} disabled={off}
                onClick={() => (row.multi ? toggle(o.key) : answer([o.key]))}>{row.multi ? '' : `${o.key}. `}{o.label}</button>
            ))}
          </div>
          {row.multi && <div className="pchat-ask-acts"><button type="button" className="btn btn-primary" disabled={off || picked.length === 0} onClick={() => answer(picked)}>{t('peerChat.ask.multiSend')}</button></div>}
          {row.allowText && (
            <div className="pchat-ask-text">
              <input type="text" value={text} placeholder={t('peerChat.ask.textPlaceholder')} aria-label={t('peerChat.ask.textPlaceholder')} disabled={off} onChange={(e) => setText(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter' && !isComposing(e) && text.trim()) answer(picked, text.trim()); }} />
              <button type="button" className="btn" disabled={off || !text.trim()} onClick={() => answer(picked, text.trim())}>{t('peerChat.ask.textSend')}</button>
            </div>
          )}
        </>
      )}
    </div>
  );
}
