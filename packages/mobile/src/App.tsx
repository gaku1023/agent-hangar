import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import type { InboxView } from './inbox.ts';
import { exitMs } from './presence.ts';
import { readPairText, type UnpairedReason } from './api.ts';
import { refreshPhoneKeys } from './keyring.ts';
import { startLaunch, type LaunchRun, type LaunchSpec, type RunState } from './launchRun.ts';
import { clearPairing, currentKey, loadPairing, loadPhoneKeys, loadPhonePair, type Keyring, type Pairing, type PhoneKey, type PhonePair } from './store.ts';
import { isIosSafari, isStandalone } from './platform.ts';
import { InstallGuide } from './views/InstallGuide.tsx';
import { InboxScreen } from './views/InboxScreen.tsx';
import { LaunchSheet } from './views/LaunchSheet.tsx';
import { NewSessionScreen } from './views/NewSessionScreen.tsx';
import { JoinScreen, type Resume } from './views/JoinScreen.tsx';

type Screen =
  | { kind: 'loading' }
  | { kind: 'join'; pairText: string | null; guide: boolean; notice?: 'expired' | null; resume?: Resume | null }
  | { kind: 'inbox'; pairing: Pairing; pair: PhonePair; keys: Keyring; current: PhoneKey };

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
 * 接続と鍵ペアとスマホ用の鍵がそろっていれば受信箱。
 * 接続と鍵ペアだけなら（keybox を待っている間に閉じた）、参加の画面の待ちから続ける。どれかが無ければ参加の画面（④）。
 */
type Launch = { spec: LaunchSpec; state: RunState; open: boolean };

type AppProps = {
  pairText: string | null;
  /** 起動の依頼の状態を読む間隔と、諦めるまでの長さ。試験で縮める。 */
  launchEveryMs?: number;
  launchGiveUpMs?: number;
  /** 接続の後に keybox を読む間隔と、待つ長さ。試験で縮める。 */
  keyboxWait?: { everyMs?: number; giveUpMs?: number };
};

const inboxOf = (pairing: Pairing, pair: PhonePair, keys: Keyring): Screen | null => {
  const current = currentKey(keys);
  return current ? { kind: 'inbox', pairing, pair, keys, current } : null;
};

export function App({ pairText, launchEveryMs, launchGiveUpMs, keyboxWait }: AppProps): ReactNode {
  const [screen, setScreen] = useState<Screen>(() => (pairText ? { kind: 'join', pairText, guide: needsGuide() } : { kind: 'loading' }));

  useEffect(() => {
    if (screen.kind !== 'loading') return;
    let off = false;
    void (async () => {
      const pairing = loadPairing();
      const pair = pairing ? await loadPhonePair() : null;
      const keys = pair ? await loadPhoneKeys() : new Map<number, CryptoKey>();
      if (off) return;
      const inbox = pairing && pair ? inboxOf(pairing, pair, keys) : null;
      if (inbox) setScreen(inbox);
      else if (pairing && pair) setScreen({ kind: 'join', pairText: null, guide: false, resume: { pairing, pair } });
      else setScreen({ kind: 'join', pairText: null, guide: !pairing && needsGuide() });
    })();
    return () => {
      off = true;
    };
  }, [screen.kind]);

  const onEnter = useCallback((pairing: Pairing, pair: PhonePair, keys: Keyring) => {
    setScreen(inboxOf(pairing, pair, keys) ?? { kind: 'join', pairText: null, guide: false, resume: { pairing, pair } });
  }, []);
  // 受信箱が keybox を読み直して手元の鍵が変わった。次に開く新しい会話の画面から、新しい世代で封じる。
  const onKeys = useCallback((keys: Keyring) => {
    setScreen((s) => (s.kind === 'inbox' ? (inboxOf(s.pairing, s.pair, keys) ?? s) : s));
  }, []);
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
  const onUnpaired = useCallback((reason?: UnpairedReason) => {
    run.current?.cancel();
    run.current = null;
    setLaunch(null);
    setSheet(null);
    setScreen({ kind: 'join', pairText: null, guide: false, notice: reason === 'expired' ? 'expired' : null });
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
  // key は新しい会話の画面を開いたときの鍵。画像もこの鍵で封じてあるので、依頼も同じ世代で封じる（受信箱が後で新しい世代を読んでも替えない）。
  const onLaunch = (spec: LaunchSpec, key: PhoneKey): void => {
    if (screen.kind !== 'inbox') return;
    run.current?.cancel();
    launchNo.current += 1;
    const no = launchNo.current;
    setLaunch({ spec, state: { kind: 'sending' }, open: true });
    run.current = startLaunch(screen.pairing, key, spec, {
      everyMs: launchEveryMs,
      giveUpMs: launchGiveUpMs,
      onState: (state) => {
        if (launchNo.current !== no) return;
        if (state.kind === 'unpaired') {
          void clearPairing();
          onUnpaired(state.reason);
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
    void clearPairing();
    onUnpaired();
  };
  const reloadKeys = useCallback(async (): Promise<Keyring> => {
    if (screen.kind !== 'inbox') return new Map();
    return refreshPhoneKeys(screen.pairing, screen.pair);
  }, [screen]);

  if (screen.kind === 'loading') return <div className="boot" />;
  if (screen.kind === 'join' && screen.guide) return <InstallGuide expiresAt={expiryOf(screen.pairText)} onContinue={() => setScreen({ ...screen, guide: false })} />;
  if (screen.kind === 'join') return <JoinScreen pairText={screen.pairText} onEnter={onEnter} notice={screen.notice ?? null} resume={screen.resume ?? null} wait={keyboxWait} />;
  return (
    <>
      <div className="under" inert={(!!sheet && !sheet.leaving) || !!launch?.open}>
        <InboxScreen
          pairing={screen.pairing}
          keys={screen.keys}
          reloadKeys={reloadKeys}
          onKeys={onKeys}
          onUnpaired={onUnpaired}
          onNewSession={onNewSession}
          onView={setInboxView}
          refresh={refresh}
        />
      </div>
      {sheet && (
        <NewSessionScreen key={sheet.n} view={sheet.view} pairing={screen.pairing} phoneKey={screen.current} leaving={sheet.leaving} onClose={onCloseSheet} onLaunch={onLaunch} />
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
