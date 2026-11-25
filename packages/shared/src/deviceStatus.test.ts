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

describe('parseDeviceStatus の ssh と tailnet_ips の欄', () => {
  const ssh = { user: 'u', host_pubkey: 'ssh-ed25519 AAAA', mux: { kind: 'psmux', path: 'C:\\psmux.exe' }, shell: 'powershell' };

  it('正しい欄はそのまま読み、tailnet_ips は文字列だけ残す', () => {
    const s = parseDeviceStatus(JSON.stringify({ ...base, ssh, tailnet_ips: ['100.64.0.1', 3, ''] }));
    expect(s?.ssh).toEqual(ssh);
    expect(s?.tailnet_ips).toEqual(['100.64.0.1']);
  });

  it('peer_chat_agents は文字列だけ残し、無い・型違いは欄ごと省く', () => {
    expect(parseDeviceStatus(JSON.stringify({ ...base, peer_chat_agents: ['claude-code', 3, '', 'codex'] }))?.peer_chat_agents).toEqual(['claude-code', 'codex']);
    expect('peer_chat_agents' in parseDeviceStatus(JSON.stringify({ ...base, peer_chat_agents: 'no' }))!).toBe(false);
    expect('peer_chat_agents' in parseDeviceStatus(JSON.stringify(base))!).toBe(false);
  });

  it('mux が null、host_pubkey が null でも読める。知らない欄は捨てる', () => {
    const s = parseDeviceStatus(JSON.stringify({ ...base, ssh: { user: 'u', host_pubkey: null, mux: null, shell: 'posix', extra: 1 } }));
    expect(s?.ssh).toEqual({ user: 'u', host_pubkey: null, mux: null, shell: 'posix' });
  });

  it('壊れた ssh はその欄だけ落とし、ほかは活かす', () => {
    for (const bad of [{ ...ssh, shell: 'fish' }, { ...ssh, user: 1 }, { ...ssh, mux: { kind: 'screen', path: 'x' } }, 'x', null]) {
      const s = parseDeviceStatus(JSON.stringify({ ...base, ssh: bad, tailnet_ips: 'no' }));
      expect(s).toEqual(base);
    }
  });
});
