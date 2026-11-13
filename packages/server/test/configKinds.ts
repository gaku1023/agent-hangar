import type { ConfigApproval, ConfigKinds } from '@agent-hangar/shared';
import { migrateConfigKinds } from '../src/sync/config/kindMigration.ts';

/**
 * 試験用。旧い対象ごとの入切（configTargets）と承認の仕方から、種類ごとの状態（configKinds）を作る。
 * 入にした対象の種類だけが切でなく、承認の仕方が each なら旧く承認の要った種類は確認になる。
 * 対象の入切を前提に書いた試験を、そのままの意味で configKinds へ移すために使う。
 */
export const kindsOf = (switches: Readonly<Record<string, boolean>> = {}, approval: ConfigApproval = 'auto'): ConfigKinds =>
  migrateConfigKinds({ configApproval: approval, configTargets: { ...switches } });

/**
 * 試験用。自動の種類を全部確認にする（切はそのまま）。
 * 受け取りのあとの自動の適用（ConfigSyncService.autoApply）を起こさずに、届いた一覧と指示書を見る試験が使う。
 */
export const confirmAll = (kinds: ConfigKinds): ConfigKinds =>
  Object.fromEntries(Object.entries(kinds).map(([k, v]) => [k, k !== 'transcript' && v === 'auto' ? 'confirm' : v])) as ConfigKinds;
