import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { LaunchPrepChoice } from '@agent-hangar/shared';
import type { LaunchPrep } from '../../../runs/launchPrep.ts';
import { whereOfHost } from '../options.ts';
import { LmStudio, type LmModel } from './lmstudio.ts';
import { planLocalModels, type OwnedInstance, type PlanAction, type WantedModel } from './plan.ts';

/**
 * 起動前に、会話が使うローカルのモデルを LM Studio に足りる長さで載せる（docs/design.md「起動前の準備」）。
 * 触るのはこの PC（127.0.0.1、localhost）の宛先だけである。LAN の LM Studio はほかの人の PC かもしれないので触らない。
 * LM Studio ではない宛先（`/api/v1/models` が 404、つながらない）は黙って飛ばす。起動後に落ちたときは live.ts の検出が拾う。
 * hangar が載せた instance は、ホームの opencode/local-models.json に、宛先と、使った hangar の会話と一緒に記録する。
 */

export type LocalModelsDeps = {
  /** hangar のホーム。記録の置き場。 */
  home: string;
  /** 設定の長さ（opencodeLocalContext）。呼ばれた時点の値を読む。 */
  context: () => number;
  /** その hangar の会話がいま動いているか。動いている会話のモデルは外さない。 */
  isRunning: (hangarSessionId: string) => boolean;
  totalmem?: () => number;
  fetch?: typeof fetch;
};

/** 会話が使うモデル 1 つ。ref は `provider/model`、uses はそれを使う agent（'$session'、'$small' を含む）。 */
export type LocalModelUse = { ref: string; uses: string[] };

export type PrepareInput = {
  hangarSessionId: string;
  uses: LocalModelUse[];
  /** opencode のプロバイダーの baseURL。 */
  providers: { id: string; baseURL: string | null }[];
  /** opencode の limit.context を ref で引く。 */
  limits: ReadonlyMap<string, number>;
  choice: LaunchPrepChoice;
  prep: Pick<LaunchPrep, 'step' | 'ask' | 'signal' | 'throwIfCancelled'>;
  /** 使うモデルが短く載っていれば、手で載せたものでも載せ直す（plan.ts の reloadShort）。 */
  reloadShort?: boolean;
};

/** 載せてよいメモリの割合。モデルの重みのほかに KV キャッシュと OS の分が要る。 */
const MEMORY_SHARE = 0.8;

type LedgerEntry = { origin: string; instanceId: string; model: string; sessions: string[] };

export const ledgerPath = (home: string): string => path.join(home, 'opencode', 'local-models.json');

function readLedger(home: string): LedgerEntry[] {
  try {
    const j = JSON.parse(fs.readFileSync(ledgerPath(home), 'utf8')) as { entries?: unknown };
    return Array.isArray(j.entries) ? j.entries.filter((e): e is LedgerEntry => !!e && typeof e === 'object' && typeof (e as LedgerEntry).origin === 'string' && typeof (e as LedgerEntry).instanceId === 'string' && Array.isArray((e as LedgerEntry).sessions)) : [];
  } catch {
    return [];
  }
}

function writeLedger(home: string, entries: LedgerEntry[]): void {
  const file = ledgerPath(home);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify({ entries }, null, 2)}\n`);
}

/** ref の最初の / で割る。 */
const split = (ref: string): { provider: string; model: string } | null => {
  const i = ref.indexOf('/');
  return i > 0 && i < ref.length - 1 ? { provider: ref.slice(0, i), model: ref.slice(i + 1) } : null;
};

/** baseURL のうち、この PC のものの origin。ほかは null。 */
function deviceOrigin(baseURL: string | null): string | null {
  if (!baseURL) return null;
  try {
    const u = new URL(baseURL);
    return (u.protocol === 'http:' || u.protocol === 'https:') && whereOfHost(u.hostname) === 'device' ? u.origin : null;
  } catch {
    return null;
  }
}

export async function prepareLocalModels(deps: LocalModelsDeps, input: PrepareInput): Promise<void> {
  if (input.choice.skip) return;
  const byOrigin = new Map<string, WantedModel[]>();
  const refs = new Map<string, string>();
  for (const u of input.uses) {
    const r = split(u.ref);
    const origin = r ? deviceOrigin(input.providers.find((p) => p.id === r.provider)?.baseURL ?? null) : null;
    if (!r || !origin) continue;
    const list = byOrigin.get(origin) ?? [];
    list.push({ model: r.model, uses: u.uses, limit: input.limits.get(u.ref) ?? null });
    refs.set(r.model, u.ref);
    byOrigin.set(origin, list);
  }
  for (const [origin, wanted] of byOrigin) await prepareAt(deps, input, origin, wanted, refs);
}

async function prepareAt(deps: LocalModelsDeps, input: PrepareInput, origin: string, wanted: WantedModel[], refs: ReadonlyMap<string, string>): Promise<void> {
  const lm = new LmStudio(origin, { fetch: deps.fetch });
  const models = await lm.list(input.prep.signal);
  input.prep.throwIfCancelled();
  if (!models) return;
  const ledger = pruneLedger(readLedger(deps.home), origin, models);
  const owned = new Map<string, OwnedInstance>(ledger.filter((e) => e.origin === origin).map((e) => [e.instanceId, { protected: e.sessions.some((s) => s !== input.hangarSessionId && deps.isRunning(s)) }]));
  const plan = planLocalModels({
    wanted, models, owned, choice: input.choice, reloadShort: input.reloadShort,
    context: deps.context(),
    memLimitBytes: (deps.totalmem ?? os.totalmem)() * MEMORY_SHARE,
  });
  // 計画は LM Studio の名前で考える。勧めるモデルは、答えにそのまま入れられるよう opencode の指定に直す。
  if (plan.ask) input.prep.ask(plan.ask.kind === 'memory' ? { ...plan.ask, suggestRef: refs.get(plan.ask.suggest) ?? plan.ask.suggest } : plan.ask);
  let entries = ledger;
  const save = () => { writeLedger(deps.home, entries); };
  // 足りていたもののうち hangar が載せたものは、この会話も使うと記録する（ほかの会話の起動で外されないため）。
  for (const w of wanted) {
    for (const x of models.find((m) => m.key === w.model)?.instances ?? []) {
      entries = entries.map((e) => (e.origin === origin && e.instanceId === x.id && !e.sessions.includes(input.hangarSessionId) ? { ...e, sessions: [...e.sessions, input.hangarSessionId] } : e));
    }
  }
  try {
    for (const a of plan.actions) entries = await run(lm, input, origin, a, entries);
  } finally {
    save();
  }
}

/** 記録のうち、その宛先で今は載っていないもの（利用者が外した、LM Studio を起こし直した）を捨てる。 */
function pruneLedger(entries: LedgerEntry[], origin: string, models: LmModel[]): LedgerEntry[] {
  const live = new Set(models.flatMap((m) => m.instances.map((x) => x.id)));
  return entries.filter((e) => e.origin !== origin || live.has(e.instanceId));
}

async function run(lm: LmStudio, input: PrepareInput, origin: string, a: PlanAction, entries: LedgerEntry[]): Promise<LedgerEntry[]> {
  input.prep.throwIfCancelled();
  const step = input.prep.step('local-model', a.model, a.kind);
  if (a.kind !== 'unload') step.update({ toContext: a.to, fromContext: a.kind === 'reload' ? a.from : null });
  try {
    let next = entries;
    if (a.kind !== 'load') {
      await lm.unload(a.instanceId, input.prep.signal);
      next = next.filter((e) => !(e.origin === origin && e.instanceId === a.instanceId));
    }
    if (a.kind !== 'unload') {
      const id = await lm.load(a.model, a.to, input.prep.signal);
      next = [...next.filter((e) => !(e.origin === origin && e.instanceId === id)), { origin, instanceId: id, model: a.model, sessions: [input.hangarSessionId] }];
    }
    step.done();
    return next;
  } catch (e) {
    step.fail(e instanceof Error ? e.message : String(e));
    input.prep.throwIfCancelled();
    throw e;
  }
}
