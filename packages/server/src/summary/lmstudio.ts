import { parseSummaryOutput, SUMMARY_SCHEMA, SUMMARY_SYSTEM_PROMPT, SummarizerError, type Summarizer, type SummaryInput, type SummaryOutput } from './types.ts';

/**
 * リダイレクトの応答かどうか。
 * `redirect: 'manual'` のとき、Node は 3xx をそのまま返し、ブラウザは type が opaqueredirect の応答を返す。
 */
const isRedirect = (r: Response): boolean => r.type === 'opaqueredirect' || (r.status >= 300 && r.status < 400);

/**
 * LM Studio の OpenAI 互換 API。
 * 既定の要約器である。
 * 思考モデルは出力上限を思考で使い切って本文が空になることがあるので、空は失敗として扱い、次の要約器へ回す。
 */
export class LmStudioSummarizer implements Summarizer {
  readonly id = 'lmstudio' as const;
  private readonly baseUrl: string;
  private readonly model: string | null;
  private readonly fetchFn: typeof fetch;
  private readonly timeoutMs: number;

  constructor(o: { baseUrl: string; model: string | null; fetch?: typeof fetch; timeoutMs?: number }) {
    this.baseUrl = o.baseUrl.replace(/\/+$/, '');
    this.model = o.model;
    this.fetchFn = o.fetch ?? ((...a) => fetch(...a));
    this.timeoutMs = o.timeoutMs ?? 180_000;
  }

  /** モデル一覧。繋がらないときは空配列を返す。 */
  async listModels(): Promise<string[]> {
    try {
      const r = await this.fetchFn(`${this.baseUrl}/v1/models`, { signal: AbortSignal.timeout(2000), redirect: 'manual' });
      if (isRedirect(r) || !r.ok) return [];
      const j = (await r.json()) as { data?: { id?: unknown }[] };
      return (j.data ?? []).map((m) => m.id).filter((id): id is string => typeof id === 'string');
    } catch {
      return [];
    }
  }

  async available(): Promise<boolean> {
    const models = await this.listModels();
    if (models.length === 0) return false;
    return this.model === null || models.includes(this.model);
  }

  async summarize(input: SummaryInput): Promise<SummaryOutput> {
    const model = this.model ?? (await this.listModels())[0];
    if (!model) throw new SummarizerError(this.id, 'LM Studio にモデルがありません');
    let r: Response;
    try {
      r = await this.fetchFn(`${this.baseUrl}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        signal: AbortSignal.timeout(this.timeoutMs),
        // リダイレクトを追わない。追うと、ループバックに縛った宛先が返す飛ばし先へ会話の本文を送り直してしまう。
        redirect: 'manual',
        body: JSON.stringify({
          model,
          temperature: 0.2,
          messages: [{ role: 'system', content: SUMMARY_SYSTEM_PROMPT }, { role: 'user', content: input.text }],
          response_format: { type: 'json_schema', json_schema: { name: 'session_summary', strict: true, schema: SUMMARY_SCHEMA } },
        }),
      });
    } catch (e) {
      throw new SummarizerError(this.id, `LM Studio に接続できません: ${e instanceof Error ? e.message : String(e)}`);
    }
    if (isRedirect(r)) throw new SummarizerError(this.id, '要約器の宛先がリダイレクトを返しました。飛ばし先へは送りません。lmStudioUrl の宛先を確かめてください');
    if (!r.ok) throw new SummarizerError(this.id, `LM Studio が ${r.status} を返しました`);
    const j = (await r.json()) as { model?: unknown; choices?: { message?: { content?: unknown } }[] };
    const content = j.choices?.[0]?.message?.content;
    if (typeof content !== 'string' || !content.trim()) throw new SummarizerError(this.id, '本文が空でした（思考モデルの可能性があります）');
    let parsed: unknown;
    try {
      parsed = JSON.parse(content);
    } catch {
      throw new SummarizerError(this.id, '本文が JSON ではありません');
    }
    const out = parseSummaryOutput(parsed);
    if (!out) throw new SummarizerError(this.id, '本文がスキーマの形ではありません');
    // 応答が名乗ったモデル名を優先し、無ければ投げたモデル名を使う。
    const used = typeof j.model === 'string' && j.model.trim() ? j.model : model;
    return { ...out, model: used || 'lmstudio:auto' };
  }
}
