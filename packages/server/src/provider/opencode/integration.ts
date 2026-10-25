import { orderProviderCatalog, providerFactOf, providerPriceOf, type OpencodeCatalogEntryDto, type OpencodeConnectedDto, type OpencodeConnectionVia, type OpencodeCustomProviderBody, type OpencodeLoginDto, type OpencodeLoginStatusDto, type OpencodeProvidersDto } from '@agent-hangar/shared';
import { JsonTextEditError, removeJsoncPath, setJsoncPath } from '../../config/jsonTextEdit.ts';
import type { CatalogFile } from './catalog.ts';
import { OpencodeClient, type OpencodeLoginField } from './client.ts';
import { configProviders, editOpencodeConfig } from './configFile.ts';
import { providerWhere } from './options.ts';
import type { ServeInfo } from './serve/manager.ts';

/**
 * 設定の「連携 › opencode › プロバイダー」（docs/design.md「opencode のプロバイダー」）。
 * つないだ先の一覧、API キーの接続と変更と解除、ログインは、opencode の serve の `/api/integration` と `/api/credential` に頼む。
 * API キーは opencode の integration に渡すだけで、hangar はファイル、DB、ログ、応答のどこにも書かない（opencode が自分の DB に保存する）。
 * `GET /api/credential` は API キーの値を返すので呼ばない。接続の記録は `/api/integration` の connections（値を含まない）から読む。
 * OpenAI 互換のサーバーとモデル ID の追加は、利用者の opencode.json に書く（configFile.ts。書く前にバックアップする）。
 * 問い合わせには専用の serve を 1 本起こし、使い終えて間が空いたら止める（ログインの途中の状態は serve のメモリにあるので、毎回は止めない）。
 */

/** 設定のプロバイダーの面のためだけに起こす serve の鍵。hangar の会話の ID とは重ならない綴りにする。 */
export const PROVIDERS_SERVE_KEY = ':providers';
/** OpenAI 互換のサーバーを足すときの opencode の package（2.1.4 の LM Studio と同じもの）。 */
export const OPENAI_COMPATIBLE_PACKAGE = '@opencode/ai/providers/openai-compatible';

/** 使い終えてから serve を止めるまでの間。 */
const IDLE_MS = 60_000;
/** opencode.json に足したプロバイダーが integration に現れるまで待つ長さ（opencode は書き換えを見張って読み直す）。 */
const APPEAR_MS = 10_000;
/** /v1/models を聞く時間の上限。 */
const MODELS_TIMEOUT_MS = 10_000;
/** opencode.json に書くモデルの数の上限。 */
const MAX_MODELS = 500;

/**
 * 画面に理由を出す断り。code ごとに辞書の文がある（http の経路が引く）。
 * unknown-provider は opencode が知らない ID、empty-key は空の API キー、bad-name は空の名前、bad-url は http(s) でない URL、bad-model は空のモデル ID、
 * models-unreachable は /v1/models に答えが無い、no-models は答えにモデルが無い、login-unsupported はログインの方法が無いか hangar で答えられない入力がある、
 * config-unreadable は opencode.json を読めない（書かない）。
 */
export type OpencodeProvidersErrorCode = 'unknown-provider' | 'empty-key' | 'bad-name' | 'bad-url' | 'bad-model' | 'models-unreachable' | 'no-models' | 'login-unsupported' | 'config-unreadable';

export class OpencodeProvidersError extends Error {
  constructor(readonly code: OpencodeProvidersErrorCode, detail = '') {
    super(`opencode providers: ${code}${detail ? `: ${detail}` : ''}`);
    this.name = 'OpencodeProvidersError';
  }
}

export type OpencodeProvidersDeps = {
  /** serve の管理（serve/manager.ts の ServeManager）。 */
  serves: { ensure(key: string, config?: { directory?: string }): Promise<ServeInfo>; stop(key: string): Promise<void> };
  /** 問い合わせの場所（location[directory]）。ホーム（ふだんの設定だけが効く場所）を渡す。 */
  home: string;
  /** 書き換える opencode.json（configFile.ts の opencodeConfigPath）。 */
  configFile: string;
  /** models.dev の保存（catalog.ts の ModelsDevCatalog）。追加の一覧の料金の型に使う。省けば料金を出さない。 */
  catalog?: { refresh(): Promise<boolean>; current(): CatalogFile | null };
  /** プロバイダーを変えたあとに呼ぶ（新しいセッションの選択肢を取り直させる）。 */
  onChange?: () => void;
  fetch?: typeof fetch;
  now?: () => Date;
  idleMs?: number;
  /** opencode.json に足したプロバイダーが現れるのを待つ長さと、聞く間。 */
  appearMs?: number;
  pollMs?: number;
  /** プロバイダーの一覧が空のときに聞き直す回数（間は pollMs）。 */
  emptyRetries?: number;
  requestTimeoutMs?: number;
};

const errMsg = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** 名前から opencode の ID を作る。英数字のほかは - にし、何も残らなければ openai-compatible。 */
function slugOf(name: string): string {
  const s = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40).replace(/-+$/, '');
  return s || 'openai-compatible';
}

/** URL の宛先の名前。読めなければ null。 */
const hostOf = (url: string | null): string | null => {
  if (!url) return null;
  try { return new URL(url).hostname || null; } catch { return null; }
};

/** ログインの方法の入力の欄に、hangar が決められる答え（隠れた欄の既定、選択肢の最初）を入れる。答えられない必須の欄があれば null。 */
export function defaultAnswer(fields: readonly OpencodeLoginField[]): Record<string, unknown> | null {
  const answer: Record<string, unknown> = {};
  for (const f of fields) {
    const shown = f.when.every((w) => (w.op === 'eq' ? answer[w.key] === w.value : w.op === 'neq' ? answer[w.key] !== w.value : false));
    if (!shown) continue;
    const v = f.default !== undefined ? f.default : f.options.length ? f.options[0] : undefined;
    if (v !== undefined) answer[f.key] = v;
    else if (f.required) return null;
  }
  return answer;
}

export class OpencodeProvidersService {
  private idleTimer: NodeJS.Timeout | null = null;
  private inUse = 0;
  /** 書き換えと接続は 1 度に 1 つ。opencode.json の読みと書きの間に、ほかの書き込みを挟まないためである。 */
  private chain: Promise<unknown> = Promise.resolve();

  constructor(private readonly deps: OpencodeProvidersDeps) {}

  /** つないだ先と、追加の一覧。 */
  list(): Promise<OpencodeProvidersDto> {
    return this.withClient((c) => this.read(c));
  }

  /** API キーで接続する。前の接続（API キーの変更）があれば、新しい接続が通ってから消す。 */
  connectKey(id: string, key: string): Promise<OpencodeProvidersDto> {
    const k = key.trim();
    return this.serial(() => this.withClient(async (c) => {
      if (!k) throw new OpencodeProvidersError('empty-key');
      await this.hiding([k], async () => {
        const integ = await c.integration(id, this.deps.home);
        if (!integ || !integ.key) throw new OpencodeProvidersError('unknown-provider', id);
        const before = integ.connections.flatMap((x) => (x.type === 'credential' ? [x.id] : []));
        await c.connectKey(id, k, this.deps.home);
        for (const cred of before) await c.deleteCredential(cred);
      });
      this.changed();
      return this.read(c);
    }));
  }

  /** 接続を解除する。API キーとログインの接続を消し、hangar が足せる形で opencode.json に書いたプロバイダーなら、そこからも消す。 */
  disconnect(id: string): Promise<OpencodeProvidersDto> {
    return this.serial(() => this.withClient(async (c) => {
      const integ = await c.integration(id, this.deps.home);
      for (const x of integ?.connections ?? []) if (x.type === 'credential') await c.deleteCredential(x.id);
      const inConfig = configProviders(this.deps.configFile).find((p) => p.id === id);
      if (inConfig) {
        this.editConfig((t) => removeJsoncPath(t, [inConfig.legacy ? 'provider' : 'providers', id]));
        // opencode は書き換えを見張って読み直すが、すぐではない。消えたのを見てから一覧を返す。
        await this.waitRows(c, (rows) => !rows.some((r) => r.id === id));
      }
      this.changed();
      return this.read(c);
    }));
  }

  /** モデル ID を追加する。opencode.json のそのプロバイダーの models に空のオブジェクトで足す。同じ ID があれば書かない。 */
  addModel(id: string, model: string): Promise<OpencodeProvidersDto> {
    const m = model.trim();
    return this.serial(() => this.withClient(async (c) => {
      if (!m) throw new OpencodeProvidersError('bad-model');
      const inConfig = configProviders(this.deps.configFile).find((p) => p.id === id);
      if (!inConfig?.models.includes(m)) {
        this.editConfig((t) => setJsoncPath(t, [inConfig?.legacy ? 'provider' : 'providers', id, 'models', m], {}));
        this.changed();
      }
      return this.read(c);
    }));
  }

  /**
   * OpenAI 互換のサーバーを足す。/v1/models からモデルを取り、opencode.json に書いてから、API キーがあれば integration に渡す。
   * URL の終わりに /v1 が無く、その下に models が無ければ /v1 を足して聞き直す。
   */
  addCustom(body: OpencodeCustomProviderBody): Promise<OpencodeProvidersDto> {
    const name = body.name.trim();
    const key = body.apiKey?.trim() ?? '';
    return this.serial(() => this.withClient(async (c) => {
      if (!name) throw new OpencodeProvidersError('bad-name');
      const found = await this.hiding([key], () => this.modelsAt(body.url, key));
      const [integrations, rows] = await Promise.all([c.integrations(this.deps.home), c.providerRows(this.deps.home)]);
      const taken = new Set([...integrations.map((x) => x.id), ...rows.map((x) => x.id), ...configProviders(this.deps.configFile).map((x) => x.id)]);
      const base = slugOf(name);
      let id = base;
      for (let n = 2; taken.has(id); n++) id = `${base}-${n}`;
      this.editConfig((t) => setJsoncPath(t, ['providers', id], {
        name, package: OPENAI_COMPATIBLE_PACKAGE, settings: { baseURL: found.baseURL }, models: Object.fromEntries(found.ids.map((m) => [m, {}])),
      }));
      if (key) {
        await this.hiding([key], async () => {
          await this.waitIntegration(c, id);
          await c.connectKey(id, key, this.deps.home);
        });
      }
      await this.waitRows(c, (rows) => rows.some((r) => r.id === id));
      this.changed();
      return this.read(c);
    }));
  }

  /** ログインを始める。methodId は opencode のログインの方法。入力の欄は hangar が決められる答え（隠れた欄の既定、選択肢の最初）で埋める。 */
  login(id: string, methodId: string): Promise<OpencodeLoginDto> {
    return this.withClient(async (c) => {
      const integ = await c.integration(id, this.deps.home);
      if (!integ) throw new OpencodeProvidersError('unknown-provider', id);
      const method = integ.logins.find((m) => m.id === methodId);
      const answer = method ? defaultAnswer(method.form) : null;
      if (!method || !answer) throw new OpencodeProvidersError('login-unsupported', id);
      return c.oauthStart(id, method.id, answer, this.deps.home);
    });
  }

  /** ログインの進み。終わったら、新しいセッションの選択肢を取り直させる。 */
  loginStatus(id: string, attemptId: string): Promise<OpencodeLoginStatusDto> {
    return this.withClient(async (c) => {
      const s = await c.oauthStatus(id, attemptId, this.deps.home);
      if (s.status === 'complete') this.changed();
      return s;
    });
  }

  /** コードを入れる型のログインを終える。 */
  loginComplete(id: string, attemptId: string, code: string): Promise<void> {
    const v = code.trim();
    return this.withClient(async (c) => {
      await this.hiding([v], () => c.oauthComplete(id, attemptId, v || null, this.deps.home));
      this.changed();
    });
  }

  /** ログインを取り消す。 */
  loginCancel(id: string, attemptId: string): Promise<void> {
    return this.withClient((c) => c.oauthCancel(id, attemptId, this.deps.home));
  }

  /** 止める（hangar の終わりと試験）。 */
  async close(): Promise<void> {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
    await this.deps.serves.stop(PROVIDERS_SERVE_KEY).catch(() => undefined);
  }

  private async read(c: OpencodeClient): Promise<OpencodeProvidersDto> {
    // 2.1.4 は場所ごとの最初の問いに空の一覧を返すことがある（OpenCode Zen の無料のモデルがあるので、本当に空になることは無い）。空なら少し待って聞き直す。
    let rows = await c.providerRows(this.deps.home);
    for (let i = 0; i < (this.deps.emptyRetries ?? 5) && rows.length === 0; i++) {
      await new Promise<void>((r) => { setTimeout(r, this.deps.pollMs ?? 250); });
      rows = await c.providerRows(this.deps.home);
    }
    const integrations = await c.integrations(this.deps.home);
    const config = configProviders(this.deps.configFile);
    void this.deps.catalog?.refresh().catch(() => false);
    const prices = this.deps.catalog?.current()?.providers ?? {};
    const costsOf = (id: string) => (Object.prototype.hasOwnProperty.call(prices, id) ? Object.values(prices[id]!).map((m) => m.cost) : null);
    const byId = new Map(integrations.map((x) => [x.id, x]));
    const connected: OpencodeConnectedDto[] = rows.map((p) => {
      const integ = byId.get(p.integrationID) ?? byId.get(p.id) ?? null;
      const creds = integ?.connections.filter((x) => x.type === 'credential') ?? [];
      const env = integ?.connections.find((x): x is { type: 'env'; name: string } => x.type === 'env') ?? null;
      const inConfig = config.find((x) => x.id === p.id) ?? null;
      const custom = !!inConfig?.baseURL;
      const via: OpencodeConnectionVia = custom ? 'config' : creds.some((x) => x.method === 'key') ? 'key' : creds.length ? 'login' : env ? 'env' : 'auto';
      const where = providerWhere(p.id, hostOf(p.baseURL));
      return {
        id: p.id, name: providerFactOf(p.id).name ?? p.name, via, envName: via === 'env' ? env!.name : null,
        url: custom || where !== 'remote' ? p.baseURL : null, where,
        price: providerPriceOf(p.id, costsOf(p.id), integ?.key ?? false),
        canChangeKey: !!integ?.key && (via === 'key' || via === 'config'),
        canDisconnect: creds.length > 0 || custom,
      };
    });
    const shown = new Set(connected.map((x) => x.id));
    const catalog: OpencodeCatalogEntryDto[] = orderProviderCatalog(
      integrations.filter((x) => !shown.has(x.id) && (x.key || x.logins.length)).map((x) => ({ id: x.id, name: providerFactOf(x.id).name ?? x.name, x })),
    ).map(({ id, name, recommended, x }) => ({
      id, name, recommended, key: x.key, logins: x.logins.map((m) => ({ id: m.id, label: m.label })), price: providerPriceOf(id, costsOf(id), x.key),
    }));
    return { connected, catalog, configPath: this.deps.configFile };
  }

  /** /v1/models を聞いてモデルの ID を返す。baseURL は opencode.json に書く URL（終わりの / を除いたもの）。 */
  private async modelsAt(raw: string, key: string): Promise<{ baseURL: string; ids: string[] }> {
    let url: URL;
    try { url = new URL(raw.trim()); } catch { throw new OpencodeProvidersError('bad-url'); }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new OpencodeProvidersError('bad-url');
    const base = url.toString().replace(/\/+$/, '');
    const tries = /\/v1$/.test(base) ? [base] : [base, `${base}/v1`];
    let last = '';
    for (const b of tries) {
      try {
        const r = await (this.deps.fetch ?? fetch)(`${b}/models`, {
          headers: { accept: 'application/json', ...(key ? { authorization: `Bearer ${key}` } : {}) },
          signal: AbortSignal.timeout(this.deps.requestTimeoutMs ?? MODELS_TIMEOUT_MS),
        });
        if (!r.ok) { last = `answered ${r.status}`; continue; }
        const j = await r.json() as { data?: unknown };
        const rows = Array.isArray(j?.data) ? j.data : [];
        const ids = [...new Set(rows.flatMap((x) => (x && typeof x === 'object' && typeof (x as { id?: unknown }).id === 'string' && (x as { id: string }).id ? [(x as { id: string }).id] : [])))];
        if (!ids.length) throw new OpencodeProvidersError('no-models');
        return { baseURL: b, ids: ids.slice(0, MAX_MODELS) };
      } catch (e) {
        if (e instanceof OpencodeProvidersError) throw e;
        last = errMsg(e);
      }
    }
    throw new OpencodeProvidersError('models-unreachable', last);
  }

  /** プロバイダーの行が ok を満たすまで待つ。待ちきれなくても投げない（一覧は次に開いたときに合う）。 */
  private async waitRows(c: OpencodeClient, ok: (rows: { id: string }[]) => boolean): Promise<void> {
    const until = Date.now() + (this.deps.appearMs ?? APPEAR_MS);
    while (!ok(await c.providerRows(this.deps.home)) && Date.now() < until) {
      await new Promise<void>((r) => { setTimeout(r, this.deps.pollMs ?? 250); });
    }
  }

  /** opencode.json に足したプロバイダーが integration に現れるまで待つ。 */
  private async waitIntegration(c: OpencodeClient, id: string): Promise<void> {
    const until = Date.now() + (this.deps.appearMs ?? APPEAR_MS);
    for (;;) {
      if (await c.integration(id, this.deps.home)) return;
      if (Date.now() > until) throw new OpencodeProvidersError('unknown-provider', id);
      await new Promise<void>((r) => { setTimeout(r, this.deps.pollMs ?? 250); });
    }
  }

  private editConfig(edit: (text: string) => string): void {
    try {
      editOpencodeConfig(this.deps.configFile, edit, (this.deps.now ?? (() => new Date()))());
    } catch (e) {
      if (e instanceof JsonTextEditError) throw new OpencodeProvidersError('config-unreadable');
      throw e;
    }
  }

  private changed(): void {
    try { this.deps.onChange?.(); } catch { /* 知らせる先の失敗は、接続の成否に関わらない */ }
  }

  /** f の中で投げた断りの文から、secrets を伏せる。 */
  private async hiding<T>(secrets: string[], f: () => Promise<T>): Promise<T> {
    try {
      return await f();
    } catch (e) {
      const live = secrets.filter(Boolean);
      if (!live.length || !(e instanceof Error) || !live.some((s) => e.message.includes(s))) throw e;
      const hidden = live.reduce((t, s) => t.split(s).join('***'), e.message);
      throw e instanceof OpencodeProvidersError ? new OpencodeProvidersError(e.code, hidden) : new Error(hidden);
    }
  }

  private serial<T>(f: () => Promise<T>): Promise<T> {
    const run = this.chain.then(f);
    this.chain = run.catch(() => undefined);
    return run;
  }

  /** 専用の serve で聞く。使い終えて idleMs の間だれも使わなければ止める。 */
  private async withClient<T>(f: (c: OpencodeClient) => Promise<T>): Promise<T> {
    this.inUse++;
    if (this.idleTimer) { clearTimeout(this.idleTimer); this.idleTimer = null; }
    try {
      const serve = await this.deps.serves.ensure(PROVIDERS_SERVE_KEY, { directory: this.deps.home });
      return await f(new OpencodeClient(serve, { timeoutMs: this.deps.requestTimeoutMs }));
    } finally {
      this.inUse--;
      if (this.inUse === 0) {
        this.idleTimer = setTimeout(() => {
          this.idleTimer = null;
          if (this.inUse === 0) void this.deps.serves.stop(PROVIDERS_SERVE_KEY).catch(() => undefined);
        }, this.deps.idleMs ?? IDLE_MS);
        this.idleTimer.unref?.();
      }
    }
  }
}

