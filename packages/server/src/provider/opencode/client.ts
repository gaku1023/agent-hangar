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

export type OpencodeClientOptions = { timeoutMs?: number };

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
    const r = await this.request('GET', `/api/mcp?${encodeURIComponent('location[directory]')}=${encodeURIComponent(directory)}`) as { data?: unknown } | null;
    const rows = Array.isArray(r?.data) ? (r.data as { name?: unknown; status?: { status?: unknown } }[]) : [];
    return rows.flatMap((x) => (typeof x?.name === 'string' && typeof x.status?.status === 'string' ? [{ name: x.name, status: x.status.status }] : []));
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
