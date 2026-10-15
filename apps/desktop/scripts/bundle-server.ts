import { build } from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { bundleWorker, WORKER_METADATA, WORKER_MODULE, workerMetadata } from '../../../packages/cloud/scripts/build-worker.ts';
import { NODE_API_MIN, NODE_MIN_LABEL } from '../../../packages/server/src/config/nodeRule.ts';
import { SETUP_GUIDE_FILES } from '../../../packages/server/src/setupGuide/guide.ts';

/**
 * 配布物を作る相手。`<process.platform>-<process.arch>` の形で、prebuild の置き場の名前と同じである。
 * Apple silicon の macOS と x64 の Windows 11 だけを作る。
 */
export const BUNDLE_TARGETS = ['darwin-arm64', 'win32-x64'] as const;
export type BundleTarget = (typeof BUNDLE_TARGETS)[number];

/** この機械で動くアプリの target。配布の対象でなければ undefined。 */
export function hostBundleTarget(platform: string = process.platform, arch: string = process.arch): BundleTarget | undefined {
  return BUNDLE_TARGETS.find((t) => t === `${platform}-${arch}`);
}

/**
 * 束を作る Node のメジャー版。build している Node のメジャー版が違えば止める。
 * 束が要る Node は、これではなく規則の値（packages/server/src/config/nodeRule.ts の NODE_API_MIN と NODE_MIN_LABEL）で、`manifest.json` の `nodeApi` と `nodeMin` に書く。
 * 殻（node.rs）、`bin/hangar`、`launch-cli.mjs` は、Node-API が `nodeApi` 以上でアーキが同じ Node を使う。
 * 同梱のネイティブモジュール（better-sqlite3、node-pty）は Node-API の prebuild なので作る Node の版に縛られないが、CI と配布の build の道筋を 1 つに固めておく。
 * 版を上げるときは、ここと CI の setup-node を一緒に上げる。
 */
export const BUNDLE_NODE_MAJOR = 22;

/**
 * Windows の `bin\hangar.cmd` が `launch-cli.mjs` を動かしてよい最も古い Node のメジャー版。
 * `launch-cli.mjs` はこの版を target に作る。cmd はこれより古い Node を飛ばし、次の候補へ進む（PATH の先頭の古い Node で構文の誤りで落ちないように）。
 * `launch-cli.mjs` は Node-API の版とアーキテクチャを確かめて、合う Node へ渡し直すだけなので、古い版でも読めればよい。
 */
export const LAUNCHER_MIN_NODE = 16;

export type BundleOptions = {
  repoRoot: string;
  outDir: string;
  uiDist: string;
  /** 省略すると、この機械の target。別の target の束も、どの機械でも作れる（prebuild は npm の包みに全部入っている）。 */
  target?: BundleTarget;
  /** build している Node のメジャー版。省略すると、いま動いている Node。試験が差し替える。 */
  buildNodeMajor?: number;
};

/**
 * バンドルに入れず、隣の node_modules から読ませるモジュール。
 * サーバの import から到達するネイティブはこの二つだけである（実測）。
 * CLI（cli.mjs）が使うのは better-sqlite3 だけで、node-pty はサーバだけが使う。
 * どちらも prebuildify 形式で、実体は build/Release ではなく prebuilds の下にある。
 */
export const NATIVE_MODULES = ['better-sqlite3', 'node-pty'];

/** ws が任意依存として require する二つは、無くても動くので外部にしておく。 */
const EXTERNALS = [...NATIVE_MODULES, 'bufferutil', 'utf-8-validate'];

/**
 * 同梱する prebuild は target のものだけにする。他は入れない。
 * 全部入れると node-pty の win32 だけで 58MB、better-sqlite3 の 8 アーキで 16MB になる（実測）。
 * Windows の node-pty は、そこからさらにデバッグの記号（.pdb、22MB）を落とす。
 */
const SKIP_DEBUG_SYMBOLS = /\.pdb$/;

/**
 * ネイティブモジュールのうち、実行に要らない中身。
 * パッケージの root からの相対パスで見る。
 * 絶対パスで見ると、リポジトリの置き場に src などが混ざったときに全部を落としてしまう。
 */
const SKIP_IN_NATIVE = /^(deps|src|test|third_party|scripts|node_modules|binding\.gyp|build\/Release\/obj(\.target)?)(\/|$)/;

/** UI の写しのうち、配布物に要らない中身。 */
const SKIP_IN_UI = /\.map$/;

const BANNER = "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);";

/** prebuilds の下で、同梱するアーキ以外を落とす。ファイル（better-sqlite3）でもディレクトリ（node-pty）でも効くようにする。 */
function keepPrebuild(target: BundleTarget): (rel: string) => boolean {
  return (rel) => {
    if (SKIP_DEBUG_SYMBOLS.test(rel)) return false;
    if (rel === 'prebuilds' || !rel.startsWith('prebuilds/')) return true;
    const name = rel.slice('prebuilds/'.length).split('/')[0]!;
    return name === target || name === `${target}.node`;
  };
}

/**
 * Windows の bin\hangar.cmd が呼ぶ入口（launch-cli.ts）を、依存の無い 1 ファイルにまとめて置く。
 * hangar.sh にあたる Node の探索を、cmd では書けないので node で行う。
 */
export async function buildLauncher(outfile: string): Promise<void> {
  await build({
    entryPoints: [fileURLToPath(new URL('./launch-cli-main.ts', import.meta.url))],
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: `node${LAUNCHER_MIN_NODE}`,
    outfile,
    logLevel: 'silent',
  });
}

/** 中身だけを消す。ディレクトリ自体は tauri-build が resources の実在を見るので残す。 */
function emptyDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
  for (const name of fs.readdirSync(dir)) fs.rmSync(path.join(dir, name), { recursive: true, force: true });
}

/**
 * 写し取りの跡に残った空のディレクトリを消す。
 * 中身だけを落として入れ物を残すと、手元に何の並びがあったかは配布物から読めてしまう。
 * 下から順に見るので、中が空になった親も続けて消える。
 */
function pruneEmptyDirs(dir: string): void {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!e.isDirectory()) continue;
    const p = path.join(dir, e.name);
    pruneEmptyDirs(p);
    if (fs.readdirSync(p).length === 0) fs.rmdirSync(p);
  }
}

/** src からの相対パスで判定する写し取り。 */
function copyTree(src: string, dest: string, skip: RegExp, extra?: (rel: string) => boolean): void {
  fs.cpSync(src, dest, {
    recursive: true,
    dereference: true,
    filter: (from) => {
      // 下の正規表現と prebuilds の判定は / を前提に書いてある。Windows の \ のままでは絞り込みが外れ、.env まで写してしまう。
      const rel = path.relative(src, from).split(path.sep).join('/');
      if (rel === '') return true;
      if (skip.test(rel)) return false;
      return extra ? extra(rel) : true;
    },
  });
  pruneEmptyDirs(dest);
}

export async function bundleServer(opts: BundleOptions): Promise<{ files: string[] }> {
  // 何かを消したり書いたりする前に確かめる。
  const buildNodeMajor = opts.buildNodeMajor ?? Number(process.versions.node.split('.')[0]);
  if (buildNodeMajor !== BUNDLE_NODE_MAJOR) {
    throw new Error(`配布物は Node ${BUNDLE_NODE_MAJOR} で作ります。いまの Node は ${buildNodeMajor} です。Node ${BUNDLE_NODE_MAJOR} に切り替えて、npm ci からやり直してください。`);
  }
  const target = opts.target ?? hostBundleTarget();
  if (!target) {
    throw new Error(`この機械（${process.platform}-${process.arch}）向けの配布物は作りません。作れるのは ${BUNDLE_TARGETS.join('、')} です。`);
  }
  if (!fs.existsSync(path.join(opts.uiDist, 'index.html'))) {
    throw new Error(`UI のビルドがありません: ${opts.uiDist}（先に npm run build を実行してください）`);
  }
  emptyDir(opts.outDir);
  // .gitkeep は消した直後に置き直す。
  // git が追跡しているファイルなので、この先の失敗で消えたまま残すと、
  // 作業ツリーに deleted が出て、tauri-build の resources の検査も通らなくなる。
  fs.writeFileSync(path.join(opts.outDir, '.gitkeep'), '');

  const entries = [
    ['packages/server/src/main.ts', 'server.mjs'],
    ['packages/cli/src/index.ts', 'cli.mjs'],
  ] as const;
  for (const [entry, out] of entries) {
    await build({
      entryPoints: [path.join(opts.repoRoot, entry)],
      bundle: true,
      platform: 'node',
      format: 'esm',
      target: 'node22',
      outfile: path.join(opts.outDir, out),
      external: EXTERNALS,
      banner: { js: BANNER },
      logLevel: 'silent',
    });
  }

  // Windows で claude を包むスクリプト。束には入らない単独のファイルで、server.mjs が隣から読む（launch/wrapper.ts）。
  fs.copyFileSync(path.join(opts.repoRoot, 'packages/server/src/launch/hangar-run.mjs'), path.join(opts.outDir, 'hangar-run.mjs'));

  // セットアップのすゝめの md。束には入らない単独のファイルで、server.mjs が隣の docs/ から読み、起動のたびに置き場へ写す（setupGuide/guide.ts）。
  // 束と同じく build のときの中身が入るので、版とハッシュは配布物ごとに決まる。
  fs.mkdirSync(path.join(opts.outDir, 'docs'));
  for (const name of SETUP_GUIDE_FILES) fs.copyFileSync(path.join(opts.repoRoot, 'docs', name), path.join(opts.outDir, 'docs', name));

  // sourcemap は配布物に入れない。
  // UI の写しの 68 パーセント（実測 2.19 MB）が index-*.js.map で、利用者の役には立たない。
  // 開発では packages/ui/dist をそのまま使うので、こちらの写しから落としても調査の手は減らない。
  copyTree(opts.uiDist, path.join(opts.outDir, 'ui'), SKIP_IN_UI);

  for (const m of NATIVE_MODULES) {
    const src = path.join(opts.repoRoot, 'node_modules', m);
    if (!fs.existsSync(src)) throw new Error(`ネイティブモジュールがありません: ${src}（先に npm install を実行してください）`);
    copyTree(src, path.join(opts.outDir, 'node_modules', m), SKIP_IN_NATIVE, keepPrebuild(target));
  }

  // Worker を 1 本に束ねたものと、その束縛の定義を同梱する。
  // 源の写しは置かない。wrangler も hono も同梱しないので源からはデプロイできず、手元の秘密を運ぶ道になるだけだった。
  // 段 5 で、利用者の API トークンと Cloudflare の REST でこの束を上げる。いまは置くだけで、誰も読まない。
  const cloudSrc = path.join(opts.repoRoot, 'packages/cloud');
  fs.mkdirSync(path.join(opts.outDir, 'cloud'));
  fs.writeFileSync(path.join(opts.outDir, 'cloud', WORKER_MODULE), await bundleWorker(cloudSrc));
  fs.writeFileSync(path.join(opts.outDir, 'cloud', WORKER_METADATA), JSON.stringify(workerMetadata(cloudSrc), null, 2) + '\n');

  fs.mkdirSync(path.join(opts.outDir, 'bin'));
  if (target.startsWith('win32-')) {
    // cmd は LF だけの行だと label の読みを誤ることがあるので、CRLF にして置く。repo では .gitattributes で LF にそろえてある。
    const cmd = fs.readFileSync(fileURLToPath(new URL('./hangar.cmd', import.meta.url)), 'utf8').replace(/\r?\n/g, '\r\n');
    fs.writeFileSync(path.join(opts.outDir, 'bin', 'hangar.cmd'), cmd);
    // Git Bash は拡張子の無い sh の起動を探すので、hangar.cmd の隣に置く。LF のまま（CRLF だと shebang が読めない）。
    fs.copyFileSync(fileURLToPath(new URL('./hangar-gitbash.sh', import.meta.url)), path.join(opts.outDir, 'bin', 'hangar'));
    await buildLauncher(path.join(opts.outDir, 'launch-cli.mjs'));
  } else {
    fs.copyFileSync(fileURLToPath(new URL('./hangar.sh', import.meta.url)), path.join(opts.outDir, 'bin', 'hangar'));
    fs.chmodSync(path.join(opts.outDir, 'bin', 'hangar'), 0o755);
  }

  const pkg = JSON.parse(fs.readFileSync(path.join(opts.repoRoot, 'apps/desktop/package.json'), 'utf8')) as { version: string };
  // manifest の arch は、束の相手のもの。別の target の束を作るときに、作る機械のものを書かないためである。
  // nodeApi は要る Node-API の版、nodeMin はそれを持つ最初の Node の版（案内に出すだけ）。値は nodeRule.ts の 1 か所で決める。
  const manifest = { version: pkg.version, nodeApi: NODE_API_MIN, nodeMin: NODE_MIN_LABEL, arch: target.split('-')[1]!, builtAt: new Date().toISOString() };
  fs.writeFileSync(path.join(opts.outDir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  // git が server-dist を追跡し続けられるように置き直す。
  // ディレクトリごと消すと tauri-build の resources の検査が通らなくなる。
  fs.writeFileSync(path.join(opts.outDir, '.gitkeep'), '');

  return { files: fs.readdirSync(opts.outDir) };
}

// `node --import tsx scripts/bundle-server.ts` として直接呼ばれたときだけ実行する。
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const repoRoot = path.resolve(here, '../../..');
  bundleServer({ repoRoot, outDir: path.resolve(here, '../server-dist'), uiDist: path.join(repoRoot, 'packages/ui/dist') })
    .then((r) => console.log(`server-dist: ${r.files.join(', ')}`))
    .catch((e: unknown) => {
      console.error(e instanceof Error ? e.message : String(e));
      process.exit(1);
    });
}
