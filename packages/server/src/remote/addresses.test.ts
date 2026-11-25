import { describe, expect, it } from 'vitest';
import { createAddressBook, resolveAddresses } from './addresses.ts';

const st = { lan_ips: ['192.168.3.40', '10.0.0.5'], tailnet_ips: ['100.1.1.1'] };
const probeFrom = (delays: Record<string, number | null>, seen: string[] = []) => (host: string, port: number): Promise<boolean> => {
  seen.push(`${host}:${port}`);
  const d = delays[host];
  if (d === null || d === undefined) return Promise.resolve(false);
  return new Promise((r) => setTimeout(() => r(true), d));
};

describe('resolveAddresses', () => {
  it('uses only the override Host, with no probing', async () => {
    const seen: string[] = [];
    expect(await resolveAddresses({ ...st, override: 'mywin', lastGood: '1.1.1.1' }, { probe: probeFrom({}, seen) })).toEqual({ ok: true, addresses: ['mywin'] });
    expect(seen).toEqual([]);
  });
  it('orders by who answers first and drops the silent ones', async () => {
    const seen: string[] = [];
    const r = await resolveAddresses({ ...st, override: null }, { probe: probeFrom({ '192.168.3.40': 30, '10.0.0.5': null, '100.1.1.1': 5 }, seen) });
    expect(r).toEqual({ ok: true, addresses: ['100.1.1.1', '192.168.3.40'] });
    expect(seen.every((s) => s.endsWith(':22'))).toBe(true);
  });
  it('puts the last good address first among candidates and dedupes', async () => {
    const seen: string[] = [];
    await resolveAddresses({ ...st, override: null, lastGood: '100.1.1.1' }, { probe: probeFrom({}, seen) });
    expect(seen).toEqual(['100.1.1.1:22', '192.168.3.40:22', '10.0.0.5:22']);
    const seen2: string[] = [];
    await resolveAddresses({ ...st, override: null, lastGood: '10.0.0.5' }, { probe: probeFrom({}, seen2) });
    expect(seen2).toEqual(['10.0.0.5:22', '192.168.3.40:22', '100.1.1.1:22']);
  });
  it('is unreachable when nobody answers or there are no candidates', async () => {
    expect(await resolveAddresses({ ...st, override: null }, { probe: probeFrom({}) })).toEqual({ ok: false, reason: 'unreachable' });
    expect(await resolveAddresses({ lan_ips: [], tailnet_ips: [], override: null }, { probe: probeFrom({}) })).toEqual({ ok: false, reason: 'unreachable' });
  });
  it('passes a 2 second timeout to the probe', async () => {
    let t = 0;
    await resolveAddresses({ ...st, override: null }, { probe: (_h, _p, ms) => { t = ms; return Promise.resolve(false); } });
    expect(t).toBe(2000);
  });
});

describe('address book', () => {
  it('remembers the last good address per device in memory', () => {
    const b = createAddressBook();
    expect(b.get('d1')).toBeUndefined();
    b.set('d1', '1.2.3.4');
    expect(b.get('d1')).toBe('1.2.3.4');
    expect(b.get('d2')).toBeUndefined();
  });
});
