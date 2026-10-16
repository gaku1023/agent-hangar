import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import type { InboxView } from './inbox.ts';
import { exitMs } from './presence.ts';
import { loadKey, loadPairing, type Pairing } from './store.ts';
import { InboxScreen } from './views/InboxScreen.tsx';
import { NewSessionScreen } from './views/NewSessionScreen.tsx';
import { JoinScreen } from './views/JoinScreen.tsx';

type Screen = { kind: 'loading' } | { kind: 'join'; pairText: string | null } | { kind: 'inbox'; pairing: Pairing; key: CryptoKey };

/**
 * 画面の切り替え。
 * #pair= 付きで開かれたら、手元の接続があっても参加の画面を先に出す（新しい QR で接続し直す）。
 * 接続と鍵の両方が手元にあれば受信箱、どちらかが無ければ参加の画面（④）。
 */
export function App({ pairText }: { pairText: string | null }): ReactNode {
  const [screen, setScreen] = useState<Screen>(() => (pairText ? { kind: 'join', pairText } : { kind: 'loading' }));

  useEffect(() => {
    if (screen.kind !== 'loading') return;
    let off = false;
    void (async () => {
      const pairing = loadPairing();
      const key = pairing ? await loadKey() : null;
      if (off) return;
      setScreen(pairing && key ? { kind: 'inbox', pairing, key } : { kind: 'join', pairText: null });
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
  const onUnpaired = useCallback(() => {
    setSheet(null);
    setScreen({ kind: 'join', pairText: null });
  }, []);
  const onNewSession = useCallback((view: InboxView) => {
    opened.current += 1;
    setSheet({ view, leaving: false, n: opened.current });
  }, []);
  const onCloseSheet = useCallback((refreshInbox: boolean) => {
    if (refreshInbox) setRefresh((n) => n + 1);
    const n = opened.current;
    const ms = exitMs();
    if (ms <= 0) {
      setSheet(null);
      return;
    }
    setSheet((s) => (s ? { ...s, leaving: true } : s));
    setTimeout(() => setSheet((s) => (s?.leaving && s.n === n ? null : s)), ms);
  }, []);

  if (screen.kind === 'loading') return <div className="boot" />;
  if (screen.kind === 'join') return <JoinScreen pairText={screen.pairText} onEnter={onEnter} />;
  return (
    <>
      <div className="under" inert={!!sheet && !sheet.leaving}>
        <InboxScreen pairing={screen.pairing} cryptoKey={screen.key} onUnpaired={onUnpaired} onNewSession={onNewSession} refresh={refresh} />
      </div>
      {sheet && <NewSessionScreen key={sheet.n} pairing={screen.pairing} cryptoKey={screen.key} view={sheet.view} leaving={sheet.leaving} onClose={onCloseSheet} onUnpaired={onUnpaired} />}
    </>
  );
}
