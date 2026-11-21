/**
 * session_states の 1 行に入っている、互いに独立した事実と、それぞれの列（版 62）。
 * 同期の取り込みは、行ごとではなく事実ごとに新しい方を採る（sync/apply.ts の mergeFacts）。
 * 書き手（sessions/states.ts の write）は、差分が触れた事実の時刻（at の列）を書いた時刻にする。
 * 削除の印（trashed_at と restored_at）も独立した事実だが、明示の復元でしか外れない決まりがあるので、別に合わせる（mergeTrash）。
 */
export type StateFact = { readonly at: string; readonly cols: readonly string[] };

export const STATE_FACTS: readonly StateFact[] = [
  { at: 'status_changed_at', cols: ['status', 'note', 'return_on', 'return_time', 'set_by', 'set_at'] },
  { at: 'candidate_changed_at', cols: ['candidate_status', 'candidate_note', 'candidate_return_on', 'candidate_return_time', 'candidate_source', 'candidate_at', 'candidate_wake_on', 'rejected_at'] },
  { at: 'project_changed_at', cols: ['project_id'] },
  { at: 'pinned_changed_at', cols: ['pinned_at'] },
  // 未読（版 67、live/unread.ts）。積むのは動かしている PC、既読はどちらの PC でもよく、新しい方を採る。
  { at: 'unread_changed_at', cols: ['unread_count', 'unread_text', 'unread_at', 'unread_kind', 'unread_device'] },
  { at: 'muted_changed_at', cols: ['muted_at'] },
];

/** 差分が触れた事実の時刻の列を、at にした差分を返す。 */
export function stampFacts(patch: Record<string, unknown>, at: number): Record<string, number> {
  const stamps: Record<string, number> = {};
  for (const f of STATE_FACTS) if (f.cols.some((c) => c in patch)) stamps[f.at] = at;
  return stamps;
}
