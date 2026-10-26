import {
  modelCostKind, modelDataUse, modelFactsStale, providerFactOf,
  type MessageKey, type ModelCostKind, type ModelDataUse, type OpencodeModelCost, type OpencodeModelOption, type OpencodeProviderOption, type OpencodeProviderWhere, type Translate,
} from '@agent-hangar/shared';
import { costLabel } from './format.ts';

/**
 * opencode のモデルの小窓（新しいセッションの「モデル」の札。docs/design.md「opencode のモデルの小窓」）の中身を組む。
 * 並べ方はプロバイダーごとのまとまり（L2）、行は札だけの簡潔な形（D1）。
 * 費用の型とデータの扱いは、料金と宛先（OpencodeOptionsDto）と手書きの表（shared/modelFacts.ts）から決める。
 */

/** 札の色の種類。local、free、metered、plan は費用の型、ok と muted はデータの扱いとコンテキスト、warn は目立たせる注意、outline は期間限定。 */
export type ModelTagTone = ModelCostKind | 'ok' | 'muted' | 'warn' | 'outline';
export type ModelTag = { label: string; tone: ModelTagTone };
/** 右端の値段。sub は従量のときの単位の行。 */
export type ModelPrice = { main: string; sub: string | null };
/** 1 行。disabled は選べない行（ツール呼び出しに対応しない、この PC に無い）で、note はその理由。 */
export type ModelRow = { id: string; name: string; tags: ModelTag[]; price: ModelPrice; disabled: boolean; note: string | null; selected: boolean };
/** 1 つのまとまり。key は畳んだ状態を覚える鍵、name は件数つきの名前、kind は見出しの費用の型の札、status は接続の状態、reload は再読み込みを置くか。 */
export type ModelGroup = { key: string; name: string; kind: ModelTag; status: string; rows: ModelRow[]; reload: boolean };
/**
 * 小窓の中身。def はデフォルトの行（絞り込みの間は null）で、sub は opencode.json のモデル。
 * empty は絞り込みに合う行が 1 つも無いこと。footer は下端の料金の出どころと取得日。
 */
export type ModelPickerView = { def: { selected: boolean; sub: string | null } | null; groups: ModelGroup[]; empty: boolean; footer: string };

export type ModelPickerInput = {
  models: OpencodeModelOption[];
  providers: OpencodeProviderOption[];
  defaultModel: string | null;
  pricesAt: number | null;
  fetchedAt: number;
  /** 選んでいるモデル。空はデフォルト。 */
  selected: string;
  query: string;
  now: number;
};

const KIND_ORDER: readonly ModelCostKind[] = ['local', 'free', 'metered', 'plan'];
const KIND_KEY = { local: 'launch.model.kind.local', free: 'launch.model.kind.free', metered: 'launch.model.kind.metered', plan: 'launch.model.kind.plan' } as const satisfies Record<ModelCostKind, MessageKey>;
const DATA = {
  'on-device': { key: 'launch.model.data.onDevice', tone: 'ok' },
  'no-training': { key: 'launch.model.data.noTraining', tone: 'ok' },
  'retain-30d': { key: 'launch.model.data.retain30d', tone: 'muted' },
  'may-train': { key: 'launch.model.data.mayTrain', tone: 'warn' },
  'provider-logs': { key: 'launch.model.data.providerLogs', tone: 'warn' },
} as const satisfies Record<ModelDataUse, { key: MessageKey; tone: ModelTagTone }>;

/**
 * 費用の型。決め方は shared の modelCostKind（スマホの答えと同じ）に任せる。
 * 定額のプロバイダー（手書きの表）、この PC か内側の網、料金のあるもの（従量）、0 円のもの（無料）の順で、料金の分からないものはローカルにする。
 */
export function costKindOf(m: Pick<OpencodeModelOption, 'provider' | 'cost'>, where: OpencodeProviderWhere): ModelCostKind {
  return modelCostKind(m.provider, m.cost, where);
}

const trim = (n: number, digits: number): string => String(Number(n.toFixed(digits)));

/** コンテキストの長さを縮める（262144 → 262K、1048576 → 1M）。 */
export function contextLabel(n: number): string {
  if (n >= 1_000_000) return `${trim(n / 1_000_000, 1)}M`;
  if (n >= 1_000) return `${Math.round(n / 1_000)}K`;
  return String(n);
}

/**
 * 右端の値段。ローカルと無料は $0.00、従量は 100 万トークンあたりの入力と出力、定額は「定額に含む」。
 * 0 の書式は会話の費用（costLabel）と同じにし、アプリの中で通貨と桁をそろえる。
 */
export function priceLabel(t: Translate, kind: ModelCostKind, cost: OpencodeModelCost | null): ModelPrice {
  if (kind === 'plan') return { main: t('launch.model.price.plan'), sub: null };
  if (kind === 'metered' && cost) return { main: `$${trim(cost.input, 3)} / $${trim(cost.output, 3)}`, sub: t('launch.model.price.unit') };
  return { main: costLabel(0), sub: null };
}

/**
 * データの扱いの札。決め方は shared の modelDataUse（スマホの答えと同じ）に任せる。
 * この PC のものは宛先から決め、ほかのローカルは出さず、ほかは手書きの表から引く。表に無いもの、表が古いものには「要確認」を出す。
 */
function dataTags(t: Translate, m: OpencodeModelOption, kind: ModelCostKind, where: OpencodeProviderWhere, stale: boolean): ModelTag[] {
  const use = modelDataUse(m, kind, where);
  if (use === 'on-device') return [{ label: t(DATA[use].key), tone: DATA[use].tone }];
  if (kind === 'local') return [];
  const recheck: ModelTag = { label: t('launch.model.recheck'), tone: 'muted' };
  if (use === null) return [recheck];
  const tag: ModelTag = { label: t(DATA[use].key), tone: DATA[use].tone };
  return stale ? [tag, recheck] : [tag];
}

const matches = (m: OpencodeModelOption, q: string): boolean => !q || m.label.toLowerCase().includes(q) || m.id.toLowerCase().includes(q);

export function presentModelPicker(t: Translate, i: ModelPickerInput): ModelPickerView {
  const stale = modelFactsStale(i.now);
  const q = i.query.trim().toLowerCase();
  const whereOf = new Map(i.providers.map((p) => [p.id, p.where]));
  const nameOf = new Map(i.providers.map((p) => [p.id, p.name]));

  // まとまりは、プロバイダーと費用の型の組。1 つのプロバイダーが 2 つの型を持つときだけ鍵に型を足す。
  type Bucket = { provider: string; kind: ModelCostKind; where: OpencodeProviderWhere; models: OpencodeModelOption[] };
  const buckets: Bucket[] = [];
  for (const m of i.models) {
    const where = whereOf.get(m.provider) ?? 'remote';
    const kind = costKindOf(m, where);
    const b = buckets.find((x) => x.provider === m.provider && x.kind === kind);
    if (b) b.models.push(m);
    else buckets.push({ provider: m.provider, kind, where, models: [m] });
  }
  const kindsOf = (provider: string) => buckets.filter((b) => b.provider === provider).length;
  const ordered = KIND_ORDER.flatMap((k) => buckets.filter((b) => b.kind === k));

  const groups: ModelGroup[] = ordered.flatMap((b) => {
    const shown = b.models.filter((m) => matches(m, q));
    if (!shown.length) return [];
    const fact = providerFactOf(b.provider);
    const name = fact.name ?? nameOf.get(b.provider) ?? b.models[0]!.group;
    const rows: ModelRow[] = shown.map((m) => {
      const tags: ModelTag[] = [{ label: t(KIND_KEY[b.kind]), tone: b.kind }, ...dataTags(t, m, b.kind, b.where, stale)];
      if (m.context !== null) tags.push({ label: contextLabel(m.context), tone: 'muted' });
      if (b.kind === 'free' && fact.limitedFree) tags.push({ label: t('launch.model.limited'), tone: 'outline' });
      if (!m.tools) tags.push({ label: t('launch.model.noTools'), tone: 'warn' });
      // この PC の LM Studio などに無いモデル（opencode.json はほかの PC と共有なので出てくる）。起こしても最初の発言で落ちるので選ばせない。
      if (m.missing) tags.push({ label: t('launch.model.missing'), tone: 'muted' });
      const note = m.missing ? t('launch.model.missingNote') : m.tools ? null : t('launch.model.noToolsNote');
      return {
        id: m.id, name: m.label, tags, price: priceLabel(t, b.kind, m.cost),
        disabled: !m.tools || m.missing === true, note, selected: m.id === i.selected,
      };
    });
    const status = b.provider === 'lmstudio' ? t('launch.model.status.lmstudio')
      : b.kind === 'free' && fact.limitedFree ? t('launch.model.status.keyless')
        : t('launch.model.status.connected');
    return [{
      key: kindsOf(b.provider) > 1 ? `${b.provider}:${b.kind}` : b.provider,
      name: t('launch.model.group', { name, n: rows.length }),
      kind: { label: t(KIND_KEY[b.kind]), tone: b.kind },
      status, rows, reload: b.provider === 'lmstudio',
    }];
  });

  const at = new Date(i.pricesAt ?? i.fetchedAt);
  return {
    def: q ? null : { selected: i.selected === '', sub: i.defaultModel },
    groups,
    empty: q !== '' && groups.length === 0,
    footer: t('launch.model.footer', { date: `${at.getMonth() + 1}/${at.getDate()}` }),
  };
}
