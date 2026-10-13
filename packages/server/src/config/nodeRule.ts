// Node を採るかどうかの規則。値はここで 1 度だけ決める。
// 同梱のネイティブモジュール（better-sqlite3、node-pty）は Node-API で作られていて、Node の ABI（NODE_MODULE_VERSION）には縛られない。
// better-sqlite3 は Node-API 10 の関数を使う（NAPI_VERSION=10）ので、要るのは Node-API 10 以上の Node である。上限は付けない。
// 束を作るとき（apps/desktop/scripts/bundle-server.ts）は、この値を manifest.json の nodeApi と nodeMin に書く。
// 殻（apps/desktop/src-tauri/src/node.rs）と hangar.sh は manifest.json を読み、ここと同じ規則で比べる。
// launch-cli.ts（Windows の hangar コマンド）と設定の確かめ（node.ts）は、この関数をそのまま使う。
// 規則が各所で同じであることは、見本の表（node-rule-cases.json）を各所の試験が読んで縛る。

/** 同梱のネイティブモジュールが要る Node-API の版。 */
export const NODE_API_MIN = 10;

/** NODE_API_MIN を持つ最初の Node の版（22.14.0。23 の系列では 23.6.0）。画面と案内に出す。 */
export const NODE_MIN_LABEL = '22.14';

/** 候補の Node の答え。version は v を除いた版（22.14.0）、napi は process.versions.napi（無ければ 0）。 */
export type NodeBuild = { version: string; napi: number; arch: string };

/** 同梱のサーバが要る Node。napi は要る Node-API の版、min はそれを持つ最初の Node の版（案内に出すだけで、比べるのには使わない）。 */
export type NodeNeed = { napi: number; min: string; arch: string };

/** 合うか。合わなければ、Node-API が足りない（version）か、アーキテクチャが違う（arch）か。両方なら version と言う。 */
export type NodeFit = 'ok' | 'version' | 'arch';

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

/** 候補の Node が要るものに合うか。 */
export function nodeFit(found: NodeBuild, need: NodeNeed): NodeFit {
  if (found.napi < need.napi) return 'version';
  if (found.arch !== need.arch) return 'arch';
  return 'ok';
}

/** 案内で入れる Node のメジャー版（brew install node@22、nvm install 22）。min の先頭の数である。 */
export function nodeLtsMajor(min: string): number {
  return Number(min.split('.')[0]);
}
