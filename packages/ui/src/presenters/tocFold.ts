import type { SessionDto } from '@agent-hangar/shared';
import type { SessionViewState } from '../mediator/types.ts';
import { currentRunOf, type Store } from '../store/store.ts';

/**
 * 要約の札（S5）を出すか。書かれた要約（土台の要約でないもの）があるか、作成中か失敗の知らせがあるときである。
 * 本文が消えた会話は、土台の要約も残った手がかりとして札にする。
 */
export function hasSummaryCard(s: SessionDto, pending: boolean, error: string | null, gone = false): boolean {
  return (s.summary !== null && (gone || s.summary.source !== 'baseline')) || pending || error !== null;
}

/** 右の欄をはじめ畳む、ターンの少なさの上限（これ以下なら畳む）。 */
export const FEW_TURNS = 2;

/**
 * 終わった画面で、右の欄をはじめ畳むか（2026-10-16 の試作の S5 に添えた決まり）。
 * 要約の札が無く、ターンが FEW_TURNS 以下なら、目次はほとんど空なので「目次 N」の札に畳んでおく。
 * そのときの開閉は保存する transcriptOpen を使わず、その画面だけの tocPeek で持つ。
 * presentSession と mediator の transcript.toggle が同じ判定を使う（⌘J の行き先を揃えるため）。
 * 実行中（run がある）、サブエージェントを見ている間、本文の無い会話は畳まない。
 */
export function tocFolds(store: Store, view: SessionViewState, id: string): boolean {
  const s = store.sessions[id];
  if (!s || !s.hasTranscript || view.agentId !== null || currentRunOf(store, id) !== null) return false;
  if (hasSummaryCard(s, store.summaryPending[id] === true, store.summaryFailed[id] ?? null)) return false;
  return s.stats.turns <= FEW_TURNS;
}
