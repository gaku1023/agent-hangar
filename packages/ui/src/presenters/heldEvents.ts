import { eventsAvailable, type HeldFactDto, type Translate } from '@agent-hangar/shared';
import type { Store } from '../store/store.ts';
import { absoluteTime } from './format.ts';

/**
 * 閉じている間に溜まったイベントの札（#563 の C4 と C6）。
 * 結び付けごとに畳んだ群で、items は古い順の 1 件ずつの行（種類と届いた時刻）である。本文と題名は外から来た文なので、札には出さない。
 */
export type HeldGroupProps = { bindingId: string; label: string; count: number; items: { text: string; at: string }[] };
export type HeldEventsCardProps = { head: string; groups: HeldGroupProps[] };

const WHEN_KEY = { ci_done: 'schedules.event.when.ciDone', review: 'schedules.event.when.review', comment: 'schedules.event.when.comment', merged: 'schedules.event.when.merged', issue_opened: 'schedules.event.when.issueOpened' } as const;

/** 1 件の言い方。CI の失敗は ci_done の結果で見分け、知らない種類は名前のまま出す。外の webhook は種類を持たないので「webhook」と言う。 */
function factText(t: Translate, f: HeldFactDto): string {
  if (f.source === 'hook') return t('schedules.event.kind.hook');
  if (f.event === 'ci_done' && f.outcome === 'failure') return t('schedules.event.when.ciFailed');
  return f.event in WHEN_KEY ? t(WHEN_KEY[f.event as keyof typeof WHEN_KEY]) : f.event;
}

/** 結び付けの名前。GitHub は repo と PR の番号、外の webhook は「webhook」。 */
function groupLabel(t: Translate, facts: HeldFactDto[]): string {
  const f = facts.find((x) => x.source === 'github' && x.repo);
  if (!f) return t('schedules.event.kind.hook');
  return f.number !== undefined ? `${f.repo} #${f.number}` : f.repo!;
}

/** 溜まったものが無いか、イベントを使えない PC なら null（札を出さない）。 */
export function presentHeldEvents(store: Store, t: Translate): HeldEventsCardProps | null {
  if (!eventsAvailable(store.sync)) return null;
  const groups = store.heldEvents.filter((h) => h.facts.length > 0).map((h): HeldGroupProps => ({
    bindingId: h.bindingId, label: groupLabel(t, h.facts), count: h.facts.length, items: h.facts.map((f) => ({ text: factText(t, f), at: absoluteTime(t, f.receivedAt) })),
  }));
  if (groups.length === 0) return null;
  return { head: t('schedules.event.heldWhileClosed', { n: groups.reduce((n, g) => n + g.count, 0) }), groups };
}
