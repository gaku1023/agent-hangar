// release の段取りを決める。release.yml の plan、publish、channel の各ジョブと、版を上げる手順（docs/release.md）が動かす。
// 使い方:
//   node --experimental-strip-types scripts/release-plan.ts plan <タグ> [リポジトリの根]
//     タグと版の在りかのファイルを照らし、GitHub の出力の形（key=value）で計画を書く。食い違えば止まる。
//     環境変数 GITHUB_REPOSITORY、HAS_MACOS_SIGN、HAS_UPDATER_KEY を見て、本家で署名の secret が無ければ止まる。
//   node --experimental-strip-types scripts/release-plan.ts gate <コミット> <main の祖先か true|false> <ci.yml の runs の JSON>
//     タグのコミットが main にあり、その ci が成功していなければ止まる。
//   node --experimental-strip-types scripts/release-plan.ts assets <タグ> <更新物を作ったか true|false> <資産の名前の一覧>
//     Release を公開する前に、資産がそろっていなければ止まる。
//   node --experimental-strip-types scripts/release-plan.ts channel <今の試しの道の latest.json> <版>
//     試しの道の目録を、この版で置き換えるかを true か false で書く。latest.json のファイルが無ければ、目録が無いとみなす。
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

/** 本家のリポジトリ。ここで走る release は、署名の secret が無ければ止める（fork は警告で続ける）。 */
export const UPSTREAM_REPO = 'gaku1023/agent-hangar';

export type SigningSecrets = { macosSign: boolean; updaterKey: boolean };

const SECRET_NAMES: Record<keyof SigningSecrets, string> = {
  macosSign: 'HANGAR_SIGN_P12_BASE64 (macOS code signing certificate)',
  updaterKey: 'TAURI_SIGNING_PRIVATE_KEY (updater signing key)',
};

/**
 * 署名の secret の有無を見る。
 * 本家では、正式な版でも試しの版でも、1 つでも無ければ止める。
 * 無いまま進むと、証明書の署名の無い .app（入れ替えのたびに許可が外れる）か、目録の無い Release を配ることになる。
 * 試しの版は正式な版の通し稽古で、試す人の許可も同じ証明書で保たれなければならないので、試しの版も止める。
 * fork には secret が無いのがふつうなので、無いものごとに警告の文を返して続ける。
 */
export function checkSigningSecrets(repo: string, has: SigningSecrets): { required: boolean; warnings: string[] } {
  const missing = (Object.keys(SECRET_NAMES) as (keyof SigningSecrets)[]).filter((k) => !has[k]).map((k) => SECRET_NAMES[k]);
  const required = repo.toLowerCase() === UPSTREAM_REPO.toLowerCase();
  if (required && missing.length > 0) {
    throw new Error(`${repo} is the upstream repository; refusing to release without signing secrets:\n${missing.map((m) => `  ${m}`).join('\n')}\nsee docs/signing.md`);
  }
  return { required, warnings: missing.map((m) => `${m} is not set; this fork builds without it`) };
}

/** ci.yml の run（GET /repos/{owner}/{repo}/actions/workflows/ci.yml/runs の workflow_runs の 1 つ）のうち、見る欄。 */
export type CiRun = {
  run_number: number;
  run_attempt?: number;
  status: string;
  conclusion: string | null;
  head_sha: string;
  event: string;
  head_branch: string | null;
};

/**
 * タグのコミットの関門。main の祖先で、そのコミットへの main の push で走った ci.yml の、いちばん新しい run が成功していること。
 * PR の ci（pull_request）は、PR の先頭のコミットではなく main と併せたものを試すので数えない。
 * release の windows ジョブは npm test を回さず、ci が同じコミットで回したことに頼るので、ここで確かめる。
 */
export function checkCommitGate(a: { sha: string; onMain: boolean; runs: CiRun[] }): void {
  if (!a.onMain) {
    throw new Error(`commit ${a.sha} is not on main (not an ancestor of origin/main); merge it to main and tag the merged commit`);
  }
  const mine = a.runs
    .filter((r) => r.head_sha === a.sha && r.event === 'push' && r.head_branch === 'main')
    .sort((x, y) => (y.run_number - x.run_number) || ((y.run_attempt ?? 1) - (x.run_attempt ?? 1)));
  const latest = mine[0];
  if (!latest) throw new Error(`no ci run on main for ${a.sha}; tag a commit whose ci.yml ran on main`);
  if (latest.status !== 'completed') {
    throw new Error(`ci.yml for ${a.sha} is still ${latest.status}; wait for it to pass, then re-run this release`);
  }
  if (latest.conclusion !== 'success') {
    throw new Error(`ci.yml for ${a.sha} concluded ${latest.conclusion ?? 'without a result'}; fix main before releasing`);
  }
}

/** Release の資産の OS と arch。release.yml の macos と windows の matrix（arch）と同じものを挙げる。 */
export const RELEASE_PLATFORMS = [
  { os: 'macos', arch: 'arm64' },
  { os: 'windows', arch: 'x64' },
] as const;

/** 公開の前にそろっているべき資産の名前。updater は、更新の署名鍵があって更新物と目録も作ったか。 */
export function expectedAssets(tag: string, updater: boolean): string[] {
  const base: string[] = [];
  const upd: string[] = [];
  for (const p of RELEASE_PLATFORMS) {
    const name = `Hangar-${tag}-${p.os}-${p.arch}`;
    if (p.os === 'macos') {
      base.push(`${name}.dmg`, `${name}.dmg.sha256`, `${name}.zip`, `${name}.zip.sha256`);
      upd.push(`${name}.app.tar.gz`, `${name}.app.tar.gz.sig`);
    } else {
      base.push(`${name}-setup.exe`, `${name}-setup.exe.sha256`);
      upd.push(`${name}-setup.exe.sig`);
    }
  }
  return updater ? [...base, ...upd, 'latest.json'] : base;
}

/** そろっていない資産の名前（expectedAssets の順）。 */
export function missingAssets(tag: string, names: readonly string[], updater: boolean): string[] {
  const have = new Set(names);
  return expectedAssets(tag, updater).filter((n) => !have.has(n));
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
    // secret の有無は release.yml の env（HAS_MACOS_SIGN、HAS_UPDATER_KEY）から受ける。値そのものは受けない。
    const signing = checkSigningSecrets(process.env.GITHUB_REPOSITORY ?? '', {
      macosSign: process.env.HAS_MACOS_SIGN === 'true',
      updaterKey: process.env.HAS_UPDATER_KEY === 'true',
    });
    // 標準出力は GITHUB_OUTPUT へ流れるので、警告は標準エラーに出す（GitHub はどちらの workflow command も読む）。
    for (const w of signing.warnings) console.error(`::warning title=unsigned::${w}`);
    process.stdout.write(`version=${plan.version}\nprerelease=${plan.prerelease}\ntauri-config=${plan.tauriConfig}\nchannel-tag=${PRERELEASE_CHANNEL_TAG}\nsigning-required=${signing.required}\n`);
    return 0;
  }
  if (cmd === 'gate' && rest[0] && rest[1] !== undefined && rest[2]) {
    if (rest[1] !== 'true' && rest[1] !== 'false') throw new Error(`gate: on-main must be true or false, got ${JSON.stringify(rest[1])}`);
    const body = JSON.parse(fs.readFileSync(rest[2], 'utf8')) as { workflow_runs?: CiRun[] };
    if (!Array.isArray(body.workflow_runs)) throw new Error(`gate: ${rest[2]} has no workflow_runs`);
    checkCommitGate({ sha: rest[0], onMain: rest[1] === 'true', runs: body.workflow_runs });
    process.stdout.write(`${rest[0]} is on main and its ci passed\n`);
    return 0;
  }
  if (cmd === 'assets' && rest[0] && rest[1] && rest[2]) {
    if (rest[1] !== 'true' && rest[1] !== 'false') throw new Error(`assets: updater must be true or false, got ${JSON.stringify(rest[1])}`);
    const names = fs.readFileSync(rest[2], 'utf8').split('\n').map((s) => s.trim()).filter(Boolean);
    const missing = missingAssets(rest[0], names, rest[1] === 'true');
    if (missing.length > 0) throw new Error(`release ${rest[0]} is missing:\n${missing.map((m) => `  ${m}`).join('\n')}`);
    process.stdout.write(`release ${rest[0]} has all ${expectedAssets(rest[0], rest[1] === 'true').length} assets\n`);
    return 0;
  }
  if (cmd === 'channel' && rest[0] && rest[1]) {
    // 目録が無いことは呼び手（release.yml）が Release の資産の一覧で決め、無ければファイルを置かない。
    // ファイルがあるのに読めなければ、「無い」と取り違えずに止める（古い版で置き換えない）。
    let existing: string | null = null;
    if (fs.existsSync(rest[0])) {
      const v = (JSON.parse(fs.readFileSync(rest[0], 'utf8')) as { version?: unknown }).version;
      if (typeof v !== 'string') throw new Error(`${rest[0]} has no version`);
      existing = assertReleaseVersion(v);
    }
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
  console.error('usage: release-plan.ts plan <tag> [root] | gate <sha> <on-main> <runs.json> | assets <tag> <updater> <names.txt> | channel <latest.json> <version> | set-version <version> [root]');
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
