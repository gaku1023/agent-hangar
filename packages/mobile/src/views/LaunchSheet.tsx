import { isRemoteControlUrl } from '@agent-hangar/shared/src/mobileCrypto.ts';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { InboxView, Row } from '../inbox.ts';
import type { LaunchSpec, RunState } from '../launchRun.ts';
import { AccountTag } from './AccountTag.tsx';
import { BottomSheet } from './BottomSheet.tsx';
import { Reveal } from './Fold.tsx';
import { openUrlOf } from './InboxScreen.tsx';

/** 始まったあと、会話の URL を受信箱の素から探して読み直しを頼む間隔と上限。 */
export const URL_REFRESH_MS = 3_000;
export const URL_REFRESH_MAX = 20;

type Step = 'todo' | 'act' | 'done' | 'fail' | 'warn';
const LABELS = ['送信', 'PC で受信', '開始'] as const;

/** 進みの 3 段。 */
function stepsOf(s: RunState): [Step, Step, Step] {
  switch (s.kind) {
    case 'sending':
      return ['act', 'todo', 'todo'];
    case 'waiting':
      return s.claimed ? ['done', 'done', 'act'] : ['done', 'act', 'todo'];
    case 'started':
      return ['done', 'done', 'done'];
    case 'failed':
      return s.at === 'send' ? ['fail', 'todo', 'todo'] : ['done', 'fail', 'todo'];
    case 'unreadable':
    case 'unanswered':
      return ['done', 'warn', 'todo'];
    case 'unpaired':
      return ['fail', 'todo', 'todo'];
  }
}

/** 進みの棒の長さ（%）。PC が受信したら先へ進める。 */
function percentOf(s: RunState): number {
  switch (s.kind) {
    case 'sending':
      return 12;
    case 'waiting':
      return s.claimed ? 72 : 50;
    case 'started':
      return 100;
    case 'failed':
    case 'unpaired':
      return 33;
    case 'unreadable':
    case 'unanswered':
      return 50;
  }
}

function titleOf(s: RunState): string {
  switch (s.kind) {
    case 'sending':
    case 'waiting':
      return '会話を開始中…';
    case 'started':
      return '会話が始まりました';
    case 'failed':
    case 'unpaired':
      return '開始できませんでした';
    case 'unreadable':
    case 'unanswered':
      return '開始を確認できません';
  }
}

function findRow(view: InboxView | null, sessionId: string): Row | null {
  if (!view) return null;
  for (const list of [view.running, view.waiting, view.returning, view.doneToday]) {
    const r = list.find((x) => x.sessionId === sessionId);
    if (r) return r;
  }
  return null;
}

type Props = {
  spec: LaunchSpec;
  state: RunState;
  /** 受信箱で最後に読めたもの。始まった会話の URL とやっていることをここから探す。 */
  view: InboxView | null;
  open: boolean;
  /** シートを閉じる。依頼は続く。 */
  onClose: () => void;
  onRetry: () => void;
  onReconnect: () => void;
  /** 受信箱を読み直してほしい。 */
  onWantRefresh: () => void;
};

/**
 * 「始める」のあとのシート（D2）。受信箱の上に下から出て、送信、PC での受信、開始の進みを見せる。
 * 始まったら会話の札を出し、受信箱の素に会話の URL が来たら開くリンクにする。
 * 閉じても依頼は続く（呼び手が持つ）。
 */
export function LaunchSheet({ spec, state, view, open, onClose, onRetry, onReconnect, onWantRefresh }: Props): ReactNode {
  const steps = stepsOf(state);
  const sessionId = state.kind === 'started' ? state.sessionId : null;
  const row = sessionId ? findRow(view, sessionId) : null;
  const url = row?.rcUrl && isRemoteControlUrl(row.rcUrl) ? row.rcUrl : null;
  const hasUrl = url !== null;
  // opencode には Remote Control が無いので、開くボタンを出さず、URL も待たない（一覧の opencode の行がリンクでないのと同じ）。
  const opencode = spec.payload.agent === 'opencode';

  // 始まったあと、URL が来るまで受信箱を読み直してもらう。
  const want = useRef(onWantRefresh);
  want.current = onWantRefresh;
  const gaveUp = useGaveUp(open && sessionId !== null && !hasUrl && !opencode, sessionId, () => want.current());

  const bad = state.kind === 'failed' || state.kind === 'unpaired';
  return (
    <BottomSheet open={open} title={titleOf(state)} closeText="受信箱へ" onClose={onClose}>
      <div className="ls">
        <ol className="stp" aria-label="進み">
          {LABELS.map((label, i) => (
            <li key={label} className="st" data-state={steps[i]}>
              <span className="stdot" aria-hidden="true" />
              <span>{label}</span>
            </li>
          ))}
        </ol>
        <div className={`bar ${bad ? 'bad' : ''}`} aria-hidden="true">
          <i style={{ width: `${percentOf(state)}%` }} />
        </div>

        <div aria-live="polite">
          {state.kind === 'waiting' && (
            <p className="ls-cap m-fade" key={state.claimed ? 'claimed' : 'waiting'}>
              {state.claimed ? `${spec.pcName} で受信しました。開始を確認中…` : `${spec.pcName} での受信を確認中…（最大 30 秒ほど）`}
            </p>
          )}
        </div>

        {state.kind === 'started' && (
          <Reveal>
            <section className="card scard" aria-label="開始した会話">
              <div className="l1">
                <span className="dot busy" aria-hidden="true" />
                <b>{spec.projectName ?? 'クイックセッション'}</b>
                <span className="l1-title"> · {row?.title || state.title}</span>
              </div>
              <div className="l2">
                <span>{spec.pcName}</span>
                <AccountTag name={spec.accountName} color={spec.accountColor} />
                <span>実行中</span>
              </div>
              {row?.intent?.trim() && (
                <Reveal>
                  <p className="intent">意図：{row.intent.trim()}</p>
                </Reveal>
              )}
              {opencode ? null : url ? (
                <a className="ns-start sm" href={openUrlOf(url)} target="_blank" rel="noopener noreferrer">
                  開く ›
                </a>
              ) : (
                <button type="button" className="ns-start sm" disabled>
                  {gaveUp ? 'URL をまだ受信していません' : 'URL を受信中…'}
                </button>
              )}
            </section>
          </Reveal>
        )}

        {(state.kind === 'failed' || state.kind === 'unreadable' || state.kind === 'unanswered') && (
          <Reveal>
            <div className="ls-err">
              <p className="strip danger" role="alert">
                {state.kind === 'failed'
                  ? state.message
                  : state.kind === 'unreadable'
                    ? `${spec.pcName} の応答を読み取れませんでした。会話が始まっているかもしれません。受信箱で確認してください。`
                    : `${spec.pcName} で受信しましたが、結果をまだ受信していません。受信箱で確認してから送り直してください。`}
              </p>
              {state.kind === 'failed' && state.detail && <p className="ns-detail">{state.detail}</p>}
              <div className="ns-actions">
                {state.kind === 'failed' && state.reconnect && (
                  <button type="button" className="ns-start sm sec" onClick={onReconnect}>
                    接続し直す
                  </button>
                )}
                {state.kind === 'failed' ? (
                  <button type="button" className="ns-start sm" onClick={onRetry}>
                    もう一度送信
                  </button>
                ) : (
                  <button type="button" className="ns-start sm" onClick={onClose}>
                    受信箱で確認
                  </button>
                )}
              </div>
            </div>
          </Reveal>
        )}
      </div>
    </BottomSheet>
  );
}

/** active の間、すぐ 1 回と URL_REFRESH_MS ごとに refresh を呼ぶ。URL_REFRESH_MAX 回で諦める。 */
function useGaveUp(active: boolean, key: string | null, refresh: () => void): boolean {
  const [gaveUp, setGaveUp] = useState(false);
  useEffect(() => {
    if (!active) return;
    setGaveUp(false);
    let n = 1;
    refresh();
    const t = setInterval(() => {
      if (n >= URL_REFRESH_MAX) {
        clearInterval(t);
        setGaveUp(true);
        return;
      }
      n += 1;
      refresh();
    }, URL_REFRESH_MS);
    return () => clearInterval(t);
    // refresh は呼び手が ref 経由で渡す。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, key]);
  return gaveUp;
}
