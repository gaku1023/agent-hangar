import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { loadKey, loadPairing, type Pairing } from './store.ts';
import { InboxScreen } from './views/InboxScreen.tsx';
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
  const onUnpaired = useCallback(() => setScreen({ kind: 'join', pairText: null }), []);

  if (screen.kind === 'loading') return <div className="boot" />;
  if (screen.kind === 'join') return <JoinScreen pairText={screen.pairText} onEnter={onEnter} />;
  return <InboxScreen pairing={screen.pairing} cryptoKey={screen.key} onUnpaired={onUnpaired} />;
}
