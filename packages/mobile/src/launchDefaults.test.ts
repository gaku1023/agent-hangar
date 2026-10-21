import { afterEach, describe, expect, it, vi } from 'vitest';
import { clearLaunchDefaults, EMPTY_DEFAULTS, loadLaunchDefaults, PERMISSION_NAMES, saveLaunchDefaults } from './launchDefaults.ts';

const KEY = 'hangar.mobile.launchDefaults';

afterEach(() => {
  vi.restoreAllMocks();
  localStorage.clear();
});

describe('新しい会話の既定（localStorage）', () => {
  it('無ければ全部デフォルト（PC とアカウントは指定なし）', () => {
    expect(loadLaunchDefaults()).toEqual({ pc: null, account: null, permissionMode: '', model: '', effort: '' });
    expect(loadLaunchDefaults()).toEqual(EMPTY_DEFAULTS);
  });

  it('保存して読み戻せる。消すとデフォルトに戻る', () => {
    const d = { pc: 'pc-2', account: 'acc-3', permissionMode: 'plan', model: 'opus', effort: 'high' };
    saveLaunchDefaults(d);
    expect(JSON.parse(localStorage.getItem(KEY)!)).toEqual(d);
    expect(loadLaunchDefaults()).toEqual(d);
    clearLaunchDefaults();
    expect(localStorage.getItem(KEY)).toBeNull();
    expect(loadLaunchDefaults()).toEqual(EMPTY_DEFAULTS);
  });

  it('知らない権限、モデル、effort はデフォルトに戻し、形の違う PC とアカウントは指定なしにする', () => {
    localStorage.setItem(KEY, JSON.stringify({ pc: 3, account: '', permissionMode: 'yolo', model: 'gpt', effort: 'ultra' }));
    expect(loadLaunchDefaults()).toEqual(EMPTY_DEFAULTS);
    localStorage.setItem(KEY, '{not json');
    expect(loadLaunchDefaults()).toEqual(EMPTY_DEFAULTS);
  });

  it('localStorage が投げても読み書きは投げない', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('denied');
    });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('quota');
    });
    vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(() => {
      throw new Error('denied');
    });
    expect(loadLaunchDefaults()).toEqual(EMPTY_DEFAULTS);
    expect(() => saveLaunchDefaults({ ...EMPTY_DEFAULTS, model: 'opus' })).not.toThrow();
    expect(() => clearLaunchDefaults()).not.toThrow();
  });

  it('権限モードの表示名は PC の新しいセッションのダイアログと同じ', () => {
    expect(PERMISSION_NAMES['']).toBe('デフォルト');
    expect(PERMISSION_NAMES.bypassPermissions).toBe('Bypass permissions');
  });
});
