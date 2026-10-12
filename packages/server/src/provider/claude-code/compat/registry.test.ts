import { describe, expect, it } from 'vitest';
import { isRegistryDrift, registryDrifts } from './registry.ts';

describe('registryDrifts', () => {
  it('知っている status と、sessionId と pid があればずれは無い', () => {
    for (const status of ['busy', 'idle', 'waiting', 'shell']) expect(registryDrifts({ pid: 1, sessionId: 's', status, version: '2.1.292' })).toEqual([]);
  });
  it('知らない status、無い項目を、登録の版を添えて返す', () => {
    expect(registryDrifts({ pid: 1, sessionId: 's', status: 'thinking', version: '2.1.300' })).toEqual([{ contract: 'registry', value: 'status=thinking', version: '2.1.300' }]);
    expect(registryDrifts({ version: '2.1.300' })).toEqual([
      { contract: 'registry', value: 'sessionId=(missing)', version: '2.1.300' },
      { contract: 'registry', value: 'pid=(missing)', version: '2.1.300' },
      { contract: 'registry', value: 'status=(missing)', version: '2.1.300' },
    ]);
  });
  it('入力待ちの waitingFor は、知らない値だけをずれにする', () => {
    for (const waitingFor of ['permission prompt', 'input needed', 'dialog open', 'sandbox request']) expect(registryDrifts({ pid: 1, sessionId: 's', status: 'waiting', waitingFor })).toEqual([]);
    // 古い Claude は書かないので、欠けはずれにしない。
    expect(registryDrifts({ pid: 1, sessionId: 's', status: 'waiting' })).toEqual([]);
    expect(registryDrifts({ pid: 1, sessionId: 's', status: 'waiting', waitingFor: 'tool approval', version: '2.1.300' })).toEqual([{ contract: 'registry', value: 'waitingFor=tool approval', version: '2.1.300' }]);
  });
  it('記録に残った waitingFor の値は、今も知らない値のときだけずれのまま', () => {
    expect(isRegistryDrift('waitingFor=tool approval')).toBe(true);
    expect(isRegistryDrift('waitingFor=permission prompt')).toBe(false);
  });
  it('オブジェクトでない登録は 1 件のずれにする', () => {
    expect(registryDrifts([])).toEqual([{ contract: 'registry', value: 'entry=(not-object)', version: null }]);
    expect(registryDrifts(null)).toEqual([{ contract: 'registry', value: 'entry=(not-object)', version: null }]);
  });
});
