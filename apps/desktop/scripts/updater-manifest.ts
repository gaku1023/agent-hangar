// updater の目録（latest.json）を作る。release.yml の updater-manifest ジョブが動かす。
// 使い方: node --experimental-strip-types scripts/updater-manifest.ts <置き場> <タグ> <owner/repo>
// 置き場には、各 OS の更新物の署名（Release の資産の名前 + .sig）が入っている。
// 目録は tauri-plugin-updater の静的な形で、アプリは tauri.conf.json の endpoints（Release の最新の latest.json）からこれを引く。
// CI のこのジョブは npm ci をしないので、Node が型を剥がすだけで動く書き方（import は node: だけ）にしておく。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export type ManifestEntry = { asset: string; signature: string };
export type Manifest = { version: string; notes: string; pub_date: string; platforms: Record<string, { url: string; signature: string }> };

/** Release の資産の名前（release.yml が付ける名前）から、updater の platform を決める。更新物でなければ null。 */
export function platformOf(asset: string): string | null {
  if (/-macos-arm64\.app\.tar\.gz$/.test(asset)) return 'darwin-aarch64';
  if (/-macos-x64\.app\.tar\.gz$/.test(asset)) return 'darwin-x86_64';
  if (/-windows-x64-setup\.exe$/.test(asset)) return 'windows-x86_64';
  return null;
}

export function buildManifest(a: { tag: string; repo: string; pubDate: string; notes: string; entries: ManifestEntry[] }): Manifest {
  const version = /^v(\d+\.\d+\.\d+(?:[-+].+)?)$/.exec(a.tag)?.[1];
  if (!version) throw new Error(`tag ${a.tag} is not v<semver>`);
  if (a.entries.length === 0) throw new Error('no updater artifacts');
  const platforms: Manifest['platforms'] = {};
  for (const e of a.entries) {
    const p = platformOf(e.asset);
    if (!p) throw new Error(`unknown updater artifact ${e.asset}`);
    platforms[p] = { url: `https://github.com/${a.repo}/releases/download/${a.tag}/${e.asset}`, signature: e.signature };
  }
  return { version, notes: a.notes, pub_date: a.pubDate, platforms };
}

/** 置き場の .sig を読み、資産の名前と署名の中身の組にする（名前の順）。 */
export function readEntries(dir: string): ManifestEntry[] {
  return fs.readdirSync(dir).filter((f) => f.endsWith('.sig')).sort()
    .map((f) => ({ asset: f.slice(0, -'.sig'.length), signature: fs.readFileSync(path.join(dir, f), 'utf8').trim() }));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [dir, tag, repo] = process.argv.slice(2);
  if (!dir || !tag || !repo) {
    console.error('usage: updater-manifest.ts <dir> <tag> <owner/repo>');
    process.exit(2);
  }
  const m = buildManifest({ tag, repo, pubDate: new Date().toISOString(), notes: '', entries: readEntries(dir) });
  process.stdout.write(`${JSON.stringify(m, null, 2)}\n`);
}
