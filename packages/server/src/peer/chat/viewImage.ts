import fs from 'node:fs';
import path from 'node:path';
import type { PeerBlobRef } from '@agent-hangar/shared';
import { resolveDrop } from '../../prompt/drops.ts';
import type { ViewImage } from './viewer.ts';

/**
 * 画面が添えた画像を、置き場（POST /api/drops の置き先）の中から読む。
 * ref は DropDto.path（絶対パス）か、置き場の中のファイルの名前。
 * 置き場の外のパス、フォルダ、リンク、無いファイルは null。
 * 種類は拡張子で決め、PNG、JPEG、WebP だけを通す（PeerBlobRef の種類）。
 * 大きさの上限は呼び手（viewer.ts）が見る。
 * ここは読むだけで、上限を超えるものも返す。
 */
const MIME: Readonly<Record<string, PeerBlobRef['mime']>> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp' };

export function readDropImage(dropsDir: string, ref: string): ViewImage | null {
  if (!ref) return null;
  // 絶対パスは、置き場の直下のファイルのときだけ名前に直す。
  let name = ref;
  if (path.isAbsolute(ref)) {
    const abs = path.resolve(ref);
    if (path.dirname(abs) !== path.resolve(dropsDir)) return null;
    name = path.basename(abs);
  }
  const mime = MIME[path.extname(name).toLowerCase()];
  if (!mime) return null;
  const file = resolveDrop(dropsDir, name);
  if (!file) return null;
  try {
    return { bytes: new Uint8Array(fs.readFileSync(file)), mime };
  } catch {
    return null;
  }
}
