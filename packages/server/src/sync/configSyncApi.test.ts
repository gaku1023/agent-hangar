import type { ConfigPreviewDto, FileEntry } from '@agent-hangar/shared';
import { describe, expect, it } from 'vitest';
import { configSyncApi } from './configSyncApi.ts';

describe('設定の同期を HTTP が触る形に包む', () => {
  it('同期を設定していない端末では null を返す', () => {
    expect(configSyncApi(null)).toBeNull();
  });

  it('取り込みは、相手の設定を読み、確認を立ててから、読んだものを当てる', async () => {
    const calls: string[] = [];
    const entries = [{ path: 'a' }] as unknown as FileEntry[];
    const preview = { entries: [], confirmed: false } as unknown as ConfigPreviewDto;
    const api = configSyncApi({
      preview: () => { calls.push('preview'); return preview; },
      pendingRemote: () => { calls.push('pending'); return entries; },
      confirm: () => { calls.push('confirm'); },
      applyPull: async (e) => { calls.push(`apply ${e.length}`); return { applied: 1, conflicts: 0 }; },
    })!;
    expect(api.preview()).toBe(preview);
    expect(await api.pull()).toEqual({ applied: 1, conflicts: 0 });
    expect(calls).toEqual(['preview', 'pending', 'confirm', 'apply 1']);
  });
});
