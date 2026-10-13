import { execFile } from 'node:child_process';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { NODE_API_MIN, NODE_MIN_LABEL, NODE_PROBE_EXPR, nodeFit, parseNodeProbe, type NodeBuild, type NodeNeed } from './nodeRule.ts';

// 設定の「Node のパス」の確かめ。
// 殻（apps/desktop/src-tauri/src/node.rs）は、nodePath を絶対パスとして読み、manifest.json の nodeApi 以上の Node-API を持ち、アーキテクチャが同じ Node だけを使う。
// 同梱の CLI（hangar.sh、launch-cli.ts）も同じ条件で選ぶ。規則は nodeRule.ts にある。
// 設定の保存と準備の確かめも同じ条件で見て、画面では ✓ なのに次の起動で使われない Node を作らない。

export type { NodeBuild, NodeNeed };

/** 要る Node と、候補の Node の答えを返す口。試験が差し替える。 */
export type NodeCheck = {
  /** 同梱のサーバが要る Node。 */
  need(): NodeNeed;
  /** 候補を起こして版、Node-API の版、アーキを訊く。Node として答えなければ null。 */
  probe(file: string): Promise<NodeBuild | null>;
};

/** 候補 1 つを調べてよい時間。殻の PROBE_TIMEOUT と同じ。 */
const PROBE_TIMEOUT_MS = 5000;

/** manifest.json の nodeApi、nodeMin、arch を読む。無い、壊れている、形が違うときは null。 */
export function readNodeNeed(manifestFile: string): NodeNeed | null {
  try {
    const m = JSON.parse(fs.readFileSync(manifestFile, 'utf8')) as { nodeApi?: unknown; nodeMin?: unknown; arch?: unknown };
    return typeof m.nodeApi === 'number' && typeof m.nodeMin === 'string' && typeof m.arch === 'string' ? { napi: m.nodeApi, min: m.nodeMin, arch: m.arch } : null;
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
    execFile(file, ['-p', NODE_PROBE_EXPR], { timeout: timeoutMs, killSignal: 'SIGKILL', maxBuffer: 64 * 1024, windowsHide: true }, (err, stdout) => {
      resolve(err ? null : parseNodeProbe(String(stdout)));
    });
  });
}

/**
 * 既定の確かめ。要る Node は同梱の manifest.json のもので、無ければ（ソースから動かしているとき）同じ規則の既定の値（nodeRule.ts）と、サーバを動かしている Node のアーキである。
 * ソースから動かすときのネイティブモジュールは、その Node に合わせて入っている。
 * 答えは、パスと更新時刻と大きさを鍵に覚え、同じファイルを起こし直さない。
 */
export function createNodeCheck(o: { manifestFile?: string; timeoutMs?: number } = {}): NodeCheck {
  const manifestFile = o.manifestFile ?? bundledManifestFile();
  const fallback: NodeNeed = { napi: NODE_API_MIN, min: NODE_MIN_LABEL, arch: process.arch };
  const cache = new Map<string, NodeBuild | null>();
  return {
    need: () => readNodeNeed(manifestFile) ?? fallback,
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

/** 候補の Node が同梱のサーバに合わない理由。合えば null。fit は Node-API が足りない（version）か、アーキが違う（arch）か。 */
export type NodeBuildIssue = { kind: 'notNode' } | { kind: 'mismatch'; fit: 'version' | 'arch'; found: NodeBuild; need: NodeNeed };

/** 候補の Node が、殻と同じ条件（Node-API が要る版以上で、アーキが同じ）で使えるか。上限は付けない。 */
export async function nodeBuildIssue(file: string, check: NodeCheck): Promise<NodeBuildIssue | null> {
  const found = await check.probe(file);
  if (found === null) return { kind: 'notNode' };
  const need = check.need();
  const fit = nodeFit(found, need);
  return fit === 'ok' ? null : { kind: 'mismatch', fit, found, need };
}
