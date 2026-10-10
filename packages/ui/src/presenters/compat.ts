import { compatState, type CompatContract, type CompatDriftDto, type CompatDto, type CompatState, type CompatSummaryDto, type ReadinessDto, type Translate } from '@agent-hangar/shared';
import { absoluteTime } from './format.ts';

/**
 * 止めた機能の言い方（B1）。
 * short は「ずれ N 件の中身」の表の列、line は常に出す一覧の 1 行である。
 * hangar が自分で止めたと伝えるため、line は「〜を止めています」か「〜を控えています」で結ぶ。
 */
export type CompatStop = { short: string; line: string };

/** 契約の呼び名。表の「契約」の列と、報告用の写しに使う。 */
const CONTRACT_KEY = {
  transcript: 'compat.contract.transcript', registry: 'compat.contract.registry', statusline: 'compat.contract.statusline',
  'claude-dir': 'compat.contract.claudeDir', cli: 'compat.contract.cli', screen: 'compat.contract.screen',
} as const satisfies Record<CompatContract, string>;
export const contractLabel = (t: Translate, c: CompatContract): string => t(CONTRACT_KEY[c]);

/** 止めた機能の名前。文は `compat.stop.<名前>Short` と `compat.stop.<名前>Line` から引く。 */
type StopId = 'jump' | 'park' | 'adopt' | 'live' | 'usage' | 'share' | 'help' | 'auth' | 'attach' | 'summary';
const STOP_KEYS = {
  jump: ['compat.stop.jumpShort', 'compat.stop.jumpLine'],
  park: ['compat.stop.parkShort', 'compat.stop.parkLine'],
  adopt: ['compat.stop.adoptShort', 'compat.stop.adoptLine'],
  live: ['compat.stop.liveShort', 'compat.stop.liveLine'],
  usage: ['compat.stop.usageShort', 'compat.stop.usageLine'],
  share: ['compat.stop.shareShort', 'compat.stop.shareLine'],
  help: ['compat.stop.helpShort', 'compat.stop.helpLine'],
  auth: ['compat.stop.authShort', 'compat.stop.authLine'],
  attach: ['compat.stop.attachShort', 'compat.stop.attachLine'],
  summary: ['compat.stop.summaryShort', 'compat.stop.summaryLine'],
} as const satisfies Record<StopId, readonly [string, string]>;

// 止めた機能。どれも、契約がずれのときに実際にしていること（docs/design.md「Claude Code との互換」）に合わせる。
const JUMP: StopId = 'jump';
const PARK: StopId = 'park';
const ADOPT: StopId = 'adopt';
const LIVE: StopId = 'live';
const USAGE: StopId = 'usage';
const SHARE: StopId = 'share';
const HELP: StopId = 'help';
const AUTH: StopId = 'auth';
const ATTACH: StopId = 'attach';
const SUMMARY: StopId = 'summary';

/**
 * 契約ごとに、値の形から止めた機能を引く表。上から見て、最初に当たった行を使う。
 * null は記録だけで、止めた機能が無いことを表す。
 * DTO は止めた機能を持たない。契約だけでは CLI、statusline、レジストリの止めたものが 1 つに決まらないので、値の頭でも分ける。
 */
const STOPS: Record<CompatContract, readonly (readonly [RegExp, StopId | null])[]> = {
  // 知らない行は meta として残し、知らない塊は捨てる。いまの扱いのままなので、止めたものは無い。
  transcript: [[/^/, null]],
  // 知らない status は作業中と読むので、休みで止めない。pid が無いと、引き取る前にプロセスを確かめられない。
  // sessionId の無い登録と、オブジェクトでない登録は読まない。
  registry: [[/^status=/, PARK], [/^pid=/, ADOPT], [/^/, LIVE]],
  // ミリ秒の resets_at は秒に直さずにそのまま使う（自動で直す）。欠けた項目は直前の値を保つ。
  statusline: [[/\.resets_at=ms$/, null], [/^/, USAGE]],
  'claude-dir': [[/^/, SHARE]],
  // サブコマンドの増減は、包み方のサブコマンドの一覧を claude --help から作り直して吸収するので、止めたものは無い。
  cli: [[/^help[.=]/, HELP], [/^auth-status[.=]/, AUTH], [/^agents-json[.=]/, ATTACH], [/^print-json[.=]/, SUMMARY], [/^/, null]],
  screen: [[/^/, JUMP]],
};

/** そのずれで止めた機能。止めたものが無ければ null。 */
export function stopOf(t: Translate, d: Pick<CompatDriftDto, 'contract' | 'value'>): CompatStop | null {
  for (const [re, id] of STOPS[d.contract]) {
    if (!re.test(d.value)) continue;
    return id === null ? null : { short: t(STOP_KEYS[id][0]), line: t(STOP_KEYS[id][1]) };
  }
  return null;
}

/** 「ずれ N 件の中身」の表の 1 行。stop は表の列の短い言い方で、止めたものが無ければ null。 */
export type CompatRow = { key: string; contract: string; value: string; version: string; firstSeen: string; stop: string | null };

/**
 * Claude Code との互換の見せ方（A4、B1、C2）。設定の節と、ホームの帯の始める前の確認の互換の行が同じこれを読む。
 * note は始める前の確認の場所の欄に出す「X（Y）」、lead は説明の行、badge は設定の見出しの右端の札である。
 * stops と rows は、ずれがあって中身（GET /api/compat）が届いたときだけ配列になる。届く前は null である。
 * report は「報告用に写す」で写す文で、rows と同じく中身が届いたときだけある。
 */
export type CompatProps = {
  state: CompatState;
  note: string;
  lead: string;
  badge: string;
  localVersion: string;
  verifiedVersion: string;
  count: number;
  stops: string[] | null;
  rows: CompatRow[] | null;
  report: string | null;
};

/** 表の時刻。月と日と時刻だけにする（10/07 14:02）。 */
export function seenLabel(t: Translate, ts: number): string {
  return absoluteTime(t, ts).slice(5).replace('-', '/');
}

/** Markdown の表のセル。改行と縦棒で表が崩れないようにする。 */
const cell = (s: string): string => s.replace(/\r?\n/g, ' ').replace(/\|/g, '\\|');
/** コードの囲み。値にバッククォートがあれば 2 つで囲む。 */
const code = (s: string): string => (s.includes('`') ? `\`\` ${s} \`\`` : `\`${s}\``);

/**
 * 「報告用に写す」で写す文。Markdown の表にして、そのまま issue に貼れるようにする。
 * 画面の表に無い回数と最後に見た時刻も載せ、時刻は年まで書く。
 * hangarVersion は頭に書く hangar の版で、空なら書かない。
 */
export function compatReport(t: Translate, summary: CompatSummaryDto, drifts: CompatDriftDto[], hangarVersion: string): string {
  const unknown = t('common.time.unknown');
  return [
    hangarVersion ? t('compat.report.titleVersion', { version: hangarVersion }) : t('compat.report.title'),
    t('compat.report.versions', { local: summary.localVersion ?? unknown, verified: summary.verifiedVersion }),
    '',
    t('compat.report.header'),
    '| --- | --- | --- | --- | --- | --- | --- |',
    ...drifts.map((d) => `| ${contractLabel(t, d.contract)} | ${cell(code(d.value))} | ${cell(d.version ?? unknown)} | ${d.count} | ${absoluteTime(t, d.firstSeenAt)} | ${absoluteTime(t, d.lastSeenAt)} | ${stopOf(t, d)?.short ?? t('compat.table.none')} |`),
  ].join('\n');
}

/**
 * 準備の確かめの要約（summary）と、ずれの中身（full。ずれがあるときだけ取る）から作る。
 * 中身が届いていれば、件数は中身の数にそろえる。要約より後に読んだ分だけ新しいからである。
 * 6 行目の「ずれ N 件（版）」は手元の版で、分からなければ版を添えない。
 */
export function presentCompat(t: Translate, summary: CompatSummaryDto, full: CompatDto | null, hangarVersion: string): CompatProps {
  const count = full ? full.drifts.length : summary.driftCount;
  const state = compatState({ ...summary, driftCount: count });
  const local = summary.localVersion ?? t('common.time.unknown');
  const base = { state, localVersion: local, verifiedVersion: summary.verifiedVersion, count, stops: null, rows: null, report: null };
  if (state === 'ok') return { ...base, note: t('compat.status.okNote', { verified: summary.verifiedVersion }), lead: t('compat.status.okLead'), badge: t('compat.status.okBadge') };
  if (state === 'unverified') return { ...base, note: t('compat.status.unverifiedNote', { local, verified: summary.verifiedVersion }), lead: t('compat.status.unverifiedLead'), badge: t('compat.status.unverifiedBadge') };
  const note = summary.localVersion ? t('compat.status.driftNote', { n: count, local: summary.localVersion }) : t('compat.status.driftNoteNoVersion', { n: count });
  const badge = t('compat.status.driftNoteNoVersion', { n: count });
  if (!full) return { ...base, note, badge, lead: t('compat.status.loadingLead') };
  // 同じ機能に当たるずれは、一覧では 1 行にまとめる。並びは中身の順（最後に見た時刻の新しい順）である。
  const stops = [...new Set(full.drifts.map((d) => stopOf(t, d)?.line).filter((l): l is string => l !== undefined))];
  return {
    ...base, note, badge,
    lead: stops.length > 0 ? t('compat.status.stopsLead') : t('compat.status.noStopsLead'),
    stops,
    rows: full.drifts.map((d) => ({ key: `${d.contract}:${d.value}`, contract: contractLabel(t, d.contract), value: d.value, version: d.version ?? t('common.time.unknown'), firstSeen: seenLabel(t, d.firstSeenAt), stop: stopOf(t, d)?.short ?? null })),
    report: compatReport(t, summary, full.drifts, hangarVersion),
  };
}

/**
 * 準備の確かめの答えから compat を取り出す。
 * 古いサーバの上に新しい UI を重ねたとき、答えには compat が無い。型は必ずあると言うので、無いことを読むのはここだけにする。
 */
export function readinessCompat(r: ReadinessDto): CompatSummaryDto | undefined {
  return (r as Partial<ReadinessDto>).compat;
}
