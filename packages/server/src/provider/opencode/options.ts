import type { OpencodeModelOption, OpencodeModeOption, OpencodeOptionsDto, OpencodeProviderOption, OpencodeProviderWhere, OpencodeStatusDto } from '@agent-hangar/shared';
import type { CatalogModel } from './catalog.ts';
import { OpencodeApiError, OpencodeClient, type OpencodeAgentInfo, type OpencodeModelInfo, type OpencodeProviderInfo, type OpencodeSlashInfo } from './client.ts';
import type { LocalModelListing } from './localModels/available.ts';
import type { ServeInfo } from './serve/manager.ts';

/**
 * 新しいセッションで opencode を選んだときの選択肢（docs/design.md「opencode の起動」の「選択肢」）。
 * モードとモデルは opencode の serve の API からしか取れない。起きている serve があればそれに聞き、1 本も無ければ待ち行列で 1 本起こして聞き、聞き終えたら止める。
 * serve を起こすのは 1〜2 秒かかるので、取った一覧は場所ごとに手元に持ち、間もなければそれを返す。スマホ（F2）は last で手元の一覧だけを読む。
 */

/** 選択肢を聞くためだけに起こす serve の鍵。hangar の会話の ID とは重ならない綴りにする。 */
export const OPTIONS_SERVE_KEY = ':options';

/** 一覧を取り直さずに返す間。 */
const FRESH_MS = 60_000;
/** モードの説明を切る長さ（opencode の既定のエージェントの説明は長い英文である）。 */
const DESCRIPTION_MAX = 120;

/**
 * serve から読んだ素の一覧。
 * commands と skills はスマホの `/` の候補（F2）に使う。道の無い版や読めなかったときは空で、省いても空と同じ。
 * baseURLs はプロバイダーの ID ごとの baseURL（`/api/provider` の行か、設定の層）。この PC のモデルの有無を聞くのに使う。省けば聞かない。
 */
export type OpencodeOptionsRaw = { agents: OpencodeAgentInfo[]; models: OpencodeModelInfo[]; providers: OpencodeProviderInfo[]; defaultModel: string | null; commands?: OpencodeSlashInfo[]; skills?: OpencodeSlashInfo[]; baseURLs?: Record<string, string> };

/** スマホの `/` の候補の 1 行。kind は opencode のスラッシュコマンドか、スキルか。 */
export type OpencodeSlashCommand = { name: string; description: string; kind: 'command' | 'skill' };

export type OpencodeOptionsDeps = {
  /** serve の管理（serve/manager.ts の ServeManager）。 */
  serves: { any(): ServeInfo | null; ensure(key: string, config?: { directory?: string }): Promise<ServeInfo>; stop(key: string): Promise<void> };
  /** 手元の opencode の版（設定の検出と同じ口）。 */
  status: () => Promise<OpencodeStatusDto>;
  /** 場所を省いたときに聞く場所。 */
  home: string;
  now?: () => number;
  freshMs?: number;
  /** エージェントの一覧が空のときに聞き直す回数と間。2.1.4 は場所ごとの最初の問いに空の一覧を返すことがある。 */
  emptyRetries?: number;
  retryMs?: number;
  requestTimeoutMs?: number;
  /** serve から読む口。試験が差し替える。 */
  read?: (serve: ServeInfo, directory: string) => Promise<OpencodeOptionsRaw>;
  /**
   * models.dev のカタログ（catalog.ts の ModelsDevCatalog）。opencode が料金やコンテキストを返さないモデルを埋める。
   * 一覧を取るたびに refresh を頼むが、待たない（取れた分は次の一覧から使う）。省けば埋めない。
   */
  catalog?: { refresh(): Promise<boolean>; current(): { fetchedAt: number } | null; lookup(provider: string, model: string): CatalogModel | null };
  /** この PC のローカルのサーバー（LM Studio など）にあるモデルを聞く口（localModels/available.ts）。無いモデルに missing を立てる。省けば立てない。 */
  listing?: LocalModelListing;
};

type Cached = { dto: OpencodeOptionsDto; at: number; commands: OpencodeSlashCommand[] };

export class OpencodeOptionsService {
  private readonly cache = new Map<string, Cached>();
  private lastDir: string | null = null;
  /** 取りに行くのは 1 度に 1 つ。選択肢のための serve を、ほかの問いの最中に止めないためである。 */
  private chain: Promise<unknown> = Promise.resolve();

  constructor(private readonly deps: OpencodeOptionsDeps) {}

  /**
   * その場所の選択肢。間もなく取ったものがあればそれを返す。取れなければ手元の一覧を stale で返し、手元にも無ければ投げる。
   * refresh を立てると、間もなくても取り直す（モデルの小窓の LM Studio の「再読み込み」）。
   */
  async get(dir: string | null, o: { refresh?: boolean } = {}): Promise<OpencodeOptionsDto> {
    const directory = dir || this.deps.home;
    const hit = this.cache.get(directory);
    if (hit && !o.refresh && this.now() - hit.at < this.freshMs()) return hit.dto;
    const run = this.chain.then(() => this.fetch(directory, o.refresh === true));
    this.chain = run.catch(() => undefined);
    try {
      return await run;
    } catch (e) {
      const kept = this.cache.get(directory);
      if (kept) return { ...kept.dto, stale: true };
      throw e;
    }
  }

  /**
   * 手元に持った選択肢を古いことにする。設定でプロバイダーを変えたあと、次の get で取り直させる。
   * 捨てはしないので、last（スマホ）は取り直すまで前の一覧を stale で返せる。
   */
  forget(): void {
    for (const [k, v] of this.cache) this.cache.set(k, { ...v, at: Number.NEGATIVE_INFINITY });
  }

  /**
   * 手元に持った選択肢（取りに行かない）。スマホの問い合わせは 5 秒しか待てないので、これを答える。
   * 場所を省くとホームの一覧、それも無ければ最後に取った一覧を返す。間が空いていれば stale にする。
   */
  last(dir: string | null): OpencodeOptionsDto | null {
    const c = this.cached(dir);
    if (!c) return null;
    return this.now() - c.at < this.freshMs() ? c.dto : { ...c.dto, stale: true };
  }

  /**
   * 手元に持ったスラッシュコマンドとスキル（取りに行かない）。スマホの `/` の候補に答える。
   * 場所の選び方は last と同じ。一覧を取ったことが無ければ null。
   */
  lastCommands(dir: string | null): OpencodeSlashCommand[] | null {
    return this.cached(dir)?.commands ?? null;
  }

  private cached(dir: string | null): Cached | undefined {
    return this.cache.get(dir || this.deps.home) ?? (dir ? undefined : this.lastDir !== null ? this.cache.get(this.lastDir) : undefined);
  }

  /**
   * モデル（`provider/model` の ID）のコンテキストの長さ（トークン）。右欄のコンテキストの帯の分母になる（計画の C5）。
   * 取りに行かない。手元に持ったどこかの場所の一覧にあればその値を、無ければ models.dev のカタログを引く。どちらにも無ければ null。
   * opencode の本文（メッセージ）には文脈の大きさが無いので、索引が使用量を書くときにここから引く。
   */
  contextOf(model: string): number | null {
    for (const c of this.cache.values()) {
      const hit = c.dto.models.find((m) => m.id === model && m.context !== null);
      if (hit) return hit.context;
    }
    const slash = model.indexOf('/');
    if (slash <= 0) return null;
    return this.deps.catalog?.lookup(model.slice(0, slash), model.slice(slash + 1))?.context ?? null;
  }

  private async fetch(directory: string, fresh: boolean): Promise<OpencodeOptionsDto> {
    const raw = await this.withServe(directory, (serve) => this.readWithRetry(serve, directory));
    const status = await this.deps.status().catch(() => ({ found: true, version: null, verified: false }));
    const at = this.now();
    const catalog = this.deps.catalog;
    void catalog?.refresh().catch(() => false);
    const options = optionsOf(raw, catalog ? (p, m) => catalog.lookup(p, m) : undefined);
    if (this.deps.listing) options.models = await markMissing(this.deps.listing, options.models, raw.baseURLs ?? {}, fresh);
    const dto: OpencodeOptionsDto = { version: status.version, verified: status.verified, ...options, pricesAt: catalog?.current()?.fetchedAt ?? null, fetchedAt: at, stale: false };
    const commands: OpencodeSlashCommand[] = [
      ...(raw.commands ?? []).map((c) => ({ ...c, kind: 'command' as const })),
      ...(raw.skills ?? []).map((c) => ({ ...c, kind: 'skill' as const })),
    ];
    this.cache.set(directory, { dto, at, commands });
    this.lastDir = directory;
    return dto;
  }

  /** 起きている serve があればそれで、無ければ聞く場所で 1 本起こして聞き、聞き終えたら（失敗しても）止める。 */
  private async withServe<T>(directory: string, f: (serve: ServeInfo) => Promise<T>): Promise<T> {
    const live = this.deps.serves.any();
    if (live) return f(live);
    const serve = await this.deps.serves.ensure(OPTIONS_SERVE_KEY, { directory });
    try {
      return await f(serve);
    } finally {
      await this.deps.serves.stop(OPTIONS_SERVE_KEY).catch(() => undefined);
    }
  }

  private async readWithRetry(serve: ServeInfo, directory: string): Promise<OpencodeOptionsRaw> {
    const read = this.deps.read ?? ((s: ServeInfo, d: string) => readOptions(new OpencodeClient(s, { timeoutMs: this.deps.requestTimeoutMs }), d));
    const tries = (this.deps.emptyRetries ?? 5) + 1;
    let raw = await read(serve, directory);
    for (let i = 1; i < tries && raw.agents.length === 0; i++) {
      await new Promise<void>((r) => { setTimeout(r, this.deps.retryMs ?? 200); });
      raw = await read(serve, directory);
    }
    return raw;
  }

  private now(): number {
    return (this.deps.now ?? Date.now)();
  }

  private freshMs(): number {
    return this.deps.freshMs ?? FRESH_MS;
  }
}

/**
 * この PC のローカルのサーバーに無いモデルに missing を立てる。opencode.json のモデルは PC の間で共有されるので、ほかの PC にだけあるモデルも一覧に出る。
 * 聞くのはこの PC の宛先だけで、つながらないか確かめられなければ立てない（起動の口が断る）。
 */
async function markMissing(listing: LocalModelListing, models: OpencodeModelOption[], baseURLs: Record<string, string>, fresh: boolean): Promise<OpencodeModelOption[]> {
  const ids = [...new Set(models.map((m) => m.provider))];
  const have = new Map(await Promise.all(ids.map(async (id) => {
    const r = await listing.list(baseURLs[id] ?? null, { fresh });
    return [id, r.kind === 'listed' ? new Set(r.models) : null] as const;
  })));
  return models.map((m) => {
    const set = have.get(m.provider);
    return set && !set.has(m.id.slice(m.provider.length + 1)) ? { ...m, missing: true } : m;
  });
}

/** serve から一覧を読む。設定を先に読むのは、その場所の読み込みを始めさせるため（2.1.4 は場所ごとの最初の問いに空の一覧を返すことがある）。 */
export async function readOptions(client: OpencodeClient, directory: string): Promise<OpencodeOptionsRaw> {
  const defaultModel = await client.configuredModel(directory);
  const [agents, models, providers, commands, skills, rows, configured] = await Promise.all([
    client.agents(directory),
    client.models(directory),
    client.providers(directory),
    slashOrEmpty(client.commands(directory)),
    slashOrEmpty(client.skills(directory)),
    client.providerRows(directory).catch(() => []),
    client.configuredBaseURLs(directory).catch(() => new Map<string, string>()),
  ]);
  // 行の baseURL を先に使い、無ければ設定の層の baseURL を使う（launch.ts の providerURLs と同じ順）。
  const baseURLs = Object.fromEntries([...configured, ...rows.flatMap((r) => (r.baseURL ? [[r.id, r.baseURL] as const] : []))]);
  return { agents, models, providers, defaultModel, commands, skills, baseURLs };
}

/** スラッシュコマンドとスキルは候補の飾りなので、道の無い版（404）や読めないときは空にして、一覧そのものは取る。 */
async function slashOrEmpty(p: Promise<OpencodeSlashInfo[]>): Promise<OpencodeSlashInfo[]> {
  try {
    return await p;
  } catch (e) {
    if (!(e instanceof OpencodeApiError)) console.warn(`[opencode] could not list slash commands: ${(e as Error).message}`);
    return [];
  }
}

/**
 * 宛先の名前から、この PC（localhost、ループバック）か、内側の網（私用の IPv4、CGNAT、リンクローカル、ULA、.local、.lan、.internal、.home.arpa）か、それ以外かを決める。
 */
export function whereOfHost(host: string): OpencodeProviderWhere {
  const h = host.toLowerCase().replace(/^\[|\]$/g, '');
  if (h === 'localhost' || h === '::1' || h.endsWith('.localhost') || /^127\./.test(h)) return 'device';
  if (/\.(local|lan|internal|home\.arpa)$/.test(h)) return 'lan';
  if (/^(fc|fd)[0-9a-f]{2}:/.test(h) || h.startsWith('fe80:')) return 'lan';
  const m = /^(\d+)\.(\d+)\.\d+\.\d+$/.exec(h);
  if (!m) return 'remote';
  const a = Number(m[1]);
  const b = Number(m[2]);
  return a === 10 || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31) || (a === 169 && b === 254) || (a === 100 && b >= 64 && b <= 127) ? 'lan' : 'remote';
}

/** この PC で動くものとして知っているプロバイダー（URL が無くてもこの PC とする）。 */
const DEVICE_PROVIDERS = new Set(['lmstudio', 'ollama']);

/** プロバイダーの宛先。URL の宛先の名前（host）があればそれで決め、無ければ知っている ID（LM Studio、Ollama）だけをこの PC とする。 */
export function providerWhere(id: string, host: string | null): OpencodeProviderWhere {
  return host !== null ? whereOfHost(host) : DEVICE_PROVIDERS.has(id) ? 'device' : 'remote';
}

/**
 * 素の一覧を画面の選択肢にする。モードは隠れていない primary（と all）だけ、モデルは無効にされていないものだけを、opencode の並びのまま出す。
 * lookup を渡すと、opencode が料金やコンテキストを返さなかったモデルを、それで埋める。ツール呼び出しの対応は opencode の答えだけを使う。
 */
export function optionsOf(raw: OpencodeOptionsRaw, lookup?: (provider: string, model: string) => CatalogModel | null): Pick<OpencodeOptionsDto, 'modes' | 'models' | 'providers' | 'defaultModel'> {
  const modes: OpencodeModeOption[] = raw.agents
    .filter((a) => (a.mode === 'primary' || a.mode === 'all') && !a.hidden)
    .map((a) => ({ id: a.id, description: a.description === null ? null : clip(a.description) }));
  const names = new Map(raw.providers.map((p) => [p.id, p.name]));
  const models: OpencodeModelOption[] = raw.models
    .filter((m) => m.enabled)
    .map((m) => {
      const known = m.cost !== null && m.context !== null ? null : lookup?.(m.providerID, m.id) ?? null;
      return {
        id: `${m.providerID}/${m.id}`, label: m.name, group: names.get(m.providerID) ?? m.providerID, provider: m.providerID,
        tools: m.tools, context: m.context ?? known?.context ?? null, cost: m.cost ?? known?.cost ?? null,
      };
    });
  const providers: OpencodeProviderOption[] = raw.providers.map((p) => ({ id: p.id, name: p.name, where: providerWhere(p.id, p.host) }));
  return { modes, models, providers, defaultModel: raw.defaultModel };
}

const clip = (s: string): string => {
  const one = s.replace(/\s+/g, ' ').trim();
  return one.length > DESCRIPTION_MAX ? `${one.slice(0, DESCRIPTION_MAX - 1)}…` : one;
};
