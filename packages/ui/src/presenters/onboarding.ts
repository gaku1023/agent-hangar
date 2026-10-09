import type { Store } from '../store/store.ts';
import { presentChecks, type ChecksProps } from './readiness.ts';

/**
 * 空のホームに出す、始める前の確認（初回の A1）。
 * checks は確かめた結果で、まだ届いていなければ null である。
 */
export type OnboardingProps = { checks: ChecksProps | null };

/**
 * セッションもプロジェクト（スクラッチを除く）も 1 つも無いときだけ出す。
 * どちらかがあれば、ふだんのホームを出す。
 */
export function presentOnboarding(store: Store): OnboardingProps | null {
  if (!store.bootstrapped || Object.keys(store.sessions).length > 0) return null;
  if (Object.values(store.projects).some((p) => !p.isScratch)) return null;
  return { checks: store.readiness ? presentChecks(store.readiness, store.compat, store.version) : null };
}
