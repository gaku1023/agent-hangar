import { useEffect, useLayoutEffect, useRef } from 'react';
import type { PeerChatRow } from '../presenters/peerChat.ts';
import { PeerChatCard } from './PeerChatCard.tsx';
import { Icon } from './primitives/Icon.tsx';
import { useT } from './primitives/language.tsx';

/** 末尾からこの距離（px）以内なら、新しい項目が来たとき末尾へ追う。読み返している間は動かさない。 */
const FOLLOW_PX = 80;

/**
 * 会話の列（試作の 1A。スマホの受信箱と同じ系統の吹き出し）。
 * 新しい項目は下から 6px とぼかしで入る（--dur と --ease-out）。開いた直後の項目は動かさない。
 * 預かり（2A）は列の末尾の点線の吹き出しで、渡ると、同じ文が会話に入り、小さく弾む。
 * 札（3A）は列の中に置き、答えが付くと答えの行に変わる。
 */
export function PeerChatLog(props: { rows: PeerChatRow[]; loading: boolean; onCancel: (queueId: string) => void; onAnswer: (askId: string, keys: string[], text?: string) => void }) {
  const t = useT();
  const box = useRef<HTMLDivElement>(null);
  // 最初の描画（読み込みが済んだ最初の列）に居た項目は動かさず、あとから増えた項目だけ入れる。
  const seen = useRef<Set<string> | null>(null);
  const entering = useRef<Set<string>>(new Set());
  const delivered = useRef<Set<string>>(new Set());
  const queuedBefore = useRef<Map<string, string>>(new Map());
  const keys = props.rows.map((r) => r.key);
  if (!props.loading) {
    if (seen.current === null) seen.current = new Set(keys);
    else {
      const queuedNow = new Map(props.rows.flatMap((r) => (r.kind === 'queued' ? [[r.key, r.text] as const] : [])));
      for (const r of props.rows) {
        if (seen.current.has(r.key) || entering.current.has(r.key)) continue;
        entering.current.add(r.key);
        // 預かりにあった文が会話に入った（同じ文の預かりが消えた）ら、渡ったしるしに弾ませる。
        if (r.kind === 'user') {
          const hit = [...queuedBefore.current].find(([k, text]) => text === r.text && !queuedNow.has(k));
          if (hit) delivered.current.add(r.key);
        }
      }
    }
    queuedBefore.current = new Map(props.rows.flatMap((r) => (r.kind === 'queued' ? [[r.key, r.text] as const] : [])));
  }
  useEffect(() => { for (const k of keys) seen.current?.add(k); });

  // 末尾に居る間は、新しい項目へ追う。最初は必ず末尾から見せる。
  const stick = useRef(true);
  useLayoutEffect(() => {
    const el = box.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [props.rows.length, props.loading, props.rows[props.rows.length - 1]?.key]);
  const onScroll = () => {
    const el = box.current;
    if (el) stick.current = el.scrollHeight - el.scrollTop - el.clientHeight <= FOLLOW_PX;
  };

  const cls = (key: string, base: string) => `${base}${entering.current.has(key) ? ' pchat-in' : ''}${delivered.current.has(key) ? ' pchat-deliver' : ''}`;
  return (
    <div ref={box} className="pchat-log" role="log" aria-label={t('peerChat.log.label')} aria-busy={props.loading ? 'true' : undefined} onScroll={onScroll}>
      {props.loading && <div className="pchat-empty">{t('peerChat.log.loading')}</div>}
      {!props.loading && props.rows.length === 0 && <div className="pchat-empty">{t('peerChat.log.empty')}</div>}
      {props.rows.map((r) => {
        switch (r.kind) {
          case 'user':
            return <div key={r.key} className={cls(r.key, 'pchat-user')}>{r.from && <span className="pchat-from">{r.from}</span>}{r.text}</div>;
          case 'assistant':
            return <div key={r.key} className={cls(r.key, 'pchat-ai')}>{r.text}</div>;
          case 'tool':
            return <div key={r.key} className={cls(r.key, 'pchat-tool')} data-ok={r.ok ? 'true' : 'false'}><Icon name={r.ok ? 'check' : 'close'} /><span className="pchat-tool-text"><b>{r.name}</b> {r.summary}</span></div>;
          case 'system':
            return <div key={r.key} className={cls(r.key, 'pchat-sys')}>{r.text}</div>;
          case 'ask':
            return <div key={r.key} className={cls(r.key, 'pchat-ask-wrap')}><PeerChatCard row={r} onAnswer={props.onAnswer} /></div>;
          case 'queued':
            return (
              <div key={r.key} className={cls(r.key, 'pchat-user pchat-queued')} data-delivering={r.delivering ? 'true' : undefined}>
                {r.from && <span className="pchat-from">{r.from}</span>}{r.text}
                <div className="pchat-qtag"><Icon name="reminder" />{r.tag}{r.mine && !r.delivering && <> · <button type="button" className="pchat-link" onClick={() => props.onCancel(r.queueId)}>{t('peerChat.queued.cancel')}</button></>}</div>
              </div>
            );
        }
      })}
    </div>
  );
}
