import fs from 'node:fs';
import path from 'node:path';
import type { OpencodeModelCost } from '@agent-hangar/shared';

/**
 * models.dev のカタログ（docs/design.md「opencode のモデルの小窓」）。
 * opencode の `/api/model` が料金やコンテキストを返さないモデルを埋めるのと、小窓の下端の「（{日付} 取得）」に使う。
 * 取りに行くのは、opencode の選択肢を取ったとき（新しいセッションで opencode を選んだとき）だけで、hangar の起動では取りに行かない。
 * 取ってから 1 日は取り直さない。失敗したら前のものを残し、1 時間は取り直さない（投げない）。
 * api.json は大きいので、料金、コンテキスト、ツール呼び出しの対応だけに削って `<home>/opencode/models-dev.json` に保存する。
 */

export const MODELS_DEV_URL = 'https://models.dev/api.json';

/** 1 つのモデルの、hangar が使う分。分からないものは null。 */
export type CatalogModel = { cost: OpencodeModelCost | null; context: number | null; tools: boolean | null };
/** 保存の形。providers はプロバイダーの ID → モデルの ID → CatalogModel。 */
export type CatalogFile = { fetchedAt: number; providers: Record<string, Record<string, CatalogModel>> };

/** 取り直すまでの間。 */
const MAX_AGE_MS = 24 * 3_600_000;
/** 失敗のあと、次に試すまでの間。 */
const RETRY_MS = 3_600_000;
/** 答えの大きさの上限。api.json はいま数 MB で、これを超えるものは読まない。 */
const MAX_BYTES = 32 * 1024 * 1024;

export type ModelsDevDeps = {
  /** 保存の場所（catalogPath）。 */
  file: string;
  fetch?: typeof fetch;
  now?: () => number;
  maxAgeMs?: number;
  retryMs?: number;
  timeoutMs?: number;
  log?: (line: string) => void;
};

export function catalogPath(home: string): string {
  return path.join(home, 'opencode', 'models-dev.json');
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null);

/** models.dev の答えを、保存する形に削る。形の違うものは捨てる。 */
export function trimModelsDev(json: unknown): CatalogFile['providers'] {
  const out: CatalogFile['providers'] = {};
  if (!isObj(json)) return out;
  for (const [pid, p] of Object.entries(json)) {
    if (!isObj(p) || !isObj(p.models)) continue;
    const models: Record<string, CatalogModel> = {};
    for (const [mid, m] of Object.entries(p.models)) {
      if (!isObj(m)) continue;
      const c = isObj(m.cost) ? m.cost : null;
      const input = num(c?.input);
      const output = num(c?.output);
      const context = num(isObj(m.limit) ? m.limit.context : null);
      models[mid] = {
        cost: input !== null && output !== null ? { input, output } : null,
        context: context !== null && context > 0 ? context : null,
        tools: typeof m.tool_call === 'boolean' ? m.tool_call : null,
      };
    }
    if (Object.keys(models).length) out[pid] = models;
  }
  return out;
}

export class ModelsDevCatalog {
  private loaded = false;
  private data: CatalogFile | null = null;
  private failedAt: number | null = null;
  private running: Promise<boolean> | null = null;

  constructor(private readonly deps: ModelsDevDeps) {}

  /** 保存したカタログ。無い、読めないときは null。 */
  current(): CatalogFile | null {
    if (!this.loaded) {
      this.loaded = true;
      this.data = readFile(this.deps.file);
    }
    return this.data;
  }

  /** 1 つのモデルの分。無ければ null。 */
  lookup(provider: string, model: string): CatalogModel | null {
    const p = this.current()?.providers;
    if (!p || !Object.prototype.hasOwnProperty.call(p, provider)) return null;
    const models = p[provider]!;
    return Object.prototype.hasOwnProperty.call(models, model) ? models[model]! : null;
  }

  /** 古ければ取り直す。取って保存したら真。取りに行かなかったとき、失敗したときは偽（投げない）。同時に頼まれたら 1 回だけ取りに行く。 */
  refresh(): Promise<boolean> {
    if (this.running) return this.running;
    const now = this.now();
    const have = this.current();
    if (have && now - have.fetchedAt < (this.deps.maxAgeMs ?? MAX_AGE_MS)) return Promise.resolve(false);
    if (this.failedAt !== null && now - this.failedAt < (this.deps.retryMs ?? RETRY_MS)) return Promise.resolve(false);
    this.running = this.fetchAndSave().finally(() => { this.running = null; });
    return this.running;
  }

  private async fetchAndSave(): Promise<boolean> {
    try {
      const r = await (this.deps.fetch ?? fetch)(MODELS_DEV_URL, { signal: AbortSignal.timeout(this.deps.timeoutMs ?? 15_000), headers: { accept: 'application/json' } });
      if (!r.ok) throw new Error(`answered ${r.status}`);
      const text = await r.text();
      if (text.length > MAX_BYTES) throw new Error('the answer is too large');
      let json: unknown;
      try { json = JSON.parse(text); } catch { throw new Error('the answer is not JSON'); }
      const providers = trimModelsDev(json);
      if (!Object.keys(providers).length) throw new Error('the answer has no models');
      const file: CatalogFile = { fetchedAt: this.now(), providers };
      writeFile(this.deps.file, file);
      this.data = file;
      this.loaded = true;
      this.failedAt = null;
      return true;
    } catch (e) {
      this.failedAt = this.now();
      this.deps.log?.(`[opencode] could not fetch models.dev: ${(e as Error).message}`);
      return false;
    }
  }

  private now(): number {
    return (this.deps.now ?? Date.now)();
  }
}

function readFile(file: string): CatalogFile | null {
  try {
    const j = JSON.parse(fs.readFileSync(file, 'utf8')) as unknown;
    if (!isObj(j) || typeof j.fetchedAt !== 'number' || !isObj(j.providers)) return null;
    return { fetchedAt: j.fetchedAt, providers: j.providers as CatalogFile['providers'] };
  } catch {
    return null;
  }
}

/** 書きかけを読まれないよう、隣の一時ファイルに書いてから置き換える。 */
function writeFile(file: string, data: CatalogFile): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data));
  fs.renameSync(tmp, file);
}
