import { serveHeaders } from './serve/spawn.ts';

/**
 * opencode の serve の HTTP の口（docs/design.md「opencode の起動」）。
 * hangar が opencode の API に触るのは、この包みを通すだけにする。v2 の API は版で変わりうる（experimental の道もある）ので、道の名前と本文の形をここに集める。
 * パスワードは basic 認証の header にだけ載せ、投げる文には載せない。
 * serve の場所（directory、会話のフォルダ）を持っていれば、どの要求にも `x-opencode-directory` の header で付ける。
 * opencode 2.1.4 は場所の無い要求を serve の作業フォルダに寄せるので、会話の ID だけの道（本文、interrupt、追記など）も会話のフォルダを指すようにする。
 * 場所を問い（`location[directory]=`）で渡す道は、問いが先に効く。
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
/**
 * `GET /api/model` の 1 行のうち hangar が使うもの。id はプロバイダーの中の ID（/ を含むことがある）。
 * tools は capabilities.tools（書いていなければ真）。context は limit.context（0 や無いときは null）。
 * cost は料金の段の配列の最初の段（100 万トークンあたりの入力と出力、米ドル）で、空の配列や無いときは null（LM Studio の手で足したモデルは空で来る）。
 */
export type OpencodeModelInfo = { providerID: string; id: string; name: string; enabled: boolean; tools: boolean; context: number | null; cost: { input: number; output: number } | null };
/**
 * `GET /api/provider` の 1 行のうち hangar が使うもの。host は settings.baseURL の宛先の名前（無ければ null）。
 * settings には API キーも載るので、ほかの欄は読まない。
 */
export type OpencodeProviderInfo = { id: string; name: string; host: string | null };

/**
 * `GET /api/provider` の 1 行を、設定のプロバイダーの面のために読んだもの。
 * activation は enabled か auto（LM Studio の自動の検出）、baseURL は settings.baseURL（無ければ null）。settings の apiKey は読まない。
 */
export type OpencodeProviderRow = { id: string; integrationID: string; name: string; activation: string; baseURL: string | null };

/** 入力の欄の 1 つ（opencode の Form.Field のうち hangar が使うもの）。when は、ほかの欄の値がそれと等しいときだけ出る、の条件。 */
export type OpencodeLoginField = { key: string; required: boolean; hidden: boolean; default: unknown; options: unknown[]; when: { key: string; op: string; value: unknown }[] };

/**
 * `GET /api/integration` の 1 行のうち hangar が使うもの（設定のプロバイダーの面）。
 * key は API キーで接続できるか、logins はログインの方法、env は API キーを読む環境変数の名前。
 * connections は接続の記録で、credential（API キーかログイン、opencode の DB にある）と env（環境変数）がある。API キーの値は opencode もここに載せない。
 */
export type OpencodeIntegrationInfo = {
  id: string; name: string; key: boolean;
  logins: { id: string; label: string; form: OpencodeLoginField[] }[];
  env: string[];
  connections: ({ type: 'credential'; id: string; method: string } | { type: 'env'; name: string })[];
};

/** ログインを始めた答え（Integration.AttemptEncoded）。 */
export type OpencodeOauthAttempt = { attemptId: string; url: string; instructions: string; mode: 'auto' | 'code' };
/** ログインの進み（Integration.AttemptStatus）。 */
export type OpencodeOauthStatus = { status: 'pending' | 'complete' | 'failed' | 'expired'; message: string | null };

export type OpencodeClientOptions = { timeoutMs?: number };

/** 場所（directory）を `location[directory]=` の形の問いにする。JSON の文字列だと 400 になる。 */
const at = (directory: string): string => `?${encodeURIComponent('location[directory]')}=${encodeURIComponent(directory)}`;
const str = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null);
const objOf = (v: unknown): Record<string, unknown> | null => (v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : null);
const firstCost = (v: unknown): { input: number; output: number } | null => {
  const c = Array.isArray(v) ? objOf(v[0]) : null;
  const input = num(c?.input);
  const output = num(c?.output);
  return input !== null && output !== null ? { input, output } : null;
};
const hostOf = (url: string | null): string | null => {
  if (!url) return null;
  try { return new URL(url).hostname || null; } catch { return null; }
};
const fieldsOf = (v: unknown): OpencodeLoginField[] => (Array.isArray(v) ? v : []).flatMap((f) => {
  const o = objOf(f);
  const key = str(o?.key);
  if (!o || !key) return [];
  const when = (Array.isArray(o.when) ? o.when : []).flatMap((w) => {
    const c = objOf(w);
    const k = str(c?.key);
    return c && k ? [{ key: k, op: str(c.op) ?? 'eq', value: c.value }] : [];
  });
  const options = (Array.isArray(o.options) ? o.options : []).map((x) => objOf(x)?.value ?? x);
  return [{ key, required: o.required === true, hidden: o.hidden === true, default: o.default, options, when }];
});
const integrationOf = (x: Record<string, unknown>): OpencodeIntegrationInfo | null => {
  const id = str(x.id);
  if (!id) return null;
  const methods = (Array.isArray(x.methods) ? x.methods : []).map(objOf).filter((m): m is Record<string, unknown> => m !== null);
  const connections = (Array.isArray(x.connections) ? x.connections : []).map(objOf).flatMap((c): OpencodeIntegrationInfo['connections'] => {
    if (c?.type === 'credential' && str(c.id)) return [{ type: 'credential', id: str(c.id)!, method: str(c.method) ?? 'key' }];
    if (c?.type === 'env' && str(c.name)) return [{ type: 'env', name: str(c.name)! }];
    return [];
  });
  return {
    id, name: str(x.name) ?? id,
    key: methods.some((m) => m.type === 'key'),
    logins: methods.flatMap((m) => (m.type === 'oauth' && str(m.id) ? [{ id: str(m.id)!, label: str(m.label) ?? str(m.id)!, form: fieldsOf(m.form) }] : [])),
    env: methods.flatMap((m) => (m.type === 'env' && Array.isArray(m.names) ? m.names.filter((n): n is string => typeof n === 'string') : [])),
    connections,
  };
};
/** スラッシュコマンドとスキルの 1 行（名前と説明。説明が無ければ空）。 */
export type OpencodeSlashInfo = { name: string; description: string };

/** 一覧の行。`{ data }` で包んだものと、包まない配列の両方を読む（2.1.4 の command と skill の答えの包みは実物で確かめていない）。 */
const slashRows = (r: unknown): Record<string, unknown>[] => (Array.isArray(r) ? r.filter((x): x is Record<string, unknown> => !!x && typeof x === 'object') : rowsOf(r));

const rowsOf = (r: unknown): Record<string, unknown>[] => {
  const data = (r as { data?: unknown } | null)?.data;
  return Array.isArray(data) ? data.filter((x): x is Record<string, unknown> => !!x && typeof x === 'object') : [];
};

/**
 * 許可を待っている 1 件（`GET /api/permission/request` と `permission.asked` の data）。
 * action は道具の名前（2.x の Bash は `shell`）、resources は許すかを聞いている中身（shell なら命令の全文）である。
 */
export type OpencodePermissionRequest = { id: string; sessionID: string; action: string; resources: string[] };

/** form（question の道具など）の 1 項目。description が問いの文、title は短い見出しである。 */
export type OpencodeFormField = { key: string; title?: string; description?: string };

/**
 * 答えを待っている form の 1 件（`GET /api/form` と `form.created` の data.form）。
 * question の道具の form は metadata.kind が `question` で、metadata.tool.id が道具の呼び出しの ID である。
 */
export type OpencodeForm = { id: string; sessionID: string; title: string; metadata?: { kind?: string; tool?: { id?: string } }; fields: OpencodeFormField[] };

export class OpencodeClient {
  constructor(private readonly serve: { url: string; password: string; directory?: string | null }, private readonly o: OpencodeClientOptions = {}) {}

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
      const context = num(objOf(x.limit)?.context);
      return providerID && id ? [{
        providerID, id, name: str(x.name) ?? id, enabled: x.enabled !== false,
        tools: objOf(x.capabilities)?.tools !== false,
        context: context ? context : null,
        cost: firstCost(x.cost),
      }] : [];
    });
  }

  /** その場所でつながっているプロバイダー。 */
  async providers(directory: string): Promise<OpencodeProviderInfo[]> {
    const r = await this.request('GET', `/api/provider${at(directory)}`);
    return rowsOf(r).flatMap((x) => {
      const id = str(x.id);
      return id ? [{ id, name: str(x.name) ?? id, host: hostOf(str(objOf(x.settings)?.baseURL)) }] : [];
    });
  }

  /** その場所のプロバイダーの行（設定のプロバイダーの面）。settings の apiKey は読まない。 */
  async providerRows(directory: string): Promise<OpencodeProviderRow[]> {
    const r = await this.request('GET', `/api/provider${at(directory)}`);
    return rowsOf(r).flatMap((x) => {
      const id = str(x.id);
      return id ? [{ id, integrationID: str(x.integrationID) ?? id, name: str(x.name) ?? id, activation: str(x.activation) ?? 'enabled', baseURL: str(objOf(x.settings)?.baseURL) }] : [];
    });
  }

  /** opencode が知っている integration（プロバイダーのカタログ）の全部。 */
  async integrations(directory: string): Promise<OpencodeIntegrationInfo[]> {
    const r = await this.request('GET', `/api/integration${at(directory)}`);
    return rowsOf(r).flatMap((x) => integrationOf(x) ?? []);
  }

  /** 1 つの integration。知らない ID なら null（opencode は 404 を返す）。 */
  async integration(id: string, directory: string): Promise<OpencodeIntegrationInfo | null> {
    try {
      const r = await this.request('GET', `/api/integration/${encodeURIComponent(id)}${at(directory)}`);
      const data = objOf(objOf(r)?.data);
      return data ? integrationOf(data) : null;
    } catch (e) {
      if (e instanceof OpencodeApiError && e.status === 404) return null;
      throw e;
    }
  }

  /**
   * API キーで接続する。opencode は新しい接続を作って有効にし、前の接続は無効にして残す（消すのは呼び手）。
   * API キーは本文にだけ載せ、断りの文からは伏せる。
   */
  async connectKey(id: string, key: string, directory: string): Promise<void> {
    await this.request('POST', `/api/integration/${encodeURIComponent(id)}/connect/key${at(directory)}`, { key }, [key]);
  }

  /** 接続の記録を 1 つ消す。 */
  async deleteCredential(credentialId: string): Promise<void> {
    await this.request('DELETE', `/api/credential/${encodeURIComponent(credentialId)}`);
  }

  /** ログインを始める。answer はその方法の入力の欄への答え。 */
  async oauthStart(id: string, methodId: string, answer: Record<string, unknown>, directory: string): Promise<OpencodeOauthAttempt> {
    const r = await this.request('POST', `/api/integration/${encodeURIComponent(id)}/connect/oauth${at(directory)}`, { methodID: methodId, ...(Object.keys(answer).length ? { answer } : {}) });
    const d = objOf(objOf(r)?.data);
    const attemptId = str(d?.attemptID);
    if (!d || !attemptId) throw new OpencodeApiError(200, '/api/integration/{id}/connect/oauth', 'the answer has no attempt id');
    return { attemptId, url: str(d.url) ?? '', instructions: str(d.instructions) ?? '', mode: d.mode === 'code' ? 'code' : 'auto' };
  }

  /** ログインの進み。 */
  async oauthStatus(id: string, attemptId: string, directory: string): Promise<OpencodeOauthStatus> {
    const r = await this.request('GET', `/api/integration/${encodeURIComponent(id)}/connect/oauth/${encodeURIComponent(attemptId)}${at(directory)}`);
    const d = objOf(objOf(r)?.data);
    const status = d?.status === 'complete' || d?.status === 'failed' || d?.status === 'expired' ? d.status : 'pending';
    return { status, message: str(d?.message) };
  }

  /** コードを入れる型のログインを終える。 */
  async oauthComplete(id: string, attemptId: string, code: string | null, directory: string): Promise<void> {
    await this.request('POST', `/api/integration/${encodeURIComponent(id)}/connect/oauth/${encodeURIComponent(attemptId)}/complete${at(directory)}`, { code }, code ? [code] : []);
  }

  /** ログインを取り消す。 */
  async oauthCancel(id: string, attemptId: string, directory: string): Promise<void> {
    await this.request('DELETE', `/api/integration/${encodeURIComponent(id)}/connect/oauth/${encodeURIComponent(attemptId)}${at(directory)}`);
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

  /**
   * その場所で使えるスラッシュコマンド（`GET /api/command`、2.1.4 の Command.Info は name と省ける description）。
   * スマホの `/` の候補に使う。
   */
  async commands(directory: string): Promise<OpencodeSlashInfo[]> {
    const r = await this.request('GET', `/api/command${at(directory)}`);
    return slashRows(r).flatMap((x) => {
      const name = str(x.name);
      return name ? [{ name, description: str(x.description) ?? '' }] : [];
    });
  }

  /**
   * その場所で使えるスキル（`GET /api/skill`、2.1.4 の Skill.Info）。本文（content）とパスは読まない。
   * スマホの `/` の候補に使う。
   */
  async skills(directory: string): Promise<OpencodeSlashInfo[]> {
    const r = await this.request('GET', `/api/skill${at(directory)}`);
    return slashRows(r).flatMap((x) => {
      const name = str(x.name) ?? str(x.id);
      return name ? [{ name, description: str(x.description) ?? '' }] : [];
    });
  }

  /** いま動いている会話の ID。`GET /api/session/active` は動いている間の会話だけを鍵に持つ。 */
  async active(): Promise<Set<string>> {
    const r = await this.request('GET', '/api/session/active') as { data?: unknown } | null;
    const data = r?.data;
    return new Set(data && typeof data === 'object' && !Array.isArray(data) ? Object.keys(data) : []);
  }

  /**
   * 会話 1 つの情報（`GET /api/session/{id}`）のうち、hangar が使う場所（2.1.4 は `location.directory`）。
   * 無い会話は OpencodeApiError（404）で投げる。場所の書いていない答えは null にする。
   */
  async session(sessionId: string): Promise<{ id: string; directory: string | null }> {
    const r = await this.request('GET', `/api/session/${encodeURIComponent(sessionId)}`) as { data?: { id?: unknown; location?: { directory?: unknown }; directory?: unknown } } | null;
    const d = r?.data;
    return { id: str(d?.id) ?? sessionId, directory: str(d?.location?.directory) ?? str(d?.directory) };
  }

  /** 会話の作業を止める（`POST /api/session/{id}/interrupt`）。動いていなくても 200 で答える。 */
  async interrupt(sessionId: string): Promise<void> {
    await this.request('POST', `/api/session/${encodeURIComponent(sessionId)}/interrupt`, {});
  }

  /**
   * その場所（directory）で許可を待っている確認。会話の下のサブエージェントの確認も、同じ場所なら載る。
   * 2.1.4 は場所を文字列のまま照らす（シンボリックリンクを解いた形は別の場所になる）ので、会話を作ったときと同じ形で渡す。
   * 形の合わない行は捨てる。
   */
  async permissionRequests(directory: string): Promise<OpencodePermissionRequest[]> {
    const r = await this.request('GET', `/api/permission/request?${locationQuery(directory)}`) as { data?: unknown } | null;
    return (Array.isArray(r?.data) ? r.data : []).flatMap((x) => { const p = permissionRequestOf(x); return p ? [p] : []; });
  }

  /** その場所（directory）で答えを待っている form。形の合わない行は捨てる。 */
  async forms(directory: string): Promise<OpencodeForm[]> {
    const r = await this.request('GET', `/api/form?${locationQuery(directory)}`) as { data?: unknown } | null;
    return (Array.isArray(r?.data) ? r.data : []).flatMap((x) => { const f = formOf(x); return f ? [f] : []; });
  }

  /**
   * 会話の本文の 1 ページ（`GET /api/session/{id}/message`）。メッセージは新しい順に並ぶ。
   * next は次の（より古い）ページの印で、無ければ null。2.1.4 は最後のページの後にもう 1 つ空のページを返し、その印が null になる。
   * 形の合わない行は捨てずに返す（変換が知らない種類を meta にする）。
   */
  async messages(sessionId: string, o: { limit: number; cursor?: string | null }): Promise<{ data: unknown[]; next: string | null }> {
    const q = new URLSearchParams({ limit: String(o.limit), ...(o.cursor ? { cursor: o.cursor } : {}) });
    const r = await this.request('GET', `/api/session/${encodeURIComponent(sessionId)}/message?${q.toString()}`) as { data?: unknown; cursor?: { next?: unknown } } | null;
    const data = Array.isArray(r?.data) ? r.data : [];
    return { data, next: str(r?.cursor?.next) };
  }

  /**
   * serve の出来事の流れ（`GET /api/event`、SSE）を開く。返すのは本文の流れで、読み終えるか signal で切るまで続く。
   * 上限の時間は付けない（流れは開いたままにするものなので）。つながらなければ投げる。
   */
  async events(signal: AbortSignal): Promise<ReadableStream<Uint8Array>> {
    const r = await fetch(this.serve.url + '/api/event', { headers: { ...serveHeaders(this.serve), accept: 'text/event-stream' }, signal });
    if (!r.ok || !r.body) {
      const text = await r.text().catch(() => '');
      throw new OpencodeApiError(r.status, '/api/event', text.split(this.serve.password).join('***').slice(0, 300));
    }
    return r.body;
  }

  /** secrets は断りの文から伏せる値（パスワードのほかに、本文に載せた API キーなど）。 */
  private async request(method: string, p: string, body?: unknown, secrets: string[] = []): Promise<unknown> {
    const r = await fetch(this.serve.url + p, {
      method,
      headers: { ...serveHeaders(this.serve), ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(this.o.timeoutMs ?? 10_000),
    });
    const text = await r.text();
    const route = p.split('?')[0] ?? p;
    if (!r.ok) {
      const detail = [this.serve.password, ...secrets].filter(Boolean).reduce((t, s) => t.split(s).join('***'), text);
      throw new OpencodeApiError(r.status, route, detail.slice(0, 300));
    }
    if (!text) return null;
    try {
      return JSON.parse(text) as unknown;
    } catch {
      throw new OpencodeApiError(r.status, route, 'the answer is not JSON');
    }
  }
}

/** 場所の指定。`location[directory]=` の形で渡す（JSON の文字列だと 400）。 */
const locationQuery = (directory: string): string => `${encodeURIComponent('location[directory]')}=${encodeURIComponent(directory)}`;

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** 許可の確認の 1 件を読む。API の答えと `permission.asked` の data は同じ形である。読めなければ null。 */
export function permissionRequestOf(v: unknown): OpencodePermissionRequest | null {
  if (!isObj(v)) return null;
  const id = str(v.id);
  const sessionID = str(v.sessionID);
  const action = str(v.action);
  if (!id || !sessionID || !action) return null;
  const resources = Array.isArray(v.resources) ? v.resources.filter((x): x is string => typeof x === 'string') : [];
  return { id, sessionID, action, resources };
}

/** form の 1 件を読む。API の答えと `form.created` の data.form は同じ形である。読めなければ null。 */
export function formOf(v: unknown): OpencodeForm | null {
  if (!isObj(v)) return null;
  const id = str(v.id);
  const sessionID = str(v.sessionID);
  if (!id || !sessionID) return null;
  const fields = (Array.isArray(v.fields) ? v.fields : []).flatMap((f): OpencodeFormField[] => {
    if (!isObj(f) || !str(f.key)) return [];
    return [{ key: f.key as string, ...(str(f.title) ? { title: f.title as string } : {}), ...(str(f.description) ? { description: f.description as string } : {}) }];
  });
  const m = isObj(v.metadata) ? v.metadata : null;
  const tool = m && isObj(m.tool) && str(m.tool.id) ? { id: m.tool.id as string } : undefined;
  const metadata = m ? { ...(str(m.kind) ? { kind: m.kind as string } : {}), ...(tool ? { tool } : {}) } : undefined;
  return { id, sessionID, title: str(v.title) ?? '', ...(metadata ? { metadata } : {}), fields };
}
