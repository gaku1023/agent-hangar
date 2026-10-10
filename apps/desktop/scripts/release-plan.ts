// release の段取りを決める。release.yml の plan ジョブと updater-manifest ジョブ、版を上げる手順（docs/release.md）が動かす。
// 使い方:
//   node --experimental-strip-types scripts/release-plan.ts plan <タグ> [リポジトリの根]
//     タグと版の在りかのファイルを照らし、GitHub の出力の形（key=value）で計画を書く。食い違えば止まる。
//   node --experimental-strip-types scripts/release-plan.ts channel <今の試しの道の latest.json> <版>
//     試しの道の目録を、この版で置き換えるかを true か false で書く。
//   node --experimental-strip-types scripts/release-plan.ts set-version <版> [リポジトリの根]
//     版の在りかのファイルを、すべてその版に書き換える（版を上げる PR を作るとき）。
// CI の plan ジョブは npm ci をしないので、Node が型を剥がすだけで動く書き方（import は node: だけ）にしておく。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** 版の在りか（リポジトリの根からの相対）。アプリが名乗る版は tauri.conf.json のもので、ほかはそれにそろえる。 */
export const VERSION_FILES = [
  'apps/desktop/src-tauri/tauri.conf.json',
  'apps/desktop/package.json',
  'apps/desktop/src-tauri/Cargo.toml',
  'apps/desktop/src-tauri/Cargo.lock',
  'package-lock.json',
] as const;

/** 試しの版の目録を置く Release のタグ。prerelease なので Release の最新には入らない。v で始めないので release.yml も走らない。 */
export const PRERELEASE_CHANNEL_TAG = 'updater-prerelease';

/** 試しの版の build に重ねる設定（apps/desktop からの相対）。updater の endpoint を試しの道に替える。 */
export const PRERELEASE_TAURI_CONFIG = 'src-tauri/tauri.prerelease.conf.json';

// semver 2.0.0 の正規表現（semver.org のもの）から、ビルドメタデータを別に取り出す形にしたもの。
const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$/;

type Parsed = { core: [number, number, number]; pre: string[] };

function parse(version: string): Parsed {
  const m = SEMVER.exec(version);
  if (!m) throw new Error(`${JSON.stringify(version)} is not semver`);
  return { core: [Number(m[1]), Number(m[2]), Number(m[3])], pre: m[4] ? m[4].split('.') : [] };
}

/** 配る版として受けるか。semver で、ビルドメタデータ（+）が無いこと。 */
export function assertReleaseVersion(version: string): string {
  const m = SEMVER.exec(version);
  if (!m) throw new Error(`${JSON.stringify(version)} is not semver`);
  // 更新の比べ方はビルドメタデータを見ないので、+ だけが違う版は更新として見つからない。NSIS も + の後ろは数字しか受けない。
  if (m[5] !== undefined) throw new Error(`${version}: build metadata (+) is not allowed in a release version`);
  return version;
}

/** タグ（v<semver>）から版を取り出す。 */
export function versionOfTag(tag: string): string {
  if (!tag.startsWith('v')) throw new Error(`tag ${JSON.stringify(tag)} is not v<semver>`);
  return assertReleaseVersion(tag.slice(1));
}

/** - の後ろ（プレリリース）があれば試しの版である。 */
export function isPrerelease(version: string): boolean {
  return parse(version).pre.length > 0;
}

/** semver の順序で比べる（a が古ければ -1、同じなら 0、新しければ 1）。tauri-plugin-updater と NSIS の比べ方と同じである。 */
export function compareVersions(a: string, b: string): -1 | 0 | 1 {
  const x = parse(a);
  const y = parse(b);
  for (let i = 0; i < 3; i++) {
    if (x.core[i]! !== y.core[i]!) return x.core[i]! < y.core[i]! ? -1 : 1;
  }
  // プレリリースの付いた版は、付かない同じ数字の版より古い。
  if (x.pre.length === 0 || y.pre.length === 0) return x.pre.length === y.pre.length ? 0 : x.pre.length === 0 ? 1 : -1;
  for (let i = 0; i < Math.max(x.pre.length, y.pre.length); i++) {
    const p = x.pre[i];
    const q = y.pre[i];
    if (p === undefined) return -1;
    if (q === undefined) return 1;
    if (p === q) continue;
    const pn = /^\d+$/.test(p);
    const qn = /^\d+$/.test(q);
    // 数字だけの識別子は数として比べ、文字を含む識別子より古い。
    if (pn && qn) return Number(p) < Number(q) ? -1 : 1;
    if (pn !== qn) return pn ? -1 : 1;
    return p < q ? -1 : 1;
  }
  return 0;
}

export type Plan = { version: string; prerelease: boolean; tauriConfig: string };

/** タグと、版の在りかの各ファイルの版を照らし、release の計画を返す。1 つでも違えば止める（食い違ったまま配らない）。 */
export function planRelease(tag: string, versions: Record<string, string | undefined>): Plan {
  const version = versionOfTag(tag);
  const wrong = VERSION_FILES.filter((f) => versions[f] !== version);
  if (wrong.length > 0) {
    const lines = wrong.map((f) => `  ${f}: ${versions[f] ?? '(no version found)'}`);
    throw new Error(`tag ${tag} does not match the version in:\n${lines.join('\n')}\nraise the version (npm run set-version -w apps/desktop -- ${version}) and merge it before tagging`);
  }
  const prerelease = isPrerelease(version);
  return { version, prerelease, tauriConfig: prerelease ? PRERELEASE_TAURI_CONFIG : '' };
}

/** 更新の目録の URL。安定版の道は Release の最新（prerelease は入らない）、試しの道は固定のタグの Release である。 */
export function manifestUrl(repo: string, channel: 'stable' | 'prerelease'): string {
  return channel === 'stable'
    ? `https://github.com/${repo}/releases/latest/download/latest.json`
    : `https://github.com/${repo}/releases/download/${PRERELEASE_CHANNEL_TAG}/latest.json`;
}

/** 試しの道の目録を、この版で置き換えるか。今より新しいか同じ（同じ版の再実行）ときだけ置き換え、古い版で巻き戻さない。 */
export function shouldUpdateChannel(existing: string | null, next: string): boolean {
  return existing === null || compareVersions(next, existing) >= 0;
}

// 各ファイルの版の 1 か所。読むのも書き換えるのも同じ正規表現で、その 1 か所だけに当てる。
// 部分一致だと依存の version 行にも当たるので、ファイルごとに場所を絞る。
const LOCATORS: Record<(typeof VERSION_FILES)[number], RegExp> = {
  // 頭の段の "version"（2 つの空白で字下げ）。
  'apps/desktop/src-tauri/tauri.conf.json': /^( {2}"version": ")([^"]*)(")/m,
  'apps/desktop/package.json': /^( {2}"version": ")([^"]*)(")/m,
  // [package] の節の version。
  'apps/desktop/src-tauri/Cargo.toml': /^(\[package\]\n(?:(?!\[)[^\n]*\n)*?version = ")([^"]*)(")/m,
  // 自分の crate（hangar-desktop）の項。
  'apps/desktop/src-tauri/Cargo.lock': /^(\[\[package\]\]\nname = "hangar-desktop"\nversion = ")([^"]*)(")/m,
  // workspace の apps/desktop の項。
  'package-lock.json': /^( {4}"apps\/desktop": \{\n {6}"name": "@agent-hangar\/desktop",\n {6}"version": ")([^"]*)(")/m,
};

function locator(file: string): RegExp {
  const re = (LOCATORS as Record<string, RegExp>)[file];
  if (!re) throw new Error(`unknown version file ${file}`);
  return re;
}

/** ファイルの中身から版を読む。見つからなければ undefined。 */
export function versionIn(file: string, text: string): string | undefined {
  return locator(file).exec(text)?.[2];
}

/** ファイルの中身の版の 1 か所だけを書き換える。 */
export function setVersionIn(file: string, text: string, version: string): string {
  const re = locator(file);
  if (!re.test(text)) throw new Error(`no version found in ${file}`);
  return text.replace(re, (_all, head: string, _old: string, tail: string) => `${head}${version}${tail}`);
}

/** リポジトリの根から、版の在りかの各ファイルの版を読む。 */
export function readVersions(root: string): Record<string, string | undefined> {
  return Object.fromEntries(VERSION_FILES.map((f) => {
    const p = path.join(root, f);
    return [f, fs.existsSync(p) ? versionIn(f, fs.readFileSync(p, 'utf8')) : undefined];
  }));
}

const repoRoot = () => path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

function main(argv: string[]): number {
  const [cmd, ...rest] = argv;
  if (cmd === 'plan' && rest[0]) {
    const plan = planRelease(rest[0], readVersions(rest[1] ?? repoRoot()));
    process.stdout.write(`version=${plan.version}\nprerelease=${plan.prerelease}\ntauri-config=${plan.tauriConfig}\nchannel-tag=${PRERELEASE_CHANNEL_TAG}\n`);
    return 0;
  }
  if (cmd === 'channel' && rest[0] && rest[1]) {
    const existing = fs.existsSync(rest[0]) ? String(JSON.parse(fs.readFileSync(rest[0], 'utf8')).version) : null;
    process.stdout.write(`${shouldUpdateChannel(existing, assertReleaseVersion(rest[1]))}\n`);
    return 0;
  }
  if (cmd === 'set-version' && rest[0]) {
    const version = assertReleaseVersion(rest[0]);
    const root = rest[1] ?? repoRoot();
    // 先に全部を読んで書き換えを作り、1 つでも当たらなければ何も書かない。
    const next = VERSION_FILES.map((f) => [f, setVersionIn(f, fs.readFileSync(path.join(root, f), 'utf8'), version)] as const);
    for (const [f, text] of next) fs.writeFileSync(path.join(root, f), text);
    process.stdout.write(`${VERSION_FILES.join('\n')}\n-> ${version}\n`);
    return 0;
  }
  console.error('usage: release-plan.ts plan <tag> [root] | channel <latest.json> <version> | set-version <version> [root]');
  return 2;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e));
    process.exitCode = 1;
  }
}
