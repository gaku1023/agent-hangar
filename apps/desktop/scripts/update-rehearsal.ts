// CI で本当の更新の経路を 1 回通すための準備（更新の通し稽古）。ci-update-windows.ps1 と ci-update-macos.sh が呼ぶ。
// 版 A の殻を入れて起こし、版 B へ updater で更新して、起き直した殻が版 B を名乗ることを見る。
// 鍵は CI の中で `tauri signer generate` で作る使い捨ての鍵で、目録（latest.json）と更新物はローカルの HTTP で配る。
// 本物の secret も、GitHub の Release も使わない。ここで作る設定は、この稽古の build にだけ重ねる。
// 使い方:
//   node --experimental-strip-types scripts/update-rehearsal.ts next-version <版>
//     版 B の版を書く（patch を 1 つ上げ、プレリリースを外す）。
//   node --experimental-strip-types scripts/update-rehearsal.ts config <公開鍵のファイル> <番号> <出力>
//     build に重ねる Tauri の設定を書く（使い捨ての公開鍵、ローカルの目録、更新物づくり）。
//   node --experimental-strip-types scripts/update-rehearsal.ts stage <置き場> <版> <platform> <更新物> <番号>
//     更新物を置き場へ写し、隣の .sig の中身で目録を書く。
//   node --experimental-strip-types scripts/update-rehearsal.ts serve <置き場> <番号>
//     置き場のファイルを 127.0.0.1 で配る。受けた要求を 1 行ずつ書く。番号 0 なら空いている番号を使う。
//   node --experimental-strip-types scripts/update-rehearsal.ts inject <UI の置き場>
//     入れた版 A の UI に、確認、取得、インストールを順に殻へ頼む台本を差し込む。
// Node が型を剥がすだけで動く書き方（import は node: と同じ置き場の .ts だけ）にしておく。
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertReleaseVersion } from './release-plan.ts';

/** 差し込む台本の名前。UI の assets に置く。 */
export const REHEARSAL_SCRIPT = 'ci-update-rehearsal.js';

/** 版 B の版。版 A より必ず新しい（patch を 1 つ上げ、プレリリースを外す）。 */
export function nextVersion(version: string): string {
  assertReleaseVersion(version);
  const [major, minor, patch] = version.split(/[-+]/)[0]!.split('.').map(Number);
  return `${major}.${minor}.${patch! + 1}`;
}

export type RehearsalConfig = {
  bundle: { createUpdaterArtifacts: true };
  plugins: { updater: { pubkey: string; endpoints: string[]; dangerousInsecureTransportProtocol: true } };
};

/**
 * 稽古の build に重ねる Tauri の設定。
 * 目録はローカルの http なので、updater に http を許させる（dangerousInsecureTransportProtocol）。ふだんの設定には書かない。
 */
export function rehearsalConfig(pubkey: string, port: number): RehearsalConfig {
  return {
    bundle: { createUpdaterArtifacts: true },
    plugins: { updater: { pubkey: pubkey.trim(), endpoints: [`http://127.0.0.1:${port}/latest.json`], dangerousInsecureTransportProtocol: true } },
  };
}

export type LocalManifest = { version: string; notes: string; pub_date: string; platforms: Record<string, { url: string; signature: string }> };

/** 更新物を置き場へ写し、隣の .sig の中身で目録（latest.json）を書く。書いた目録を返す。 */
export function stageUpdate(a: { serveDir: string; version: string; platform: string; artifact: string; port: number; now?: Date }): LocalManifest {
  const sig = `${a.artifact}.sig`;
  if (!fs.existsSync(sig)) throw new Error(`${sig} is missing: build with TAURI_SIGNING_PRIVATE_KEY and createUpdaterArtifacts`);
  const name = path.basename(a.artifact);
  fs.mkdirSync(a.serveDir, { recursive: true });
  fs.copyFileSync(a.artifact, path.join(a.serveDir, name));
  const manifest: LocalManifest = {
    version: assertReleaseVersion(a.version),
    notes: '',
    pub_date: (a.now ?? new Date()).toISOString(),
    platforms: { [a.platform]: { url: `http://127.0.0.1:${a.port}/${encodeURIComponent(name)}`, signature: fs.readFileSync(sig, 'utf8').trim() } },
  };
  fs.writeFileSync(path.join(a.serveDir, 'latest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}

/**
 * 頁に差し込む台本。頁の Runtime と同じ口（__TAURI_INTERNALS__.invoke）で、殻の更新の命令を順に呼ぶ。
 * 失敗は殻が desktop.log に 1 行残す（lib.rs の update_failed）ので、ここでは console に出すだけにする。
 * 頁が読み込み直されても 2 度は走らない（sessionStorage の印）。
 */
const PAGE_SCRIPT = `// CI の更新の通し稽古（apps/desktop/scripts/update-rehearsal.ts）が、入れた版 A の UI にだけ差し込む。配る版には入らない。
(() => {
  const t = window.__TAURI_INTERNALS__;
  if (!t || typeof t.invoke !== 'function') return;
  try {
    if (sessionStorage.getItem('hangar-ci-update-rehearsal')) return;
    sessionStorage.setItem('hangar-ci-update-rehearsal', '1');
  } catch {}
  const invoke = (cmd) => t.invoke(cmd);
  (async () => {
    const found = await invoke('update_check');
    if (!found || !found.version) return;
    await invoke('update_download');
    await invoke('update_install');
  })().catch((e) => console.error('ci update rehearsal', e));
})();
`;

/** 入れた版 A の UI の置き場に台本を置き、index.html の head の終わりで読み込ませる。2 度呼んでも 1 つだけにする。 */
export function injectRehearsal(uiDir: string): void {
  const index = path.join(uiDir, 'index.html');
  const html = fs.readFileSync(index, 'utf8');
  const tag = `<script src="/assets/${REHEARSAL_SCRIPT}"></script>`;
  fs.writeFileSync(path.join(uiDir, 'assets', REHEARSAL_SCRIPT), PAGE_SCRIPT);
  if (html.includes(tag)) return;
  if (!html.includes('</head>')) throw new Error(`${index} has no </head>`);
  fs.writeFileSync(index, html.replace('</head>', `${tag}</head>`));
}

/** 置き場の直下のファイルだけを配る。受けた要求を 1 行ずつ書く。 */
export function serve(dir: string, port: number, log: (line: string) => void): http.Server {
  const base = path.resolve(dir);
  const server = http.createServer((req, res) => {
    let name: string;
    try {
      name = decodeURIComponent(new URL(req.url ?? '/', 'http://127.0.0.1').pathname.slice(1));
    } catch {
      name = '';
    }
    const file = path.join(base, name);
    const ok = name !== '' && !name.includes('/') && !name.includes('\\') && path.dirname(file) === base && fs.existsSync(file) && fs.statSync(file).isFile();
    if (!ok) {
      res.writeHead(404).end();
      log(`${req.method} ${req.url} 404`);
      return;
    }
    const body = fs.readFileSync(file);
    res.writeHead(200, { 'Content-Type': name.endsWith('.json') ? 'application/json' : 'application/octet-stream', 'Content-Length': body.length }).end(body);
    log(`${req.method} ${req.url} 200 ${body.length}`);
  });
  server.listen(port, '127.0.0.1', () => {
    const a = server.address();
    log(`listening on http://127.0.0.1:${typeof a === 'object' && a ? a.port : port}`);
  });
  return server;
}

function main(argv: string[]): number {
  const [cmd, ...rest] = argv;
  const usage = () => {
    console.error('usage: update-rehearsal.ts next-version <version> | config <pubkey> <port> <out> | stage <dir> <version> <platform> <artifact> <port> | serve <dir> <port> | inject <ui dir>');
    return 2;
  };
  const port = (s: string | undefined) => {
    const n = Number(s);
    if (!Number.isInteger(n) || n < 0 || n > 65535) throw new Error(`bad port ${s}`);
    return n;
  };
  switch (cmd) {
    case 'next-version':
      if (rest.length !== 1) return usage();
      process.stdout.write(`${nextVersion(rest[0]!)}\n`);
      return 0;
    case 'config':
      if (rest.length !== 3) return usage();
      fs.writeFileSync(rest[2]!, `${JSON.stringify(rehearsalConfig(fs.readFileSync(rest[0]!, 'utf8'), port(rest[1])), null, 2)}\n`);
      return 0;
    case 'stage':
      if (rest.length !== 5) return usage();
      process.stdout.write(`${JSON.stringify(stageUpdate({ serveDir: rest[0]!, version: rest[1]!, platform: rest[2]!, artifact: rest[3]!, port: port(rest[4]) }), null, 2)}\n`);
      return 0;
    case 'inject':
      if (rest.length !== 1) return usage();
      injectRehearsal(rest[0]!);
      return 0;
    default:
      return usage();
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const argv = process.argv.slice(2);
  if (argv[0] === 'serve') {
    if (argv.length !== 3) process.exit(main([]));
    serve(argv[1]!, Number(argv[2]), (line) => console.log(line));
  } else {
    process.exit(main(argv));
  }
}
