/** ホーム画面から開いたアプリとして動いているか。 */
export function isStandalone(): boolean {
  try {
    return window.matchMedia?.('(display-mode: standalone)').matches === true || (navigator as Navigator & { standalone?: boolean }).standalone === true;
  } catch {
    return false;
  }
}

/**
 * iPhone か iPad の Safari か。
 * iPadOS 13 以降の Safari は Mac を名乗るので、タッチを持つ Mac も iPad と見る。
 * iPhone と iPad の別のブラウザ（Chrome、Firefox、Edge、Opera）は含めない。
 */
export function isIosSafari(ua: string = navigator.userAgent, touchPoints: number = navigator.maxTouchPoints ?? 0): boolean {
  const ios = /iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && touchPoints > 1);
  return ios && /Safari\//.test(ua) && !/CriOS|FxiOS|EdgiOS|OPiOS/.test(ua);
}
