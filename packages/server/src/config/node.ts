import { execFile } from 'node:child_process';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { NodeBuildDto } from '@agent-hangar/shared';

// 設定の「Node のパス」の確かめ。
// 殻（apps/desktop/src-tauri/src/node.rs）は、nodePath を絶対パスとして読み、manifest.json と同じメジャー版とアーキテクチャの Node だけを使う。
// 同梱の CLI（hangar.sh、launch-cli.ts）も同じ条件で選ぶ。
// 設定の保存と準備の確かめも同じ条件で見て、画面では ✓ なのに次の起動で使われない Node を作らない。

export type NodeBuild = NodeBuildDto;

/** 要る Node と、候補の Node の答えを返す口。試験が差し替える。 */
export type NodeCheck = {
  /** 同梱のサーバが要る Node。 */
  need(): NodeBuild;
  /** 候補を起こして版とアーキを訊く。Node として答えなければ null。 */
  probe(file: string): Promise<NodeBuild | null>;
};

/** 候補 1 つを調べてよい時間。殻の PROBE_TIMEOUT と同じ。 */
const PROBE_TIMEOUT_MS = 5000;

/** 候補に訊く式。出力は「メジャー版 アーキ」の 1 行で、hangar.sh と launch-cli.ts と同じ。 */
const PROBE_EXPR = 'process.versions.node.split(".")[0] + " " + process.arch';

/**
 * 候補の出力から「メジャー版 アーキ」の行を読む。
 * 前置きや後書きの行（NODE_OPTIONS の警告など）が混ざっても拾えるよう、後ろの行から探す（殻の parse_probe と同じ）。
 */
export function parseNodeProbe(out: string): NodeBuild | null {
  for (const line of out.split(/\r?\n/).reverse()) {
    const m = /^(\d+) ([a-z0-9]+)$/.exec(line.trim());
    if (m) return { major: Number(m[1]), arch: m[2]! };
  }
  return null;
}

/** manifest.json の nodeMajor と arch を読む。無い、壊れている、形が違うときは null。 */
export function readNodeNeed(manifestFile: string): NodeBuild | null {
  try {
    const m = JSON.parse(fs.readFileSync(manifestFile, 'utf8')) as { nodeMajor?: unknown; arch?: unknown };
    return typeof m.nodeMajor === 'number' && typeof m.arch === 'string' ? { major: m.nodeMajor, arch: m.arch } : null;
  } catch {
    return null;
  }
}

/**
 * 同梱の manifest.json の場所。
 * 配布版では server.mjs が 1 ファイルにまとまっていて、manifest.json はその隣にある。
 * ソースから動かしているときは、この場所に manifest.json は無い。
 */
function bundledManifestFile(): string {
  return fileURLToPath(new URL('./manifest.json', import.meta.url));
}

/** 候補を起こして版とアーキを訊く。時間を区切り、出力は上限つきで読む。 */
export function probeNodeBuild(file: string, timeoutMs: number = PROBE_TIMEOUT_MS): Promise<NodeBuild | null> {
  return new Promise((resolve) => {
    execFile(file, ['-p', PROBE_EXPR], { timeout: timeoutMs, killSignal: 'SIGKILL', maxBuffer: 64 * 1024, windowsHide: true }, (err, stdout) => {
      resolve(err ? null : parseNodeProbe(String(stdout)));
    });
  });
}

/**
 * 既定の確かめ。要る Node は同梱の manifest.json のもので、無ければ（ソースから動かしているとき）サーバを動かしている Node である。
 * ソースから動かすときのネイティブモジュールは、その Node に合わせて入っている。
 * 答えは、パスと更新時刻と大きさを鍵に覚え、同じファイルを起こし直さない。
 */
export function createNodeCheck(o: { manifestFile?: string; timeoutMs?: number } = {}): NodeCheck {
  const manifestFile = o.manifestFile ?? bundledManifestFile();
  const running: NodeBuild = { major: Number(process.versions.node.split('.')[0]), arch: process.arch };
  const cache = new Map<string, NodeBuild | null>();
  return {
    need: () => readNodeNeed(manifestFile) ?? running,
    async probe(file) {
      const st = fs.statSync(file, { throwIfNoEntry: false });
      const key = st ? `${file}\0${st.mtimeMs}\0${st.size}` : undefined;
      if (key !== undefined && cache.has(key)) return cache.get(key) ?? null;
      const got = await probeNodeBuild(file, o.timeoutMs);
      // 答えなかったものは覚えない。時間切れが一時のものなら、次に開いたときにもう一度試せる。
      if (key !== undefined && got !== null) cache.set(key, got);
      return got;
    },
  };
}

/**
 * 殻がそのまま起こせるフルパスか。
 * macOS と Linux は / で始まるもの、Windows はドライブから始まるもの（C:\）か UNC のもの（\\server\share）。
 * 名前だけや相対のパスは、起こす側の作業ディレクトリや PATH で指す先が変わる。
 */
export function isFullPath(p: string, platform: NodeJS.Platform = process.platform): boolean {
  return platform === 'win32' ? /^([a-zA-Z]:[\\/]|[\\/]{2})/.test(p) : p.startsWith('/');
}

/** 候補の Node が同梱のサーバに合わない理由。合えば null。 */
export type NodeBuildIssue = { kind: 'notNode' } | { kind: 'mismatch'; found: NodeBuild; need: NodeBuild };

/** 候補の Node が、殻と同じ条件（メジャー版とアーキの完全一致）で使えるか。新しい版でも代わりにならない。 */
export async function nodeBuildIssue(file: string, check: NodeCheck): Promise<NodeBuildIssue | null> {
  const found = await check.probe(file);
  if (found === null) return { kind: 'notNode' };
  const need = check.need();
  return found.major === need.major && found.arch === need.arch ? null : { kind: 'mismatch', found, need };
}
