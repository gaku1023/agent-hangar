import jsQR from 'jsqr';

/** カメラの映像を縮めて読む幅の上限。大きいままだと古い端末で 1 枚の読みが重い。 */
const MAX_SIDE = 640;
/** 次の 1 枚を読むまでの間。 */
const INTERVAL_MS = 150;

const abortError = (): DOMException => new DOMException('読み取りをやめました', 'AbortError');

/**
 * 背面のカメラで QR を読み、#pair= を含む文字列が読めたら返す。
 * iOS の Safari には BarcodeDetector が無いので、jsQR で 1 枚ずつ読む。
 * 読めたとき、やめたとき、失敗したときのどれでも、カメラは止めて video から外す。
 */
export async function scanQr(video: HTMLVideoElement, signal: AbortSignal): Promise<string> {
  if (signal.aborted) throw abortError();
  const media = navigator.mediaDevices;
  if (!media?.getUserMedia) throw new Error('このブラウザではカメラを使えません');
  const stream = await media.getUserMedia({ video: { facingMode: 'environment' }, audio: false });
  const stop = (): void => {
    for (const t of stream.getTracks()) t.stop();
    video.srcObject = null;
  };
  if (signal.aborted) {
    stop();
    throw abortError();
  }
  try {
    video.setAttribute('playsinline', '');
    video.muted = true;
    video.srcObject = stream;
    await video.play();
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) throw new Error('映像を読めません');
    return await new Promise<string>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const onAbort = (): void => {
        clearTimeout(timer);
        reject(abortError());
      };
      signal.addEventListener('abort', onAbort, { once: true });
      const tick = (): void => {
        if (signal.aborted) return;
        try {
          const w = video.videoWidth;
          const h = video.videoHeight;
          if (w > 0 && h > 0) {
            const scale = Math.min(1, MAX_SIDE / Math.max(w, h));
            canvas.width = Math.round(w * scale);
            canvas.height = Math.round(h * scale);
            ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
            const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
            const code = jsQR(img.data, img.width, img.height, { inversionAttempts: 'dontInvert' });
            if (code && code.data.includes('#pair=')) {
              signal.removeEventListener('abort', onAbort);
              resolve(code.data);
              return;
            }
          }
        } catch (e) {
          signal.removeEventListener('abort', onAbort);
          reject(e instanceof Error ? e : new Error('映像を読めません'));
          return;
        }
        timer = setTimeout(tick, INTERVAL_MS);
      };
      tick();
    });
  } finally {
    stop();
  }
}
