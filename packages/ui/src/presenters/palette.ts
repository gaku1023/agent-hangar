import { type LiveStatus, type SessionDto, type Translate } from '@agent-hangar/shared';
import { asideWord } from '../lib/aside.ts';
import { displayKeys, keyLabel, KEYMAP, type KeyId } from '../keys.ts';
import type { State } from '../mediator/types.ts';
import { liveFilterOfSession, nextWaitingSession, runningSessionIds, shownAside, shownLive, type Store } from '../store/store.ts';
import { durationLabel, relativeTime } from './format.ts';
import { translatorOf } from './i18n.ts';
import { projectDisplayName } from './projectName.ts';
import { newSessionTarget } from './newSession.ts';

/** 最後の活動が新しい順。時刻が同じか無いものは id の順にして、並びを決定的にする。 */
const byRecency = <T extends { id: string; lastActivityAt: number | null }>(items: T[]): T[] =>
  [...items].sort((a, b) => (b.lastActivityAt ?? 0) - (a.lastActivityAt ?? 0) || a.id.localeCompare(b.id));

/** ヒントに出す打鍵。キーの表を正にして、割り当てを変えたときにここがずれないようにする。 */
function keysOf(id: KeyId): string {
  const b = KEYMAP.find((k) => k.id === id);
  return b ? displayKeys(b) : '';
}

/** 行頭の印に使う絵の名前。View が Icon の名前へ写す。 */
export type PaletteIcon = 'home' | 'projects' | 'settings' | 'next' | 'sidebar' | 'keys' | 'add' | 'scratch' | 'rebuild' | 'fulltext' | 'general' | 'cloud' | 'integrations' | 'summary' | 'tools' | 'info' | 'retention';
/** 行頭の印。セッションは状態の点、コマンドは絵である。 */
export type PaletteLead = { kind: 'dot'; live: LiveStatus | null; aside: boolean } | { kind: 'icon'; icon: PaletteIcon };
/**
 * パレットの 1 行。
 * sub は名前の右に淡く添える語（セッションならプロジェクト名、設定の節なら「設定」）、meta は右端の淡い語（経った時間や件数）、keys は右端のキー帽である。
 */
export type PaletteItem = { id: string; label: string; kind: 'command' | 'session' | 'search'; lead: PaletteLead; sub: string; meta: string; keys: string };
/** 群。count は群に当たる全件の数で、limit は上限で切ったときだけ「上位 N」になる。 */
export type PaletteSection = { title: string; count: number | null; limit: string | null; items: PaletteItem[] };
/** noMatch は、語を打ったのに名前にも操作にも 1 つも当たらなかったこと（ホームへ渡す行だけが残る）。 */
export type PaletteProps = { query: string; sections: PaletteSection[]; noMatch: boolean };
/** ホームの欄に同じ語を打ったときの件数。q はその語で、いまの語と違えば古い答えとして使わない。 */
export type PaletteFound = { q: string; total: number };

const cmd = (id: string, label: string, icon: PaletteIcon, keys = '', sub = ''): PaletteItem => ({ id, label, kind: 'command', lead: { kind: 'icon', icon }, sub, meta: '', keys });

/** 何も打っていないときの「最近」の上限。 */
const EMPTY_RECENT = 3;
/** 打ち始めた後の、1 つの群の上限。 */
const TYPED_LIMIT = 8;
/** 打ち始めた後に名前を引く、終わったセッションの数。これより古いものは、ホームの欄で引く。 */
const TYPED_ENDED = 20;

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

/** 右端に添える語。入力待ちは待った長さ、作業中は動き始めてからの長さ、休みと裏だけは最後の返答からの長さ、終わったものは最後の活動の時期。 */
function sessionMeta(t: Translate, s: SessionDto, running: boolean, now: number): string {
  const since = (ts: number | null) => durationLabel(t, now - (ts ?? now));
  const live = shownLive(s);
  if (live === 'waiting') return t('palette.meta.waiting', { time: since(s.lastActivityAt) });
  if (shownAside(s)) return t('palette.meta.aside', { word: asideWord(t), time: since(s.lastActivityAt) });
  if (live === 'busy') return t('palette.meta.working', { time: since(s.startedAt) });
  if (live === 'idle') return t('palette.meta.idle', { time: since(s.lastActivityAt) });
  // hangar の run は生きているが、Claude の一覧にまだ載っていないもの。
  if (running) return t('palette.meta.starting');
  return relativeTime(t, s.lastActivityAt, now);
}

type Scored = { item: PaletteItem; score: number };

/**
 * 群を作る。
 * 点の高い順に並べ（同点は渡した順）、limit で切る。
 * 何も当たらなければ null を返し、空の群は出さない。
 */
function section(t: Translate, title: string, scored: Scored[], limit: number): { section: PaletteSection; best: number } | null {
  const hits = scored.filter((x) => x.score > 0).map((x, at) => ({ ...x, at })).sort((a, b) => b.score - a.score || a.at - b.at);
  if (hits.length === 0) return null;
  const cut = hits.length > limit;
  return { section: { title, count: hits.length, limit: cut ? t('palette.limit.top', { n: limit }) : null, items: hits.slice(0, limit).map((x) => x.item) }, best: hits[0]!.score };
}

/** 群の全件の数を出さない。「最近」は終わったセッションの全件で、千を超える数は見出しに要らない（「上位 3」だけを添える）。 */
const noCount = (g: { section: PaletteSection; best: number } | null) => (g ? { ...g, section: { ...g.section, count: null } } : null);

/**
 * パレットの項目。overlay がパレットでなければ null を返す。入力欄の文字は Root が持ち、引数で渡す。
 * パレットは移動と操作に絞る（設計書 2.11.1）。探すのはホームの欄で、名前も要約もトランスクリプトも引く。
 * 何も打っていないときは、入力待ち、最近 3、操作、設定の 4 群を上から並べる。
 * 作業中とアイドルの名前は、サイドバーの「実行中」にあるので出さない。
 * 打ち始めた後は、入力待ち、実行中、新しいほうの終わったセッションの名前と、操作、設定の節に当て、最後の行でホームの欄へ渡す。
 * found は、同じ語をホームの欄に打ったときの件数で、最後の行に添える。
 */
export function presentPalette(state: State, store: Store, query: string, now: number, found: PaletteFound | null = null): PaletteProps | null {
  if (state.overlay.kind !== 'palette') return null;
  const q = query.trim();
  const t = translatorOf(store);
  const alive = runningSessionIds(store);
  const projectName = (s: SessionDto) => (s.projectId && store.projects[s.projectId] ? projectDisplayName(store.projects[s.projectId]!, t) : '');

  // セッションは状態で 3 つに分ける。入力待ちは実行中に含めない（用語の D1）。
  // 引くのは名前だけである。要約と本文は、ホームの欄が引く。
  const sessions = byRecency(Object.values(store.sessions));
  const sessionItem = (s: SessionDto, running: boolean): PaletteItem => ({ id: `session:${s.id}`, label: s.name ?? t('common.label.noName'), kind: 'session', lead: { kind: 'dot', live: shownLive(s), aside: shownAside(s) !== null }, sub: projectName(s), meta: sessionMeta(t, s, running, now), keys: '' });
  const byState = { waiting: [] as Scored[], running: [] as Scored[], ended: [] as Scored[] };
  for (const s of sessions) {
    const f = liveFilterOfSession(store, s, alive);
    byState[f].push({ item: sessionItem(s, f === 'running'), score: fuzzyScore(q, s.name ?? t('common.label.noName')) });
  }

  // 次の入力待ちへは、移る先を添える。どこへ移るかは ⌘I と同じ関数で決める。
  const from = state.screen.name === 'session' ? state.screen.id : null;
  const next = nextWaitingSession(store, from);
  // 新しいセッションは、ヘッダーの新規ボタンや ⌘N と同じく、いまの画面のプロジェクトを最初から選ぶ。
  // Mediator はストアを見ないので、選ぶものを ID の後ろに載せる（mediator/workbench.ts の paletteRun が読む）。
  const target = newSessionTarget(state, store);
  const newId = target.projectId ? `cmd:new-session:project:${target.projectId}` : target.scratch ? 'cmd:new-session:scratch' : 'cmd:new-session';
  // 何も打っていないときに出す操作と、打ったときだけ足す操作。ホームとプロジェクトは、サイドバーから移れるので、打ったときだけ出す。
  const actions = [
    cmd(newId, t('palette.cmd.newSession'), 'add', keysOf('session.new')),
    cmd('cmd:new-scratch', t('palette.cmd.newScratch'), 'scratch', keysOf('session.newScratch')),
    cmd('cmd:next-waiting', t('palette.cmd.nextWaiting'), 'next', keysOf('session.nextWaiting'), next ? store.sessions[next]?.name ?? t('common.label.noName') : ''),
    cmd('cmd:new-project', t('palette.cmd.newProject'), 'add'),
    cmd('cmd:shortcuts', t('palette.cmd.shortcuts'), 'keys', keysOf('shortcuts.open')),
  ];
  const typedOnly = [
    cmd('go:home', t('palette.cmd.home'), 'home'),
    cmd('go:projects', t('palette.cmd.projects'), 'projects'),
    cmd('cmd:sidebar', t('palette.cmd.sidebar'), 'sidebar', keysOf('sidebar.toggle')),
    cmd('cmd:rebuild-index', t('palette.cmd.rebuildIndex'), 'rebuild'),
  ];
  // 設定の節は、行き先として並べる。保持は一般の節の中にあるので、一般の節へ移る。
  const place = t('settings.heading.title');
  const sectionRows = [
    cmd('settings:general', t('settings.section.general'), 'general', '', place),
    cmd('settings:cloud', t('settings.section.cloud'), 'cloud', '', place),
    cmd('settings:integrations', t('settings.section.integrations'), 'integrations', '', place),
    cmd('settings:retention', t('settings.general.retention.title'), 'retention', '', place),
  ];
  const typedSections = [
    cmd('settings:summary', t('settings.section.summary'), 'summary', '', place),
    cmd('settings:tools', t('settings.section.tools'), 'tools', '', place),
    cmd('settings:info', t('settings.section.info'), 'info', '', place),
  ];
  // 設定の節は、添え書きの「設定」でも当てる。「設定」と打つと、節がそろって出る。
  const scoreAll = (items: PaletteItem[], withSub = false) => items.map((item) => ({ item, score: fuzzyScore(q, withSub ? `${item.label} ${item.sub}` : item.label) }));

  if (!q) {
    const all = Number.POSITIVE_INFINITY;
    const groups = [
      section(t, t('palette.section.waiting'), byState.waiting, all), noCount(section(t, t('palette.section.recent'), byState.ended, EMPTY_RECENT)),
      section(t, t('palette.section.actions'), scoreAll(actions), all), section(t, t('palette.section.settings'), scoreAll(sectionRows, true), all),
    ];
    return { query, sections: groups.filter((g) => g !== null).map((g) => g.section), noMatch: false };
  }

  // 打ち始めた後は、いちばんよく当たった行の点の高い順に群を並べる。
  // 決まった順のままだと、名前に散らばって当たったセッションが、名前の頭から当たる操作より上に来る。
  // 点が同じ群は、何も打っていないときと同じ順にする。
  // 終わったセッションは新しいほうの TYPED_ENDED 件だけを引く。古いものは、ホームの欄で引く。
  const groups = [
    section(t, t('palette.section.waiting'), byState.waiting, TYPED_LIMIT), section(t, t('palette.section.running'), byState.running, TYPED_LIMIT), section(t, t('palette.section.sessions'), byState.ended.slice(0, TYPED_ENDED), TYPED_LIMIT),
    section(t, t('palette.section.actions'), scoreAll([...actions, ...typedOnly]), TYPED_LIMIT), section(t, t('palette.section.settings'), scoreAll([...sectionRows, ...typedSections], true), TYPED_LIMIT),
  ].map((g, order) => (g ? { ...g, order } : null)).filter((g) => g !== null).sort((a, b) => b.best - a.best || a.order - b.order);
  // 最後の行は、ホームの欄へ渡す。名前と要約とトランスクリプトを引く欄で、件数はそこに並ぶ行の数である。
  const total = found !== null && found.q === q ? found.total : null;
  const handoff: PaletteSection = { title: t('palette.section.home'), count: null, limit: null, items: [{ id: `search:${q}`, label: t('palette.search.label', { q }), kind: 'search', lead: { kind: 'icon', icon: 'fulltext' }, sub: '', meta: total === null ? '' : t('palette.meta.count', { n: total.toLocaleString('en-US') }), keys: keyLabel('⌘↵') }] };
  return { query, sections: [...groups.map((g) => g.section), handoff], noMatch: groups.length === 0 };
}
