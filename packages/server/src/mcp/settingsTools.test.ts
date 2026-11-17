import { describe, expect, it } from 'vitest';
import type { SettingsDto } from '@agent-hangar/shared';
import { getSettingsTool, SETTING_TIERS, updateSettingsTool, type SettingsToolDeps } from './settingsTools.ts';
import { ToolError } from './tools.ts';

const base = { workspaceRoot: '/w', claudeDir: '/c', tmuxPath: null, terminalApp: 'terminal', editor: { id: 'vscode', path: null, fileCmd: '', dirCmd: '', terminal: 'none' }, lmStudioUrl: 'http://127.0.0.1:1234', lmStudioModel: null, summaryApiKeySet: true, summaryFallback: false, summaryHourlyCap: 20, allowExternalSummarizer: false, nodePath: null, claudePath: null, language: 'ja', unreadOs: true, autoDone: true, permissionPolicy: null } as unknown as SettingsDto;

function setup() {
  const patches: Record<string, unknown>[] = [];
  let cur: SettingsDto = { ...base };
  const deps: SettingsToolDeps = {
    settingsDto: () => cur,
    patchSettings: async (body) => {
      patches.push(body);
      if ('autoDoneIdleDays' in body && body.autoDoneIdleDays === 999) return { ok: false, error: '自動で Done にするまでの日数の値が違います' };
      cur = { ...cur, ...(body as Partial<SettingsDto>) };
      return { ok: true, settings: cur };
    },
  };
  return { deps, patches };
}

const fail = async (p: Promise<unknown>) => { try { await p; } catch (e) { return e; } throw new Error('断られなかった'); };

describe('get_settings', () => {
  it('今の値と、項目ごとの段を返す。鍵そのものは返さない', () => {
    const { deps } = setup();
    const r = getSettingsTool(deps) as { settings: Record<string, unknown>; tiers: Record<string, string[]> };
    expect(r.settings.language).toBe('ja');
    expect(r.settings.summaryApiKeySet).toBe(true);
    expect(r.settings).not.toHaveProperty('summaryApiKey');
    expect(r.tiers.direct).toContain('language');
    expect(r.tiers.confirm).toContain('autoDone');
    expect(r.tiers.refused).toContain('claudePath');
  });
});

describe('update_settings', () => {
  it('段の direct の項目は、そのまま画面と同じ道で書く', async () => {
    const { deps, patches } = setup();
    const r = await updateSettingsTool(deps, { changes: { language: 'en', unreadOs: false } });
    expect(patches).toEqual([{ language: 'en', unreadOs: false }]);
    expect(r).toMatchObject({ status: 'updated', changed: { language: 'en', unreadOs: false } });
  });

  it('段の confirm の項目は、confirmed が無ければ何も書かず、前と後の値を返して聞くよう促す', async () => {
    const { deps, patches } = setup();
    const r = await updateSettingsTool(deps, { changes: { autoDone: false, language: 'en' } });
    expect(patches).toEqual([]);
    expect(r).toMatchObject({ status: 'needs_confirmation', keys: ['autoDone'], current: { autoDone: true }, proposed: { autoDone: false } });
    expect(typeof (r as { note: unknown }).note).toBe('string');
  });

  it('confirmed: true なら confirm の項目も書く', async () => {
    const { deps, patches } = setup();
    const r = await updateSettingsTool(deps, { changes: { autoDone: false }, confirmed: true });
    expect(patches).toEqual([{ autoDone: false }]);
    expect(r).toMatchObject({ status: 'updated' });
  });

  it('refused の項目は confirmed があっても断り、同じ呼び出しのほかの項目も書かない', async () => {
    const { deps, patches } = setup();
    for (const key of ['claudePath', 'nodePath', 'tmuxPath', 'codexPath', 'opencodePath', 'editor', 'opencodeProviderPrep', 'claudeDir', 'summaryApiKey', 'trustedWorkspaceRoot', 'permissionPolicy', 'lmStudioUrl', 'allowExternalSummarizer']) {
      const e = await fail(updateSettingsTool(deps, { changes: { [key]: 'x', language: 'en' }, confirmed: true }));
      expect(e).toBeInstanceOf(ToolError);
    }
    expect(patches).toEqual([]);
  });

  it('知らない項目と、空の changes と、形の違う changes と confirmed を断る', async () => {
    const { deps, patches } = setup();
    for (const args of [{ changes: { nope: 1 } }, { changes: {} }, {}, { changes: [] }, { changes: 'x' }, { changes: { language: 'en' }, confirmed: 'yes' }, { changes: { dryRun: true } }]) {
      expect(await fail(updateSettingsTool(deps, args))).toBeInstanceOf(ToolError);
    }
    expect(patches).toEqual([]);
  });

  it('画面の道の検査に落ちたら、その文で断る', async () => {
    const { deps } = setup();
    const e = await fail(updateSettingsTool(deps, { changes: { autoDoneIdleDays: 999 }, confirmed: true })) as Error;
    expect(e).toBeInstanceOf(ToolError);
    expect(String((e as ToolError).message ?? e)).toBeDefined();
  });

  it('段の表は SettingsDto の全部の鍵を持つ（足し忘れは型で止まる）。direct は見た目と知らせ方だけ', () => {
    const direct = Object.entries(SETTING_TIERS).filter(([, t]) => t === 'direct').map(([k]) => k).sort();
    expect(direct).toEqual(['language', 'notifyPreference', 'sidebarOtherPcs', 'unreadBadge', 'unreadOs', 'unreadPhone']);
  });
});
