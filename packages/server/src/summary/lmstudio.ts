import { DEFAULT_LANGUAGE, t } from '@agent-hangar/shared';
import { parseSummaryOutput, SUMMARY_SCHEMA, summarySystemPrompt, SummarizerError, type Summarizer, type SummaryInput, type SummaryOutput } from './types.ts';
import { causeOf, msg } from '../i18n/message.ts';

/**
 * リダイレクトの応答かどうか。
 * `redirect: 'manual'` のとき、Node は 3xx をそのまま返し、ブラウザは type が opaqueredirect の応答を返す。
 */
const isRedirect = (r: Response): boolean => r.type === 'opaqueredirect' || (r.status >= 300 && r.status < 400);

/** json_schema の形の指定を受けない口が返す状態。これを受けたら json_object で投げ直す。 */
const SCHEMA_REJECTED = new Set([400, 422]);

type Attempt = { kind: 'ok'; content: string; model: unknown } | { kind: 'notJson' } | { kind: 'rejected'; status: number };

/**
 * OpenAI 互換の API（LM Studio、Ollama、vLLM など）の要約器。
 * 設定の要約エンジンで OpenAI 互換を選んだときに使う。id は LM Studio だけだった頃のまま（lmstudio）で、書いた要約の source_id と合わせてある。
 * API キーがあれば Authorization: Bearer で添える。
 * まず json_schema で形を指定して投げ、受けない口（400、422 を返すか、指定を無視して JSON でない本文を返す）には、
 * json_object で投げ直し、スキーマは指示文に書く。Ollama の古い版などが json_schema を受けないためである。
 * 思考モデルは出力上限を思考で使い切って本文が空になることがあるので、空は失敗として扱い、次の要約器へ回す。
 */
export class LmStudioSummarizer implements Summarizer {
  readonly id = 'lmstudio' as const;
  private readonly baseUrl: string;
  private readonly model: string | null;
  private readonly apiKey: string | null;
  private readonly fetchFn: typeof fetch;
  private readonly timeoutMs: number;

  constructor(o: { baseUrl: string; model: string | null; apiKey?: string | null; fetch?: typeof fetch; timeoutMs?: number }) {
    this.baseUrl = o.baseUrl.replace(/\/+$/, '');
    this.model = o.model;
    this.apiKey = o.apiKey?.trim() ? o.apiKey.trim() : null;
    this.fetchFn = o.fetch ?? ((...a) => fetch(...a));
    this.timeoutMs = o.timeoutMs ?? 180_000;
  }

  /** 要求に添える見出し。API キーがあるときだけ Authorization を付ける。 */
  private headers(extra: Record<string, string> = {}): Record<string, string> {
    return this.apiKey ? { ...extra, authorization: `Bearer ${this.apiKey}` } : extra;
  }

  /** モデル一覧。繋がらないときは空配列を返す。 */
  async listModels(): Promise<string[]> {
    try {
      const r = await this.fetchFn(`${this.baseUrl}/v1/models`, { headers: this.headers(), signal: AbortSignal.timeout(2000), redirect: 'manual' });
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

  /**
   * 1 回投げる。strict が真なら json_schema で、偽なら json_object でスキーマを指示文に足して投げる。
   * 形の指定を断られた（400、422）か、本文が JSON でなかったときは、投げ直せるように失敗を投げずに返す。
   */
  private async attempt(model: string, input: SummaryInput, strict: boolean): Promise<Attempt> {
    const system = strict ? summarySystemPrompt(input.language) : `${summarySystemPrompt(input.language)}\n\n${t(input.language ?? DEFAULT_LANGUAGE, 'summary.prompt.jsonObject', { schema: JSON.stringify(SUMMARY_SCHEMA, null, 2) })}`;
    let r: Response;
    try {
      r = await this.fetchFn(`${this.baseUrl}/v1/chat/completions`, {
        method: 'POST',
        headers: this.headers({ 'content-type': 'application/json' }),
        signal: AbortSignal.timeout(this.timeoutMs),
        // リダイレクトを追わない。追うと、ループバックに縛った宛先が返す飛ばし先へ会話の本文を送り直してしまう。
        redirect: 'manual',
        body: JSON.stringify({
          model,
          temperature: 0.2,
          messages: [{ role: 'system', content: system }, { role: 'user', content: input.text }],
          response_format: strict ? { type: 'json_schema', json_schema: { name: 'session_summary', strict: true, schema: SUMMARY_SCHEMA } } : { type: 'json_object' },
        }),
      });
    } catch (e) {
      throw new SummarizerError(this.id, msg('summary.lmstudio.unreachable', { reason: causeOf(e) }));
    }
    if (isRedirect(r)) throw new SummarizerError(this.id, msg('summary.lmstudio.redirected', { label: msg('settings.label.lmStudioUrl') }));
    if (strict && SCHEMA_REJECTED.has(r.status)) return { kind: 'rejected', status: r.status };
    if (!r.ok) throw new SummarizerError(this.id, msg('summary.lmstudio.badStatus', { status: r.status }));
    const j = (await r.json()) as { model?: unknown; choices?: { message?: { content?: unknown } }[] };
    const content = j.choices?.[0]?.message?.content;
    if (typeof content !== 'string' || !content.trim()) throw new SummarizerError(this.id, msg('summary.lmstudio.emptyContent'));
    try {
      JSON.parse(content);
    } catch {
      return { kind: 'notJson' };
    }
    return { kind: 'ok', content, model: j.model };
  }

  async summarize(input: SummaryInput): Promise<SummaryOutput> {
    const model = this.model ?? (await this.listModels())[0];
    if (!model) throw new SummarizerError(this.id, msg('summary.lmstudio.noModel'));
    let a = await this.attempt(model, input, true);
    if (a.kind !== 'ok') a = await this.attempt(model, input, false);
    if (a.kind === 'rejected') throw new SummarizerError(this.id, msg('summary.lmstudio.badStatus', { status: a.status }));
    if (a.kind === 'notJson') throw new SummarizerError(this.id, msg('summary.lmstudio.notJson'));
    const out = parseSummaryOutput(JSON.parse(a.content));
    if (!out) throw new SummarizerError(this.id, msg('summary.lmstudio.badShape'));
    // 応答が名乗ったモデル名を優先し、無ければ投げたモデル名を使う。
    const used = typeof a.model === 'string' && a.model.trim() ? a.model : model;
    return { ...out, model: used || 'lmstudio:auto' };
  }
}
