import { compatState, type CompatContract, type CompatDriftDto, type CompatDto, type CompatState, type CompatSummaryDto, type ReadinessDto } from '@agent-hangar/shared';
import { absoluteTime } from './format.ts';

/**
 * 止めた機能の言い方（B1）。
 * short は「ずれ N 件の中身」の表の列、line は常に出す一覧の 1 行である。
 * hangar が自分で止めたと伝えるため、line は「〜を止めています」か「〜を控えています」で結ぶ。
 */
export type CompatStop = { short: string; line: string };

/** 契約の呼び名。表の「契約」の列と、報告用の写しに使う。 */
export const CONTRACT_LABEL: Record<CompatContract, string> = {
  transcript: 'トランスクリプト', registry: 'レジストリ', statusline: 'statusline', 'claude-dir': '~/.claude の項目', cli: 'CLI', screen: '画面の文字',
};

// 止めた機能。どれも、契約がずれのときに実際にしていること（docs/design.md「Claude Code との互換」）に合わせる。
const JUMP: CompatStop = { short: '目次から跳ぶ', line: 'ターンの目次から端末の指示へ跳ぶのを止めています' };
const PARK: CompatStop = { short: '休みで止める', line: '休んでいるセッションを自動で止めるのを控えています' };
const ADOPT: CompatStop = { short: '引き取り', line: '外のターミナルで動いている会話を引き取るのを止めています' };
const LIVE: CompatStop = { short: '実行中の印', line: '状態のファイルが読めない会話を、実行中として出すのを控えています' };
const USAGE: CompatStop = { short: '使用率の一部', line: '使用率のゲージの欠けた項目の更新を止めています' };
const SHARE: CompatStop = { short: 'アカウントの共有', line: '新しい ~/.claude の項目をアカウントの間で共有するのを控えています' };
const HELP: CompatStop = { short: '外のターミナル', line: '外のターミナルの包み方で、サブコマンドの一覧を claude --help から作るのを止めています' };
const AUTH: CompatStop = { short: 'ログインの状態', line: 'アカウントのログインの状態を読むのを止めています' };
const ATTACH: CompatStop = { short: 'attach で再開', line: 'バックグラウンドのセッションを attach で再開するのを止めています' };
const SUMMARY: CompatStop = { short: 'Claude で要約', line: 'Claude で要約するのを止めています' };

/**
 * 契約ごとに、値の形から止めた機能を引く表。上から見て、最初に当たった行を使う。
 * null は記録だけで、止めた機能が無いことを表す。
 * DTO は止めた機能を持たない。契約だけでは CLI、statusline、レジストリの止めたものが 1 つに決まらないので、値の頭でも分ける。
 */
const STOPS: Record<CompatContract, readonly (readonly [RegExp, CompatStop | null])[]> = {
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
export function stopOf(d: Pick<CompatDriftDto, 'contract' | 'value'>): CompatStop | null {
  for (const [re, stop] of STOPS[d.contract]) if (re.test(d.value)) return stop;
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

const UNKNOWN = '不明';

/** 表の時刻。月と日と時刻だけにする（10/07 14:02）。 */
export function seenLabel(ts: number): string {
  return absoluteTime(ts).slice(5).replace('-', '/');
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
export function compatReport(summary: CompatSummaryDto, drifts: CompatDriftDto[], hangarVersion: string): string {
  return [
    hangarVersion ? `Claude Code との互換のずれ（hangar ${hangarVersion}）` : 'Claude Code との互換のずれ',
    `手元の版 ${summary.localVersion ?? UNKNOWN}、確かめた版 ${summary.verifiedVersion}`,
    '',
    '| 契約 | 値 | 版 | 回数 | 最初に見た | 最後に見た | 止めた機能 |',
    '| --- | --- | --- | --- | --- | --- | --- |',
    ...drifts.map((d) => `| ${CONTRACT_LABEL[d.contract]} | ${cell(code(d.value))} | ${cell(d.version ?? UNKNOWN)} | ${d.count} | ${absoluteTime(d.firstSeenAt)} | ${absoluteTime(d.lastSeenAt)} | ${stopOf(d)?.short ?? 'なし'} |`),
  ].join('\n');
}

/**
 * 準備の確かめの要約（summary）と、ずれの中身（full。ずれがあるときだけ取る）から作る。
 * 中身が届いていれば、件数は中身の数にそろえる。要約より後に読んだ分だけ新しいからである。
 * 6 行目の「ずれ N 件（版）」は手元の版で、分からなければ版を添えない。
 */
export function presentCompat(summary: CompatSummaryDto, full: CompatDto | null, hangarVersion: string): CompatProps {
  const count = full ? full.drifts.length : summary.driftCount;
  const state = compatState({ ...summary, driftCount: count });
  const local = summary.localVersion ?? UNKNOWN;
  const base = { state, localVersion: local, verifiedVersion: summary.verifiedVersion, count, stops: null, rows: null, report: null };
  if (state === 'ok') return { ...base, note: `ずれなし（${summary.verifiedVersion} で確かめた版）`, lead: 'hangar が読む Claude Code の形を見張っています', badge: '問題なし' };
  if (state === 'unverified') return { ...base, note: `${local}（確かめた版は ${summary.verifiedVersion}）`, lead: 'まだ確かめていない版です。動きは止めていません', badge: '未確認の版' };
  const note = summary.localVersion ? `ずれ ${count} 件（${summary.localVersion}）` : `ずれ ${count} 件`;
  const badge = `ずれ ${count} 件`;
  if (!full) return { ...base, note, badge, lead: 'ずれの中身を読み込んでいます' };
  // 同じ機能に当たるずれは、一覧では 1 行にまとめる。並びは中身の順（最後に見た時刻の新しい順）である。
  const stops = [...new Set(full.drifts.map((d) => stopOf(d)?.line).filter((l): l is string => l !== undefined))];
  return {
    ...base, note, badge,
    lead: stops.length > 0 ? '知らない形に頼る機能だけを止め、ほかは動かしています' : '知らない形を記録しましたが、止めた機能はありません',
    stops,
    rows: full.drifts.map((d) => ({ key: `${d.contract}:${d.value}`, contract: CONTRACT_LABEL[d.contract], value: d.value, version: d.version ?? UNKNOWN, firstSeen: seenLabel(d.firstSeenAt), stop: stopOf(d)?.short ?? null })),
    report: compatReport(summary, full.drifts, hangarVersion),
  };
}

/**
 * 準備の確かめの答えから compat を取り出す。
 * 古いサーバの上に新しい UI を重ねたとき、答えには compat が無い。型は必ずあると言うので、無いことを読むのはここだけにする。
 */
export function readinessCompat(r: ReadinessDto): CompatSummaryDto | undefined {
  return (r as Partial<ReadinessDto>).compat;
}
