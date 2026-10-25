/**
 * LM Studio の REST（`/api/v1/models`、`/load`、`/unload`）の薄い口（docs/design.md「起動前の準備」）。
 * 呼ぶのは、この PC の LM Studio だけである（どの宛先を触るかは prepare.ts が決める）。
 * 古い LM Studio は `/api/v1/models` に 404 を返す。そのときは null を返し、呼び手は黙って飛ばす。
 */

/** 載っている 1 つ（instance）。 */
export type LmInstance = { id: string; context: number | null };
/** LM Studio が持っているモデル 1 つ。key は opencode のモデルの ID と同じ綴りである（LM Studio の OpenAI 互換の口が返す ID）。 */
export type LmModel = { key: string; type: string; sizeBytes: number | null; maxContext: number | null; instances: LmInstance[] };

export type LmStudioDeps = {
  fetch?: typeof fetch;
  /** 一覧の問い合わせの上限。宛先が居ないときに起動を長く止めないため、短くする。 */
  listTimeoutMs?: number;
  /** 載せる上限。大きいモデルは 1 分を超えることがある。 */
  loadTimeoutMs?: number;
};

export class LmStudioError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
    this.name = 'LmStudioError';
  }
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : null);

/** `/api/v1/models` の答えを読む。形の違う行は捨てる。 */
export function lmModelsOf(v: unknown): LmModel[] {
  const rows = isObj(v) && Array.isArray(v.models) ? v.models : [];
  return rows.flatMap((m): LmModel[] => {
    if (!isObj(m) || typeof m.key !== 'string' || !m.key) return [];
    const instances = (Array.isArray(m.loaded_instances) ? m.loaded_instances : []).flatMap((x): LmInstance[] => (
      isObj(x) && typeof x.id === 'string' && x.id ? [{ id: x.id, context: num(isObj(x.config) ? x.config.context_length : null) }] : []
    ));
    return [{ key: m.key, type: typeof m.type === 'string' ? m.type : 'llm', sizeBytes: num(m.size_bytes), maxContext: num(m.max_context_length), instances }];
  });
}

export class LmStudio {
  private readonly f: typeof fetch;

  constructor(readonly origin: string, private readonly deps: LmStudioDeps = {}) {
    this.f = deps.fetch ?? fetch;
  }

  /** 持っているモデルの一覧。LM Studio ではない（404、つながらない、形が違う）なら null。 */
  async list(signal?: AbortSignal): Promise<LmModel[] | null> {
    try {
      const r = await this.f(`${this.origin}/api/v1/models`, { signal: anySignal(signal, this.deps.listTimeoutMs ?? 3_000) });
      if (!r.ok) return null;
      const j = await r.json() as unknown;
      return isObj(j) && Array.isArray(j.models) ? lmModelsOf(j) : null;
    } catch (e) {
      if (signal?.aborted) throw e;
      return null;
    }
  }

  /** 載せる。返すのは載せた instance の ID。 */
  async load(model: string, contextLength: number, signal?: AbortSignal): Promise<string> {
    const j = await this.post('/api/v1/models/load', { model, context_length: contextLength }, signal, this.deps.loadTimeoutMs ?? 180_000);
    return isObj(j) && typeof j.instance_id === 'string' && j.instance_id ? j.instance_id : model;
  }

  async unload(instanceId: string, signal?: AbortSignal): Promise<void> {
    await this.post('/api/v1/models/unload', { instance_id: instanceId }, signal, 30_000);
  }

  private async post(p: string, body: unknown, signal: AbortSignal | undefined, timeoutMs: number): Promise<unknown> {
    const r = await this.f(`${this.origin}${p}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: anySignal(signal, timeoutMs) });
    const text = await r.text();
    if (!r.ok) throw new LmStudioError(r.status, errorText(text) || `LM Studio answered ${r.status}`);
    try { return text ? JSON.parse(text) as unknown : null; } catch { return null; }
  }
}

/** 断りの本文から、人に見せる 1 文を取り出す（`{ error: { message } }`、`{ error: "…" }`、素の文）。 */
function errorText(text: string): string {
  try {
    const j = JSON.parse(text) as unknown;
    if (isObj(j)) {
      const e = j.error;
      if (typeof e === 'string') return e;
      if (isObj(e) && typeof e.message === 'string') return e.message;
      if (typeof j.message === 'string') return j.message;
    }
  } catch { /* 素の文 */ }
  return text.trim().split('\n').at(-1)?.slice(0, 300) ?? '';
}

/** 呼び手の signal と時間の上限の、先に来た方で切る。 */
function anySignal(signal: AbortSignal | undefined, timeoutMs: number): AbortSignal {
  const t = AbortSignal.timeout(timeoutMs);
  return signal ? AbortSignal.any([signal, t]) : t;
}
