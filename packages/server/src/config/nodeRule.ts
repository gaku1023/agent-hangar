// Node を採るかどうかの規則。値はここで 1 度だけ決める。
// 同梱のネイティブモジュール（better-sqlite3、node-pty）は Node-API で作られていて、Node の ABI（NODE_MODULE_VERSION）には縛られない。
// better-sqlite3 は Node-API 10 の関数を使う（NAPI_VERSION=10）ので、要るのは Node-API 10 以上の Node である。上限は付けない。
// 束を作るとき（apps/desktop/scripts/bundle-server.ts）は、この値を manifest.json の nodeApi と nodeMin に書く。
// 殻（apps/desktop/src-tauri/src/node.rs）と hangar.sh は manifest.json を読み、ここと同じ規則で比べる。
// launch-cli.ts（Windows の hangar コマンド）と設定の確かめ（node.ts）は、この関数をそのまま使う。
// 規則が各所で同じであることは、見本の表（node-rule-cases.json）を各所の試験が読んで縛る。
// Windows だけは、Node 24.0 から 24.15 を使わない（isUnstableNodeOnWindows）。nodejs/node#63620 の不具合で、サーバが黙って落ちるためである。

/** 同梱のネイティブモジュールが要る Node-API の版。 */
export const NODE_API_MIN = 10;

/** NODE_API_MIN を持つ最初の Node の版（22.14.0。23 の系列では 23.6.0）。画面と案内に出す。 */
export const NODE_MIN_LABEL = '22.14';

/** 候補の Node の答え。version は v を除いた版（22.14.0）、napi は process.versions.napi（無ければ 0）。 */
export type NodeBuild = { version: string; napi: number; arch: string };

/** 同梱のサーバが要る Node。napi は要る Node-API の版、min はそれを持つ最初の Node の版（案内に出すだけで、比べるのには使わない）。 */
export type NodeNeed = { napi: number; min: string; arch: string };

/**
 * 合うか。合わなければ、Node-API が足りない（version）か、アーキテクチャが違う（arch）か、Windows で使えない版（unstable）か。
 * 重なるときは version、arch、unstable の順に言う（入れ直すものを先に言うため）。
 */
export type NodeFit = 'ok' | 'version' | 'arch' | 'unstable';

/** Windows で使えない Node の、直った最初の版（24.16.0）。案内に出す。 */
export const NODE_UNSTABLE_FIXED_LABEL = '24.16';

/**
 * 候補に訊く式（node -p に渡す）。出力は「v<版> <アーキ> <Node-API の版>」の 1 行（例 v22.14.0 arm64 10）。
 * 殻と hangar.sh も同じ式を使う（node.rs の試験と bundle-server.test.ts が突き合わせる）。
 */
export const NODE_PROBE_EXPR = 'process.version+" "+process.arch+" "+(process.versions.napi||0)';

/**
 * 候補の出力から答えの行を読む。
 * 前置きや後書きの行（NODE_OPTIONS の警告、包みの script）が混ざっても拾えるよう、後ろの行から探す。
 * 行はちょうど 3 語でなければならない。アーキは process.arch の値の形（英小文字と数字）だけを採る。
 */
export function parseNodeProbe(out: string): NodeBuild | null {
  for (const line of out.split(/\r?\n/).reverse()) {
    const m = /^v(\d+\.\d+\.\d+) ([a-z0-9]+) (\d+)$/.exec(line.trim());
    if (m) return { version: m[1]!, arch: m[2]!, napi: Number(m[3]) };
  }
  return null;
}

/**
 * Windows で使えない Node か。24.0.0 から 24.15.x（major 24 かつ minor 15 以下）だけを、Windows のときだけ対象にする。
 * この範囲の Node（libuv 1.50 と 1.51）は、TCP で接続するときに uv__tcp_try_connect のスタックが壊れ、
 * /GS の stack cookie の検査で fast-fail（0xc0000409）が起きて、サーバが何も残さず落ちる（nodejs/node#63620）。
 * Node 24.16.0（libuv 1.52.1、nodejs/node#62561）で直った。macOS と Linux、22 系、25 系には影響がない。
 * 版は process.version から v を除いたもの（22.14.0）。読めなければ対象にしない。
 */
export function isUnstableNodeOnWindows(version: string, platform: NodeJS.Platform = process.platform): boolean {
  if (platform !== 'win32') return false;
  const m = /^(\d+)\.(\d+)\.\d+$/.exec(version);
  return m !== null && Number(m[1]) === 24 && Number(m[2]) <= 15;
}

/** 候補の Node が要るものに合うか。platform は試験が差し替える（既定はこの機械の OS）。 */
export function nodeFit(found: NodeBuild, need: NodeNeed, platform: NodeJS.Platform = process.platform): NodeFit {
  if (found.napi < need.napi) return 'version';
  if (found.arch !== need.arch) return 'arch';
  if (isUnstableNodeOnWindows(found.version, platform)) return 'unstable';
  return 'ok';
}

/** 案内で入れる Node のメジャー版（brew install node@22、nvm install 22）。min の先頭の数である。 */
export function nodeLtsMajor(min: string): number {
  return Number(min.split('.')[0]);
}
