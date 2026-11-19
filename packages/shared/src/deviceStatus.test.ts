import { describe, expect, it } from 'vitest';
import { DEVICE_ORCHESTRATOR_IDS_MAX, parseDeviceStatus } from './deviceStatus.ts';

const base = { accounts: [], agents: ['claude-code'], lan_ips: [], ssh_host_key: null, hangar_version: '1.0.0' };

describe('parseDeviceStatus の統括の系譜の欄', () => {
  it('文字列の id だけを残して読む', () => {
    const s = parseDeviceStatus(JSON.stringify({ ...base, orchestrator_ids: ['now', 'old', 3, '', null, 'now'] }));
    expect(s?.orchestrator_ids).toEqual(['now', 'old']);
  });

  it('欄が無い、配列でない、空なら鍵ごと持たない（この欄を知らない版と同じ）', () => {
    expect(parseDeviceStatus(JSON.stringify(base))).toEqual(base);
    expect(parseDeviceStatus(JSON.stringify({ ...base, orchestrator_ids: 'now' }))).toEqual(base);
    expect(parseDeviceStatus(JSON.stringify({ ...base, orchestrator_ids: [] }))).toEqual(base);
  });

  it('上限を越えた分は落とす', () => {
    const ids = Array.from({ length: DEVICE_ORCHESTRATOR_IDS_MAX + 5 }, (_, i) => `s${i}`);
    expect(parseDeviceStatus(JSON.stringify({ ...base, orchestrator_ids: ids }))?.orchestrator_ids).toHaveLength(DEVICE_ORCHESTRATOR_IDS_MAX);
  });
});
