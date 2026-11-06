import { describe, expect, it } from 'vitest';
import { PEER_CHAT_MIN_HANGAR_VERSION } from '@agent-hangar/shared';
import { versionAtLeast } from './version.ts';

describe('versionAtLeast', () => {
  it('major、minor、patch の順に比べ、rc の前置きは見ない', () => {
    expect(versionAtLeast('0.19.0', '0.19.0')).toBe(true);
    expect(versionAtLeast('0.19.0-rc.1', '0.19.0')).toBe(true);
    expect(versionAtLeast('0.18.9', '0.19.0')).toBe(false);
    expect(versionAtLeast('1.0.0', '0.19.3')).toBe(true);
    expect(versionAtLeast('0.19.10', '0.19.9')).toBe(true);
  });
  it('相手の版が無いか読めなければ false', () => {
    expect(versionAtLeast(null, '0.19.0')).toBe(false);
    expect(versionAtLeast('dev', '0.19.0')).toBe(false);
  });
  it('会話の機能の下限（PEER_CHAT_MIN_HANGAR_VERSION）: 前置きは見ず、機能の版以降を受け、その前を断る', () => {
    expect(PEER_CHAT_MIN_HANGAR_VERSION).toBe('0.20.0-rc.1');
    for (const v of ['0.20.0-rc.1', '0.20.0-rc.2', '0.20.0', '0.20.1', '0.21.0']) expect(versionAtLeast(v, PEER_CHAT_MIN_HANGAR_VERSION)).toBe(true);
    for (const v of ['0.19.0', '0.19.99', 'dev', '']) expect(versionAtLeast(v, PEER_CHAT_MIN_HANGAR_VERSION)).toBe(false);
  });
});
