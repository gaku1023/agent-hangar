import { describe, expect, it } from 'vitest';
import { registryDrifts } from './registry.ts';

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
  it('オブジェクトでない登録は 1 件のずれにする', () => {
    expect(registryDrifts([])).toEqual([{ contract: 'registry', value: 'entry=(not-object)', version: null }]);
    expect(registryDrifts(null)).toEqual([{ contract: 'registry', value: 'entry=(not-object)', version: null }]);
  });
});
