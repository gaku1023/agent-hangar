import type { LiveStatus, ProjectStatus, SessionDto } from '@agent-hangar/shared';
import { KEYMAP, type KeyId } from '../keys.ts';
import type { State } from '../mediator/types.ts';
import { liveFilterOfSession, nextWaitingSession, runningSessionIds, type Store } from '../store/store.ts';
import { durationLabel, relativeTime } from './format.ts';
import { newSessionTarget } from './newSession.ts';

/** 最後の活動が新しい順。時刻が同じか無いものは id の順にして、並びを決定的にする。 */
const byRecency = <T extends { id: string; lastActivityAt: number | null }>(items: T[]): T[] =>
  [...items].sort((a, b) => (b.lastActivityAt ?? 0) - (a.lastActivityAt ?? 0) || a.id.localeCompare(b.id));

/** ヒントに出す打鍵。キーの表を正にして、割り当てを変えたときにここがずれないようにする。 */
function keysOf(id: KeyId): string {
  return KEYMAP.find((b) => b.id === id)?.keys ?? '';
}

/** 行頭の印に使う絵の名前。View が Icon の名前へ写す。 */
export type PaletteIcon = 'home' | 'projects' | 'sessions' | 'settings' | 'next' | 'sidebar' | 'keys' | 'add' | 'scratch' | 'rebuild' | 'fulltext';
/** 行頭の印。セッションは状態の点、プロジェクトは状態の色の点、コマンドは絵である。 */
export type PaletteLead = { kind: 'dot'; live: LiveStatus | null } | { kind: 'status'; status: ProjectStatus } | { kind: 'icon'; icon: PaletteIcon };
/**
 * パレットの 1 行。
 * sub は名前の右に淡く添える語（セッションならプロジェクト名）、meta は右端の淡い語（経った時間やパス）、keys は右端のキー帽である。
 */
export type PaletteItem = { id: string; label: string; kind: 'command' | 'project' | 'session' | 'search'; lead: PaletteLead; sub: string; meta: string; keys: string };
/** 群。count は群に当たる全件の数で、limit は上限で切ったときだけ「上位 N」になる。 */
export type PaletteSection = { title: string; count: number | null; limit: string | null; items: PaletteItem[] };
/** noMatch は、語を打ったのに名前に 1 つも当たらなかったこと（全文検索の行だけが残る）。 */
export type PaletteProps = { query: string; sections: PaletteSection[]; noMatch: boolean };

const cmd = (id: string, label: string, icon: PaletteIcon, keys = '', sub = ''): PaletteItem => ({ id, label, kind: 'command', lead: { kind: 'icon', icon }, sub, meta: '', keys });

/** 何も打っていないときの群の上限。 */
const EMPTY_LIMIT = { recent: 5, projects: 4 } as const;
/** 打ち始めた後の、1 つの群の上限。 */
const TYPED_LIMIT = 8;

/**
 * 部分列の一致に点を付ける。
 * 入力の各文字が同じ順に現れれば一致とみなし、前にあるほど、直前の文字と連続しているほど高い点にする。
 * 一致しなければ 0 を返す。
 * 入力が空のときは 1 を返し、すべての項目が同じ点で並ぶようにする。
 */
export function fuzzyScore(query: string, text: string): number {
  const q = query.trim().toLowerCase();
  if (!q) return 1;
  const t = text.toLowerCase();
  let score = 0;
  let at = 0;
  let prev = -2;
  for (const ch of q) {
    const i = t.indexOf(ch, at);
    if (i < 0) return 0;
    score += 10 + Math.max(0, 20 - i) + (i === prev + 1 ? 15 : 0);
    prev = i;
    at = i + 1;
  }
  return score;
}

/** 右端に添える語。入力待ちは待った長さ、作業中は動き始めてからの長さ、休みは最後の返答からの長さ、終わったものは最後の活動の時期。 */
function sessionMeta(s: SessionDto, running: boolean, now: number): string {
  const since = (ts: number | null) => durationLabel(now - (ts ?? now));
  if (s.live === 'waiting') return `${since(s.lastActivityAt)}待っている`;
  if (s.live === 'busy') return `作業中 ${since(s.startedAt)}`;
  if (s.live === 'idle') return `休み ${since(s.lastActivityAt)}`;
  // hangar の run は生きているが、Claude の一覧にまだ載っていないもの。
  if (running) return '起動しています';
  return relativeTime(s.lastActivityAt, now);
}

type Scored = { item: PaletteItem; score: number };

/**
 * 群を作る。
 * 点の高い順に並べ（同点は渡した順）、limit で切る。
 * 何も当たらなければ null を返し、空の群は出さない。
 */
function section(title: string, scored: Scored[], limit: number): { section: PaletteSection; best: number } | null {
  const hits = scored.filter((x) => x.score > 0).map((x, at) => ({ ...x, at })).sort((a, b) => b.score - a.score || a.at - b.at);
  if (hits.length === 0) return null;
  const cut = hits.length > limit;
  return { section: { title, count: hits.length, limit: cut ? `上位 ${limit}` : null, items: hits.slice(0, limit).map((x) => x.item) }, best: hits[0]!.score };
}

/**
 * パレットの項目。overlay がパレットでなければ null を返す。入力欄の文字は Root が持ち、引数で渡す。
 * 何も打っていないときは、入力待ち、実行中、最近、プロジェクト、移動、コマンドの群を上から並べる（B1）。
 * 打ち始めた後は名前で絞り、最後の行にいつも「全文検索」を置く（C1）。
 */
export function presentPalette(state: State, store: Store, query: string, now: number): PaletteProps | null {
  if (state.overlay.kind !== 'palette') return null;
  const q = query.trim();
  const alive = runningSessionIds(store);
  const projectName = (s: SessionDto) => (s.projectId ? store.projects[s.projectId]?.name ?? '' : '');

  // セッションは状態で 3 つに分ける。入力待ちは実行中に含めない（用語の D1）。
  const sessions = byRecency(Object.values(store.sessions));
  const sessionItem = (s: SessionDto, running: boolean): PaletteItem => ({ id: `session:${s.id}`, label: s.name ?? '（名前なし）', kind: 'session', lead: { kind: 'dot', live: s.live }, sub: projectName(s), meta: sessionMeta(s, running, now), keys: '' });
  const scoreSession = (s: SessionDto) => fuzzyScore(q, `${s.name ?? '（名前なし）'} ${s.summary?.oneLiner ?? s.firstPrompt ?? ''}`);
  const byState = { waiting: [] as Scored[], running: [] as Scored[], ended: [] as Scored[] };
  for (const s of sessions) {
    const f = liveFilterOfSession(store, s, alive);
    byState[f].push({ item: sessionItem(s, f === 'running'), score: scoreSession(s) });
  }
  // スクラッチの擬似プロジェクトはカードに出さないので、パレットがその画面への入口の 1 つになる。
  const projects: Scored[] = byRecency(Object.values(store.projects)).map((p) => ({ item: { id: `project:${p.id}`, label: p.name, kind: 'project', lead: { kind: 'status', status: p.status }, sub: '', meta: p.path ?? 'この PC にパスがありません', keys: '' }, score: fuzzyScore(q, p.name) }));

  // 次の入力待ちへは、移る先を添える。どこへ移るかは ⌘I と同じ関数で決める。
  const from = state.screen.name === 'session' ? state.screen.id : null;
  const next = nextWaitingSession(store, from);
  const moves = [
    cmd('go:home', 'ホームへ', 'home'),
    cmd('go:projects', 'プロジェクトへ', 'projects'),
    cmd('go:sessions', 'セッション一覧へ', 'sessions'),
    cmd('cmd:settings', '設定', 'settings', keysOf('settings.open')),
    cmd('cmd:next-waiting', '次の入力待ちへ', 'next', keysOf('session.nextWaiting'), next ? store.sessions[next]?.name ?? '（名前なし）' : ''),
    cmd('cmd:sidebar', 'サイドバーの開閉', 'sidebar', keysOf('sidebar.toggle')),
    cmd('cmd:shortcuts', 'キーの一覧', 'keys', keysOf('shortcuts.open')),
  ];
  // 新しいセッションは、ヘッダーの新規ボタンや ⌘N と同じく、いまの画面のプロジェクトを最初から選ぶ。
  // Mediator はストアを見ないので、選ぶものを ID の後ろに載せる（mediator/workbench.ts の paletteRun が読む）。
  const target = newSessionTarget(state, store);
  const newId = target.projectId ? `cmd:new-session:project:${target.projectId}` : target.scratch ? 'cmd:new-session:scratch' : 'cmd:new-session';
  const commands = [
    cmd(newId, '新しいセッション', 'add', keysOf('session.new')),
    cmd('cmd:new-scratch', 'スクラッチで始める', 'scratch', keysOf('session.newScratch')),
    cmd('cmd:new-project', '新しいプロジェクト', 'add'),
    cmd('cmd:rebuild-index', '索引を作り直す', 'rebuild'),
  ];
  const scoreAll = (items: PaletteItem[]) => items.map((item) => ({ item, score: fuzzyScore(q, item.label) }));

  if (!q) {
    const all = Number.POSITIVE_INFINITY;
    const groups = [
      section('入力待ち', byState.waiting, all), section('実行中', byState.running, all), section('最近', byState.ended, EMPTY_LIMIT.recent),
      section('プロジェクト', projects, EMPTY_LIMIT.projects), section('移動', scoreAll(moves), all), section('コマンド', scoreAll(commands), all),
    ];
    return { query, sections: groups.filter((g) => g !== null).map((g) => g.section), noMatch: false };
  }

  // 打ち始めた後は、いちばんよく当たった行の点の高い順に群を並べる。
  // 決まった順のままだと、要約の中で散らばって当たったセッションが、名前の頭から当たったコマンドより上に来る。
  // 点が同じ群は、何も打っていないときと同じ順にする。
  const groups = [
    section('入力待ち', byState.waiting, TYPED_LIMIT), section('実行中', byState.running, TYPED_LIMIT), section('セッション', byState.ended, TYPED_LIMIT),
    section('プロジェクト', projects, TYPED_LIMIT), section('移動', scoreAll(moves), TYPED_LIMIT), section('コマンド', scoreAll(commands), TYPED_LIMIT),
  ].map((g, order) => (g ? { ...g, order } : null)).filter((g) => g !== null).sort((a, b) => b.best - a.best || a.order - b.order);
  // 全文検索はいつも最後の行に置く。名前の照合とは別の経路（セッション一覧の画面）へ移る。
  const search: PaletteSection = { title: '本文', count: null, limit: null, items: [{ id: `search:${q}`, label: `『${q}』を全文検索`, kind: 'search', lead: { kind: 'icon', icon: 'fulltext' }, sub: '', meta: 'セッション一覧で開く', keys: '⌘↵' }] };
  return { query, sections: [...groups.map((g) => g.section), search], noMatch: groups.length === 0 };
}
