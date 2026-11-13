import { useLayoutEffect, useRef, useState } from 'react';
import type { PeerChatRow } from '../presenters/peerChat.ts';
import { PeerChatCard } from './PeerChatCard.tsx';
import { Icon } from './primitives/Icon.tsx';
import { Markdown } from './primitives/Markdown.tsx';
import { useT } from './primitives/language.tsx';

/** 末尾からこの距離（px）以内なら、新しい項目が来たとき末尾へ追う。読み返している間は動かさない。 */
const FOLLOW_PX = 80;

/** 動きの印。seen は一度でも列に居た項目、entering は入る動きを持つ項目、delivered は預かりが渡って入った項目、queued は前の描画の預かり。 */
type Track = { seen: Set<string> | null; entering: Set<string>; delivered: Set<string>; queued: string[] };
const EMPTY_TRACK: Track = { seen: null, entering: new Set(), delivered: new Set(), queued: [] };

/**
 * 前の描画との差から、次の動きの印を決める（純粋）。
 * 預かりの吹き出しが消え、同じ描画で新しい文（user）が現れたら、その文を「渡った」ものとして、消えた預かりの数だけ先頭から印を付ける。
 * 取り消し（消えるだけで新しい文が無い）には印を付けない。文の中身は見ない。
 */
export function nextTrack(prev: Track, rows: PeerChatRow[], loading: boolean): Track {
  if (loading) return prev;
  const keys = rows.map((r) => r.key);
  const queued = rows.filter((r) => r.kind === 'queued').map((r) => r.key);
  if (prev.seen === null) return { seen: new Set(keys), entering: new Set(), delivered: new Set(), queued };
  const seen = prev.seen;
  const fresh = rows.filter((r) => !seen.has(r.key));
  const vanished = prev.queued.filter((k) => !keys.includes(k));
  if (fresh.length === 0 && vanished.length === 0 && queued.length === prev.queued.length && queued.every((k, i) => k === prev.queued[i])) return prev;
  const entering = new Set(prev.entering);
  const delivered = new Set(prev.delivered);
  for (const r of fresh) entering.add(r.key);
  const users = fresh.filter((r) => r.kind === 'user');
  for (const r of users.slice(0, vanished.length)) delivered.add(r.key);
  return { seen: new Set([...seen, ...keys]), entering, delivered, queued };
}

/**
 * 会話の列（試作の 1A。スマホの受信箱と同じ系統の吹き出し）。
 * 新しい項目は下から 6px とぼかしで入る（--dur と --ease-out）。開いた直後の項目は動かさない。
 * 預かり（2A）は列の末尾の点線の吹き出しで、渡ると、同じ文が会話に入り、小さく弾む。
 * 札（3A）は列の中に置き、答えが付くと答えの行に変わる。
 * 返答は手元の会話の画面と同じ Markdown の部品で描く。
 */
export function PeerChatLog(props: { rows: PeerChatRow[]; loading: boolean; onCancel: (queueId: string) => void; onAnswer: (askId: string, keys: string[], text?: string) => void; /** 列の名前。省くと「他の PC の会話」。 */ label?: string; /** 会話が空のときの 1 行を出さない（統括の柱）。 */ quietEmpty?: boolean }) {
  const t = useT();
  const box = useRef<HTMLDivElement>(null);
  // 最初の描画（読み込みが済んだ最初の列）に居た項目は動かさず、あとから増えた項目だけ入れる。
  // 前の描画との比べは state に持ち、描画の中で畳み直す（ref を描画中に書き換えない）。
  const [track, setTrack] = useState<Track>(EMPTY_TRACK);
  const next = nextTrack(track, props.rows, props.loading);
  if (next !== track) setTrack(next);
  const keys = props.rows.map((r) => r.key);

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

  const cls = (key: string, base: string) => `${base}${next.entering.has(key) ? ' pchat-in' : ''}${next.delivered.has(key) ? ' pchat-deliver' : ''}`;
  return (
    <div ref={box} className="pchat-log" role="log" aria-label={props.label ?? t('peerChat.log.label')} aria-busy={props.loading ? 'true' : undefined} onScroll={onScroll}>
      {props.loading && !props.quietEmpty && <div className="pchat-empty">{t('peerChat.log.loading')}</div>}
      {!props.loading && !props.quietEmpty && props.rows.length === 0 && <div className="pchat-empty">{t('peerChat.log.empty')}</div>}
      {props.rows.map((r) => {
        switch (r.kind) {
          case 'user':
            return <div key={r.key} className={cls(r.key, 'pchat-user')}>{r.from && <span className="pchat-from">{r.from}</span>}{r.text}</div>;
          case 'assistant':
            return <div key={r.key} className={cls(r.key, 'pchat-ai')} data-speaking={r.speaking ? 'true' : undefined}><Markdown text={r.text} /></div>;
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
