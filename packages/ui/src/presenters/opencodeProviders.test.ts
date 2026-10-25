import { describe, expect, it } from 'vitest';
import type { OpencodeConnectedDto, OpencodeProvidersDto } from '@agent-hangar/shared';
import { initialState } from '../mediator/transition.ts';
import { initialStore, type OpencodeProvidersState, type Store } from '../store/store.ts';
import { presentOpencodeProviders } from './opencodeProviders.ts';

const row = (o: Partial<OpencodeConnectedDto> & { id: string }): OpencodeConnectedDto => ({ name: o.id, via: 'key', envName: null, url: null, where: 'remote', price: null, canChangeKey: true, canDisconnect: true, ...o });
const DTO: OpencodeProvidersDto = {
  connected: [
    row({ id: 'lmstudio', name: 'LM Studio', via: 'auto', where: 'device', url: 'http://127.0.0.1:1234/v1', price: { kind: 'local', monthlyUsd: null, loginOnly: false }, canChangeKey: false, canDisconnect: false }),
    row({ id: 'cit-code', name: 'cit-code', via: 'config', where: 'lan', url: 'https://gpu.example/v1' }),
    row({ id: 'opencode', name: 'OpenCode Zen', via: 'auto', canChangeKey: false, canDisconnect: false }),
    row({ id: 'deepseek', name: 'DeepSeek', price: { kind: 'metered', monthlyUsd: null, loginOnly: false } }),
    row({ id: 'groq', name: 'Groq', via: 'env', envName: 'GROQ_API_KEY', canChangeKey: false, canDisconnect: false }),
  ],
  catalog: [
    { id: 'opencode-go', name: 'OpenCode Go', recommended: true, key: true, logins: [], price: { kind: 'plan', monthlyUsd: 10, loginOnly: false } },
    { id: 'github-copilot', name: 'GitHub Copilot', recommended: true, key: false, logins: [{ id: 'device', label: 'Login with GitHub Copilot' }], price: { kind: 'plan', monthlyUsd: null, loginOnly: true } },
    { id: 'groq2', name: 'Groq', recommended: false, key: true, logins: [], price: { kind: 'metered-free', monthlyUsd: null, loginOnly: false } },
    { id: 'abacus', name: 'Abacus', recommended: false, key: true, logins: [], price: null },
  ],
  configPath: '/Users/me/.config/opencode/opencode.json',
};
const withProviders = (p: Partial<OpencodeProvidersState>): Store => ({ ...initialStore(), home: '/Users/me', opencodeProviders: { status: 'ready', data: DTO, busy: null, error: null, added: null, login: null, ...p } });

describe('設定のプロバイダーの面', () => {
  it('つないだ先の行は、接続の仕方と料金の型を 1 行の説明にする', () => {
    const p = presentOpencodeProviders(initialState(), withProviders({}));
    expect(p.rows.map((r) => [r.id, r.desc, r.url])).toEqual([
      ['lmstudio', 'ローカル · 自動で取得', '127.0.0.1:1234/v1'],
      ['cit-code', 'OpenAI 互換', 'gpu.example/v1'],
      ['opencode', 'API キー不要 · 期間限定', null],
      ['deepseek', '従量 · 接続済み', null],
      ['groq', '環境変数 GROQ_API_KEY', null],
    ]);
    expect(p.configPath).toBe('~/.config/opencode/opencode.json');
  });

  it('追加の一覧の右に料金の型を出す。定額は月額か要ログインを添え、分からなければ出さない', () => {
    const p = presentOpencodeProviders(initialState(), withProviders({}));
    expect(p.catalog.map((c) => [c.id, c.side, c.recommended, c.login?.id ?? null])).toEqual([
      ['opencode-go', '定額 · 月 $10', true, null],
      ['github-copilot', '定額 · 要ログイン', true, 'device'],
      ['groq2', '従量・無料枠あり', false, null],
      ['abacus', null, false, null],
    ]);
    expect(p.total).toBe(4);
  });

  it('送っている操作と失敗は、その行にだけ出す。直前に接続した行は fresh にする', () => {
    const p = presentOpencodeProviders(initialState(), withProviders({ busy: { id: 'deepseek', op: 'disconnect' }, error: { id: 'opencode-go', op: 'key', message: 'bad' }, added: 'deepseek' }));
    expect(p.rows.find((r) => r.id === 'deepseek')).toMatchObject({ busy: 'disconnect', fresh: true, error: null });
    expect(p.catalog.find((c) => c.id === 'opencode-go')).toMatchObject({ busy: false, error: 'bad' });
    const c = presentOpencodeProviders(initialState(), withProviders({ busy: { id: ':custom', op: 'custom' }, error: { id: ':custom', op: 'custom', message: 'no' } }));
    expect(c.custom).toEqual({ busy: true, error: 'no' });
  });

  it('読み込み中と失敗、ログインの進み、戻る行', () => {
    expect(presentOpencodeProviders(initialState(), initialStore()).status).toBe('loading');
    const failed = presentOpencodeProviders(initialState(), withProviders({ status: 'failed', data: null, error: { id: '', op: 'load', message: 'serve did not answer' } }));
    expect(failed).toMatchObject({ status: 'failed', failure: 'serve did not answer', rows: [], catalog: [] });
    const login = presentOpencodeProviders({ ...initialState(), opencodeReturn: { projectId: null, scratch: true } }, withProviders({ login: { id: 'github-copilot', attempt: { attemptId: 'a', url: 'https://github.com/login/device', instructions: 'Enter code: AB-12', mode: 'auto' }, status: 'pending', message: null } }));
    expect(login.login).toEqual({ id: 'github-copilot', name: 'GitHub Copilot', url: 'https://github.com/login/device', instructions: 'Enter code: AB-12', mode: 'auto', state: 'pending', note: 'ログインを待っています…', busy: false, error: null });
    expect(login.back).toBe(true);
    expect(presentOpencodeProviders(initialState(), withProviders({})).back).toBe(false);
  });
});
