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
  return isIos(ua, touchPoints) && /Safari\//.test(ua) && !/CriOS|FxiOS|EdgiOS|OPiOS/.test(ua);
}

/**
 * iPhone か iPad か（ブラウザを問わない）。
 * iOS ではどのブラウザも WebKit で、Web Push はホーム画面に追加したアプリの中でだけ使える。
 */
export function isIos(ua: string = navigator.userAgent, touchPoints: number = navigator.maxTouchPoints ?? 0): boolean {
  return /iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && touchPoints > 1);
}
