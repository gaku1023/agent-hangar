import { useEffect, useState } from 'react';

/** 目次の列を、タブの列の「目次 N」の札に畳む窓の幅（px）。これより狭いときは畳む（設計書 2.3、900px の窓）。 */
export const NARROW_BELOW = 1000;
const QUERY = `(max-width: ${NARROW_BELOW - 1}px)`;

const read = (): boolean => typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia(QUERY).matches;

/**
 * 窓が狭いか。セッション画面が、目次の列を札に畳むかどうかに使う。
 * 窓の幅を変えたときに追う。matchMedia の無い環境（jsdom）では、いつも広い。
 */
export function useNarrow(): boolean {
  const [narrow, setNarrow] = useState(read);
  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
    const mq = window.matchMedia(QUERY);
    const on = () => setNarrow(mq.matches);
    on();
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, []);
  return narrow;
}
