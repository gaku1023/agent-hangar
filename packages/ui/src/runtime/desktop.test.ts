import { describe, expect, it, vi } from 'vitest';
import { createDesktopBridge } from './desktop.ts';

describe('createDesktopBridge', () => {
  it('殻が差し込む口が無ければ null を返す', () => {
    expect(createDesktopBridge({})).toBeNull();
    expect(createDesktopBridge(null)).toBeNull();
    expect(createDesktopBridge({ __TAURI_INTERNALS__: {} })).toBeNull();
  });
  it('殻の中では、決まった命令だけを呼ぶ', async () => {
    const invoke = vi.fn(async () => null);
    const b = createDesktopBridge({ __TAURI_INTERNALS__: { invoke } })!;
    await b.openLog();
    await b.restart();
    expect(invoke.mock.calls).toEqual([['open_log'], ['restart_app']]);
  });
  it('フォルダの選択は既定の場所を渡し、選んだパスか、取り消しなら null を返す', async () => {
    const invoke = vi.fn(async (): Promise<string | null> => '/Users/me/thesis');
    const b = createDesktopBridge({ __TAURI_INTERNALS__: { invoke } })!;
    expect(await b.pickFolder('/Users/me/workspace')).toBe('/Users/me/thesis');
    expect(invoke).toHaveBeenCalledWith('pick_folder', { defaultPath: '/Users/me/workspace' });
    invoke.mockResolvedValueOnce(null);
    expect(await b.pickFolder(null)).toBeNull();
  });
});
