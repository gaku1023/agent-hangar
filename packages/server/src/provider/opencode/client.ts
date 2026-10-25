import { authHeader } from './serve/spawn.ts';

/**
 * opencode の serve の HTTP の口（docs/design.md「opencode の起動」）。
 * hangar が opencode の API に触るのは、この包みを通すだけにする。v2 の API は版で変わりうる（experimental の道もある）ので、道の名前と本文の形をここに集める。
 * パスワードは basic 認証の header にだけ載せ、投げる文には載せない。
 */

/** 応答が 2xx でなかった。status は HTTP の状態、path は道（パスワードを含まない）。 */
export class OpencodeApiError extends Error {
  constructor(readonly status: number, readonly path: string, detail: string) {
    super(`opencode API ${path} answered ${status}${detail ? `: ${detail}` : ''}`);
    this.name = 'OpencodeApiError';
  }
}

export type OpencodeModelRef = { providerID: string; id: string };

/** `POST /api/session` の本文。ID は付けない（hangar が決めた ID は OpenCode Zen の無料枠が 403 で断るため）。 */
export type CreateSessionBody = { directory: string; title?: string; agent?: string; model?: OpencodeModelRef };

/** `GET /api/mcp` の 1 行。status は pending、connected、failed など。 */
export type McpServerStatus = { name: string; status: string };

/** `GET /api/agent` の 1 行のうち hangar が使うもの。mode は primary、subagent、all。 */
export type OpencodeAgentInfo = { id: string; mode: string; hidden: boolean; description: string | null };
/** `GET /api/model` の 1 行のうち hangar が使うもの。id はプロバイダーの中の ID（/ を含むことがある）。 */
export type OpencodeModelInfo = { providerID: string; id: string; name: string; enabled: boolean };
/** `GET /api/provider` の 1 行のうち hangar が使うもの。 */
export type OpencodeProviderInfo = { id: string; name: string };

export type OpencodeClientOptions = { timeoutMs?: number };

/** 場所（directory）を `location[directory]=` の形の問いにする。JSON の文字列だと 400 になる。 */
const at = (directory: string): string => `?${encodeURIComponent('location[directory]')}=${encodeURIComponent(directory)}`;
const str = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null);
const rowsOf = (r: unknown): Record<string, unknown>[] => {
  const data = (r as { data?: unknown } | null)?.data;
  return Array.isArray(data) ? data.filter((x): x is Record<string, unknown> => !!x && typeof x === 'object') : [];
};

export class OpencodeClient {
  constructor(private readonly serve: { url: string; password: string }, private readonly o: OpencodeClientOptions = {}) {}

  /** 新しい会話を作り、opencode が振った ID を返す。 */
  async createSession(b: CreateSessionBody): Promise<string> {
    const body: Record<string, unknown> = { location: { directory: b.directory } };
    if (b.title) body.title = b.title;
    if (b.agent) body.agent = b.agent;
    if (b.model) body.model = b.model;
    const r = await this.request('POST', '/api/session', body) as { data?: { id?: unknown } } | null;
    const id = r?.data?.id;
    if (typeof id !== 'string' || id === '') throw new OpencodeApiError(200, '/api/session', 'the answer has no session id');
    return id;
  }

  /** システムプロンプトへの追記を 1 つ差し込む（置き換える）。opencode は `<context key="{key}">` の形で system prompt の末尾近くに入れる。 */
  async putInstruction(sessionId: string, key: string, value: string): Promise<void> {
    await this.request('PUT', `/api/experimental/session/${encodeURIComponent(sessionId)}/instructions/entries/${encodeURIComponent(key)}`, { value });
  }

  /** その場所（directory）での MCP の接続の状態。location は `location[directory]=` の形で渡す（JSON の文字列だと 400）。 */
  async mcpStatus(directory: string): Promise<McpServerStatus[]> {
    const r = await this.request('GET', `/api/mcp${at(directory)}`) as { data?: unknown } | null;
    const rows = Array.isArray(r?.data) ? (r.data as { name?: unknown; status?: { status?: unknown } }[]) : [];
    return rows.flatMap((x) => (typeof x?.name === 'string' && typeof x.status?.status === 'string' ? [{ name: x.name, status: x.status.status }] : []));
  }

  /**
   * その場所で使えるエージェント（opencode の言うエージェント。hangar の画面ではモード）。
   * 2.1.4 は場所ごとの最初の問いに空の一覧を返すことがある。聞き直すのは呼び手が決める。
   */
  async agents(directory: string): Promise<OpencodeAgentInfo[]> {
    const r = await this.request('GET', `/api/agent${at(directory)}`);
    return rowsOf(r).flatMap((x) => {
      const id = str(x.id);
      return id ? [{ id, mode: str(x.mode) ?? 'primary', hidden: x.hidden === true, description: str(x.description) }] : [];
    });
  }

  /** その場所で使えるモデル。つないだプロバイダーのものと、鍵なしの無料のものが並ぶ。 */
  async models(directory: string): Promise<OpencodeModelInfo[]> {
    const r = await this.request('GET', `/api/model${at(directory)}`);
    return rowsOf(r).flatMap((x) => {
      const providerID = str(x.providerID);
      const id = str(x.id) ?? str(x.modelID);
      return providerID && id ? [{ providerID, id, name: str(x.name) ?? id, enabled: x.enabled !== false }] : [];
    });
  }

  /** その場所でつながっているプロバイダー。 */
  async providers(directory: string): Promise<OpencodeProviderInfo[]> {
    const r = await this.request('GET', `/api/provider${at(directory)}`);
    return rowsOf(r).flatMap((x) => {
      const id = str(x.id);
      return id ? [{ id, name: str(x.name) ?? id }] : [];
    });
  }

  /**
   * 設定（opencode.json の層の重なり）の既定のモデル。`provider/model` の形で、書いていなければ null。
   * `GET /api/config` は `{ data }` で包まずに、層の配列を返す。並びは弱い順で、ふだんの設定（~/.config/opencode）の後にその場所の opencode.json が来る（2.1.4 で確かめた）。
   */
  async configuredModel(directory: string): Promise<string | null> {
    const r = await this.request('GET', `/api/config${at(directory)}`);
    const layers = Array.isArray(r) ? (r as { info?: { model?: { providerID?: unknown; model?: unknown } } }[]) : [];
    let found: string | null = null;
    for (const l of layers) {
      const providerID = str(l?.info?.model?.providerID);
      const model = str(l?.info?.model?.model);
      if (providerID && model) found = `${providerID}/${model}`;
    }
    return found;
  }

  private async request(method: string, p: string, body?: unknown): Promise<unknown> {
    const r = await fetch(this.serve.url + p, {
      method,
      headers: { authorization: authHeader(this.serve.password), ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(this.o.timeoutMs ?? 10_000),
    });
    const text = await r.text();
    const route = p.split('?')[0] ?? p;
    if (!r.ok) throw new OpencodeApiError(r.status, route, text.split(this.serve.password).join('***').slice(0, 300));
    if (!text) return null;
    try {
      return JSON.parse(text) as unknown;
    } catch {
      throw new OpencodeApiError(r.status, route, 'the answer is not JSON');
    }
  }
}
