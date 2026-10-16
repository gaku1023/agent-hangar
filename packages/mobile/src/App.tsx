import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import type { InboxView } from './inbox.ts';
import { exitMs } from './presence.ts';
import { readPairText } from './api.ts';
import { startLaunch, type LaunchRun, type LaunchSpec, type RunState } from './launchRun.ts';
import { clearPairing, loadKey, loadPairing, type Pairing } from './store.ts';
import { isIosSafari, isStandalone } from './platform.ts';
import { InstallGuide } from './views/InstallGuide.tsx';
import { InboxScreen } from './views/InboxScreen.tsx';
import { LaunchSheet } from './views/LaunchSheet.tsx';
import { NewSessionScreen } from './views/NewSessionScreen.tsx';
import { JoinScreen } from './views/JoinScreen.tsx';

type Screen = { kind: 'loading' } | { kind: 'join'; pairText: string | null; guide: boolean } | { kind: 'inbox'; pairing: Pairing; key: CryptoKey };

/** 入口の案内（A1）を先に出すか。iPhone と iPad の Safari で、ホーム画面のアプリでなく、未接続のとき。 */
const needsGuide = (): boolean => isIosSafari() && !isStandalone() && !loadPairing();

/** 開いた QR の期限。QR から開いたのでなければ、読めなければ null。 */
function expiryOf(pairText: string | null): number | null {
  if (!pairText) return null;
  try {
    return readPairText(pairText).expiresAt;
  } catch {
    return null;
  }
}

/**
 * 画面の切り替え。
 * #pair= 付きで開かれたら、手元の接続があっても参加の画面を先に出す（新しい QR で接続し直す）。
 * 接続と鍵の両方が手元にあれば受信箱、どちらかが無ければ参加の画面（④）。
 */
type Launch = { spec: LaunchSpec; state: RunState; open: boolean };

type AppProps = {
  pairText: string | null;
  /** 起動の依頼の状態を読む間隔と、諦めるまでの長さ。試験で縮める。 */
  launchEveryMs?: number;
  launchGiveUpMs?: number;
};

export function App({ pairText, launchEveryMs, launchGiveUpMs }: AppProps): ReactNode {
  const [screen, setScreen] = useState<Screen>(() => (pairText ? { kind: 'join', pairText, guide: needsGuide() } : { kind: 'loading' }));

  useEffect(() => {
    if (screen.kind !== 'loading') return;
    let off = false;
    void (async () => {
      const pairing = loadPairing();
      const key = pairing ? await loadKey() : null;
      if (off) return;
      setScreen(pairing && key ? { kind: 'inbox', pairing, key } : { kind: 'join', pairText: null, guide: !pairing && needsGuide() });
    })();
    return () => {
      off = true;
    };
  }, [screen.kind]);

  const onEnter = useCallback((pairing: Pairing, key: CryptoKey) => setScreen({ kind: 'inbox', pairing, key }), []);
  // 新しい会話の画面は受信箱の上に重ねる（受信箱は読んだものと位置を保ったまま裏に残る）。
  // 閉じるときは下がって消える動きの間だけ残す（動きを減らす設定ではすぐ外す）。
  // n は開くたびに増やす番号。畳んでいる間に開き直しても、前の画面の選択を持ち越さない（key に使う）。
  const [sheet, setSheet] = useState<{ view: InboxView; leaving: boolean; n: number } | null>(null);
  const opened = useRef(0);
  const [refresh, setRefresh] = useState(0);
  // 「始める」のあとの依頼。フォームを閉じても続き、起動のシートが進みを見せる。
  const [launch, setLaunch] = useState<Launch | null>(null);
  const run = useRef<LaunchRun | null>(null);
  const launchNo = useRef(0);
  // 受信箱で最後に読めたもの。起動のシートが、始まった会話の URL をここから探す。
  const [inboxView, setInboxView] = useState<InboxView | null>(null);
  useEffect(() => () => run.current?.cancel(), []);
  const onUnpaired = useCallback(() => {
    run.current?.cancel();
    run.current = null;
    setLaunch(null);
    setSheet(null);
    setScreen({ kind: 'join', pairText: null, guide: false });
  }, []);
  const onNewSession = useCallback((view: InboxView) => {
    opened.current += 1;
    setSheet({ view, leaving: false, n: opened.current });
  }, []);
  const onCloseSheet = useCallback(() => {
    const n = opened.current;
    const ms = exitMs();
    if (ms <= 0) {
      setSheet(null);
      return;
    }
    setSheet((s) => (s ? { ...s, leaving: true } : s));
    setTimeout(() => setSheet((s) => (s?.leaving && s.n === n ? null : s)), ms);
  }, []);

  const onWantRefresh = useCallback(() => setRefresh((n) => n + 1), []);
  const onLaunch = (spec: LaunchSpec): void => {
    if (screen.kind !== 'inbox') return;
    run.current?.cancel();
    launchNo.current += 1;
    const no = launchNo.current;
    setLaunch({ spec, state: { kind: 'sending' }, open: true });
    run.current = startLaunch(screen.pairing, screen.key, spec, {
      everyMs: launchEveryMs,
      giveUpMs: launchGiveUpMs,
      onState: (state) => {
        if (launchNo.current !== no) return;
        if (state.kind === 'unpaired') {
          clearPairing();
          onUnpaired();
          return;
        }
        setLaunch((l) => (l ? { ...l, state } : l));
        // 始まったら受信箱を読み直す（実行中の行に出る）。
        if (state.kind === 'started') setRefresh((n) => n + 1);
      },
    });
    onCloseSheet();
  };
  const reconnect = (): void => {
    clearPairing();
    onUnpaired();
  };

  if (screen.kind === 'loading') return <div className="boot" />;
  if (screen.kind === 'join' && screen.guide) return <InstallGuide expiresAt={expiryOf(screen.pairText)} onContinue={() => setScreen({ ...screen, guide: false })} />;
  if (screen.kind === 'join') return <JoinScreen pairText={screen.pairText} onEnter={onEnter} />;
  return (
    <>
      <div className="under" inert={(!!sheet && !sheet.leaving) || !!launch?.open}>
        <InboxScreen pairing={screen.pairing} cryptoKey={screen.key} onUnpaired={onUnpaired} onNewSession={onNewSession} onView={setInboxView} refresh={refresh} />
      </div>
      {sheet && (
        <NewSessionScreen key={sheet.n} view={sheet.view} pairing={screen.pairing} cryptoKey={screen.key} leaving={sheet.leaving} onClose={onCloseSheet} onLaunch={onLaunch} />
      )}
      {launch && (
        <LaunchSheet
          spec={launch.spec}
          state={launch.state}
          view={inboxView}
          open={launch.open}
          onClose={() => setLaunch((l) => (l ? { ...l, open: false } : l))}
          onRetry={() => run.current?.retry()}
          onReconnect={reconnect}
          onWantRefresh={onWantRefresh}
        />
      )}
    </>
  );
}
