import { whereOfHost } from '../options.ts';
import { lmModelsOf } from './lmstudio.ts';

/**
 * この PC のローカルのサーバー（LM Studio、Ollama など）に、ダウンロード済みのモデルを聞く（docs/design.md「起動前の準備」の「モデルの有無」）。
 * opencode.json のモデルの一覧は PC の間で共有されるので、その PC に実際にあるかはサーバーに聞かないと分からない。
 * 先に LM Studio の `/api/v1/models` を聞く。OpenAI 互換の `/v1/models` は、LM Studio の JIT の読み込みを切ると載っているモデルしか返さないからである。
 * LM Studio の口が無ければ（404、形が違う）、OpenAI 互換の `{baseURL}/models` を聞く。
 * 触るのはこの PC（127.0.0.1、localhost）の宛先だけで、ほかは聞かずに unknown を返す。
 */

/** listed は一覧が取れた（models はモデルの ID）。unreachable はどちらの口にもつながらない。unknown は確かめられない（この PC でない、一覧の形でない）。 */
export type ModelListingResult = { kind: 'listed'; models: string[] } | { kind: 'unreachable'; origin: string } | { kind: 'unknown' };

export type LocalModelListingDeps = {
  fetch?: typeof fetch;
  now?: () => number;
  /** 取れた一覧を使い回す間。 */
  ttlMs?: number;
  /** 1 つの問い合わせの上限。宛先が居ないときに起動を長く止めないため、短くする。 */
  timeoutMs?: number;
};

/** 取れた一覧を使い回す間。起動のたびと小窓を開くたびに聞くので、その間だけ覚える。 */
const TTL_MS = 30_000;

/** baseURL のうち、この PC のものの origin。ほかは null。 */
export function deviceOrigin(baseURL: string | null): string | null {
  if (!baseURL) return null;
  try {
    const u = new URL(baseURL);
    return (u.protocol === 'http:' || u.protocol === 'https:') && whereOfHost(u.hostname) === 'device' ? u.origin : null;
  } catch {
    return null;
  }
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

export class LocalModelListing {
  private readonly cache = new Map<string, { at: number; models: string[] }>();

  constructor(private readonly deps: LocalModelListingDeps = {}) {}

  /** baseURL のサーバーにあるモデル。fresh を立てると、覚えた一覧を使わずに聞き直す（小窓の「再読み込み」）。 */
  async list(baseURL: string | null, o: { fresh?: boolean } = {}): Promise<ModelListingResult> {
    const origin = deviceOrigin(baseURL);
    if (!origin || !baseURL) return { kind: 'unknown' };
    const hit = this.cache.get(baseURL);
    if (hit && !o.fresh && this.now() - hit.at < (this.deps.ttlMs ?? TTL_MS)) return { kind: 'listed', models: hit.models };
    const native = await this.get(`${origin}/api/v1/models`);
    let models = isObj(native) && Array.isArray(native.models) ? lmModelsOf(native).filter((m) => m.type !== 'embedding').map((m) => m.key) : null;
    let reached = native !== DOWN;
    if (!models) {
      const openai = await this.get(`${baseURL.replace(/\/+$/, '')}/models`);
      reached ||= openai !== DOWN;
      models = isObj(openai) && Array.isArray(openai.data) ? openai.data.flatMap((m) => (isObj(m) && typeof m.id === 'string' && m.id ? [m.id] : [])) : null;
    }
    if (!models) return reached ? { kind: 'unknown' } : { kind: 'unreachable', origin };
    this.cache.set(baseURL, { at: this.now(), models });
    return { kind: 'listed', models };
  }

  /** JSON の答え。答えはあるが読めない（404、JSON でない）なら null、つながらなければ DOWN。 */
  private async get(url: string): Promise<unknown> {
    let r: Response;
    try {
      r = await (this.deps.fetch ?? fetch)(url, { signal: AbortSignal.timeout(this.deps.timeoutMs ?? 3_000) });
    } catch {
      return DOWN;
    }
    if (!r.ok) return null;
    try { return await r.json() as unknown; } catch { return null; }
  }

  private now(): number {
    return (this.deps.now ?? Date.now)();
  }
}

const DOWN = Symbol('down');
