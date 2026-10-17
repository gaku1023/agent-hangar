// shared を入口（index.ts）から読むと PC 向けの表まで束に入るので、使うものだけを直に読む。
import { MOBILE_IMAGE_MAX_BYTES, MOBILE_IMAGES_PER_LAUNCH, MOBILE_IMAGES_PER_PHONE, type MobileImageRef } from '@agent-hangar/shared/src/mobile.ts';
import { COMPAT_HEADER, parseCompat } from '@agent-hangar/shared/src/compat.ts';
import { aadImage, MobilePairingError, sealBytes } from '@agent-hangar/shared/src/mobileCrypto.ts';
import { useCallback, useEffect, useRef, useState } from 'react';
import { mobileHeaders, originOf, unpairedReasonOf, workerTooOld, type UnpairedReason } from './api.ts';
import type { Pairing, PhoneKey } from './store.ts';

/** 縮めた後の長い辺。 */
export const IMAGE_LONG_EDGE = 2048;
/** 縮めるときの JPEG の品質。 */
export const IMAGE_QUALITY = 0.85;
/** 知らせの帯を出しておく長さ。 */
const NOTICE_MS = 4_500;

type Mime = MobileImageRef['mime'];

/** 起動の依頼に付ける画像 1 枚（縮めた後、封の前）。送り直しで依頼の ID が変わったら、これを封じ直して置き直す。 */
export type LaunchImage = { n: number; mime: Mime; data: Uint8Array };

/** 長い辺を max に収めた寸法。小さい画像は大きくしない。 */
export function fitSize(w: number, h: number, max: number = IMAGE_LONG_EDGE): { w: number; h: number } {
  const long = Math.max(w, h);
  if (long <= max) return { w, h };
  const s = max / long;
  return { w: Math.max(1, Math.round(w * s)), h: Math.max(1, Math.round(h * s)) };
}

const mb = (bytes: number): string => (Math.round((bytes / 1024 / 1024) * 10) / 10).toFixed(1);

/** 断る理由の文。count は今ある枚数、bytes は縮めた後の大きさ。断らないなら null。 */
export function rejectImage(o: { count: number; name?: string; bytes?: number }): string | null {
  if (o.count >= MOBILE_IMAGES_PER_LAUNCH) return `${MOBILE_IMAGES_PER_LAUNCH} 枚までです。1 枚削除してから追加してください。`;
  if (o.bytes !== undefined && o.bytes > MOBILE_IMAGE_MAX_BYTES) return `${o.name ?? '画像'} は添付できません。1 枚 5 MB までです（${mb(o.bytes)} MB）`;
  return null;
}

export type ImageFailure = 'too-large' | 'too-many' | 'rate-limited' | 'unpaired' | 'unsupported' | 'network' | 'server' | 'aborted';

/** 置けなかった理由。unpairedReason は 401 の理由。 */
export class ImageError extends Error {
  constructor(
    readonly reason: ImageFailure,
    readonly status: number | null = null,
    readonly unpairedReason: UnpairedReason = 'unknown',
  ) {
    super(`画像を送信できませんでした（${reason}）`);
    this.name = 'ImageError';
  }
}

/**
 * 置けなかったことを知らせる文。lead の後ろに状態の番号（分からない失敗のとき）と句点、理由の 1 文、tail を続ける。
 * 例：「画像を送信できませんでした（500）。もう一度送信してください。」
 */
export function imageFailureText(e: unknown, lead: string, tail: string): string {
  const reason = e instanceof ImageError ? e.reason : 'server';
  const status = e instanceof ImageError ? e.status : null;
  const code = reason === 'server' && status ? `（${status}）` : '';
  const expired = e instanceof ImageError && e.unpairedReason === 'expired';
  return `${lead}${code}。${imageCause(reason, expired)}${tail}`;
}

function imageCause(reason: ImageFailure, expired: boolean): string {
  switch (reason) {
    case 'too-many':
      return `クラウドに保存している画像が上限の ${MOBILE_IMAGES_PER_PHONE} 枚に達しています。PC が受信すると消えます。`;
    case 'too-large':
      return '画像が大きすぎます。';
    case 'rate-limited':
      return '送信の上限です。少し待ってください。';
    case 'unpaired':
      return expired ? 'このスマホの接続は期限が切れています。' : 'このスマホの接続は解除されています。';
    case 'unsupported':
      return 'クラウドが画像の添付に対応していません。PC の hangar を更新して、クラウドを更新してください。';
    case 'network':
      return '通信を確認してください。';
    default:
      return '';
  }
}

export type PutImage = (
  p: Pairing,
  key: PhoneKey,
  launchId: string,
  n: number,
  data: Uint8Array,
  o?: { onProgress?: (pct: number) => void; signal?: AbortSignal; xhr?: () => XMLHttpRequest },
) => Promise<void>;

/**
 * 画像 1 枚を aadImage(依頼, 番号) で封じ、PUT /m/blobs/<依頼>/<番号> で置く。
 * 進みを出すため fetch でなく XMLHttpRequest で送る。本文は Blob にする（長さを名乗らない本文は Worker が 411 で断る）。
 */
export const putImage: PutImage = async (p, key, launchId, n, data, o = {}) => {
  let origin: string;
  try {
    origin = originOf(p.url);
  } catch (e) {
    if (e instanceof MobilePairingError) throw new ImageError('unpaired');
    throw e;
  }
  if (o.signal?.aborted) throw new ImageError('aborted');
  // 画像は依頼と同じ世代のスマホ用の鍵で封じる（Worker は画像の世代を持たず、PC は依頼の世代で開く）。
  const sealed = await sealBytes(key.key, aadImage(launchId, n), data);
  if (o.signal?.aborted) throw new ImageError('aborted');
  await new Promise<void>((resolve, reject) => {
    const x = o.xhr ? o.xhr() : new XMLHttpRequest();
    x.open('PUT', `${origin}/m/blobs/${encodeURIComponent(launchId)}/${n}`);
    for (const [k, v] of Object.entries(mobileHeaders(p))) x.setRequestHeader(k, v);
    x.setRequestHeader('content-type', 'application/octet-stream');
    x.upload.onprogress = (e) => {
      if (e.lengthComputable && e.total > 0) o.onProgress?.(Math.min(99, Math.round((e.loaded / e.total) * 100)));
    };
    x.onload = () => {
      const s = x.status;
      // 画像の口を知らない古い Worker（rc.1 も JSON の 404 を返す）は、応答の版の見出しで見分ける。
      const compat = x.getResponseHeader(COMPAT_HEADER);
      if (workerTooOld(compat === null ? null : parseCompat(compat))) {
        reject(new ImageError('unsupported', s));
        return;
      }
      if (s >= 200 && s < 300) {
        o.onProgress?.(100);
        resolve();
        return;
      }
      let error = '';
      try {
        const b = JSON.parse(x.responseText) as { error?: unknown };
        if (typeof b.error === 'string') error = b.error;
      } catch {
        // 本文が JSON でなければ、理由は状態の番号だけで決める。
      }
      const reason: ImageFailure = s === 401 ? 'unpaired' : s === 413 ? 'too-large' : s === 429 ? (error === 'too many images' ? 'too-many' : 'rate-limited') : 'server';
      reject(new ImageError(reason, s, s === 401 ? unpairedReasonOf(error) : 'unknown'));
    };
    x.onerror = () => reject(new ImageError('network'));
    x.onabort = () => reject(new ImageError('aborted'));
    o.signal?.addEventListener('abort', () => x.abort(), { once: true });
    x.send(new Blob([sealed as BlobPart], { type: 'application/octet-stream' }));
  });
};

export type Shrink = (file: Blob) => Promise<{ data: Uint8Array; mime: Mime }>;

/**
 * 長い辺 2048 px、JPEG（品質 0.85）に縮める。
 * 描き直すので、位置情報などの付帯情報は落ちる。向きはブラウザが画像の向きの情報に従って描く。
 * 透ける画像は白の上に描く（JPEG は透けない）。
 */
export const shrinkImage: Shrink = async (file) => {
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    const { w, h } = fitSize(img.naturalWidth, img.naturalHeight);
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    const ctx = c.getContext('2d');
    if (!ctx) throw new Error('no canvas');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, w, h);
    ctx.drawImage(img, 0, 0, w, h);
    const blob = await new Promise<Blob | null>((r) => c.toBlob(r, 'image/jpeg', IMAGE_QUALITY));
    // iOS の Safari は canvas の領域を早く返さないと次の描画で詰まる。
    c.width = 0;
    c.height = 0;
    if (!blob) throw new Error('encode failed');
    return { data: new Uint8Array(await blob.arrayBuffer()), mime: 'image/jpeg' };
  } finally {
    URL.revokeObjectURL(url);
  }
};

/** 欄に付けた画像 1 枚。 */
export type Attachment = {
  id: number;
  /** 置き場の番号（0 から 3）。 */
  n: number;
  name: string;
  /** サムネイル（URL.createObjectURL）。外すときに放す。 */
  url: string;
  data: Uint8Array;
  mime: Mime;
  state: 'up' | 'done' | 'fail';
  pct: number;
};

export type Attachments = {
  items: Attachment[];
  /** 選んだ画像を足す。縮めて、断るものは知らせ、残りを置く。 */
  add: (files: File[]) => Promise<void>;
  remove: (id: number) => void;
  /** 失敗したものを送り直す。 */
  retry: (id: number) => void;
  notice: string | null;
  busy: boolean;
  failed: boolean;
  /** 置き終えたもの。 */
  ready: LaunchImage[];
};

type Slot = { n: number; url: string; ac: AbortController | null };

/**
 * 初期プロンプトの欄の画像。依頼の ID（launchId）を先に振り、選んだらすぐに置く。
 * 外したもの、画面を閉じたときは、送るのをやめてサムネイルを放す。置いたものは Worker が後で消す。
 */
export function useAttachments(o: { pairing: Pairing; key: PhoneKey; launchId: string; put?: PutImage; shrink?: Shrink }): Attachments {
  const [items, setItems] = useState<Attachment[]>([]);
  const [notice, setNotice] = useState<{ text: string; no: number } | null>(null);
  const deps = useRef(o);
  deps.current = o;
  const slots = useRef(new Map<number, Slot>());
  const pending = useRef(0);
  const uid = useRef(0);
  const noticeNo = useRef(0);

  const say = useCallback((text: string) => {
    noticeNo.current += 1;
    setNotice({ text, no: noticeNo.current });
  }, []);

  useEffect(() => {
    if (!notice) return;
    const t = setTimeout(() => setNotice((n) => (n && n.no === notice.no ? null : n)), NOTICE_MS);
    return () => clearTimeout(t);
  }, [notice]);

  useEffect(() => {
    const live = slots.current;
    return () => {
      for (const s of live.values()) {
        s.ac?.abort();
        URL.revokeObjectURL(s.url);
      }
      live.clear();
    };
  }, []);

  const patch = (id: number, f: (a: Attachment) => Attachment): void => setItems((list) => list.map((a) => (a.id === id ? f(a) : a)));

  const upload = useCallback((id: number, n: number, data: Uint8Array) => {
    const slot = slots.current.get(id);
    if (!slot) return;
    const ac = new AbortController();
    slot.ac = ac;
    patch(id, (a) => ({ ...a, state: 'up', pct: 0 }));
    const { pairing, key, launchId, put = putImage } = deps.current;
    put(pairing, key, launchId, n, data, { signal: ac.signal, onProgress: (pct) => slots.current.get(id)?.ac === ac && patch(id, (a) => ({ ...a, pct })) }).then(
      () => {
        if (slots.current.get(id)?.ac !== ac) return;
        slot.ac = null;
        patch(id, (a) => ({ ...a, state: 'done', pct: 100 }));
      },
      (e: unknown) => {
        if (ac.signal.aborted || slots.current.get(id)?.ac !== ac) return;
        slot.ac = null;
        patch(id, (a) => ({ ...a, state: 'fail' }));
        say(imageFailureText(e, '画像を 1 枚送信できませんでした', '画像をタップすると、もう一度送信します。'));
      },
    );
  }, [say]);

  const add = useCallback(
    async (files: File[]) => {
      for (const f of files) {
        const full = rejectImage({ count: slots.current.size + pending.current });
        if (full) {
          say(full);
          return;
        }
        pending.current += 1;
        let shrunk: { data: Uint8Array; mime: Mime };
        try {
          shrunk = await (deps.current.shrink ?? shrinkImage)(f);
        } catch {
          say(`${f.name || '画像'} を読み込めませんでした。別の画像を選んでください。`);
          continue;
        } finally {
          pending.current -= 1;
        }
        const big = rejectImage({ count: 0, name: f.name || '画像', bytes: shrunk.data.length });
        if (big) {
          say(big);
          continue;
        }
        const used = new Set([...slots.current.values()].map((s) => s.n));
        let n = 0;
        while (used.has(n)) n += 1;
        uid.current += 1;
        const id = uid.current;
        const url = URL.createObjectURL(new Blob([shrunk.data as BlobPart], { type: shrunk.mime }));
        slots.current.set(id, { n, url, ac: null });
        setItems((list) => [...list, { id, n, name: f.name || '画像', url, data: shrunk.data, mime: shrunk.mime, state: 'up', pct: 0 }]);
        upload(id, n, shrunk.data);
      }
    },
    [say, upload],
  );

  const remove = useCallback((id: number) => {
    const s = slots.current.get(id);
    if (!s) return;
    slots.current.delete(id);
    s.ac?.abort();
    URL.revokeObjectURL(s.url);
    setItems((list) => list.filter((a) => a.id !== id));
  }, []);

  const retry = useCallback(
    (id: number) => {
      const a = items.find((x) => x.id === id);
      if (!a || a.state !== 'fail') return;
      upload(id, a.n, a.data);
    },
    [items, upload],
  );

  return {
    items,
    add,
    remove,
    retry,
    notice: notice?.text ?? null,
    busy: items.some((a) => a.state === 'up'),
    failed: items.some((a) => a.state === 'fail'),
    ready: items.filter((a) => a.state === 'done').map((a) => ({ n: a.n, mime: a.mime, data: a.data })),
  };
}
