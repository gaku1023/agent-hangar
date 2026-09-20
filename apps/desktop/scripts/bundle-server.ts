import { build } from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export type BundleOptions = { repoRoot: string; outDir: string; uiDist: string };

/**
 * バンドルに入れず、隣の node_modules から読ませるモジュール。
 * サーバと CLI の import から到達するネイティブはこの二つだけである（実測）。
 * どちらも prebuildify 形式で、実体は build/Release ではなく prebuilds の下にある。
 */
export const NATIVE_MODULES = ['better-sqlite3', 'node-pty'];

/** ws が任意依存として require する二つは、無くても動くので外部にしておく。 */
const EXTERNALS = [...NATIVE_MODULES, 'bufferutil', 'utf-8-validate'];

/**
 * 同梱する prebuild のアーキテクチャ。
 * 配布は Apple silicon 向けだけなので、他は入れない。
 * 全部入れると node-pty の win32 だけで 58MB、better-sqlite3 の 8 アーキで 16MB になる（実測）。
 */
export const PREBUILD_ARCH = 'darwin-arm64';

/**
 * ネイティブモジュールのうち、実行に要らない中身。
 * パッケージの root からの相対パスで見る。
 * 絶対パスで見ると、リポジトリの置き場に src などが混ざったときに全部を落としてしまう。
 */
const SKIP_IN_NATIVE = /^(deps|src|test|third_party|scripts|node_modules|binding\.gyp|build\/Release\/obj(\.target)?)(\/|$)/;

/**
 * packages/cloud のうち、同梱に要らない中身。
 * デプロイに要らないもの（試験、依存、wrangler の作業場）に加えて、秘密と記録も落とす。
 * .dev.vars と .env には Worker の秘密が入り、ログには実物のアカウントの様子が残る。
 * CI は clean な checkout から作るので公開の Release には入らないが、
 * 手元で bundle-server を回して .app を人に渡す道がある。
 */
const SKIP_IN_CLOUD = /^(test|node_modules|\.wrangler)(\/|$)|(^|\/)\.dev\.vars(\.|$)|(^|\/)\.env(rc)?(\.|$)|\.log$/;

/** UI の写しのうち、配布物に要らない中身。 */
const SKIP_IN_UI = /\.map$/;

/**
 * 同梱した cloud/ に置く目印の名前。
 * packages/cli/src/cloud.ts の requireCloudDir() がこの名前を見て、配布版からのデプロイを断る。
 * 片方だけ変えると断れなくなるので、名前は両方で揃える。
 * 揃っていることは apps/desktop/test/bundle-server.test.ts が、
 * packages/cli/src/cloud.ts の宣言を読んで突き合わせる。
 */
export const BUNDLED_CLOUD_MARKER = '.bundled';

const BANNER = "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);";

/** prebuilds の下で、同梱するアーキ以外を落とす。ファイル（better-sqlite3）でもディレクトリ（node-pty）でも効くようにする。 */
function keepPrebuild(rel: string): boolean {
  if (rel === 'prebuilds' || !rel.startsWith('prebuilds/')) return true;
  const name = rel.slice('prebuilds/'.length).split('/')[0]!;
  return name === PREBUILD_ARCH || name === `${PREBUILD_ARCH}.node`;
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
      const rel = path.relative(src, from);
      if (rel === '') return true;
      if (skip.test(rel)) return false;
      return extra ? extra(rel) : true;
    },
  });
  pruneEmptyDirs(dest);
}

/**
 * packages/cloud を同梱用に写す。
 * 何を落とすかを試験から確かめられるように、bundleServer と同じ道をここに切り出してある。
 */
export function copyCloudTree(src: string, dest: string): void {
  copyTree(src, dest, SKIP_IN_CLOUD);
}

export async function bundleServer(opts: BundleOptions): Promise<{ files: string[] }> {
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

  // sourcemap は配布物に入れない。
  // UI の写しの 68 パーセント（実測 2.19 MB）が index-*.js.map で、利用者の役には立たない。
  // 開発では packages/ui/dist をそのまま使うので、こちらの写しから落としても調査の手は減らない。
  copyTree(opts.uiDist, path.join(opts.outDir, 'ui'), SKIP_IN_UI);

  for (const m of NATIVE_MODULES) {
    const src = path.join(opts.repoRoot, 'node_modules', m);
    if (!fs.existsSync(src)) throw new Error(`ネイティブモジュールがありません: ${src}（先に npm install を実行してください）`);
    copyTree(src, path.join(opts.outDir, 'node_modules', m), SKIP_IN_NATIVE, keepPrebuild);
  }

  // Worker のソースを同梱する。
  // 単一ファイルにまとめると CLI から packages/cloud への相対が届かなくなるので、bin/hangar が
  // HANGAR_CLOUD_DIR でここを指す。
  copyCloudTree(path.join(opts.repoRoot, 'packages/cloud'), path.join(opts.outDir, 'cloud'));
  // 同梱した写しである目印を置く。
  // ここには wrangler も hono も入っていないのでデプロイはできないが、
  // .app をリポジトリの中や node_modules を持つディレクトリの下に置くと、親をたどって拾った
  // wrangler のせいで検査が素通りし、実物のアカウントに資源を作ってしまう。
  // 名前は packages/cli/src/cloud.ts の BUNDLED_CLOUD_MARKER と合わせる。
  fs.writeFileSync(path.join(opts.outDir, 'cloud', BUNDLED_CLOUD_MARKER), 'agent-hangar: 配布版に同梱した packages/cloud の写しです。ここからはデプロイできません。\n');

  fs.mkdirSync(path.join(opts.outDir, 'bin'));
  fs.copyFileSync(fileURLToPath(new URL('./hangar.sh', import.meta.url)), path.join(opts.outDir, 'bin', 'hangar'));
  fs.chmodSync(path.join(opts.outDir, 'bin', 'hangar'), 0o755);

  const pkg = JSON.parse(fs.readFileSync(path.join(opts.repoRoot, 'apps/desktop/package.json'), 'utf8')) as { version: string };
  const manifest = { version: pkg.version, nodeMajor: Number(process.versions.node.split('.')[0]), arch: process.arch, builtAt: new Date().toISOString() };
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
