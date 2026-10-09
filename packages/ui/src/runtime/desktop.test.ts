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
  it('設定の同期の適用と世代へ戻すは、決まった命令だけを呼び、結果を決まった形で返す', async () => {
    const invoke = vi.fn(async (cmd: string): Promise<unknown> => (cmd === 'apply_config_sync' ? { status: 'applied', message: '適用しました。', generation: '20261010-120000' } : { status: 'cancelled', message: '戻しませんでした。', generation: null }));
    const b = createDesktopBridge({ __TAURI_INTERNALS__: { invoke } })!;
    expect(await b.applyConfigSync()).toEqual({ status: 'applied', message: '適用しました。', generation: '20261010-120000' });
    expect(await b.restoreConfigSync('20261010-120000')).toEqual({ status: 'cancelled', message: '戻しませんでした。', generation: null });
    expect(invoke.mock.calls).toEqual([['apply_config_sync'], ['restore_config_sync', { name: '20261010-120000' }]]);
  });
  it('殻が知らない形を返したら、適用したとは言わず失敗として返す', async () => {
    const invoke = vi.fn(async (): Promise<unknown> => ({ status: 'maybe', message: 5 }));
    const b = createDesktopBridge({ __TAURI_INTERNALS__: { invoke } })!;
    expect((await b.applyConfigSync()).status).toBe('failed');
    invoke.mockResolvedValueOnce(null);
    expect((await b.restoreConfigSync('20261010-120000')).status).toBe('failed');
  });
});
