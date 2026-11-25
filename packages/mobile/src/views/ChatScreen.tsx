import { peerChatJa } from '@agent-hangar/shared/src/i18n/ja/peerChat.ts';
import { PEER_CHAT_TEXT_MAX_BYTES, askTextValid, type PeerChatAsk, type PeerChatItem, type PeerChatOp, type PeerChatReply } from '@agent-hangar/shared/src/peerChat.ts';
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { CHAT_TAIL_WAIT_MS, applyChatState, chatCall, ChatError, emptyChat, type ChatFailure, type ChatState } from '../chat.ts';
import type { UnpairedReason } from '../api.ts';
import { usePresence } from '../presence.ts';
import type { Pairing, PhoneKey } from '../store.ts';
import { Fold, Reveal } from './Fold.tsx';

/** 会話の頁が開く会話。通知から開いて受信箱の素に無い会話は、title が空で waiting が偽になる。 */
export type ChatTarget = {
  sessionId: string;
  deviceId: string;
  deviceName: string;
  projectName: string;
  title: string;
  /** PC がスマホからの送信を受けるか（caps.chat.input）。偽なら入力欄と中断を出さず、札は答えられない。 */
  input: boolean;
  /** 通知から開いた。着いたら問いの位置まで送り、札を軽く浮かせる（試作 3B）。 */
  focusAsk?: boolean;
  /** 受信箱の素に無い会話。1 度読めなければ頁を閉じて受信箱に印だけ付ける（onGone）。 */
  speculative?: boolean;
};

type Call = (op: PeerChatOp, o: { sessionId: string; signal?: AbortSignal }) => Promise<PeerChatReply>;

type Props = {
  target: ChatTarget;
  pairing: Pairing;
  /** 頁を開いたときの、いちばん新しい世代のスマホ用の鍵。 */
  phoneKey: PhoneKey;
  /** Worker の時刻からスマホの時刻を引いた差（ms）。 */
  skewMs?: number;
  /** 閉じる動きの間。押せないようにして、右へ出て行く。 */
  leaving?: boolean;
  onClose: () => void;
  /** 接続が外された、期限が切れた（401）。 */
  onUnpaired: (reason?: UnpairedReason) => void;
  /** speculative の会話が読めなかった。 */
  onGone?: () => void;
  /** 試験で差し替える口と、読み直しの最短の間。 */
  deps?: { call?: Call; gapMs?: number };
};

/** 読み直しの最短の間（Worker は 1 台 1 分 120 回まで。長い待ちが空振りで返り続けても 1 分 30 回に収める）。 */
export const CHAT_GAP_MS = 2_000;
/** 届かなかったときの読み直しの間（1 回目、2 回目以降）。 */
const RETRY_MS = [5_000, 15_000] as const;
/** 会話が見つからない、または Claude Code の会話でないとき、読み続けても変わらない断り。 */
const FATAL = new Set(['session-unknown', 'not-claude']);

const textBytes = (s: string): number => new TextEncoder().encode(s).length;

/** 断りの文。PC の画面と同じ辞書から引く。 */
function refusalText(reason: string, device: string): string {
  const t = (k: keyof typeof peerChatJa): string => peerChatJa[k].replace('{device}', device);
  switch (reason) {
    case 'offline':
    case 'pc-offline':
    case 'pc-timeout':
      return t('peerChat.refusal.offline');
    case 'refused-by-setting':
      return t('peerChat.refusal.refusedBySetting');
    case 'not-claude':
      return t('peerChat.refusal.notClaude');
    case 'session-unknown':
      return t('peerChat.refusal.sessionUnknown');
    case 'expired':
      return t('peerChat.refusal.expired');
    case 'already-answered':
      return t('peerChat.refusal.alreadyAnswered');
    case 'ask-mismatch':
      return t('peerChat.refusal.askMismatch');
    case 'resume-failed':
      return t('peerChat.refusal.resumeFailed');
    case 'queue-expired':
      return t('peerChat.refusal.queueExpired');
    case 'too-large':
      return t('peerChat.refusal.tooLarge');
    case 'rate':
    case 'rate-limited':
      return t('peerChat.refusal.rate');
    case 'host-error':
      return t('peerChat.refusal.hostError');
    default:
      return t('peerChat.refusal.other');
  }
}

/** 送った文。PC が渡すまで薄く出す。baseline は送ったときに見えていた項目で、新しい同じ文の項目が届いたら外す。 */
type Local = { id: string; text: string; baseline: Set<string> };

export function ChatScreen({ target, pairing, phoneKey, skewMs, leaving, onClose, onUnpaired, onGone, deps }: Props): ReactNode {
  const [chat, setChat] = useState<ChatState>(emptyChat);
  const [phase, setPhase] = useState<'loading' | 'live' | 'failed'>('loading');
  const [failure, setFailure] = useState<string | null>(null);
  const [offline, setOffline] = useState(false);
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [locals, setLocals] = useState<Local[]>([]);
  const [notice, setNotice] = useState<string | null>(null);
  /** 答えを送って、結果を待っている札の askId と、自分が答えた札の選択肢の名前。 */
  const [answering, setAnswering] = useState<string[]>([]);
  const [answered, setAnswered] = useState<Record<string, string>>({});
  const [key] = useState(() => phoneKey);
  const scroller = useRef<HTMLDivElement>(null);
  const seen = useRef<Set<string> | null>(null);
  const focusDone = useRef(false);
  const stick = useRef(true);
  const alive = useRef(true);
  const handlers = useRef({ onUnpaired, onGone });
  handlers.current = { onUnpaired, onGone };
  const skew = useRef(skewMs);
  skew.current = skewMs;
  const call = useCallback<Call>(
    (op, o) => (deps?.call ? deps.call(op, o) : chatCall(pairing, key, target.deviceId, op, { ...o, skewMs: skew.current })),
    [deps, pairing, key, target.deviceId],
  );
  const gapMs = deps?.gapMs ?? CHAT_GAP_MS;

  // 見張り：tail を長く待ち、返ったらすぐ次を頼む（見えている間だけ）。
  useEffect(() => {
    alive.current = true;
    const ctl = new AbortController();
    let cursor: string | null = null;
    let first = true;
    let errors = 0;
    const nap = (ms: number): Promise<void> =>
      new Promise((resolve) => {
        const t = setTimeout(resolve, ms);
        ctl.signal.addEventListener('abort', () => (clearTimeout(t), resolve()), { once: true });
      });
    const visible = (): Promise<void> =>
      document.visibilityState === 'visible' || ctl.signal.aborted
        ? Promise.resolve()
        : new Promise((resolve) => {
            const on = (): void => {
              if (document.visibilityState !== 'visible') return;
              document.removeEventListener('visibilitychange', on);
              resolve();
            };
            document.addEventListener('visibilitychange', on);
            ctl.signal.addEventListener('abort', () => (document.removeEventListener('visibilitychange', on), resolve()), { once: true });
          });
    const fail = (reason: string): void => {
      if (!alive.current) return;
      if (target.speculative) handlers.current.onGone?.();
      setFailure(reason);
      setPhase('failed');
    };
    void (async () => {
      while (!ctl.signal.aborted) {
        await visible();
        if (ctl.signal.aborted) return;
        const began = Date.now();
        try {
          const reply = await call({ t: 'tail', after: cursor, waitMs: first ? 0 : CHAT_TAIL_WAIT_MS }, { sessionId: target.sessionId, signal: ctl.signal });
          if (ctl.signal.aborted) return;
          if (!reply.ok) {
            if (FATAL.has(reply.reason)) return fail(reply.reason);
            if (first && target.speculative) return fail(reply.reason);
            throw new ChatError('pc-offline');
          }
          if (reply.state) {
            const st = reply.state;
            cursor = st.cursor ?? cursor;
            setChat((c) => applyChatState(c, st));
          }
          first = false;
          errors = 0;
          setOffline(false);
          setPhase('live');
        } catch (e) {
          if (ctl.signal.aborted) return;
          if (e instanceof ChatError) {
            if (e.failure === 'unpaired') {
              handlers.current.onUnpaired(e.unpairedReason);
              return;
            }
            if (first && (target.speculative || e.failure === 'not-found' || e.failure === 'unsupported')) return fail(e.failure);
          }
          setOffline(true);
          await nap(RETRY_MS[Math.min(errors, RETRY_MS.length - 1)]!);
          errors += 1;
          continue;
        }
        const rest = gapMs - (Date.now() - began);
        if (rest > 0) await nap(rest);
      }
    })();
    return () => {
      alive.current = false;
      ctl.abort();
    };
  }, [call, target.sessionId, target.speculative, gapMs]);

  // 送った文が会話の項目として届いたら、薄い仮の行を外す。
  useEffect(() => {
    setLocals((ls) => {
      const next = ls.filter((l) => !chat.items.some((i) => i.kind === 'user' && !l.baseline.has(i.uuid) && i.text.trim() === l.text.trim()));
      return next.length === ls.length ? ls : next;
    });
  }, [chat.items]);

  // 新しく届いた項目は軽く浮かせる（一度に来たものは少しずつ遅らせる）。最初に並べたものは動かさない。
  const fresh = new Map<string, number>();
  if (seen.current) {
    let n = 0;
    for (const i of chat.items) if (!seen.current.has(i.uuid)) fresh.set(i.uuid, n++);
  }
  useLayoutEffect(() => {
    if (phase === 'live' && !seen.current) seen.current = new Set(chat.items.map((i) => i.uuid));
    else if (seen.current) for (const i of chat.items) seen.current.add(i.uuid);
  });

  // 位置：最初は末尾（通知から開いたときは問いの位置）。あとは、末尾にいれば末尾に付いていく。
  useLayoutEffect(() => {
    const box = scroller.current;
    if (!box || phase !== 'live') return;
    if (!focusDone.current) {
      focusDone.current = true;
      const ask = target.focusAsk ? [...box.querySelectorAll<HTMLElement>('[data-open-ask]')].pop() : undefined;
      if (ask) box.scrollTop = Math.max(0, ask.offsetTop - box.offsetTop - 120);
      else box.scrollTop = box.scrollHeight;
      return;
    }
    if (stick.current) box.scrollTop = box.scrollHeight;
  }, [chat.items, locals.length, phase, target.focusAsk]);
  const onScroll = (): void => {
    const box = scroller.current;
    if (box) stick.current = box.scrollHeight - box.scrollTop - box.clientHeight < 80;
  };

  const run = async (op: PeerChatOp): Promise<PeerChatReply | null> => {
    try {
      const r = await call(op, { sessionId: target.sessionId });
      if (!r.ok) setNotice(refusalText(r.reason, target.deviceName));
      return r;
    } catch (e) {
      if (e instanceof ChatError && e.failure === 'unpaired') onUnpaired(e.unpairedReason);
      else setNotice(refusalText(e instanceof ChatError ? (e.failure satisfies ChatFailure) : 'other', target.deviceName));
      return null;
    }
  };

  const send = async (): Promise<void> => {
    const text = draft.trim();
    if (!text || sending || textBytes(text) > PEER_CHAT_TEXT_MAX_BYTES) return;
    setSending(true);
    setNotice(null);
    const local: Local = { id: globalThis.crypto.randomUUID(), text, baseline: new Set(chat.items.map((i) => i.uuid)) };
    setLocals((ls) => [...ls, local]);
    setDraft('');
    stick.current = true;
    const r = await run({ t: 'send', text, images: [], waitMs: 10_000 });
    if (!alive.current) return;
    setSending(false);
    if (!r?.ok) {
      setLocals((ls) => ls.filter((l) => l.id !== local.id));
      setDraft((d) => d || text);
    }
  };

  const answer = async (ask: PeerChatAsk, keys: string[], label: string, text?: string): Promise<void> => {
    setAnswering((a) => [...a, ask.askId]);
    setNotice(null);
    const r = await run({ t: 'answer', askId: ask.askId, keys, ...(text ? { text } : {}) });
    if (!alive.current) return;
    setAnswering((a) => a.filter((x) => x !== ask.askId));
    if (r?.ok) setAnswered((m) => ({ ...m, [ask.askId]: label }));
  };

  const busy = chat.status === 'busy';
  const interrupt = async (): Promise<void> => {
    setNotice(null);
    await run({ t: 'interrupt' });
  };

  const empty = phase === 'live' && chat.items.length === 0 && locals.length === 0;
  const sub = [target.projectName, target.deviceName].filter(Boolean).join(' · ');
  const hostOnly = peerChatJa['peerChat.ask.hostOnly'].replace('{device}', target.deviceName);
  const unanswerable = peerChatJa['peerChat.ask.unanswerable'].replace('{device}', target.deviceName);

  return (
    <div className={`chat ${leaving ? 'leaving' : ''}`} role="dialog" aria-modal="true" aria-label={target.title || target.projectName} inert={leaving}>
      <div className="chat-head">
        <button type="button" className="chat-back" aria-label="戻る" onClick={onClose}>
          ‹
        </button>
        <div className="chat-title">
          <b>{target.title || target.projectName}</b>
          <span>
            <i className={`st ${chat.status ?? ''}`} aria-hidden="true" />
            {sub}
          </span>
        </div>
        {target.input && busy ? (
          <button type="button" className="chat-stop" onClick={() => void interrupt()}>
            {peerChatJa['peerChat.composer.interrupt']}
          </button>
        ) : (
          <span />
        )}
      </div>

      <div className="chat-scroll" ref={scroller} onScroll={onScroll} data-testid="chat-scroll">
        <div className="chat-items">
          {phase === 'loading' && <p className="chat-note m-fade">{peerChatJa['peerChat.log.loading']}</p>}
          {phase === 'failed' && <p className="chat-note m-fade" role="status">{refusalText(failure ?? 'other', target.deviceName)}</p>}
          {empty && <p className="chat-note m-fade">{peerChatJa['peerChat.log.empty']}</p>}
          {chat.items.map((it) => (
            <ChatItem
              key={it.uuid}
              item={it}
              rise={fresh.has(it.uuid) ? fresh.get(it.uuid)! : null}
              focus={!!target.focusAsk && !focusDone.current && !!it.ask && !it.ask.answered}
              input={target.input}
              hostOnly={hostOnly}
              unanswerable={unanswerable}
              busyAsk={!!it.ask && answering.includes(it.ask.askId)}
              myLabel={it.ask ? (answered[it.ask.askId] ?? null) : null}
              onAnswer={answer}
            />
          ))}
          {chat.queued
            .filter((q) => q.from.deviceId !== pairing.deviceId)
            .map((q) => (
              <div key={q.queueId} className="it-user pending">
                {q.text}
                <small>{q.from.deviceName}</small>
              </div>
            ))}
          {locals.map((l) => (
            <div key={l.id} className="it-user pending m-rise">
              {l.text}
            </div>
          ))}
        </div>
      </div>

      {notice && (
        <p className="chat-notice m-fade" role="status">
          {notice}
        </p>
      )}
      {offline && phase === 'live' && (
        <p className="chat-notice m-fade" role="status">
          {peerChatJa['peerChat.status.offline']}
        </p>
      )}
      {target.input && phase !== 'failed' && (
        <div className="chat-composer">
          <textarea
            rows={1}
            aria-label={peerChatJa['peerChat.composer.label']}
            placeholder="返信"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onInput={(e) => {
              const el = e.currentTarget;
              el.style.height = 'auto';
              el.style.height = `${Math.min(el.scrollHeight, 140)}px`;
            }}
          />
          <button type="button" className="chat-send" aria-label={peerChatJa['peerChat.composer.send']} disabled={!draft.trim() || sending || textBytes(draft) > PEER_CHAT_TEXT_MAX_BYTES} onClick={() => void send()}>
            ↑
          </button>
        </div>
      )}
    </div>
  );
}

type ItemProps = {
  item: PeerChatItem;
  rise: number | null;
  focus: boolean;
  input: boolean;
  hostOnly: string;
  unanswerable: string;
  busyAsk: boolean;
  myLabel: string | null;
  onAnswer: (ask: PeerChatAsk, keys: string[], label: string, text?: string) => Promise<void>;
};

/** 届いたばかりの項目の浮かせ方（riseIn、一度に来たものは 40ms ずつ遅らせる）。 */
const riseStyle = (n: number | null): CSSProperties | undefined => (n === null ? undefined : { animationDelay: `${n * 40}ms` });

function ChatItem({ item, rise, focus, input, hostOnly, unanswerable, busyAsk, myLabel, onAnswer }: ItemProps): ReactNode {
  const cls = rise === null ? '' : ' m-rise';
  if (item.ask) return <AskCard item={item} ask={item.ask} cls={rise === null && !focus ? '' : ' m-rise'} style={riseStyle(rise ?? 0)} input={input} hostOnly={hostOnly} unanswerable={unanswerable} busy={busyAsk} myLabel={myLabel} onAnswer={onAnswer} />;
  if (item.kind === 'user') {
    return (
      <div className={`it-user${cls}`} style={riseStyle(rise)}>
        {item.text}
        {item.from && <small>{item.from.deviceName}</small>}
      </div>
    );
  }
  if (item.kind === 'tool') {
    return (
      <div className={`it-tool${item.tool?.ok === false ? '' : ' ok'}${cls}`} style={riseStyle(rise)}>
        {item.tool ? `${item.tool.name} ${item.tool.summary}`.trim() : item.text}
      </div>
    );
  }
  if (item.kind === 'system') return <div className={`it-tool${cls}`} style={riseStyle(rise)}>{item.text}</div>;
  return (
    <div className={`it-as${cls}`} style={riseStyle(rise)}>
      {item.text}
    </div>
  );
}

const OPEN = ['open'];
const NONE: string[] = [];

type AskProps = {
  item: PeerChatItem;
  ask: PeerChatAsk;
  cls: string;
  style: CSSProperties | undefined;
  input: boolean;
  hostOnly: string;
  unanswerable: string;
  busy: boolean;
  myLabel: string | null;
  onAnswer: ItemProps['onAnswer'];
};

/** 許可と質問の札。選択肢のボタンは、答えると畳まれ、答えの 1 行が伸びて出る（collapseOut、growIn）。 */
function AskCard({ item, ask, cls, style, input, hostOnly, unanswerable, busy, myLabel, onAnswer }: AskProps): ReactNode {
  const [picked, setPicked] = useState<string[]>([]);
  const [text, setText] = useState('');
  // 伏せる入力は、値も選んだ行も残さず「入力完了」だけにする。
  const doneLabel = ask.secret && (ask.answered || myLabel !== null) ? peerChatJa['peerChat.ask.secretDone'] : (ask.answered?.label ?? myLabel);
  const textOk = askTextValid(ask, text);
  const invalid = ask.textKind !== undefined && text.trim() !== '' && !textOk;
  const doneBy = ask.answered?.by.deviceName ?? null;
  const canAnswer = input && ask.answerable !== false && !ask.answered && myLabel === null;
  const opts = usePresence(doneLabel === null ? OPEN : NONE, (k) => k);
  const labelOf = (key: string): string => ask.options.find((o) => o.key === key)?.label ?? key;
  const head = ask.kind === 'permission' ? '許可' : '質問';

  return (
    <div className={`card ask${cls}`} style={style} data-open-ask={doneLabel === null ? '' : undefined}>
      <div className="ask-h">
        {head}
        {ask.step && ask.step.total > 1 ? ` ${ask.step.index}/${ask.step.total}` : ''}
      </div>
      {ask.header && <div className="ask-title">{ask.header}</div>}
      {ask.input && <div className="ask-in">{ask.input}</div>}
      {!ask.input && item.text && ask.kind === 'question' && <div className="ask-in">{item.text}</div>}
      {opts.map((p) => (
        <Fold key={p.key} phase={p.phase}>
          {canAnswer ? (
            <div className="ask-opts">
              {ask.options.map((o, n) =>
                ask.multi ? (
                  <button key={o.key} type="button" className={`ask-opt${picked.includes(o.key) ? ' go' : ''}`} aria-pressed={picked.includes(o.key)} disabled={busy} onClick={() => setPicked((s) => (s.includes(o.key) ? s.filter((x) => x !== o.key) : [...s, o.key]))}>
                    <span className="k">{o.key}</span>
                    {o.label}
                  </button>
                ) : (
                  <button key={o.key} type="button" className={`ask-opt${n === 0 ? ' go' : ''}`} disabled={busy} onClick={() => void onAnswer(ask, [o.key], o.label)}>
                    <span className="k">{o.key}</span>
                    {o.label}
                  </button>
                ),
              )}
              {ask.multi && (
                <button type="button" className="ask-opt go" disabled={busy || picked.length === 0} onClick={() => void onAnswer(ask, picked, picked.map(labelOf).join('、'))}>
                  {peerChatJa['peerChat.ask.multiSend']}
                </button>
              )}
              {ask.allowText && (
                <div className="ask-text">
                  <input className="input" type={ask.secret ? 'password' : 'text'} autoComplete={ask.secret ? 'off' : undefined} inputMode={ask.textKind === 'integer' ? 'numeric' : ask.textKind === 'number' ? 'decimal' : undefined} aria-invalid={invalid ? 'true' : undefined} value={text} placeholder={peerChatJa['peerChat.ask.textPlaceholder']} onChange={(e) => setText(e.target.value)} />
                  <button type="button" className="ask-opt go" disabled={busy || !textOk} onClick={() => void onAnswer(ask, [], text.trim(), text.trim())}>
                    {peerChatJa['peerChat.ask.textSend']}
                  </button>
                </div>
              )}
            </div>
          ) : (
            <div className="ask-opts ro">
              {ask.options.map((o) => (
                <span key={o.key} className="ask-opt ro">
                  <span className="k">{o.key}</span>
                  {o.label}
                </span>
              ))}
              <p className="ask-host">{input && ask.answerable === false ? unanswerable : hostOnly}</p>
            </div>
          )}
        </Fold>
      ))}
      {doneLabel !== null && (
        <Reveal>
          <div className="ask-done">
            <b>{doneLabel}</b>
            {doneBy ? ` · ${doneBy}` : ''}
          </div>
        </Reveal>
      )}
    </div>
  );
}
