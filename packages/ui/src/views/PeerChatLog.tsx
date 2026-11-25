import { useLayoutEffect, useRef, useState } from 'react';
import type { PeerChatRow } from '../presenters/peerChat.ts';
import { PeerChatCard } from './PeerChatCard.tsx';
import { Icon } from './primitives/Icon.tsx';
import { Markdown } from './primitives/Markdown.tsx';
import { useT } from './primitives/language.tsx';
import { collapseOut, growIn, motionOn } from './primitives/motionKit.ts';
import { usePresence } from './primitives/usePresence.ts';

/** 先頭からこの距離（px）以内に着いたら、古い分を頼む。 */
const TOP_PX = 40;

/** 末尾からこの距離（px）以内なら、新しい項目が来たとき末尾へ追う。読み返している間は動かさない。 */
const FOLLOW_PX = 80;

/** 目次から跳んだ行に付ける目印の属性名（base.css の [data-hit]）。 */
const HIT = 'data-hit';

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
 * 続けて呼んだツールのまとめ（2026-11-18 の試作の案 1）。畳んだ行は「✓ ツール呼び出し N 回」で、押すと 1 本ずつの行が開く。
 * 動きは本文の画面のまとめ（ToolGroup）と同じ growIn と collapseOut。
 */
function PeerToolFold({ row }: { row: Extract<PeerChatRow, { kind: 'tools' }> }) {
  const [open, setOpen] = useState(false);
  const list = usePresence<HTMLDivElement>(open, (el) => (motionOn(el) ? collapseOut(el) : null));
  useLayoutEffect(() => {
    if (open && list.ref.current) growIn(list.ref.current);
    // 開いた変わり目だけで動かす。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);
  const ok = row.failed === null;
  return (
    <>
      <button type="button" className="pchat-tool pchat-tools-row" data-ok={ok ? 'true' : 'false'} data-open={open ? 'true' : undefined} aria-expanded={open} onClick={() => setOpen(!open)}>
        <span className="chev"><Icon name="chevron" /></span>
        <Icon name={ok ? 'check' : 'close'} />
        <span className="pchat-tool-text">{row.label}{row.failed && <span className="pchat-tools-failed"> · {row.failed}</span>}</span>
      </button>
      {list.mounted && (
        <div ref={list.ref} className="pchat-tools-list" aria-hidden={list.leaving ? true : undefined}>
          {row.items.map((it) => <div key={it.key} className="pchat-tools-item" data-ok={it.ok ? 'true' : 'false'}><Icon name={it.ok ? 'check' : 'close'} /><span className="pchat-tool-text"><b>{it.name}</b>{it.summary && ` ${it.summary}`}</span></div>)}
        </div>
      )}
    </>
  );
}

/**
 * 会話の列（試作の 1A。スマホの受信箱と同じ系統の吹き出し）。
 * 新しい項目は下から 6px とぼかしで入る（--dur と --ease-out）。開いた直後の項目は動かさない。
 * 預かり（2A）は列の末尾の点線の吹き出しで、渡ると、同じ文が会話に入り、小さく弾む。
 * 札（3A）は列の中に置き、答えが付くと答えの行に変わる。
 * 返答は手元の会話の画面と同じ Markdown の部品で描く。
 */
export function PeerChatLog(props: { rows: PeerChatRow[]; loading: boolean; onCancel: (queueId: string) => void; /** 自分の預かりを、ターンを中断して渡す。省くとボタンを出さない。 */ onRush?: (queueId: string) => void; onAnswer: (askId: string, keys: string[], text?: string) => void; /** 列の名前。省くと「他の PC の会話」。 */ label?: string; /** 会話が空のときの 1 行を出さない（統括の柱）。 */ quietEmpty?: boolean;
  /** さらに古い分が元の PC に残っている。上へスクロールして先頭に着いたら onLoadOlder を呼ぶ。 */ hasMore?: boolean; /** 古い分を読み足している間。 */ loadingOlder?: boolean; onLoadOlder?: () => void;
  /** 目次の行を押した。この項目へ寄せる。n が増えるたびに 1 度寄せる。 */ jump?: { uuid: string; n: number } | null }) {
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
    if (!el) return;
    stick.current = el.scrollHeight - el.scrollTop - el.clientHeight <= FOLLOW_PX;
    // 先頭に着いたら古い分を頼む（読み込み中と、もう無いときは頼まない）。
    if (el.scrollTop <= TOP_PX && props.hasMore && !props.loadingOlder) props.onLoadOlder?.();
  };

  // 頭に古い分が足されたとき、見ていた行が跳ねないよう、増えた高さの分だけ位置をずらす（末尾を追っている間は上の追いかけに任せる）。
  const top = useRef<{ first: string | undefined; height: number }>({ first: undefined, height: 0 });
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    const prev = top.current;
    const first = props.rows[0]?.key;
    if (prev.first !== undefined && first !== prev.first && props.rows.some((r) => r.key === prev.first) && !stick.current) {
      el.scrollTop += el.scrollHeight - prev.height;
    }
    top.current = { first, height: el.scrollHeight };
  });

  // 目次から跳ぶ。行を箱の上から 3 分の 1 のあたりへ送り、手元の会話と同じ目印（data-hit）を付ける。追っていたらやめる。
  const jumped = useRef(0);
  useLayoutEffect(() => {
    const j = props.jump;
    const el = box.current;
    if (!j || !el || j.n === jumped.current) return;
    const target = [...el.querySelectorAll<HTMLElement>('[data-pk]')].find((x) => x.dataset.pk === j.uuid);
    if (!target) return;
    jumped.current = j.n;
    stick.current = false;
    el.scrollTop += target.getBoundingClientRect().top - el.getBoundingClientRect().top - Math.round(el.clientHeight / 3);
    target.removeAttribute(HIT);
    target.setAttribute(HIT, '');
    target.addEventListener('animationend', () => target.removeAttribute(HIT), { once: true });
  }, [props.jump, props.rows]);

  const cls = (key: string, base: string) => `${base}${next.entering.has(key) ? ' pchat-in' : ''}${next.delivered.has(key) ? ' pchat-deliver' : ''}`;
  return (
    <div ref={box} className="pchat-log" role="log" aria-label={props.label ?? t('peerChat.log.label')} aria-busy={props.loading ? 'true' : undefined} onScroll={onScroll}>
      {props.loadingOlder && <div className="pchat-empty">{t('common.state.loading')}</div>}
      {props.loading && !props.quietEmpty && <div className="pchat-empty">{t('peerChat.log.loading')}</div>}
      {!props.loading && !props.quietEmpty && props.rows.length === 0 && <div className="pchat-empty">{t('peerChat.log.empty')}</div>}
      {props.rows.map((r) => {
        switch (r.kind) {
          case 'user':
            return <div key={r.key} data-pk={r.key} className={cls(r.key, 'pchat-user')}>{r.from && <span className="pchat-from">{r.from}</span>}{r.text}</div>;
          case 'assistant':
            return <div key={r.key} data-pk={r.key} className={cls(r.key, 'pchat-ai')} data-speaking={r.speaking ? 'true' : undefined}><Markdown text={r.text} /></div>;
          case 'tool':
            return <div key={r.key} data-pk={r.key} className={cls(r.key, 'pchat-tool')} data-ok={r.ok ? 'true' : 'false'}><Icon name={r.ok ? 'check' : 'close'} /><span className="pchat-tool-text"><b>{r.name}</b>{r.summary && ` ${r.summary}`}</span></div>;
          case 'tools':
            return <div key={r.key} data-pk={r.key} className={cls(r.key, 'pchat-tools')}><PeerToolFold row={r} /></div>;
          case 'system':
            return <div key={r.key} data-pk={r.key} className={cls(r.key, 'pchat-sys')}>{r.text}</div>;
          case 'ask':
            return <div key={r.key} data-pk={r.key} className={cls(r.key, 'pchat-ask-wrap')}><PeerChatCard row={r} onAnswer={props.onAnswer} /></div>;
          case 'queued':
            return (
              <div key={r.key} data-pk={r.key} className={cls(r.key, 'pchat-user pchat-queued')} data-delivering={r.delivering ? 'true' : undefined}>
                {r.from && <span className="pchat-from">{r.from}</span>}{r.text}
                <div className="pchat-qtag">
                  <Icon name="reminder" />{r.tag}
                  {r.mine && !r.delivering && !r.rushing && <> · <button type="button" className="pchat-link" onClick={() => props.onCancel(r.queueId)}>{t('peerChat.queued.cancel')}</button></>}
                  {r.mine && !r.delivering && !r.rushing && props.onRush && <button type="button" className="pchat-qbtn" onClick={() => props.onRush!(r.queueId)}>{t('peerChat.queued.rush')}</button>}
                </div>
              </div>
            );
        }
      })}
    </div>
  );
}
