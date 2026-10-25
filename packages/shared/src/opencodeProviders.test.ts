import { describe, expect, it } from 'vitest';
import { orderProviderCatalog, providerPriceOf, RECOMMENDED_PROVIDERS } from './opencodeProviders.ts';

describe('opencode のプロバイダーの追加の一覧', () => {
  it('おすすめ（DeepSeek、Z.AI、OpenCode Go、GLM Coding Plan、GitHub Copilot）をこの順で先頭に置き、残りは名前の順にする', () => {
    const rows = [
      { id: 'groq', name: 'Groq' }, { id: 'github-copilot', name: 'GitHub Copilot' }, { id: 'abacus', name: 'Abacus' },
      { id: 'zai', name: 'Z.AI' }, { id: 'opencode-go', name: 'OpenCode Go' }, { id: 'deepseek', name: 'DeepSeek' },
      { id: 'zai-coding-plan', name: 'Z.AI Coding Plan' }, { id: 'alibaba', name: 'alibaba' },
    ];
    const out = orderProviderCatalog(rows);
    expect(out.map((r) => r.id)).toEqual(['deepseek', 'zai', 'opencode-go', 'zai-coding-plan', 'github-copilot', 'abacus', 'alibaba', 'groq']);
    expect(out.filter((r) => r.recommended).map((r) => r.id)).toEqual([...RECOMMENDED_PROVIDERS]);
  });

  it('おすすめが opencode のカタログに無ければ、その行は飛ばす', () => {
    const out = orderProviderCatalog([{ id: 'groq', name: 'Groq' }, { id: 'zai', name: 'Z.AI' }]);
    expect(out.map((r) => [r.id, r.recommended])).toEqual([['zai', true], ['groq', false]]);
  });
});

describe('一覧の右の料金の型', () => {
  it('手書きの表の定額とローカルを先に使う。月額があれば添え、API キーで接続できなければ要ログインにする', () => {
    expect(providerPriceOf('opencode-go', null, true)).toEqual({ kind: 'plan', monthlyUsd: 10, loginOnly: false });
    expect(providerPriceOf('github-copilot', null, false)).toEqual({ kind: 'plan', monthlyUsd: null, loginOnly: true });
    expect(providerPriceOf('lmstudio', null, true)).toEqual({ kind: 'local', monthlyUsd: null, loginOnly: false });
  });

  it('それ以外は models.dev の料金で決める。0 円のモデルが混ざれば無料枠あり、全部 0 円なら無料、分からなければ null', () => {
    const paid = { input: 0.27, output: 1.1 };
    const zero = { input: 0, output: 0 };
    expect(providerPriceOf('deepseek', [paid, paid], true)).toEqual({ kind: 'metered', monthlyUsd: null, loginOnly: false });
    expect(providerPriceOf('groq', [paid, zero], true)).toEqual({ kind: 'metered-free', monthlyUsd: null, loginOnly: false });
    expect(providerPriceOf('someone', [zero], true)).toEqual({ kind: 'free', monthlyUsd: null, loginOnly: false });
    expect(providerPriceOf('someone', [null], true)).toBeNull();
    expect(providerPriceOf('someone', null, true)).toBeNull();
  });
});
