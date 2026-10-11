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
  it('更新は決まった 4 つの命令だけを呼び、答えを決まった形に直す', async () => {
    const invoke = vi.fn(async (cmd: string): Promise<unknown> => {
      if (cmd === 'update_status') return { current: '1.4.2', done: 10, total: 40 };
      if (cmd === 'update_check') return { version: '1.5.0' };
      return null;
    });
    const b = createDesktopBridge({ __TAURI_INTERNALS__: { invoke } })!;
    expect(await b.update.status()).toEqual({ current: '1.4.2', done: 10, total: 40 });
    expect(await b.update.check()).toEqual({ version: '1.5.0' });
    await b.update.download();
    await b.update.install();
    expect(invoke.mock.calls).toEqual([['update_status'], ['update_check'], ['update_download'], ['update_install']]);
  });
  it('更新の答えの形が違えば、版は無い、大きさは分からないとして扱う', async () => {
    const invoke = vi.fn(async (cmd: string): Promise<unknown> => (cmd === 'update_status' ? { current: 5, done: 'x', total: -1 } : { version: 7 }));
    const b = createDesktopBridge({ __TAURI_INTERNALS__: { invoke } })!;
    await expect(b.update.status()).rejects.toThrow();
    expect(await b.update.check()).toEqual({ version: null });
    invoke.mockResolvedValueOnce({ current: '1.4.2', done: 'x', total: null });
    expect(await b.update.status()).toEqual({ current: '1.4.2', done: 0, total: null });
  });
  it('更新の失敗は、殻の分けた理由に直して投げる。知らない形は other にする', async () => {
    const invoke = vi.fn(async (): Promise<unknown> => { throw { kind: 'signature', detail: 'bad sig' }; });
    const b = createDesktopBridge({ __TAURI_INTERNALS__: { invoke } })!;
    await expect(b.update.download()).rejects.toMatchObject({ reason: 'signature' });
    invoke.mockRejectedValueOnce('command update_check not allowed');
    await expect(b.update.check()).rejects.toMatchObject({ reason: 'other' });
  });
});

describe('クラウド同期の参加と解除の口', () => {
  const plan = { url: 'https://h.example', host: 'h.example', current: null, change: 'new' };
  it('決まった 4 つの命令だけを呼び、参加トークンは命令の引数にだけ載せる', async () => {
    const invoke = vi.fn(async (cmd: string): Promise<unknown> => {
      if (cmd === 'cloud_join_plan') return { ok: true, plan };
      if (cmd === 'cloud_join') return { ok: true, result: { url: 'https://h.example', host: 'h.example' } };
      if (cmd === 'cloud_revoke') return { ok: true, result: { id: 'b', name: 'b', platform: 'darwin', joinedAt: 1, lastSeenAt: 2, revokedAt: 3, lastIp: null, lastCity: null, lastRegion: null, lastCountry: null } };
      return { ok: true, result: { revoked: true, revokeError: null, creator: false } };
    });
    const b = createDesktopBridge({ __TAURI_INTERNALS__: { invoke } })!;
    expect(await b.cloud!.joinPlan('tok')).toEqual({ ok: true, value: plan });
    expect(await b.cloud!.join('tok', true)).toEqual({ ok: true, value: { url: 'https://h.example', host: 'h.example' } });
    expect((await b.cloud!.revoke('b')).ok).toBe(true);
    expect(await b.cloud!.leave(false)).toEqual({ ok: true, value: { revoked: true, revokeError: null, creator: false } });
    expect(invoke.mock.calls).toEqual([
      ['cloud_join_plan', { token: 'tok' }],
      ['cloud_join', { token: 'tok', overwrite: true }],
      ['cloud_revoke', { id: 'b' }],
      ['cloud_leave', { revoke: false }],
    ]);
  });
  it('失敗は符号と文で返し、知らない形と投げた失敗も失敗として返す', async () => {
    const invoke = vi.fn(async (): Promise<unknown> => ({ ok: false, code: 'forbidden', message: '違います' }));
    const b = createDesktopBridge({ __TAURI_INTERNALS__: { invoke } })!;
    expect(await b.cloud!.join('tok', false)).toEqual({ ok: false, failure: { code: 'forbidden', message: '違います' } });
    invoke.mockResolvedValueOnce({ ok: true });
    expect(await b.cloud!.joinPlan('tok')).toEqual({ ok: false, failure: { code: 'unreadable', message: '' } });
    invoke.mockRejectedValueOnce(new Error('not allowed'));
    expect(await b.cloud!.leave(true)).toEqual({ ok: false, failure: { code: 'shell', message: 'Error: not allowed' } });
  });
});
