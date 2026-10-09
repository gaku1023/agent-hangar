import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadSettings, type Settings } from './paths.ts';
import { applySettingsPatch } from './settingsUpdate.ts';

describe('設定の書き替えを部品へ行き渡らせる', () => {
  let home: string;
  let box: { current: Settings };
  let calls: string[];
  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'hangar-home-'));
    box = { current: loadSettings(home) };
    calls = [];
  });
  afterEach(() => { fs.rmSync(home, { recursive: true, force: true }); });

  const patch = (p: Parameters<typeof applySettingsPatch>[1]): Settings => applySettingsPatch({
    home, box,
    applyTmux: (s) => { calls.push(`tmux ${s.tmuxPath}`); },
    onTmuxPath: () => { calls.push('shell'); },
    onClaudePath: (s) => { calls.push(`claude ${s.claudePath}`); },
    onSummaryCap: () => { calls.push('cap'); },
    publishConfigSync: (s) => { calls.push(`publish ${s.configBundleSync}`); },
  }, p);

  it('書き替えた値を返し、置き場と settings.json の両方に残す', () => {
    const s = patch({ lmStudioModel: 'm1' });
    expect(s.lmStudioModel).toBe('m1');
    expect(box.current).toBe(s);
    expect(loadSettings(home).lmStudioModel).toBe('m1');
  });

  it('tmux の口は毎回渡し直し、包みの本体は tmuxPath の欄が来たときだけ書き直す', () => {
    patch({ lmStudioModel: 'm1' });
    expect(calls.filter((c) => c.startsWith('tmux ')).length).toBe(1);
    expect(calls).not.toContain('shell');
    patch({ tmuxPath: '/opt/tmux' });
    expect(calls).toContain('tmux /opt/tmux');
    expect(calls).toContain('shell');
  });

  it('claudePath の欄が来たら claude の読み直しを、上限の欄が来たら要約器の作り直しを頼む', () => {
    patch({ lmStudioModel: 'm1' });
    expect(calls.some((c) => c.startsWith('claude ') || c === 'cap')).toBe(false);
    patch({ claudePath: '/opt/claude' });
    expect(calls).toContain('claude /opt/claude');
    patch({ summaryHourlyCap: 5 });
    expect(calls).toContain('cap');
  });

  it('設定の同期の入り切りは、どの書き替えの後にも表示へ載せ直す。順は、部品、表示である', () => {
    patch({ configBundleSync: true });
    calls.length = 0;
    patch({ configBundleSync: false, tmuxPath: '/t', claudePath: '/c', summaryHourlyCap: 1 });
    expect(calls).toEqual(['tmux /t', 'shell', 'claude /c', 'cap', 'publish false']);
  });
});
