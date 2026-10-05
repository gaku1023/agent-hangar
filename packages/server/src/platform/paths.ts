// パスの比べ方。OS で変わるのは、区切りと、大文字小文字を区別するかどうかである。
// 受け取るパスは、呼ぶ側で path.resolve と NFC の正規化を済ませたものとする。
//
// 比べ方は、動いている OS ではなくパスの形から決める。
// DB には、同期で届いた別の OS の端末のパスも入る。Windows で macOS のセッションを見ても、その逆でも、同じ答えになる。

/** ドライブ文字（C:\、C:/）か UNC（\\server）で始まるパスは Windows の形である。 */
function styleOf(p: string): NodeJS.Platform {
  return /^[A-Za-z]:[\\/]|^\\\\/.test(p) ? 'win32' : 'linux';
}

const sepOf = (platform: NodeJS.Platform): string => (platform === 'win32' ? '\\' : '/');

/**
 * 比べるための鍵。
 * Windows のファイルシステムは大文字小文字を区別しないので、小文字にそろえる。区切りは / も受けるので \ にそろえる。
 */
export function pathKey(p: string, platform: NodeJS.Platform = styleOf(p)): string {
  return platform === 'win32' ? p.toLowerCase().replace(/\//g, '\\') : p;
}

export function samePath(a: string, b: string, platform: NodeJS.Platform = styleOf(b)): boolean {
  return pathKey(a, platform) === pathKey(b, platform);
}

/** p が dir の下にあるか。dir 自身は含めない。 */
export function isStrictlyUnder(p: string, dir: string, platform: NodeJS.Platform = styleOf(dir)): boolean {
  const sep = sepOf(platform);
  const d = pathKey(dir, platform);
  // ドライブの直下（D:\）と / は、すでに区切りで終わっている。
  const base = d.endsWith(sep) ? d : d + sep;
  const x = pathKey(p, platform);
  return x.length > base.length && x.startsWith(base);
}

/** p が dir 自身か、その下にあるか。 */
export function isUnder(p: string, dir: string, platform: NodeJS.Platform = styleOf(dir)): boolean {
  return samePath(p, dir, platform) || isStrictlyUnder(p, dir, platform);
}
