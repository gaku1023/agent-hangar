import { isRemoteControlUrl } from '@agent-hangar/shared/src/mobileCrypto.ts';
import { useCallback, useEffect, useRef, useState, type ReactNode, type TouchEvent } from 'react';
import { fetchInbox, UnpairedError } from '../api.ts';
import { ago, clock, dayLabel, elapsed, waitedFor } from '../format.ts';
import { openInbox, type InboxView, type Row } from '../inbox.ts';
import { phaseClass, usePresence, type Present } from '../presence.ts';
import { clearPairing, type Pairing } from '../store.ts';

/** /rc の URL が拾えなかったとき、または PC から来た値が claude.ai でないときに開く先。 */
export const CLAUDE_CODE_URL = 'https://claude.ai/code';
/** 見えている間の読み直しの間隔。 */
export const POLL_MS = 30_000;
/** 下に引いて読み直すまでの距離（px）。 */
const PULL_TRIGGER = 56;
const PULL_MAX = 80;

/** PC から来た値も信じない。https://claude.ai/ の URL だけを開き、ほかは claude.ai/code にする。 */
export const openUrlOf = (rcUrl: string | null): string => (rcUrl && isRemoteControlUrl(rcUrl) ? rcUrl : CLAUDE_CODE_URL);

const waitingText = (r: Row): string => {
  const t = r.waiting?.text.trim();
  if (t) return t;
  return r.waiting?.kind === 'permission' ? '許可を求めています' : r.waiting?.kind === 'question' ? '質問があります' : '入力を待っています';
};

const waitingKind = (r: Row): string | null => (r.waiting?.kind === 'permission' ? '許可待ち' : r.waiting?.kind === 'question' ? '質問' : null);

type Props = {
  pairing: Pairing;
  cryptoKey: CryptoKey;
  /** 接続が外された（401）か、接続し直すと決めた。参加の画面に戻る。 */
  onUnpaired: () => void;
  /** 「＋ 新しい会話」。まだ無いときは押せない。 */
  onNewSession?: () => void;
};

type Pull = { phase: 'idle' } | { phase: 'pulling'; dist: number } | { phase: 'refreshing' };

export function InboxScreen({ pairing, cryptoKey, onUnpaired, onNewSession }: Props): ReactNode {
  const [view, setView] = useState<InboxView | null>(null);
  const [failed, setFailed] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const [pull, setPull] = useState<Pull>({ phase: 'idle' });
  const inFlight = useRef<Promise<void> | null>(null);
  const alive = useRef(true);
  const start = useRef<number | null>(null);
  const scroller = useRef<HTMLDivElement>(null);

  const load = useCallback((): Promise<void> => {
    if (inFlight.current) return inFlight.current;
    const run = (async () => {
      try {
        const res = await fetchInbox(pairing);
        const v = await openInbox(res, cryptoKey, new Date());
        if (!alive.current) return;
        setView(v);
        setFailed(false);
        setNow(Date.now());
      } catch (e) {
        if (!alive.current) return;
        if (e instanceof UnpairedError) {
          clearPairing();
          onUnpaired();
          return;
        }
        setFailed(true);
      }
    })().finally(() => {
      inFlight.current = null;
    });
    inFlight.current = run;
    return run;
  }, [pairing, cryptoKey, onUnpaired]);

  // 開いたとき、見えたとき、見えている間 30 秒ごとに読み直す。
  useEffect(() => {
    alive.current = true;
    void load();
    const onVisible = (): void => {
      if (document.visibilityState === 'visible') void load();
    };
    document.addEventListener('visibilitychange', onVisible);
    const timer = setInterval(() => {
      if (document.visibilityState === 'visible') void load();
    }, POLL_MS);
    return () => {
      alive.current = false;
      document.removeEventListener('visibilitychange', onVisible);
      clearInterval(timer);
    };
  }, [load]);

  // 下に引いて読み直す。いちばん上までスクロールしているときだけ引ける。
  const onTouchStart = (e: TouchEvent): void => {
    const top = scroller.current?.scrollTop ?? 0;
    start.current = top <= 0 && pull.phase !== 'refreshing' ? (e.touches[0]?.clientY ?? null) : null;
  };
  const onTouchMove = (e: TouchEvent): void => {
    if (start.current === null) return;
    const dy = (e.touches[0]?.clientY ?? start.current) - start.current;
    if (dy <= 0) {
      setPull({ phase: 'idle' });
      return;
    }
    setPull({ phase: 'pulling', dist: Math.min(PULL_MAX, dy / 2) });
  };
  const onTouchEnd = (): void => {
    if (start.current === null) return;
    start.current = null;
    if (pull.phase === 'pulling' && pull.dist >= PULL_TRIGGER * 0.9) {
      setPull({ phase: 'refreshing' });
      void load().finally(() => {
        if (alive.current) setPull({ phase: 'idle' });
      });
    } else setPull({ phase: 'idle' });
  };

  const reconnect = (): void => {
    clearPairing();
    onUnpaired();
  };

  const allUnreadable = !!view && view.unreadable.length > 0 && view.feeds.length === 0;
  const pullHeight = pull.phase === 'pulling' ? pull.dist : pull.phase === 'refreshing' ? 44 : 0;
  const pullLabel = pull.phase === 'refreshing' ? '読み直しています…' : pull.phase === 'pulling' && pull.dist >= PULL_TRIGGER * 0.9 ? '離すと読み直します' : '引くと読み直します';
  const today = new Date(now);

  return (
    <div className="inbox">
      <div className="inbox-scroll" ref={scroller} data-testid="inbox-scroll" onTouchStart={onTouchStart} onTouchMove={onTouchMove} onTouchEnd={onTouchEnd} onTouchCancel={onTouchEnd}>
        <div className={`pull ${pull.phase === 'pulling' ? 'dragging' : ''}`} style={{ height: pullHeight }} aria-live="polite">
          {pull.phase !== 'idle' && (
            <span className="pull-label">
              <span className={`pull-ring ${pull.phase === 'refreshing' ? 'spin' : ''}`} style={pull.phase === 'pulling' ? { transform: `rotate(${pull.dist * 4}deg)` } : undefined} aria-hidden="true" />
              {pullLabel}
            </span>
          )}
        </div>

        <header className="inbox-head">
          <div className="inbox-title-row">
            <h1 className="inbox-title">
              あなたの番{view && !allUnreadable ? <span className="inbox-count"> {view.waiting.length}</span> : null}
            </h1>
            <span className="inbox-date">{dayLabel(today)}</span>
          </div>
          {view && view.devices.length > 0 && (
            <div className="alive-line">
              {view.devices.map((d) => (
                <span key={d.id} className={`alive ${d.alive ? '' : 'stale'}`}>
                  <span className="dot" aria-hidden="true" />
                  <span className="alive-name">{d.name}</span>
                  <span className="alive-age">{d.alive && d.lastSeenAt !== null ? ago(now - d.lastSeenAt) : '不明'}</span>
                </span>
              ))}
            </div>
          )}
        </header>

        {failed && (
          <p className="strip warn m-fade" role="status">
            読み込めませんでした。通信を確かめて、下に引いて読み直してください。
          </p>
        )}

        {!view && !failed && <p className="inbox-loading m-fade">読み込んでいます…</p>}

        {allUnreadable && (
          <section className="card reconnect m-fade">
            <p className="reconnect-h">受信箱を開けません</p>
            <p className="reconnect-t">PC で参加の秘密を作り直すと、このスマホの鍵では開けなくなります。PC の設定 › クラウド で新しい QR を出し、接続し直してください。</p>
            <button type="button" className="btn-primary" onClick={reconnect}>
              接続し直す
            </button>
          </section>
        )}

        {view && !allUnreadable && (
          <>
            {view.unreadable.length > 0 && (
              <p className="strip warn m-fade" role="status">
                {view.unreadable.join('、')} の一覧を開けません。その PC の hangar が古いか、鍵が合っていません。
              </p>
            )}
            <WaitingList rows={view.waiting} now={now} />
            <Sections view={view} now={now} />
          </>
        )}
      </div>

      <div className="bottom-bar">
        <button type="button" className="new-btn" onClick={onNewSession} disabled={!onNewSession}>
          ＋ 新しい会話
        </button>
      </div>
    </div>
  );
}

const rowKey = (r: Row): string => r.sessionId;

/** 出入りの段階の箱。中の .fold-in が高さの補間の間だけはみ出しを隠す（styles.css）。 */
function Fold({ phase, children, className = '' }: { phase: Present<unknown>['phase']; children: ReactNode; className?: string }): ReactNode {
  return (
    <div className={`fold ${phaseClass(phase)} ${className}`} aria-hidden={phase === 'leave' ? true : undefined}>
      <div className="fold-in">
        <div className="fold-pad">{children}</div>
      </div>
    </div>
  );
}

function WaitingList({ rows, now }: { rows: Row[]; now: number }): ReactNode {
  const list = usePresence(rows, rowKey);
  return (
    <section className="waiting" aria-label="あなたの番">
      {rows.length === 0 && <p className="empty m-fade">待っている会話はありません</p>}
      {list.map((p) => (
        <Fold key={p.key} phase={p.phase}>
          <WaitingCard row={p.item} now={now} />
        </Fold>
      ))}
    </section>
  );
}

function AccountDot({ color }: { color: string | null }): ReactNode {
  return <span className="acct-dot" style={color ? { background: color } : undefined} aria-hidden="true" />;
}

function WaitingCard({ row, now }: { row: Row; now: number }): ReactNode {
  const kind = waitingKind(row);
  return (
    <a className="card wait-card" href={openUrlOf(row.rcUrl)} target="_blank" rel="noopener noreferrer">
      <div className="wait-top">
        <AccountDot color={row.accountColor} />
        <span className="wait-proj">{row.projectName}</span>
        <span className="wait-title">· {row.title}</span>
        <span className="wait-for">{row.at !== null ? waitedFor(now - row.at) : ''}</span>
      </div>
      <div className="wait-text">{waitingText(row)}</div>
      <div className="wait-foot">
        <span className="wait-meta">{kind ? `${row.deviceName} · ${kind}` : row.deviceName}</span>
        <span className="wait-open">Claude アプリで開く ›</span>
      </div>
    </a>
  );
}

type SectionDef = { key: 'running' | 'returning' | 'done'; label: string; rows: Row[] };

function Sections({ view, now }: { view: InboxView; now: number }): ReactNode {
  const defs: SectionDef[] = [
    { key: 'running', label: '動いている', rows: view.running },
    { key: 'returning', label: '今日戻る', rows: view.returning },
    { key: 'done', label: '今日終わった', rows: view.doneToday },
  ];
  const shown = usePresence(
    defs.filter((d) => d.rows.length > 0),
    (d) => d.key,
  );
  return (
    <>
      {shown.map((p) => (
        <Fold key={p.key} phase={p.phase}>
          <section className="sec" aria-label={p.item.label}>
            <h2 className="sec-h">{p.item.label}</h2>
            <SectionRows def={p.item} now={now} />
          </section>
        </Fold>
      ))}
    </>
  );
}

function SectionRows({ def, now }: { def: SectionDef; now: number }): ReactNode {
  const list = usePresence(def.rows, rowKey);
  return (
    <>
      {list.map((p) => (
        <Fold key={p.key} phase={p.phase}>
          <ThinRow kind={def.key} row={p.item} now={now} />
        </Fold>
      ))}
    </>
  );
}

function ThinRow({ kind, row, now }: { kind: SectionDef['key']; row: Row; now: number }): ReactNode {
  if (kind === 'running') {
    const unknown = row.status === 'unknown';
    return (
      <a className={`thin ${unknown ? 'unknown' : ''}`} href={openUrlOf(row.rcUrl)} target="_blank" rel="noopener noreferrer">
        <span className={`dot ${unknown ? 'unknown' : row.status === 'idle' ? 'idle' : 'busy'}`} aria-hidden="true" />
        <span className="thin-text">{row.intent?.trim() || `${row.projectName} · ${row.title}`}</span>
        <span className="thin-meta">{unknown ? `${row.deviceName} · 不明` : `${row.deviceName} · ${row.startedAt !== null ? elapsed(now - row.startedAt) : ''}`}</span>
      </a>
    );
  }
  if (kind === 'returning') {
    return (
      <div className="thin">
        <span className="dot returning" aria-hidden="true" />
        <span className="thin-text">{row.title || row.projectName}</span>
        <span className="thin-meta">{row.returnTime ?? '今日'}</span>
      </div>
    );
  }
  return (
    <div className="thin">
      <span className="dot done" aria-hidden="true" />
      <span className="thin-text">{row.oneLiner?.trim() || row.title}</span>
      <span className="thin-meta">{row.at !== null ? clock(row.at) : ''}</span>
    </div>
  );
}
