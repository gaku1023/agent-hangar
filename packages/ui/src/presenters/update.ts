import type { Translate, UiAction } from '@agent-hangar/shared';
import { runningSessionIds, type Store } from '../store/store.ts';
import { cardPhase, phaseVersion, updateBusy, whatsNew, type UpdateFailReason, type UpdatePhase, type UpdateState } from '../store/update.ts';
import { compareVersions, parseNote, type ReleaseNote } from '../lib/releaseNotes.ts';
import { relativeTime } from './format.ts';
import { translatorOf } from './i18n.ts';

/** 札と節の操作 1 つ。primary は主の操作（青いボタン）、link は枠の無い文字だけのボタン（ノートを読む）。 */
export type UpdateAct = { label: string; action: UiAction; primary: boolean; link?: true };

/** 札に載せる要点の数。残りは設定の節で読む。 */
const CARD_POINTS = 3;
/** 取得の進み。大きさが分からないとき percent は null で、label は「ダウンロードしています…」になる。 */
export type UpdateProgress = { percent: number | null; label: string };

/**
 * 右下の更新の札（試作の A2）。新しい版が出たこと、取得の進み、再起動の確認、失敗までを、同じ札の中で済ませる。
 * tone は見出しの色で、info は青、ok は緑、err は赤である。
 * 新しい版の札には、目録のノートから注意（before、「更新の前に」の節）と要点（points）を載せる（試作の C1）。ノートが無ければ null と空である。
 */
export type UpdateCardProps = {
  kind: 'available' | 'downloading' | 'installing' | 'ready' | 'failed'; tone: 'info' | 'ok' | 'err';
  head: string; title: string; detail: string | null; progress: UpdateProgress | null; actions: UpdateAct[];
  beforeLabel: string; before: string | null; points: string[];
};

/**
 * 更新したあと、初めて開いたときに一度だけ出す札（試作の B1）。
 * 版を飛ばして上げたなら、間の版の要点と注意もまとめ、sub でその版を言う。閉じるか読みに行けば、次の版までは出さない。
 */
export type WhatsNewCardProps = {
  head: string; title: string; beforeLabel: string; before: string | null; points: string[]; sub: string | null; actions: UpdateAct[];
};

/**
 * 設定の「更新」の節に並べる、版ごとのノート（試作の A1）。新しい順で、見つけた版（まだ入れていない版）が先頭に来る。
 * tag は版の札（新しい版、使用中）、open ははじめから開いておくかである。
 * 開いた版は注意（before、「更新の前に」の節）と要点（points）だけを出し、本文（body）は「全文を読む」で出す（2026-10-17、試作の L1）。count は行に添える要点の数で、要点が無ければ null。
 */
export type UpdateNoteRow = { version: string; tag: string | null; before: string | null; points: string[]; count: string | null; open: boolean; body: string };

/**
 * 設定の「更新」の節。
 * badge は節の見出しの札、version は版の行、pending は見つけた版の行（無ければ null）、notify は知らせのスイッチの行である。
 * tocState は目次の状態の 1 行。supported が偽（ブラウザ）のときは unsupported の 1 文だけを出す。
 */
export type UpdateSectionProps = {
  supported: boolean; unsupported: string;
  badge: { text: string; tone: 'ok' | 'off' | 'warn' | 'stop' | 'info' } | null;
  version: { title: string; sub: string; checkLabel: string; checkDisabled: boolean };
  pending: { title: string; detail: string | null; progress: UpdateProgress | null; actions: UpdateAct[] } | null;
  notify: { on: boolean; info: string };
  notesTitle: string; beforeLabel: string; notes: UpdateNoteRow[];
  tocState: string;
};

const DOWNLOAD: UiAction = { type: 'update.download' };
const INSTALL: UiAction = { type: 'update.install' };
const DISMISS: UiAction = { type: 'update.dismiss' };
const READ_NOTES: UiAction = { type: 'nav.go', to: { name: 'settings', at: 'update' } };

/** 見つけた版のノート。目録にノートが無いか、版が食い違えば null。 */
function foundNote(u: UpdateState, version: string): ReleaseNote | null {
  return u.foundNotes && u.foundNotes.version === version ? parseNote(version, u.foundNotes.text) : null;
}

const reasonText = (t: Translate, r: UpdateFailReason): string => t(`update.reason.${r}`);

function progressOf(t: Translate, p: Extract<UpdatePhase, { kind: 'downloading' }>): UpdateProgress {
  if (p.total === null || p.total <= 0) return { percent: null, label: t('update.card.downloadingUnknown') };
  const percent = Math.max(0, Math.min(100, Math.floor((p.done / p.total) * 100)));
  return { percent, label: t('update.card.percent', { n: percent }) };
}

/** 札と節に共通の、見つけた版の題と説明と進み。 */
function pendingText(t: Translate, store: Store, u: UpdateState, p: UpdatePhase): { title: string; detail: string | null; progress: UpdateProgress | null } | null {
  const current = u.current ?? '';
  switch (p.kind) {
    case 'available': return { title: t('update.card.availableTitle', { version: p.version }), detail: t('update.card.availableDetail', { current }), progress: null };
    case 'downloading': return { title: t('update.card.downloadingTitle', { version: p.version }), detail: null, progress: progressOf(t, p) };
    case 'installing': return { title: t('update.card.downloadingTitle', { version: p.version }), detail: t('update.card.installingDetail'), progress: null };
    case 'ready': {
      // 再起動しても、tmux（Windows は psmux）の中のセッションは止まらない。
      const n = runningSessionIds(store).size;
      return { title: t('update.card.readyTitle', { version: p.version }), detail: n > 0 ? t('update.card.readyRunning', { n }) : t('update.card.readyNone'), progress: null };
    }
    case 'failed':
      if (p.step === 'check') return null;
      return { title: t(p.step === 'install' ? 'update.card.failedInstall' : 'update.card.failedDownload'), detail: t('update.card.failedDetail', { current, reason: reasonText(t, p.reason) }), progress: null };
    default: return null;
  }
}

export function presentUpdateCard(store: Store): UpdateCardProps | null {
  const u = store.update;
  const p = cardPhase(u);
  if (!p) return null;
  const t = translatorOf(store);
  const text = pendingText(t, store, u, p);
  if (!text) return null;
  const none = { beforeLabel: t('update.notes.before'), before: null, points: [] };
  switch (p.kind) {
    case 'available': {
      const note = foundNote(u, p.version);
      const acts: UpdateAct[] = [{ label: t('update.card.download'), action: DOWNLOAD, primary: true }, { label: t('update.card.later'), action: DISMISS, primary: false }];
      return {
        kind: 'available', tone: 'info', head: t('update.card.headAvailable'), ...text,
        ...none, before: note?.before ?? null, points: note?.points.slice(0, CARD_POINTS) ?? [],
        actions: note ? [{ label: t('update.card.readNotes'), action: READ_NOTES, primary: false, link: true }, ...acts] : acts,
      };
    }
    case 'downloading': return { kind: 'downloading', tone: 'info', head: t('update.card.headDownloading'), ...text, ...none, actions: [] };
    case 'installing': return { kind: 'installing', tone: 'info', head: t('update.card.headInstalling'), ...text, ...none, actions: [] };
    case 'ready':
      return { kind: 'ready', tone: 'ok', head: t('update.card.headReady'), ...text, ...none, actions: [{ label: t('update.card.restart'), action: INSTALL, primary: true }, { label: t('update.card.later'), action: DISMISS, primary: false }] };
    case 'failed':
      return { kind: 'failed', tone: 'err', head: t('update.card.headFailed'), ...text, ...none, actions: [{ label: t('update.card.retry'), action: DOWNLOAD, primary: true }, { label: t('common.button.close'), action: DISMISS, primary: false }] };
    default: return null;
  }
}

/** 更新したあとの札。知らせるノートが無ければ null。 */
export function presentWhatsNew(store: Store): WhatsNewCardProps | null {
  const notes = whatsNew(store.update);
  const latest = notes[0];
  if (!latest) return null;
  const t = translatorOf(store);
  const older = notes.slice(1).map((n) => n.version);
  return {
    head: t('update.whatsNew.head'), title: t('update.whatsNew.title', { version: latest.version }),
    beforeLabel: t('update.notes.before'), before: notes.find((n) => n.before !== null)?.before ?? null,
    points: notes.flatMap((n) => n.points).slice(0, CARD_POINTS),
    sub: older.length > 0 ? t('update.whatsNew.includes', { versions: older.join('、') }) : null,
    actions: [
      { label: t('common.button.close'), action: { type: 'update.notesClose' }, primary: false },
      { label: t('update.whatsNew.readAll'), action: { type: 'update.notesRead' }, primary: true },
    ],
  };
}

/**
 * 節に並べるノート。見つけた版（目録にノートがあるとき）を先頭に、同梱のノートのうちいまの版までを新しい順に置く。
 * はじめから開くのは、見つけた版と、更新後の札で見せた版（無ければいまの版）である。
 */
function noteRows(t: Translate, u: UpdateState): UpdateNoteRow[] {
  const v = phaseVersion(u.phase);
  const found = v !== null && (u.current === null || compareVersions(v, u.current) > 0) ? foundNote(u, v) : null;
  const open = new Set(u.notesOpen.length > 0 ? u.notesOpen : u.current !== null ? [u.current] : []);
  const row = (n: ReleaseNote, tag: string | null, isOpen: boolean): UpdateNoteRow => ({
    version: n.version, tag, before: n.before, points: n.points, count: n.points.length > 0 ? t('update.notes.count', { n: n.points.length }) : null, open: isOpen, body: n.body,
  });
  const rows: UpdateNoteRow[] = found ? [row(found, t('update.notes.next'), true)] : [];
  for (const n of u.notes) {
    if (u.current !== null && compareVersions(n.version, u.current) > 0) continue;
    rows.push(row(n, n.version === u.current ? t('update.notes.inUse') : null, open.has(n.version)));
  }
  return rows;
}

/** 節の見出しの札。段階の札を先に、何も起きていなければ知らせのオフ、確認中、最新の順に見る。 */
function badgeOf(t: Translate, u: UpdateState): UpdateSectionProps['badge'] {
  const p = u.phase;
  if (p.kind === 'failed' && p.step !== 'check') return { text: t('update.settings.badgeFailed'), tone: 'stop' };
  if (p.kind === 'ready' || p.kind === 'installing') return { text: t('update.settings.badgeReady'), tone: 'warn' };
  if (p.kind === 'downloading') return { text: t('update.settings.badgeDownloading'), tone: 'info' };
  if (p.kind === 'available') return { text: t('update.settings.badgeAvailable'), tone: 'info' };
  if (!u.notify) return { text: t('update.settings.badgeOff'), tone: 'off' };
  if (p.kind === 'checking') return { text: t('update.settings.badgeChecking'), tone: 'off' };
  if (p.kind === 'latest') return { text: t('update.settings.badgeLatest'), tone: 'ok' };
  return null;
}

export function presentUpdateSection(store: Store, now: number): UpdateSectionProps {
  const t = translatorOf(store);
  const u = store.update;
  const p = u.phase;
  const checking = p.kind === 'checking';
  const sub = checking ? t('update.settings.checking')
    : p.kind === 'failed' && p.step === 'check' ? t('update.settings.checkFailed', { reason: reasonText(t, p.reason) })
      : u.checkedAt !== null ? t('update.settings.checkedAt', { time: relativeTime(t, u.checkedAt, now) })
        : t('update.settings.never');
  const versionTitle = u.current !== null ? t('update.settings.versionTitle', { version: u.current }) : t('update.settings.versionUnknown');
  // 節では、閉じた版も出す（札を閉じても、ここから入れられる）。
  const text = phaseVersion(p) !== null ? pendingText(t, store, u, p) : null;
  const acts: UpdateAct[] = p.kind === 'available' ? [{ label: t('update.card.download'), action: DOWNLOAD, primary: true }]
    : p.kind === 'ready' ? [{ label: t('update.card.restart'), action: INSTALL, primary: true }]
      : p.kind === 'failed' && p.step !== 'check' ? [{ label: t('update.card.retry'), action: DOWNLOAD, primary: true }]
        : [];
  const badge = badgeOf(t, u);
  return {
    supported: u.supported, unsupported: t('update.settings.unsupported'),
    badge,
    version: { title: versionTitle, sub, checkLabel: checking ? t('update.settings.checking') : t('update.settings.check'), checkDisabled: checking || updateBusy(p) },
    pending: text ? { ...text, actions: acts } : null,
    notify: { on: u.notify, info: t('update.settings.notifyInfo') },
    notesTitle: t('update.notes.title'), beforeLabel: t('update.notes.before'), notes: noteRows(t, u),
    tocState: badge?.text ?? versionTitle,
  };
}
