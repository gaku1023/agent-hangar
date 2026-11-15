import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { holdOfCodexPlugin } from './codexPluginHold.ts';

let home: string;
beforeEach(() => { home = fs.mkdtempSync(path.join(os.tmpdir(), 'cph-')); });
afterEach(() => fs.rmSync(home, { recursive: true, force: true }));
const key = ['plugins', 'browser@openai-bundled', 'enabled'];

describe('holdOfCodexPlugin', () => {
  it('config.toml も cache も無ければ保留', () => {
    expect(holdOfCodexPlugin(key, { codexHome: home })).toBe('marketplace-missing');
  });
  it('[marketplaces.<配布元>] があれば保留しない', () => {
    fs.writeFileSync(path.join(home, 'config.toml'), '[marketplaces.openai-bundled]\nsource = "/x"\n');
    expect(holdOfCodexPlugin(key, { codexHome: home })).toBeNull();
  });
  it('別の配布元の宣言だけなら保留', () => {
    fs.writeFileSync(path.join(home, 'config.toml'), '[marketplaces.other]\nsource = "/x"\n');
    expect(holdOfCodexPlugin(key, { codexHome: home })).toBe('marketplace-missing');
  });
  it('plugins/cache/<配布元> があれば保留しない', () => {
    fs.mkdirSync(path.join(home, 'plugins', 'cache', 'openai-bundled'), { recursive: true });
    expect(holdOfCodexPlugin(key, { codexHome: home })).toBeNull();
  });
  it('plugins 以外と @ の無い名前は対象外', () => {
    expect(holdOfCodexPlugin(['features', 'x'], { codexHome: home })).toBeNull();
    expect(holdOfCodexPlugin(['plugins', 'plain', 'enabled'], { codexHome: home })).toBeNull();
  });
});
